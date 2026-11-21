import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  calculateFee,
  deriveUnifiedAccount,
  generateMnemonic,
  getNetwork,
  qorechainRegistry,
  type EncodeObject,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const NETWORK = getNetwork("testnet");
export const CHAIN_ID = NETWORK.chainId; // qorechain-diana
export const EVM_CHAIN_ID = NETWORK.evmChainId ?? 9800;
export const REST_URL = NETWORK.endpoints.rest;
export const RPC_URL = NETWORK.endpoints.rpc;
export const EVM_RPC_URL = NETWORK.endpoints.evmRpc;

export const FUSD_EVM_ADDRESS = "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as const;
export const FUSD_RULE_DENOM = `erc20/${FUSD_EVM_ADDRESS}`;
export const FUSD_BANK_DENOM = `erc20:${FUSD_EVM_ADDRESS}`;

export const SPIKE_ENV_PATH = path.join(os.homedir(), ".config", "attenua-spike", "spike.env");
export const LIVE_DIR = path.join(os.homedir(), ".config", "attenua-live");
export const LIVE_ENV_PATH = path.join(LIVE_DIR, "swarm.env");

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CONTRACTS_OUT = path.join(REPO_ROOT, "contracts", "out");
export const DEPLOYMENT_FILE = path.join(REPO_ROOT, "deployments", "qorechain-diana.json");
export const EVIDENCE_FILE = path.join(REPO_ROOT, "deployments", "live-run-evidence.json");

export const dianaChain = defineChain({
  id: EVM_CHAIN_ID,
  name: "QoreChain Diana Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC_URL] } },
});

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createEvmPublicClient() {
  return createPublicClient({ chain: dianaChain, transport: http(EVM_RPC_URL) });
}

export function createEvmWalletClient(privateKeyHex: string) {
  const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  return createWalletClient({ account, chain: dianaChain, transport: http(EVM_RPC_URL) });
}

export interface SwarmAccounts {
  owner: UnifiedAccount;
  monitorAccount: UnifiedAccount;
  relayer: UnifiedAccount;
  orchestratorPqc: UnifiedAccount;
  allocator: UnifiedAccount;
  payables: UnifiedAccount;
  research: UnifiedAccount;
  vendor: UnifiedAccount;
  unlistedAttacker: UnifiedAccount;
  orchestratorEdPriv: Uint8Array;
  monitorEdPriv: Uint8Array;
}

export async function loadOrCreateSwarmAccounts(): Promise<SwarmAccounts> {
  if (!fs.existsSync(SPIKE_ENV_PATH)) {
    throw new Error(`Expected funded spike keys at ${SPIKE_ENV_PATH}. Run Step 0 spike first.`);
  }
  const base = dotenv.parse(fs.readFileSync(SPIKE_ENV_PATH, "utf8"));

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  let extra: Record<string, string>;
  if (!fs.existsSync(LIVE_ENV_PATH)) {
    extra = {
      ORCHESTRATOR_PQC_MNEMONIC: generateMnemonic(128),
      ALLOCATOR_MNEMONIC: generateMnemonic(128),
      PAYABLES_MNEMONIC: generateMnemonic(128),
      RESEARCH_MNEMONIC: generateMnemonic(128),
      VENDOR_MNEMONIC: generateMnemonic(128),
      ATTACKER_MNEMONIC: generateMnemonic(128),
      LIVE_ORCHESTRATOR_ED25519_PRIV_HEX: crypto.randomBytes(32).toString("hex"),
      LIVE_MONITOR_ED25519_PRIV_HEX: crypto.randomBytes(32).toString("hex"),
    };
    const lines = [
      "# Throwaway qorechain-diana testnet keys ONLY. NEVER fund on mainnet. NEVER commit.",
      ...Object.entries(extra).map(([k, v]) => (k.includes("MNEMONIC") ? `${k}="${v}"` : `${k}=${v}`)),
      "",
    ];
    fs.writeFileSync(LIVE_ENV_PATH, lines.join("\n"), { mode: 0o600 });
    console.log(`[KEYS] Created throwaway swarm keys outside repo at ${LIVE_ENV_PATH}`);
  } else {
    extra = dotenv.parse(fs.readFileSync(LIVE_ENV_PATH, "utf8"));
  }

  const [
    owner,
    monitorAccount,
    relayer,
    orchestratorPqc,
    allocator,
    payables,
    research,
    vendor,
    unlistedAttacker,
  ] = await Promise.all([
    deriveUnifiedAccount(base.OWNER_MNEMONIC),
    deriveUnifiedAccount(base.MONITOR_ACCOUNT_MNEMONIC),
    deriveUnifiedAccount(base.RELAYER_MNEMONIC),
    deriveUnifiedAccount(extra.ORCHESTRATOR_PQC_MNEMONIC),
    deriveUnifiedAccount(extra.ALLOCATOR_MNEMONIC),
    deriveUnifiedAccount(extra.PAYABLES_MNEMONIC),
    deriveUnifiedAccount(extra.RESEARCH_MNEMONIC),
    deriveUnifiedAccount(extra.VENDOR_MNEMONIC),
    deriveUnifiedAccount(extra.ATTACKER_MNEMONIC),
  ]);

  return {
    owner,
    monitorAccount,
    relayer,
    orchestratorPqc,
    allocator,
    payables,
    research,
    vendor,
    unlistedAttacker,
    orchestratorEdPriv: hexToBytes(extra.LIVE_ORCHESTRATOR_ED25519_PRIV_HEX),
    monitorEdPriv: hexToBytes(extra.LIVE_MONITOR_ED25519_PRIV_HEX),
  };
}

