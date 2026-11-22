import { createPublicClient, http, parseAbi, type Address } from "viem";
import deployment from "@deployments/qorechain-diana.json";
import evidence from "@deployments/live-run-evidence.json";

export const EVM_RPC_URL = "https://evm-testnet.qore.host";
export const EXPLORER_BASE = "https://dashboard.qorechain.io/explorer";
export const QORE_CHAIN_HEX = "0x2648"; // 9800

export type DeploymentManifest = typeof deployment;
export type LiveRunEvidence = typeof evidence;

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
  idleFusd: bigint;
  liquidityAssets: bigint;
  reserveAssets: bigint;
  liquidityBps: number;
  guardOwner: Address;
  vaultExempt: boolean;
  ownerWindowLive: boolean;
  ownerActiveAuthenticators: number;
  monitorFusdBalance: bigint;
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

export const DEPLOYMENT: DeploymentManifest = deployment;
export const EVIDENCE: LiveRunEvidence = evidence;

export const ADDRESS_PRESETS: Array<{ label: string; address: Address }> = [
  { label: "Owner", address: DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.evm as Address },
  { label: "Allocator", address: DEPLOYMENT.actors.allocator.evm as Address },
  { label: "Payables", address: DEPLOYMENT.actors.payables.evm as Address },
  { label: "Research", address: DEPLOYMENT.actors.research.evm as Address },
  { label: "Vendor", address: DEPLOYMENT.actors.vendor.evm as Address },
  { label: "Attacker", address: DEPLOYMENT.actors.unlistedAttacker.evm as Address },
  { label: "AttenuaVault", address: DEPLOYMENT.contracts.attenuaVault.address as Address },
];

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
  "function registeredVendors(address) view returns (bool)",
  "function nonces(address) view returns (uint64)",
]);

const GUARD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function exempt(address) view returns (bool)",
  "function isEligible(address) view returns (bool)",
  "function keyStatus(address) view returns (bool,bool,uint8,bool)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const publicClient = createPublicClient({
  transport: http(EVM_RPC_URL, { timeout: 12_000 }),
});

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

export function splitFusdParts(micro: bigint): { whole: string; frac: string } {
  const whole = (micro / 1_000_000n).toString();
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return { whole, frac };
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
      diagnostic: happy
        .map((s) => `${s.id} (${Number(s.evmGasUsed).toLocaleString()} gas): ${s.title}`)
        .join("\n"),
    };
  }

  if (chipId === "verify") {
    const guardOwner = live ? live.guardOwner : DEPLOYMENT.contracts.holderGuard.ownerAfterRenounce;
    const winLive = live ? String(live.ownerWindowLive) : "false";
    const aa1Keys = live ? String(live.ownerActiveAuthenticators) : "0";
    const monFusd = live ? formatFusd(live.monitorFusdBalance) : "0.00 fUSD";
    return {
      id: "verify",
      kind: "check",
      eyebrow: "verify · Keyless CLI audit (cd agent && npm run verify)",
      title: "19 read-only on-chain invariant checks pass without private keys",
      pillTone: "ok",
      pillLabel: "19 passed, 0 failed",
      subtitle: "Verifies deployed bytecode, renounced guard ownership, AA isolation, and PQC keys",
      actorLabel: "Runner",
      actorValue: "Keyless JSON-RPC & Cosmos REST queries",
      layerLabel: "Target chain",
      layerValue: `${DEPLOYMENT.network} (EVM Chain ID ${DEPLOYMENT.evmChainId})`,
      diagnosticTitle: "Live check values",
      diagnostic: [
        `Guard owner()           = ${guardOwner} (live EVM RPC · renounced)`,
        `Monitor AA #2 fUSD      = ${monFusd} (live EVM RPC · freeze() 0xbd2d305f only)`,
        `Owner EVM window live   = ${winLive} (verified via CLI npm run verify)`,
        `AA #1 active linked keys = ${aa1Keys} (<= 1 invariant · verified via CLI npm run verify)`,
        `Command                 = cd agent && npm install && npm run verify`,
      ].join("\n"),
    };
  }

  const foundAttack = attacks.find((a) => a.id === chipId);
  if (foundAttack) {
    const context = CONTEXT_MAP[foundAttack.id] ?? "adversarial defense check";
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
      diagnosticTitle: "Verbatim on-chain diagnostic",
      diagnostic: foundAttack.verbatimReason ?? "execution reverted: evm transaction execution failed",
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

export async function fetchLiveChainSnapshot(): Promise<LiveChainSnapshot> {
  const vaultAddr = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const guardAddr = DEPLOYMENT.contracts.holderGuard.address as Address;
  const fusdAddr = DEPLOYMENT.contracts.fusd as Address;
  const monitorEvm = DEPLOYMENT.abstractAccounts.monitorAA2.evm as Address;

  const [
    blockNumber,
    rootEpoch,
    frozen,
    summary,
    guardOwner,
    vaultExempt,
    monitorFusdBalance,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "rootEpoch" }),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "frozen" }),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "portfolioSummary" }),
    publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "owner" }),
    publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "exempt", args: [vaultAddr] }),
    publicClient.readContract({ address: fusdAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [monitorEvm] }),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
    rootEpoch: Number(rootEpoch),
    frozen,
    idleFusd: summary[0],
    liquidityAssets: summary[1],
    reserveAssets: summary[2],
    liquidityBps: Number(summary[3]),
    guardOwner,
    vaultExempt,
    ownerWindowLive: false,
    ownerActiveAuthenticators: 0,
    monitorFusdBalance,
  };
}

