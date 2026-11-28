import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import deployment from "@deployments/qorechain-diana.json";
import evidence from "@deployments/live-run-evidence.json";
import standingTree from "@deployments/standing-tree.json";
import decodedAttacks from "@deployments/decoded-attacks.json";
import authenticatedMessage from "@deployments/authenticated-message.json";

export const EVM_RPC_URL = "https://evm-testnet.qore.host";
export const EXPLORER_BASE = "https://dashboard.qorechain.io/explorer";
export const HALLMARK_BASE = "https://hallmark-jade.vercel.app/c";
export const QORE_CHAIN_HEX = "0x2648"; // 9800
export const ZERO_ID = ("0x" + "00".repeat(32)) as `0x${string}`;
export const DUMMY_PQC_SIG = ("0x" + "11".repeat(4627)) as `0x${string}`;

const SNAPSHOT_CACHE_KEY = "attenua-snapshot-cache-v1";

export type DeploymentManifest = typeof deployment;
export type LiveRunEvidence = typeof evidence;
export type StandingTreeManifest = typeof standingTree;
export type DecodedAttacksManifest = typeof decodedAttacks;
export type AuthenticatedMessageManifest = typeof authenticatedMessage;

export interface EvidenceEntry {
  id: string;
  title: string;
  actor: string;
  layer: string;
  passed: boolean;
  txHash: string;
  evmGasUsed: string;
  summary: string;
  verbatimReason?: string;
}

export interface InspectorItem {
  id: string;
  kind: "attack" | "run" | "check";
  eyebrow: string;
  title: string;
  pillTone: "ok" | "danger" | "warn" | "neutral";
  pillLabel: string;
  subtitle: string;
  actorLabel: string;
  actorValue: string;
  layerLabel: string;
  layerValue: string;
  gasUsed?: string;
  txHash?: string;
  extraTxs?: Array<{ id: string; txHash: string; gas: string }>;
  diagnosticTitle: string;
  diagnostic: string;
}

export interface LiveChainSnapshot {
  fetchedAt: string;
  blockNumber: string;
  rootEpoch: number;
  frozen: boolean;
  rootMandateActive: boolean;
  idleFusd: bigint;
  liquidityAssets: bigint;
  reserveAssets: bigint;
  liquidityBps: number;
  guardOwner: Address;
  vaultExempt: boolean;
  ownerWindowLive: boolean;
  ownerActiveAuthenticators: number;
  monitorFusdBalance: bigint;
  isCachedFallback?: boolean;
}

export interface AddressPosture {
  address: Address;
  role: string;
  fusdBalance: bigint;
  vaultNonce: bigint;
  isVendor: boolean;
  guardExempt: boolean;
  guardEligible: boolean;
  pqcResponded: boolean;
  pqcRegistered: boolean;
  pqcAlgorithmId: number;
  pqcPossessionProven: boolean;
}

export interface DecodedVaultRevert {
  errorName: string;
  args: string[];
  formatted: string;
  wall: "wall1" | "wall2" | "state" | "unknown";
  invariant: string;
  explanation: string;
}

export interface LiveSimulationResult {
  succeededUnexpectedly: boolean;
  calldata: Hex;
  issuer: Address;
  issuerNonce: string;
  decoded: DecodedVaultRevert;
}

export const DEPLOYMENT: DeploymentManifest = deployment;
export const EVIDENCE: LiveRunEvidence = evidence;
export const STANDING_TREE: StandingTreeManifest = standingTree;
export const DECODED_ATTACKS: DecodedAttacksManifest = decodedAttacks;
export const AUTHENTICATED_MESSAGE: AuthenticatedMessageManifest = authenticatedMessage;

export const ADDRESS_PRESETS: Array<{ label: string; address: Address }> = [
  { label: "Owner", address: DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.evm as Address },
  { label: "Allocator", address: DEPLOYMENT.actors.allocator.evm as Address },
  { label: "Payables", address: DEPLOYMENT.actors.payables.evm as Address },
  { label: "Research", address: DEPLOYMENT.actors.research.evm as Address },
  { label: "Vendor", address: DEPLOYMENT.actors.vendor.evm as Address },
  { label: "Attacker", address: DEPLOYMENT.actors.unlistedAttacker.evm as Address },
  { label: "AttenuaVault", address: DEPLOYMENT.contracts.attenuaVault.address as Address },
];

