import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { DEPLOYMENT_FILE, EVM_RPC_URL, REPO_ROOT } from "./config.js";

const STANDING_TREE_FILE = path.join(REPO_ROOT, "deployments", "standing-tree.json");
const ZERO_ID = ("0x" + "00".repeat(32)) as `0x${string}`;
const DUMMY_PQC_SIG = ("0x" + "11".repeat(4627)) as `0x${string}`;

export const ATTENUA_ERROR_ABI = parseAbi([

  "function nonces(address) view returns (uint64)",
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function setRootMandate(address,uint256,uint16,uint16,uint8,uint8,uint64,uint64,uint64,bytes)",
  "function registerSubMandate(bytes32,bytes32,address,uint256,uint16,uint16,uint8,uint64,uint64,uint64,bytes)",
  "function executeAllocate(bytes32,uint256,bool,uint256,bool,uint64,uint64,bytes)",
  "function executePayInvoice(bytes32,bytes32,address,bytes32,uint256,uint64,uint64,bytes,bytes,bytes)",
  "error ZeroAddress()",
  "error InvalidRoles()",
  "error DuplicateVaults()",
  "error InvalidVaultAsset(address vault)",
  "error MonitorDisabled()",
  "error InvalidMandateId()",
  "error SelfDelegationNotAllowed()",
  "error SeparationOfDutiesViolated()",
  "error ActiveChildrenExist(bytes32 mandateId)",
  "error InvalidBand(uint16 minBps, uint16 maxBps)",
  "error VaultIsFrozen()",
  "error SignatureExpired(uint64 deadline, uint256 current)",
  "error BadNonce(address signer, uint64 expected, uint64 provided)",
  "error RootMandateInactive()",
  "error EpochMismatch(uint64 expected, uint64 provided)",
  "error MandateAlreadyExists(bytes32 mandateId)",
  "error MandateNotFound(bytes32 mandateId)",
  "error MandateClosed(bytes32 mandateId)",
  "error MandateExpired(uint64 expiry, uint256 current)",
  "error AttenuationBudgetExceeded(uint256 requested, uint256 available)",
  "error AttenuationBandWidened(uint16 childMin, uint16 childMax, uint16 parentMin, uint16 parentMax)",
  "error AttenuationMaskWidened(uint8 childMask, uint8 parentMask)",
  "error AttenuationExpiryWidened(uint64 childExpiry, uint64 parentExpiry)",
  "error AttenuationDepthExceeded(uint8 childDepth, uint8 maxDepth)",
  "error ZeroBudgetCapability(bytes32 mandateId)",
  "error ActionNotPermitted(uint8 requiredBit, uint8 actualMask)",
  "error SubMandateBudgetExceeded(uint256 requested, uint256 remaining)",
  "error PortfolioBandViolated(uint256 actualBps, uint16 minBps, uint16 maxBps)",
  "error VendorNotRegistered(address vendor)",
  "error InvoiceAlreadyPaid(bytes32 invoiceKey)",
  "error InvalidResearchMandate(bytes32 researchMandateId)",
  "error InvalidMonitorSignature()",
  "error InvalidAmount()",
  "error PrecompileInactive(address target)",
  "error PqcKeyNotRegistered(address account)",
  "error PqcKeyUnsupportedAlgorithm(address account, uint8 algorithmId)",
  "error PqcKeyNotProven(address account)",
  "error PqcKeyLengthInvalid(uint256 length)",
  "error PqcSigLengthInvalid(uint256 length)",
  "error PqcSignatureInvalid(address account)",
]);