export async function fetchAuthNumbers(cosmosAddress: string): Promise<{
  accountNumber: bigint;
  sequence: bigint;
}> {
  const res = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${cosmosAddress}`);
  if (!res.ok) throw new Error(`Account ${cosmosAddress} not found (${res.status})`);
  const data = (await res.json()) as {
    account?: {
      account_number?: string;
      sequence?: string;
      base_account?: { account_number?: string; sequence?: string };
    };
  };
  const base = data.account?.base_account ?? data.account;
  return {
    accountNumber: BigInt(base?.account_number ?? "0"),
    sequence: BigInt(base?.sequence ?? "0"),
  };
}

export async function fetchUqorBalance(cosmosAddress: string): Promise<bigint> {
  const res = await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${cosmosAddress}/by_denom?denom=uqor`);
  if (!res.ok) return 0n;
  const data = (await res.json()) as { balance?: { amount?: string } };
  return BigInt(data.balance?.amount ?? "0");
}

const MSG_CONVERT_COIN_TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertCoin";
const MsgConvertCoinCodec = {
  encode(msg: { coin: { denom: string; amount: string }; receiver: string; sender: string }, writer = new BinaryWriter()) {
    if (msg.coin) {
      const cw = new BinaryWriter();
      if (msg.coin.denom) cw.tag(1, 2).string(msg.coin.denom);
      if (msg.coin.amount) cw.tag(2, 2).string(msg.coin.amount);
      writer.tag(1, 2).bytes(cw.finish());
    }
    if (msg.receiver) writer.tag(2, 2).string(msg.receiver);
    if (msg.sender) writer.tag(3, 2).string(msg.sender);
    return writer;
  },
  decode() {
    return { coin: { denom: "", amount: "" }, receiver: "", sender: "" };
  },
  fromPartial(obj: Record<string, unknown>) {
    return obj;
  },
};

export function convertCoinMsg(senderCosmos: string, receiverEvm: string, denom: string, amount: string): EncodeObject {
  return {
    typeUrl: MSG_CONVERT_COIN_TYPE_URL,
    value: { coin: { denom, amount }, receiver: receiverEvm, sender: senderCosmos },
  };
}

export interface NativeBroadcastOut {
  transactionHash: string;
  code: number;
  height?: number;
  gasUsed?: bigint;
  gasWanted?: bigint;
  rawLog?: string;
  events?: ReadonlyArray<{ type: string; attributes: ReadonlyArray<{ key: string; value: string }> }>;
  msgResponses?: ReadonlyArray<{ typeUrl: string; value: Uint8Array }>;
}

export async function broadcastNative(
  account: UnifiedAccount,
  messages: readonly EncodeObject[],
  opts?: { signMode?: "hybrid" | "classical"; gas?: number; memo?: string }
): Promise<NativeBroadcastOut> {
  const signMode = opts?.signMode ?? "hybrid";
  const gas = opts?.gas ?? 500_000;
  const fee = calculateFee(gas, "0.2uqor");
  const { accountNumber, sequence } = await fetchAuthNumbers(account.cosmos);

  const client = await StargateClient.connect(RPC_URL);
  try {
    const registry = qorechainRegistry([[MSG_CONVERT_COIN_TYPE_URL, MsgConvertCoinCodec as never]]);
    const signer = new EthNativeSigner(account, { registry, signMode, rest: REST_URL });
    const res = await signer.signAndBroadcast(client, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      messages,
      fee,
      memo: opts?.memo ?? "",
    });
    return res as NativeBroadcastOut;
  } finally {
    client.disconnect();
  }
}

export async function fetchTxRest(txHash: string) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs/${txHash}`);
    if (res.ok) {
      const body = (await res.json()) as {
        tx_response?: {
          code?: number;
          height?: string;
          gas_used?: string;
          gas_wanted?: string;
          raw_log?: string;
          events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
        };
      };
      if (body.tx_response) {
        return {
          code: body.tx_response.code ?? 0,
          height: body.tx_response.height ?? "0",
          gasUsed: body.tx_response.gas_used ?? "0",
          gasWanted: body.tx_response.gas_wanted ?? "0",
          rawLog: body.tx_response.raw_log ?? "",
          events: body.tx_response.events ?? [],
        };
      }
    }
    await sleep(1500);
  }
  throw new Error(`Timed out fetching tx ${txHash}`);
}

export function loadContractArtifact(name: "AttenuaVault" | "QoreChainHybridHolderGuard" | "QoreChainRwaVault") {
  const p = path.join(CONTRACTS_OUT, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as {
    contractName: string;
    compiler: string;
    abi: unknown[];
    bytecode: `0x${string}`;
    deployedBytecode: `0x${string}`;
    bytecodeHash: `0x${string}`;
    methodIdentifiers: Record<string, string>;
  };
}