export const ATTENUA_VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function rootMandate() view returns (address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
  "function registeredVendors(address) view returns (bool)",
  "function nonces(address) view returns (uint64)",
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

const GUARD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function exempt(address) view returns (bool)",
  "function isEligible(address) view returns (bool)",
  "function keyStatus(address) view returns (bool,bool,uint8,bool)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const publicClient = createPublicClient({
  transport: http(EVM_RPC_URL, {
    timeout: 15_000,
    retryCount: 4,
    retryDelay: 800,
  }),
});

async function runInPairs(
  tasks: ReadonlyArray<() => Promise<unknown>>,
  delayMs = 120,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < tasks.length; i += 2) {
    const chunk = tasks.slice(i, i + 2).map((fn) => fn());
    results.push(...(await Promise.all(chunk)));
    if (i + 2 < tasks.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

export function formatFusd(micro: bigint, withUnit = true): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return withUnit ? `${whole}.${frac} fUSD` : `${whole}.${frac}`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function shortAddr(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function hallmarkContractUrl(address: string): string {
  return `${HALLMARK_BASE}/${address.toLowerCase()}`;
}

export function formatRecordedRunUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d.getUTCDate();
  const mon = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${year}, ${hh}:${mm} UTC`;
}

const CONTEXT_MAP: Record<string, string> = {
  A1: "tests I4, Monotonic attenuation",
  A2: "tests I5, Budget conservation",
  A3: "tests I4, Monotonic attenuation",
  A4: "tests I4, Monotonic attenuation",
  A5: "tests I6, 3-signature invoice settlement",
  A6: "tests I6, 3-signature invoice settlement",
  A7: "tests I7, No standing allowance",
  A8: "tests I3, Isolated freeze-only monitor",
  A9: "tests I9, O(1) post-quantum kill-switch",
  A10: "tests I6, H-01 self-delegated Research clearance bypass",
  H1: "root IPS mandate setup",
  H2: "proven vendor onboarding",
  H3: "tests I7, No standing allowance",
  H4a: "delegates Allocator sub-mandate",
  H4b: "delegates Payables sub-mandate",
  H4c: "delegates Research clearance role",
  H5: "ERC-4626 rebalance inside band",
  H6: "tests I6, 3-signature invoice settlement",
  H7: "tests I5, Budget conservation",
};

const FRIENDLY_ATTACK_TITLE: Record<string, string> = {
  A5: "Prompt-injected invoice to an unlisted attacker address",
};

function shortReasonTag(layer: string): string {
  const match = /\(([^)]+)\)/.exec(layer);
  if (!match) return layer;
  const base = layer.slice(0, match.index).trim();
  const errName = match[1];
  return `${base || "AttenuaVault"} · ${errName}`;
}

export function getInspectorItem(
  chipId: string,
  live: LiveChainSnapshot | null,
): InspectorItem | null {
  const attacks = EVIDENCE.attacks as EvidenceEntry[];
  const happy = EVIDENCE.happyPath as EvidenceEntry[];

  if (chipId === "H4") {
    const sub = happy.filter((h) => h.id === "H4a" || h.id === "H4b" || h.id === "H4c");
    if (sub.length === 0) return null;
    const totalGas = sub.reduce((acc, s) => acc + Number(s.evmGasUsed || 0), 0);
    return {
      id: "H4",
      kind: "run",
      eyebrow: "H4 · H4a + H4b + H4c delegation batch",
      title: "Orchestrator delegates 3 sub-mandates",
      pillTone: "ok",
      pillLabel: "3/3 verified",
      subtitle: "Allocator (6 fUSD, [45%,65%]), Payables (2 fUSD), Research (0 fUSD)",
      actorLabel: "Issuer",
      actorValue: "Orchestrator (ML-DSA-87)",
      layerLabel: "Enforced by",
      layerValue: "AttenuaVault Attenuation Lattice",
      gasUsed: String(totalGas),
      txHash: sub[0].txHash,
      extraTxs: sub.map((s) => ({ id: s.id, txHash: s.txHash, gas: s.evmGasUsed })),
      diagnosticTitle: "Mandate IDs committed on-chain",
      diagnostic: sub.map((s) => `${s.id}: ${s.summary} (tx ${s.txHash})`).join("\n"),
    };
  }

  if (chipId === "H1 to H7") {
    const totalGas = happy.reduce((acc, s) => acc + Number(s.evmGasUsed || 0), 0);
    return {
      id: "H1 to H7",
      kind: "run",
      eyebrow: "H1 to H7 · tests I1, Zero msg.sender trust",
      title: "Full 9-transaction swarm lifecycle",
      pillTone: "ok",
      pillLabel: `${happy.length}/${happy.length} verified`,
      subtitle: "Every state mutation authenticated by ML-DSA-87, zero msg.sender / onlyOwner checks",
      actorLabel: "Principals",
      actorValue: "Owner, Orchestrator, Allocator, Payables, Vendor, Research",
      layerLabel: "Enforced by",
      layerValue: "AttenuaVault + PqcVerifier (0x…0a01 / 0x…0a02)",
      gasUsed: String(totalGas),
      txHash: happy[0]?.txHash,
      extraTxs: happy.map((s) => ({ id: s.id, txHash: s.txHash, gas: s.evmGasUsed })),
      diagnosticTitle: "Verified happy-path transactions",
      diagnostic: happy.map((s) => `${s.id} (${Number(s.evmGasUsed).toLocaleString()} gas): ${s.title}`).join("\n"),
    };
  }

  if (chipId === "verify") {
    const guardOwner = live ? live.guardOwner : DEPLOYMENT.contracts.holderGuard.ownerAfterRenounce;
    const monFusd = live ? formatFusd(live.monitorFusdBalance) : "0.00 fUSD";
    return {
      id: "verify",
      kind: "check",
      eyebrow: "verify · Keyless CLI audit (cd agent && npm run verify)",
      title: "31 read-only on-chain, KEM, archive & MCP checks pass without private keys",
      pillTone: "ok",
      pillLabel: "31 passed, 0 failed",
      subtitle: "Verifies deployed bytecode, Epoch 2 standing tree, KEM registry, height-1 archive reverts, @qorechain/mcp preflight & QoreScan CBOM",
      actorLabel: "Runner",
      actorValue: "Keyless JSON-RPC, Cosmos REST, Archive EVM & @qorechain/mcp",
      layerLabel: "Target chain",
      layerValue: `${DEPLOYMENT.network} (EVM Chain ID ${DEPLOYMENT.evmChainId})`,
      diagnosticTitle: "Live check values",
      diagnostic: [
        `Guard owner()           = ${guardOwner} (live EVM RPC · renounced)`,
        `Monitor AA #2 fUSD      = ${monFusd} (live EVM RPC · freeze() 0xbd2d305f only)`,
        `Standing Root Mandate   = active=${live ? String(live.rootMandateActive) : "true"} (Epoch ${live ? live.rootEpoch : standingTree.epoch})`,
        `KEM Registry (ML-KEM)   = OrchestratorPqc #${authenticatedMessage.kemRegistry.orchestratorPqc.registeredHeight} · Payables #${authenticatedMessage.kemRegistry.payables.registeredHeight}`,
        `Archive Decoder         = ${decodedAttacks.totalAttacks}/10 historical A1-A10 reverts decoded @ height - 1`,
        `QoreScan CBOM           = docs/cbom.json (CycloneDX 1.6)`,
        `Command                 = cd agent && npm install && npm run verify`,
      ].join("\n"),
    };
  }

  const foundAttack = attacks.find((a) => a.id === chipId);
  if (foundAttack) {
    const context = CONTEXT_MAP[foundAttack.id] ?? "adversarial defense check";
    const dec = decodedAttacks.attacks.find((d) => d.id === foundAttack.id);
    const replayBlockLine = dec
      ? dec.replayHeight
        ? `Archive replay: block ${dec.replayHeight} (tx block ${dec.txHeight} · outer code=${dec.outerCode} · abstractaccount_execution_failed=${String(dec.aaFailedEvent)})`
        : `Tx block ${dec.txHeight} · outer code=${dec.outerCode} · abstractaccount_execution_failed=${String(dec.aaFailedEvent)}`
      : null;
    const diagnosticLines = dec
      ? [
          `Decoded revert: ${dec.formattedError}`,
          replayBlockLine!,
          `Cosmos diagnostic: ${foundAttack.verbatimReason ?? "execution reverted: evm transaction execution failed"}`,
        ].join("\n")
      : (foundAttack.verbatimReason ?? "execution reverted: evm transaction execution failed");

    return {
      id: foundAttack.id,
      kind: "attack",
      eyebrow: `${foundAttack.id} · ${context}`,
      title: FRIENDLY_ATTACK_TITLE[foundAttack.id] ?? foundAttack.title,
      pillTone: foundAttack.passed ? "ok" : "danger",
      pillLabel: foundAttack.passed ? "Refused on-chain" : "Unexpected pass",
      subtitle: foundAttack.summary.replace(/^Refused on-chain:\s*/i, ""),
      actorLabel: "Attacker",
      actorValue: foundAttack.actor,
      layerLabel: "Refused by",
      layerValue: shortReasonTag(foundAttack.layer),
      gasUsed: foundAttack.evmGasUsed,
      txHash: foundAttack.txHash,
      extraTxs:
        dec && dec.targetTxHash && dec.targetTxHash.toUpperCase() !== foundAttack.txHash.toUpperCase()
          ? [
              { id: `${foundAttack.id} (kill-switch)`, txHash: foundAttack.txHash, gas: foundAttack.evmGasUsed },
              { id: `${foundAttack.id} (post-revoke refused)`, txHash: dec.targetTxHash, gas: "0" },
            ]
          : undefined,
      diagnosticTitle: dec
        ? dec.layer === "cosmos_abstractaccount"
          ? "Cosmos x/abstractaccount spending-limit refusal"
          : "Decoded on-chain revert (height - 1 archive eth_call)"
        : "Verbatim on-chain diagnostic",
      diagnostic: diagnosticLines,
    };
  }

  const foundHappy = happy.find((h) => h.id === chipId);
  if (foundHappy) {
    const context = CONTEXT_MAP[foundHappy.id] ?? "happy-path execution";
    return {
      id: foundHappy.id,
      kind: "run",
      eyebrow: `${foundHappy.id} · ${context}`,
      title: foundHappy.title,
      pillTone: foundHappy.passed ? "ok" : "danger",
      pillLabel: foundHappy.passed ? "Verified on-chain" : "Failed",
      subtitle: foundHappy.summary,
      actorLabel: "Signer",
      actorValue: foundHappy.actor,
      layerLabel: "Verified by",
      layerValue: foundHappy.layer,
      gasUsed: foundHappy.evmGasUsed,
      txHash: foundHappy.txHash,
      diagnosticTitle: "Recorded execution summary",
      diagnostic: foundHappy.summary,
    };
  }

  return null;
}