export async function rawEthCall(to: Address, data: Hex): Promise<{ ok: boolean; result?: Hex; errorData?: Hex; errorMessage?: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(EVM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    if (res.status === 503 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as {
      result?: Hex;
      error?: { code?: number; message?: string; data?: Hex };
    };
    if (body.error) {
      return { ok: false, errorData: body.error.data, errorMessage: body.error.message };
    }
    return { ok: true, result: body.result };
  }
  throw new Error("RPC rate-limited after retries");
}

export function decodeAttenuaRevert(errorData?: Hex, fallbackMessage?: string): { errorName: string; args: string[]; formatted: string } {
  if (errorData && errorData.startsWith("0x") && errorData.length >= 10) {
    try {
      const dec = decodeErrorResult({ abi: ATTENUA_ERROR_ABI, data: errorData });
      const args = (dec.args ?? []).map((a) => String(a));
      return {
        errorName: dec.errorName,
        args,
        formatted: `${dec.errorName}(${args.join(", ")})`,
      };
    } catch {
      return { errorName: errorData.slice(0, 10), args: [], formatted: errorData };
    }
  }
  return { errorName: "UnknownRevert", args: [], formatted: fallbackMessage ?? "execution reverted" };
}

interface LabPreset {
  id: string;
  description: string;
  invariant: string;
  expectedError: string;
  buildCalldata: (nonces: Record<string, bigint>) => Hex;
}

async function readNonce(vault: Address, account: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: ATTENUA_ERROR_ABI, functionName: "nonces", args: [account] });
  const r = await rawEthCall(vault, data);
  if (!r.ok || !r.result) throw new Error(`Failed reading nonce for ${account}: ${r.errorMessage}`);
  return BigInt(r.result);
}

