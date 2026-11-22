import { encodePacked, keccak256, parseAbi, type Address } from "viem";
import { createEvmPublicClient } from "./config.js";
import { signResearchClearance } from "./signing.js";

export interface InvoiceScreeningInput {
  vendor: Address;
  invoiceId: `0x${string}`;
  amountMicro: bigint;
  recipientName: string;
  memo: string;
  description: string;
  attachmentsText?: string;
}

export interface ChainCheckResult {
  vendorRegistered: boolean;
  vendorHolderEligible: boolean;
  invoiceAlreadyPaid: boolean;
  rootEpoch: bigint;
}

export interface ChainReader {
  readInvoiceChecks: (vendor: Address, invoiceKey: `0x${string}`) => Promise<ChainCheckResult>;
}

export interface ScreeningVerdict {
  decision: "APPROVE_CLEARANCE" | "REFUSE";
  reasons: string[];
  promptInjectionFlags: string[];
  chainChecks: ChainCheckResult;
  clearanceSignaturePrefix?: string;
  clearanceSignatureBytes?: number;
  clearanceSignature?: `0x${string}`;
}

const VAULT_VIEW_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function registeredVendors(address) view returns (bool)",
  "function usedInvoices(bytes32) view returns (bool)",
]);

const GUARD_VIEW_ABI = parseAbi([
  "function isEligible(address) view returns (bool)",
]);

const PROMPT_INJECTION_RULES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "instruction_override_directive",
    pattern: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+instructions?/i,
  },
  {
    label: "system_prompt_spoof",
    pattern: /<\s*\/?\s*(?:system|instruction|override|developer)\s*>|system\s+override\s*:/i,
  },
  {
    label: "allowlist_bypass_attempt",
    pattern: /bypass\s+(?:allowlist|whitelist|holderguard|guard|mandate|research)/i,
  },
  {
    label: "redirect_payout_command",
    pattern: /(?:redirect|divert|route|forward)\s+(?:funds|payment|payout|fusd|transfer)\s+to\b/i,
  },
];

export function detectPromptInjection(input: InvoiceScreeningInput): string[] {
  const combined = `${input.recipientName}\n${input.memo}\n${input.description}\n${input.attachmentsText ?? ""}`;
  const flags: string[] = [];

  for (const rule of PROMPT_INJECTION_RULES) {
    if (rule.pattern.test(combined)) {
      flags.push(`pattern:${rule.label}`);
    }
  }

  const addrMatches = combined.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  const declared = input.vendor.toLowerCase();
  for (const found of addrMatches) {
    if (found.toLowerCase() !== declared) {
      flags.push(`rogue_evm_address:${found}`);
    }
  }

  return Array.from(new Set(flags));
}

export function createLiveChainReader(params: {
  vault: Address;
  holderGuard: Address;
}): ChainReader {
  const evm = createEvmPublicClient();
  return {
    async readInvoiceChecks(vendor: Address, invoiceKey: `0x${string}`): Promise<ChainCheckResult> {
      const [rootEpoch, vendorRegistered, invoiceAlreadyPaid, vendorHolderEligible] = await Promise.all([
        evm.readContract({
          address: params.vault,
          abi: VAULT_VIEW_ABI,
          functionName: "rootEpoch",
        }),
        evm.readContract({
          address: params.vault,
          abi: VAULT_VIEW_ABI,
          functionName: "registeredVendors",
          args: [vendor],
        }),
        evm.readContract({
          address: params.vault,
          abi: VAULT_VIEW_ABI,
          functionName: "usedInvoices",
          args: [invoiceKey],
        }),
        evm.readContract({
          address: params.holderGuard,
          abi: GUARD_VIEW_ABI,
          functionName: "isEligible",
          args: [vendor],
        }),
      ]);

      return {
        rootEpoch,
        vendorRegistered,
        invoiceAlreadyPaid,
        vendorHolderEligible,
      };
    },
  };
}

export async function screenInvoice(params: {
  input: InvoiceScreeningInput;
  chainId: bigint;
  vault: Address;
  researchMandateId: `0x${string}`;
  researchPqcSecret?: Uint8Array;
  maxSingleInvoiceMicro?: bigint;
  reader: ChainReader;
}): Promise<ScreeningVerdict> {
  const maxPerTx = params.maxSingleInvoiceMicro ?? 10_000_000n; // 10.00 fUSD AA #1 ceiling
  const invoiceKey = keccak256(
    encodePacked(["address", "bytes32"], [params.input.vendor, params.input.invoiceId])
  );

  const promptInjectionFlags = detectPromptInjection(params.input);
  const chainChecks = await params.reader.readInvoiceChecks(params.input.vendor, invoiceKey);
  const reasons: string[] = [];

  if (params.input.amountMicro <= 0n) {
    reasons.push("Amount must be strictly positive.");
  }
  if (params.input.amountMicro > maxPerTx) {
    reasons.push(
      `Requested amount (${params.input.amountMicro} micro-fUSD) exceeds per-tx policy cap (${maxPerTx}).`
    );
  }
  if (promptInjectionFlags.length > 0) {
    reasons.push(`Prompt-injection heuristic triggered: ${promptInjectionFlags.join(", ")}.`);
  }
  if (!chainChecks.vendorRegistered) {
    reasons.push(`Vendor ${params.input.vendor} is NOT registered in AttenuaVault.registeredVendors.`);
  }
  if (!chainChecks.vendorHolderEligible) {
    reasons.push(`Vendor ${params.input.vendor} failed QoreChainHybridHolderGuard.isEligible().`);
  }
  if (chainChecks.invoiceAlreadyPaid) {
    reasons.push(`Invoice key ${invoiceKey} is already marked paid on-chain.`);
  }

  if (reasons.length > 0) {
    return {
      decision: "REFUSE",
      reasons,
      promptInjectionFlags,
      chainChecks,
    };
  }

  let clearanceSignature: `0x${string}` | undefined;
  if (params.researchPqcSecret) {
    clearanceSignature = signResearchClearance({
      chainId: params.chainId,
      vault: params.vault,
      rootEpoch: chainChecks.rootEpoch,
      researchMandateId: params.researchMandateId,
      vendor: params.input.vendor,
      invoiceId: params.input.invoiceId,
      amount: params.input.amountMicro,
      researchPqcSecret: params.researchPqcSecret,
    });
  }

  return {
    decision: "APPROVE_CLEARANCE",
    reasons: [
      "Zero prompt-injection indicators detected.",
      "Vendor allowlisted on AttenuaVault and passes ML-DSA-87 HolderGuard eligibility.",
      "Invoice unpaid on-chain and strictly within per-tx policy ceiling.",
    ],
    promptInjectionFlags,
    chainChecks,
    clearanceSignature,
    clearanceSignaturePrefix: clearanceSignature?.slice(0, 26),
    clearanceSignatureBytes: clearanceSignature ? (clearanceSignature.length - 2) / 2 : undefined,
  };
}