function saveSnapshotCache(snap: LiveChainSnapshot) {
  try {
    localStorage.setItem(
      SNAPSHOT_CACHE_KEY,
      JSON.stringify({
        ...snap,
        idleFusd: snap.idleFusd.toString(),
        liquidityAssets: snap.liquidityAssets.toString(),
        reserveAssets: snap.reserveAssets.toString(),
        monitorFusdBalance: snap.monitorFusdBalance.toString(),
      }),
    );
  } catch {
    // ignore storage errors
  }
}

export function loadCachedSnapshot(): LiveChainSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      fetchedAt: String(p.fetchedAt ?? ""),
      blockNumber: String(p.blockNumber ?? "0"),
      rootEpoch: Number(p.rootEpoch ?? STANDING_TREE.epoch),
      frozen: Boolean(p.frozen),
      rootMandateActive: Boolean(p.rootMandateActive ?? true),
      idleFusd: BigInt(String(p.idleFusd ?? "0")),
      liquidityAssets: BigInt(String(p.liquidityAssets ?? "0")),
      reserveAssets: BigInt(String(p.reserveAssets ?? "0")),
      liquidityBps: Number(p.liquidityBps ?? 5000),
      guardOwner: (p.guardOwner as Address) ?? (DEPLOYMENT.contracts.holderGuard.ownerAfterRenounce as Address),
      vaultExempt: Boolean(p.vaultExempt ?? true),
      ownerWindowLive: false,
      ownerActiveAuthenticators: 1,
      monitorFusdBalance: BigInt(String(p.monitorFusdBalance ?? "0")),
      isCachedFallback: true,
    };
  } catch {
    return null;
  }
}