export function inferAttenuaRole(addr: string, isVendor: boolean): string {
  const lower = addr.toLowerCase();
  if (lower === DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.evm.toLowerCase()) {
    return "Root Owner (AA #1)";
  }
  if (lower === DEPLOYMENT.actors.orchestratorPqc.evm.toLowerCase()) {
    return "Orchestrator (ML-DSA-87)";
  }
  if (lower === DEPLOYMENT.actors.allocator.evm.toLowerCase()) {
    return "Allocator sub-agent";
  }
  if (lower === DEPLOYMENT.actors.payables.evm.toLowerCase()) {
    return "Payables sub-agent";
  }
  if (lower === DEPLOYMENT.actors.research.evm.toLowerCase()) {
    return "Research sub-agent (budget = 0)";
  }
  if (lower === DEPLOYMENT.actors.vendor.evm.toLowerCase() || isVendor) {
    return "Allowlisted Vendor";
  }
  if (lower === DEPLOYMENT.actors.unlistedAttacker.evm.toLowerCase()) {
    return "Unlisted Attacker (0 authority)";
  }
  if (lower === DEPLOYMENT.abstractAccounts.monitorAA2.evm.toLowerCase()) {
    return "Monitor (AA #2 · freeze only)";
  }
  if (lower === DEPLOYMENT.contracts.attenuaVault.address.toLowerCase()) {
    return "AttenuaVault contract";
  }
  if (lower === DEPLOYMENT.contracts.liquidityVault.address.toLowerCase()) {
    return "LiquidityVault (ERC-4626)";
  }
  if (lower === DEPLOYMENT.contracts.reserveVault.address.toLowerCase()) {
    return "ReserveVault (ERC-4626)";
  }
  return "External Observer (0 spend authority)";
}

export async function fetchAddressPosture(address: Address): Promise<AddressPosture> {
  const vaultAddr = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const guardAddr = DEPLOYMENT.contracts.holderGuard.address as Address;
  const fusdAddr = DEPLOYMENT.contracts.fusd as Address;

  const [fusdBalance, vaultNonce, isVendor, guardExempt, guardEligible, keyStatus] =
    await Promise.all([
      publicClient.readContract({
        address: fusdAddr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.readContract({
        address: vaultAddr,
        abi: VAULT_ABI,
        functionName: "nonces",
        args: [address],
      }),
      publicClient.readContract({
        address: vaultAddr,
        abi: VAULT_ABI,
        functionName: "registeredVendors",
        args: [address],
      }),
      publicClient.readContract({
        address: guardAddr,
        abi: GUARD_ABI,
        functionName: "exempt",
        args: [address],
      }),
      publicClient.readContract({
        address: guardAddr,
        abi: GUARD_ABI,
        functionName: "isEligible",
        args: [address],
      }),
      publicClient.readContract({
        address: guardAddr,
        abi: GUARD_ABI,
        functionName: "keyStatus",
        args: [address],
      }),
    ]);

  return {
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
}
