import { createPublicClient, http, parseAbi, type Address } from "viem";
import deployment from "@deployments/qorechain-diana.json";
import evidence from "@deployments/live-run-evidence.json";

export const EVM_RPC_URL = "https://evm-diana.qorechain.io";
export const REST_URL = "https://rest-diana.qorechain.io";
export const EXPLORER_BASE = "https://dashboard.qorechain.io/explorer";

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
  error?: string;
}

export const DEPLOYMENT: DeploymentManifest = deployment;
export const EVIDENCE: LiveRunEvidence = evidence;

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
]);

const GUARD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function exempt(address) view returns (bool)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const publicClient = createPublicClient({
  transport: http(EVM_RPC_URL, { timeout: 12_000 }),
});

export function formatFusd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac} fUSD`;
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

export async function fetchLiveChainSnapshot(): Promise<LiveChainSnapshot> {
  const vaultAddr = DEPLOYMENT.contracts.attenuaVault.address as Address;
  const guardAddr = DEPLOYMENT.contracts.holderGuard.address as Address;
  const fusdAddr = DEPLOYMENT.contracts.fusd as Address;
  const monitorEvm = DEPLOYMENT.abstractAccounts.monitorAA2.evm as Address;
  const ownerCosmos = DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.cosmos;

  const [
    blockNumber,
    rootEpoch,
    frozen,
    summary,
    guardOwner,
    vaultExempt,
    monitorFusdBalance,
    windowRes,
    authRes,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "rootEpoch" }),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "frozen" }),
    publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "portfolioSummary" }),
    publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "owner" }),
    publicClient.readContract({ address: guardAddr, abi: GUARD_ABI, functionName: "exempt", args: [vaultAddr] }),
    publicClient.readContract({ address: fusdAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [monitorEvm] }),
    fetch(`${REST_URL}/qorechain/pqc/v1/evm_window/${ownerCosmos}`).then((r) => r.json()) as Promise<{
      live?: boolean;
    }>,
    fetch(`${REST_URL}/qorechain/abstractaccount/v1/account/${ownerCosmos}/authenticators`).then((r) =>
      r.json(),
    ) as Promise<{
      authenticators?: Array<{ active?: boolean }>;
    }>,
  ]);

  const activeAuthenticators = (authRes.authenticators ?? []).filter((a) => a.active).length;

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
    ownerWindowLive: Boolean(windowRes.live),
    ownerActiveAuthenticators: activeAuthenticators,
    monitorFusdBalance,
  };
}