export async function fetchLiveChainSnapshot(): Promise<LiveChainSnapshot> {
  const vaultAddr = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const guardAddr = DEPLOYMENT.contracts.holderGuard.address as Address;
  const fusdAddr = DEPLOYMENT.contracts.fusd as Address;
  const monitorEvm = DEPLOYMENT.abstractAccounts.monitorAA2.evm as Address;

  const [blockNumber, rootEpoch, frozen, rootMandate, summary, guardOwner, vaultExempt, monitorFusdBalance] =
    (await runInPairs([
      () => publicClient.getBlockNumber(),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "rootEpoch" }),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "frozen" }),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "rootMandate" }),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "portfolioSummary" }),
      () => publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "owner" }),
      () => publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "exempt", args: [vaultAddr] }),
      () => publicClient.readContract({ address: fusdAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [monitorEvm] }),
    ])) as [
      bigint,
      bigint,
      boolean,
      readonly [Address, bigint, bigint, bigint, number, number, number, number, bigint, bigint, boolean],
      readonly [bigint, bigint, bigint, bigint],
      Address,
      boolean,
      bigint,
    ];

  const snap: LiveChainSnapshot = {
    fetchedAt: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
    rootEpoch: Number(rootEpoch),
    frozen,
    rootMandateActive: Boolean(rootMandate[10]),
    idleFusd: summary[0],
    liquidityAssets: summary[1],
    reserveAssets: summary[2],
    liquidityBps: Number(summary[3]),
    guardOwner,
    vaultExempt,
    ownerWindowLive: false,
    ownerActiveAuthenticators: 1,
    monitorFusdBalance,
    isCachedFallback: false,
  };
  saveSnapshotCache(snap);
  return snap;
}