async function main() {
  const arg = (process.argv[2] ?? "ALL").toUpperCase();
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const tree = JSON.parse(fs.readFileSync(STANDING_TREE_FILE, "utf8"));

  const vault = dep.contracts.attenuaVault.address as Address;
  const orch = tree.rootMandate.orchestrator as Address;
  const alloc = tree.mandates.allocator.subAgent as Address;
  const pay = tree.mandates.payables.subAgent as Address;
  const res = tree.mandates.research.subAgent as Address;
  const vendor = dep.actors.vendor.evm as Address;
  const attacker = dep.actors.unlistedAttacker.evm as Address;

  const ownerAddr = dep.abstractAccounts.ownerTreasuryAA1.evm as Address;
  const [ownerNonce, orchNonce, allocNonce, payNonce] = await Promise.all([
    readNonce(vault, ownerAddr),
    readNonce(vault, orch),
    readNonce(vault, alloc),
    readNonce(vault, pay),
  ]);
  const nonces = { owner: ownerNonce, orch: orchNonce, alloc: allocNonce, pay: payNonce };
  const rootExp = BigInt(tree.rootMandate.expiryUnix) - 100n;
  const depth1ChildExp = BigInt(tree.mandates.allocator.expiryUnix) - 100n;
  const depth2ChildExp = BigInt(tree.mandates.allocatorLeaf.expiryUnix) - 100n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const tag = keccak256(toHex(`lab-${Date.now()}`));

  const presets: LabPreset[] = [
    {
      id: "A1",
      description: "Root IPS Band Widen [30%, 80%] vs Root [40%, 70%]",
      invariant: "I4 (Monotonic IPS Band)",
      expectedError: "AttenuationBandWidened",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, ZERO_ID, res, 1_000_000n, 3000, 8000, 1, rootExp, n.orch, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "TRANSITIVITY",
      description: "Depth-2 Transitivity under Allocator: [41%, 69%] fits Root [40%, 70%] but widens Allocator [45%, 65%]",
      invariant: "I4 (Hierarchical Transitivity)",
      expectedError: "AttenuationBandWidened",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, tree.mandates.allocator.id as `0x${string}`, res, 1_000_000n, 4100, 6900, 1, depth1ChildExp, n.alloc, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "DEPTH3",
      description: "Depth-3 Overflow under depth-2 allocatorLeaf (maxDepth = 2)",
      invariant: "I4 (Max Depth)",
      expectedError: "AttenuationDepthExceeded",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, tree.mandates.allocatorLeaf.id as `0x${string}`, res, 500_000n, 5000, 6000, 1, depth2ChildExp, n.pay, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "A2",
      description: "Budget Conservation Breach (13 fUSD requested when 12 fUSD of 20 fUSD remains)",
      invariant: "I5 (Budget Conservation)",
      expectedError: "AttenuationBudgetExceeded",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, ZERO_ID, res, 13_000_000n, 4500, 6500, 1, rootExp, n.orch, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "A4",
      description: "Zero-Budget Research Breakout via action-mask widening (mask 2 vs mask 0)",
      invariant: "I4 (Action-Mask Subset)",
      expectedError: "ActionNotPermitted",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "executeAllocate",
          args: [tree.mandates.research.id as `0x${string}`, 100_000n, true, 0n, false, n.alloc, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "A5",
      description: "Prompt-Injected Invoice to Unlisted Attacker Address",
      invariant: "I6 (Allowlisted Vendor)",
      expectedError: "VendorNotRegistered",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "executePayInvoice",
          args: [
            tree.mandates.payables.id as `0x${string}`,
            tree.mandates.research.id as `0x${string}`,
            attacker,
            tag,
            500_000n,
            n.pay,
            deadline,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
          ],
        }),
    },
    {
      id: "A6",
      description: "Duplicate Invoice Replay Attack (reusing live H6 paid invoiceId)",
      invariant: "I6 (Single-Use Invoice Key)",
      expectedError: "InvoiceAlreadyPaid",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "executePayInvoice",
          args: [
            tree.mandates.payables.id as `0x${string}`,
            tree.mandates.research.id as `0x${string}`,
            vendor,
            tree.paidInvoiceId as `0x${string}`,
            500_000n,
            n.pay,
            deadline,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
          ],
        }),
    },
    {
      id: "A10",
      description: "Self-Delegated Zero-Budget Clearance Bypass (Audit H-01)",
      invariant: "I4 / I6 (Anti-Self-Delegation)",
      expectedError: "SelfDelegationNotAllowed",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, tree.mandates.payables.id as `0x${string}`, pay, 0n, 4500, 6500, 0, depth1ChildExp, n.pay, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "LEGAL",
      description: "Make-It-Legal under Allocator: passes Wall 1 (Lattice), stopped at Wall 2 by ML-DSA-87 Precompile 0x...0a01",
      invariant: "I1 / I2 (Two-Wall Fail-Closed PQC Gate)",
      expectedError: "PqcSignatureInvalid",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "registerSubMandate",
          args: [tag, tree.mandates.allocator.id as `0x${string}`, res, 1_000_000n, 4800, 6000, 1, depth1ChildExp, n.alloc, deadline, DUMMY_PQC_SIG],
        }),
    },
    {
      id: "CLASSICAL",
      description: "Classical 65-byte ECDSA signature submitted to setRootMandate() (zero keys published)",
      invariant: "I1 / I2 (Zero Classical Spend)",
      expectedError: "PqcSigLengthInvalid",
      buildCalldata: (n) =>
        encodeFunctionData({
          abi: ATTENUA_ERROR_ABI,
          functionName: "setRootMandate",
          args: [
            orch,
            1_000_000n,
            4000,
            7000,
            3,
            2,
            rootExp,
            n.owner,
            deadline,
            ("0x" + "22".repeat(65)) as `0x${string}`,
          ],
        }),
    },
  ];

  const selected = arg === "ALL" ? presets : presets.filter((p) => p.id === arg);
  if (selected.length === 0) {
    console.error(`Unknown preset "${arg}". Available: ALL, ${presets.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`=== Attenua Keyless Live Attack Lab (qorechain-diana @ ${vault}) ===`);
  console.log(`Standing Tree Epoch: ${tree.epoch} | Expires: ${tree.rootMandate.expiryIso}\n`);

  let passed = 0;
  let failed = 0;
  for (const p of selected) {
    const calldata = p.buildCalldata(nonces);
    const out = await rawEthCall(vault, calldata);
    if (out.ok) {
      failed++;
      console.error(`  [FAIL] ${p.id}: expected ${p.expectedError}, but eth_call succeeded unexpectedly!`);
      continue;
    }
    const decoded = decodeAttenuaRevert(out.errorData, out.errorMessage);
    const match = decoded.errorName === p.expectedError;
    if (match) {
      passed++;
      console.log(`  [PASS] ${p.id} | ${p.invariant}`);
      console.log(`         ${p.description}`);
      console.log(`         Live chain revert -> ${decoded.formatted}`);
    } else {
      failed++;
      console.error(`  [FAIL] ${p.id}: expected ${p.expectedError}, got ${decoded.formatted}`);
    }
  }

  console.log(`\n=== Lab Summary: ${passed} PASSED, ${failed} FAILED ===`);
  if (failed > 0) process.exit(1);
}

const isDirectCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
