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
  getNetwork,
  qorechainRegistry,
  type EncodeObject,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const NETWORK = getNetwork("testnet");
export const CHAIN_ID = NETWORK.chainId; // "qorechain-diana"
export const EVM_CHAIN_ID = NETWORK.evmChainId ?? 9800;
export const REST_URL = NETWORK.endpoints.rest;
export const RPC_URL = NETWORK.endpoints.rpc;
export const EVM_RPC_URL = NETWORK.endpoints.evmRpc;

// Official Diana testnet fUSD ERC-20 token address (from build.qorechain.io/faq)
export const FUSD_EVM_ADDRESS = "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as const;
export const FUSD_RULE_DENOM = `erc20/${FUSD_EVM_ADDRESS}`;
export const FUSD_BANK_DENOM = `erc20:${FUSD_EVM_ADDRESS}`;

// Throwaway spike keys live OUTSIDE the git repository
export const STATE_DIR = process.env.ATTENUA_SPIKE_DIR ?? path.join(os.homedir(), ".config", "attenua-spike");
export const ENV_PATH = path.join(STATE_DIR, "spike.env");
export const DEPLOY_PATH = path.join(STATE_DIR, "deployment.json");
export const ARTIFACT_PATH = path.resolve(import.meta.dirname, "..", "out", "SpikeProbe.json");
export const REPORT_PATH = path.resolve(import.meta.dirname, "..", "..", "docs", "SPIKE_RESULTS.md");

export const dianaChain = defineChain({
  id: EVM_CHAIN_ID,
  name: "QoreChain Diana Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC_URL] } },
});

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

export interface SpikeEnv {
  OWNER_MNEMONIC: string;
  MONITOR_ACCOUNT_MNEMONIC: string;
  RELAYER_MNEMONIC: string;
  SIGNER2_MNEMONIC: string;
  SIGNER3_MNEMONIC: string;
  ORCHESTRATOR_ED25519_PRIV_HEX: string;
  MONITOR_ED25519_PRIV_HEX: string;
}

export interface SpikeAccounts {
  owner: UnifiedAccount;
  monitorAccount: UnifiedAccount;
  relayer: UnifiedAccount;
  signer2: UnifiedAccount;
  signer3: UnifiedAccount;
  orchestratorEdPriv: Uint8Array;
  monitorEdPriv: Uint8Array;
}

export function loadSpikeEnv(): SpikeEnv {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Spike keys not found at ${ENV_PATH}. Run "npm run init" first.`);
  }
  const parsed = dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
  const required: (keyof SpikeEnv)[] = [
    "OWNER_MNEMONIC",
    "MONITOR_ACCOUNT_MNEMONIC",
    "RELAYER_MNEMONIC",
    "SIGNER2_MNEMONIC",
    "SIGNER3_MNEMONIC",
    "ORCHESTRATOR_ED25519_PRIV_HEX",
    "MONITOR_ED25519_PRIV_HEX",
  ];
  for (const k of required) {
    if (!parsed[k]) throw new Error(`Missing ${k} in ${ENV_PATH}`);
  }
  return parsed as unknown as SpikeEnv;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export async function loadSpikeAccounts(): Promise<SpikeAccounts> {
  const env = loadSpikeEnv();
  const [owner, monitorAccount, relayer, signer2, signer3] = await Promise.all([
    deriveUnifiedAccount(env.OWNER_MNEMONIC),
    deriveUnifiedAccount(env.MONITOR_ACCOUNT_MNEMONIC),
    deriveUnifiedAccount(env.RELAYER_MNEMONIC),
    deriveUnifiedAccount(env.SIGNER2_MNEMONIC),
    deriveUnifiedAccount(env.SIGNER3_MNEMONIC),
  ]);
  return {
    owner,
    monitorAccount,
    relayer,
    signer2,
    signer3,
    orchestratorEdPriv: hexToBytes(env.ORCHESTRATOR_ED25519_PRIV_HEX),
    monitorEdPriv: hexToBytes(env.MONITOR_ED25519_PRIV_HEX),
  };
}

export function createEvmPublicClient() {
  return createPublicClient({ chain: dianaChain, transport: http(EVM_RPC_URL) });
}

export function createEvmWalletClient(privateKeyHex: string) {
  const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  return createWalletClient({ account, chain: dianaChain, transport: http(EVM_RPC_URL) });
}

export async function fetchAuthNumbers(cosmosAddress: string): Promise<{
  accountNumber: bigint;
  sequence: bigint;
}> {
  const res = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${cosmosAddress}`);
  if (!res.ok) {
    throw new Error(`Account ${cosmosAddress} not found on chain (${res.status}): fund it with test QOR first.`);
  }
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

export async function fetchBankBalances(cosmosAddress: string): Promise<Array<{ denom: string; amount: string }>> {
  const res = await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${cosmosAddress}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { balances?: Array<{ denom: string; amount: string }> };
  return data.balances ?? [];
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

const MSG_CONVERT_COIN_TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertCoin";

interface MsgConvertCoinVal {
  coin: { denom: string; amount: string };
  receiver: string;
  sender: string;
}

const MsgConvertCoinCodec = {
  encode(msg: MsgConvertCoinVal, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
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
  decode(): MsgConvertCoinVal {
    return { coin: { denom: "", amount: "" }, receiver: "", sender: "" };
  },
  fromPartial(obj: Partial<MsgConvertCoinVal>): MsgConvertCoinVal {
    return {
      coin: obj.coin ?? { denom: "", amount: "" },
      receiver: obj.receiver ?? "",
      sender: obj.sender ?? "",
    };
  },
};

export function convertCoinMsg(senderCosmos: string, receiverEvm: string, denom: string, amount: string): EncodeObject {
  return {
    typeUrl: MSG_CONVERT_COIN_TYPE_URL,
    value: { coin: { denom, amount }, receiver: receiverEvm, sender: senderCosmos },
  };
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
    const signer = new EthNativeSigner(account, {
      registry,
      signMode,
      rest: REST_URL,
    });
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

export async function fetchTxRest(txHash: string): Promise<{
  code: number;
  gasUsed: string;
  gasWanted: string;
  rawLog: string;
  events: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
}> {
  const url = `${REST_URL}/cosmos/tx/v1beta1/txs/${txHash}`;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as {
        tx_response?: {
          code?: number;
          gas_used?: string;
          gas_wanted?: string;
          raw_log?: string;
          events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
        };
      };
      const tr = body.tx_response;
      if (tr) {
        return {
          code: tr.code ?? 0,
          gasUsed: tr.gas_used ?? "0",
          gasWanted: tr.gas_wanted ?? "0",
          rawLog: tr.raw_log ?? "",
          events: tr.events ?? [],
        };
      }
    }
    await sleep(1500);
  }
  throw new Error(`Timed out reading tx ${txHash} from REST`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadProbeArtifact(): {
  compiler: string;
  abi: unknown[];
  bytecode: `0x${string}`;
  methodIdentifiers: Record<string, string>;
} {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(`Compiled artifact missing at ${ARTIFACT_PATH}. Run "npm run compile" first.`);
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
}