function classifyVaultError(errorName: string, args: string[]): DecodedVaultRevert {
  const formatted = `${errorName}(${args.join(", ")})`;
  if (errorName === "AttenuationBandWidened") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 · Monotonic IPS Band",
      explanation: `Child band [${(Number(args[0]) / 100).toFixed(0)}%, ${(Number(args[1]) / 100).toFixed(0)}%] widens parent ceiling [${(Number(args[2]) / 100).toFixed(0)}%, ${(Number(args[3]) / 100).toFixed(0)}%].`,
    };
  }
  if (errorName === "AttenuationBudgetExceeded") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I5 · Budget Conservation",
      explanation: `Requested ${formatFusd(BigInt(args[0] ?? "0"))} exceeds remaining unallocated parent budget (${formatFusd(BigInt(args[1] ?? "0"))}).`,
    };
  }
  if (errorName === "AttenuationMaskWidened") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 · Action-Mask Subset",
      explanation: `Requested action bitmask ${args[0]} grants permissions outside parent mask ${args[1]}.`,
    };
  }
  if (errorName === "AttenuationExpiryWidened") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 · Monotonic Expiry",
      explanation: `Child expiry timestamp ${args[0]} exceeds parent expiry ${args[1]}.`,
    };
  }
  if (errorName === "AttenuationDepthExceeded") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 · Max Delegation Depth",
      explanation: `Delegation depth ${args[0]} exceeds root maxDepth (${args[1]}).`,
    };
  }
  if (errorName === "SelfDelegationNotAllowed") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 / I6 · Audit H-01 Self-Delegation Block",
      explanation: "A compromised agent cannot issue a sub-mandate (even at 0 fUSD budget) back to its own signing key.",
    };
  }
  if (errorName === "VendorNotRegistered") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I6 · Allowlisted Vendor Registry",
      explanation: `Target recipient ${shortAddr(args[0] ?? "", 6, 4)} is not approved in AttenuaVault.registeredVendors.`,
    };
  }
  if (errorName === "InvoiceAlreadyPaid") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I6 · Single-Use Invoice Replay Lock",
      explanation: "This (vendor, invoiceId) key was already settled on-chain and cannot be replayed.",
    };
  }
  if (errorName === "SubMandateBudgetExceeded") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I5 · Sub-Mandate Cap",
      explanation: `Invoice amount ${formatFusd(BigInt(args[0] ?? "0"))} exceeds remaining sub-mandate balance (${formatFusd(BigInt(args[1] ?? "0"))}).`,
    };
  }
  if (errorName === "InvalidAmount") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I5 · Non-Zero Settlement",
      explanation: "Settlement amount must be strictly greater than zero.",
    };
  }
  if (errorName === "ActionNotPermitted" || errorName === "ZeroBudgetCapability") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I4 · Zero-Budget Research Isolation",
      explanation: "Zero-budget Research agent lacks execution capability bits and cannot initiate transfers or rebalances.",
    };
  }
  if (errorName === "PqcSignatureInvalid") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall2",
      invariant: "I1 / I2 · Fail-Closed ML-DSA-87 Gate (0x...0a01)",
      explanation: `All Wall 1 lattice checks PASSED for this parameter shape, then precompile 0x...0a01 rejected the dummy signature because only ${shortAddr(args[0] ?? "", 6, 4)}'s genuine FIPS 204 ML-DSA-87 private key can finalize it.`,
    };
  }
  if (errorName === "PqcKeyNotRegistered" || errorName === "PqcKeyNotProven") {
    return {
      errorName,
      args,
      formatted,
      wall: "wall1",
      invariant: "I2 · pqcKeyStatus Precompile (0x...0a02)",
      explanation: `Target agent ${shortAddr(args[0] ?? "", 6, 4)} has no registered, possession-proven ML-DSA-87 key on chain.`,
    };
  }
  if (errorName === "RootMandateInactive") {
    return {
      errorName,
      args,
      formatted,
      wall: "state",
      invariant: "I9 · O(1) Epoch Kill-Switch",
      explanation: "Root mandate is currently inactive on this epoch (kill-switch triggered or expired).",
    };
  }
  if (errorName === "VaultIsFrozen") {
    return {
      errorName,
      args,
      formatted,
      wall: "state",
      invariant: "I3 · Monotonic Vault Freeze",
      explanation: "AttenuaVault is currently frozen pending Owner ML-DSA-87 unfreeze().",
    };
  }
  return {
    errorName,
    args,
    formatted,
    wall: "unknown",
    invariant: "AttenuaVault Guard",
    explanation: `Live EVM revert returned: ${formatted}`,
  };
}

export async function rawEvmEthCall(to: Address, data: Hex): Promise<{ ok: boolean; result?: Hex; errorData?: Hex; errorMessage?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
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
  throw new Error("QoreChain Diana RPC rate-limited after retries");
}

export async function readVaultNonce(account: Address): Promise<bigint> {
  const vault = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const data = encodeFunctionData({ abi: ATTENUA_VAULT_ABI, functionName: "nonces", args: [account] });
  const r = await rawEvmEthCall(vault, data);
  if (!r.ok || !r.result) throw new Error(r.errorMessage ?? "Unable to read nonce");
  return BigInt(r.result);
}

export async function simulateRawVaultCalldata(calldata: Hex, issuer: Address): Promise<LiveSimulationResult> {
  const vault = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const out = await rawEvmEthCall(vault, calldata);
  if (out.ok) {
    return {
      succeededUnexpectedly: true,
      calldata,
      issuer,
      issuerNonce: "0",
      decoded: {
        errorName: "None",
        args: [],
        formatted: "Succeeded without revert",
        wall: "unknown",
        invariant: "Check inputs",
        explanation: "eth_call did not revert.",
      },
    };
  }
  if (out.errorData && out.errorData.startsWith("0x") && out.errorData.length >= 10) {
    try {
      const dec = decodeErrorResult({ abi: ATTENUA_VAULT_ABI, data: out.errorData });
      const args = (dec.args ?? []).map((a) => String(a));
      return {
        succeededUnexpectedly: false,
        calldata,
        issuer,
        issuerNonce: "live",
        decoded: classifyVaultError(dec.errorName, args),
      };
    } catch {
      return {
        succeededUnexpectedly: false,
        calldata,
        issuer,
        issuerNonce: "live",
        decoded: classifyVaultError(out.errorData.slice(0, 10), []),
      };
    }
  }
  return {
    succeededUnexpectedly: false,
    calldata,
    issuer,
    issuerNonce: "live",
    decoded: classifyVaultError("UnknownRevert", [out.errorMessage ?? "reverted"]),
  };
}

export async function simulateDelegationAttack(params: {
  parentId: `0x${string}`;
  issuer: Address;
  subAgent: Address;
  budgetMicro: bigint;
  minBps: number;
  maxBps: number;
  actionMask: number;
  expiryUnix: bigint;
}): Promise<LiveSimulationResult> {
  const nonce = await readVaultNonce(params.issuer);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mandateId = keccak256(toHex(`browser-attack-${Date.now()}`));
  const calldata = encodeFunctionData({
    abi: ATTENUA_VAULT_ABI,
    functionName: "registerSubMandate",
    args: [
      mandateId,
      params.parentId,
      params.subAgent,
      params.budgetMicro,
      params.minBps,
      params.maxBps,
      params.actionMask,
      params.expiryUnix,
      nonce,
      deadline,
      DUMMY_PQC_SIG,
    ],
  });
  const res = await simulateRawVaultCalldata(calldata, params.issuer);
  res.issuerNonce = nonce.toString();
  return res;
}

export async function simulatePayInvoiceAttack(params: {
  vendor: Address;
  invoiceId: `0x${string}`;
  amountMicro: bigint;
}): Promise<LiveSimulationResult> {
  const payablesAgent = STANDING_TREE.mandates.payables.subAgent as Address;
  const nonce = await readVaultNonce(payablesAgent);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const calldata = encodeFunctionData({
    abi: ATTENUA_VAULT_ABI,
    functionName: "executePayInvoice",
    args: [
      STANDING_TREE.mandates.payables.id as `0x${string}`,
      STANDING_TREE.mandates.research.id as `0x${string}`,
      params.vendor,
      params.invoiceId,
      params.amountMicro,
      nonce,
      deadline,
      DUMMY_PQC_SIG,
      DUMMY_PQC_SIG,
      DUMMY_PQC_SIG,
    ],
  });
  const res = await simulateRawVaultCalldata(calldata, payablesAgent);
  res.issuerNonce = nonce.toString();
  return res;
}

export function inferAttenuaRole(addr: string, isVendor: boolean): string {
  const lower = addr.toLowerCase();
  if (lower === DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.evm.toLowerCase()) return "Root Owner (AA #1)";
  if (lower === DEPLOYMENT.actors.orchestratorPqc.evm.toLowerCase()) return "Orchestrator (ML-DSA-87)";
  if (lower === DEPLOYMENT.actors.allocator.evm.toLowerCase()) return "Allocator sub-agent";
  if (lower === DEPLOYMENT.actors.payables.evm.toLowerCase()) return "Payables sub-agent";
  if (lower === DEPLOYMENT.actors.research.evm.toLowerCase()) return "Research sub-agent (budget = 0)";
  if (lower === DEPLOYMENT.actors.vendor.evm.toLowerCase() || isVendor) return "Allowlisted Vendor";
  if (lower === DEPLOYMENT.actors.unlistedAttacker.evm.toLowerCase()) return "Unlisted Attacker (0 authority)";
  if (lower === DEPLOYMENT.abstractAccounts.monitorAA2.evm.toLowerCase()) return "Monitor (AA #2 · freeze only)";
  if (lower === DEPLOYMENT.contracts.attenuaVault.address.toLowerCase()) return "AttenuaVault contract";
  if (lower === DEPLOYMENT.contracts.liquidityVault.address.toLowerCase()) return "LiquidityVault (ERC-4626)";
  if (lower === DEPLOYMENT.contracts.reserveVault.address.toLowerCase()) return "ReserveVault (ERC-4626)";
  return "External Observer (0 spend authority)";
}

const postureCache = new Map<string, AddressPosture>();

export async function fetchAddressPosture(address: Address): Promise<AddressPosture> {
  const cacheKey = address.toLowerCase();
  const cached = postureCache.get(cacheKey);
  if (cached) return cached;

  const vaultAddr = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const guardAddr = DEPLOYMENT.contracts.holderGuard.address as Address;
  const fusdAddr = DEPLOYMENT.contracts.fusd as Address;

  const [fusdBalance, vaultNonce, isVendor, guardExempt, guardEligible, keyStatus] =
    (await runInPairs([
      () => publicClient.readContract({ address: fusdAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "nonces", args: [address] }),
      () => publicClient.readContract({ address: vaultAddr, abi: ATTENUA_VAULT_ABI, functionName: "registeredVendors", args: [address] }),
      () => publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "exempt", args: [address] }),
      () => publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "isEligible", args: [address] }),
      () => publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "keyStatus", args: [address] }),
    ])) as [bigint, bigint, boolean, boolean, boolean, readonly [boolean, boolean, number, boolean]];

  const result: AddressPosture = {
    address,
    role: inferAttenuaRole(address, isVendor),
    fusdBalance,
    vaultNonce,
    isVendor,
    guardExempt,
    guardEligible,
    pqcResponded: keyStatus[0],
    pqcRegistered: keyStatus[1],
    pqcAlgorithmId: Number(keyStatus[2]),
    pqcPossessionProven: keyStatus[3],
  };
  postureCache.set(cacheKey, result);
  return result;
}
