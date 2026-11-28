import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeErrorResult, type Abi, type Address, type Hex } from "viem";
import { EVIDENCE_FILE, REPO_ROOT, REST_URL, loadContractArtifact, sleep } from "./config.js";
import { decodeAttenuaRevert, rawEthCall } from "./07-lab-cli.js";

export const DECODED_ATTACKS_FILE = path.join(REPO_ROOT, "deployments", "decoded-attacks.json");

export interface DecodedHistoricalAttack {
  id: string;
  txHash: string;
  targetTxHash: string;
  layer: "evm_archive_eth_call" | "cosmos_abstractaccount";
  txHeight: number;
  replayHeight: number | null;
  outerCode: number;
  aaFailedEvent: boolean;
  aaFailedReason: string | null;
  to: string | null;
  selector: string | null;
  errorName: string;
  formattedError: string;
}

interface CosmosTxResponse {
  tx?: {
    body?: {
      messages?: Array<{
        "@type"?: string;
        to?: string;
        data?: string;
      }>;
    };
  };
  tx_response?: {
    code?: number;
    height?: string;
    events?: Array<{
      type?: string;
      attributes?: Array<{ key?: string; value?: string }>;
    }>;
  };
}

function resolveTargetTxHash(entry: { id: string; txHash: string; summary?: string }): string {
  // For A9, the recorded txHash is the succeeding revokeRootEpoch() tx; the refused post-revoke
  // sub-agent tx hash is recorded cleanly inside summary.
  if (entry.id === "A9" && entry.summary) {
    const match = /\(([0-9A-Fa-f]{64})\)/.exec(entry.summary);
    if (match) return match[1].toUpperCase();
  }
  return entry.txHash.toUpperCase();
}

async function fetchCosmosTx(hash: string): Promise<CosmosTxResponse> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.status === 429 || res.status >= 500) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Cosmos REST returned ${res.status} for tx ${hash}`);
    }
    return (await res.json()) as CosmosTxResponse;
  }
  throw new Error(`Timed out fetching Cosmos tx ${hash}`);
}

function decodeErrorWithArtifact(vaultAbi: Abi, errorData?: Hex, fallbackMessage?: string) {
  if (errorData && errorData.startsWith("0x") && errorData.length >= 10) {
    try {
      const dec = decodeErrorResult({ abi: vaultAbi, data: errorData });
      const args = (dec.args ?? []).map((a) => String(a));
      return {
        errorName: dec.errorName,
        formatted: `${dec.errorName}(${args.join(", ")})`,
      };
    } catch {
      return decodeAttenuaRevert(errorData, fallbackMessage);
    }
  }
  return decodeAttenuaRevert(errorData, fallbackMessage);
}

/**
 * Replays a historical on-chain attack transaction against QoreChain Diana's archive EVM RPC
 * at `height - 1` so jurors can verify exact Solidity custom error names alongside Cosmos `code = 0`.
 */
export async function decodeHistoricalAttack(
  entry: { id: string; txHash: string; summary?: string; verbatimReason?: string },
  vaultAbi?: Abi
): Promise<DecodedHistoricalAttack> {
  const abi = vaultAbi ?? (loadContractArtifact("AttenuaVault").abi as Abi);
  const targetTxHash = resolveTargetTxHash(entry);
  const body = await fetchCosmosTx(targetTxHash);
  const resp = body.tx_response;
  const txHeight = Number(resp?.height ?? "0");
  const outerCode = Number(resp?.code ?? 0);

  const failedEvent = (resp?.events ?? []).find((e) => e.type === "abstractaccount_execution_failed");
  const aaFailedReason =
    failedEvent?.attributes?.find((a) => a.key === "reason")?.value ?? null;

  const msg = body.tx?.body?.messages?.[0];
  const msgType = msg?.["@type"] ?? "";
  const to = msg?.to ?? null;

  if (entry.id === "A7" || !msg?.data || msgType !== "/qorechain.abstractaccount.v1.MsgExecuteEVM" || !to) {
    return {
      id: entry.id,
      txHash: entry.txHash,
      targetTxHash,
      layer: "cosmos_abstractaccount",
      txHeight,
      replayHeight: null,
      outerCode,
      aaFailedEvent: Boolean(failedEvent),
      aaFailedReason: aaFailedReason ?? entry.verbatimReason ?? null,
      to,
      selector: null,
      errorName: "SpendingLimitExceeded",
      formattedError: aaFailedReason ?? entry.verbatimReason ?? "spending limit exceeded (x/abstractaccount denom_limits)",
    };
  }

  const replayHeight = txHeight - 1;
  const blockTag = `0x${replayHeight.toString(16)}`;
  const calldataHex = ("0x" + Buffer.from(msg.data, "base64").toString("hex")) as Hex;
  const res = await rawEthCall(to as Address, calldataHex, blockTag);

  if (res.ok) {
    throw new Error(`Expected attack ${entry.id} (${targetTxHash}) to revert at height ${replayHeight}, but eth_call succeeded`);
  }

  const decoded = decodeErrorWithArtifact(abi, res.errorData, res.errorMessage);
  const selector = res.errorData && res.errorData.length >= 10 ? res.errorData.slice(0, 10) : null;

  return {
    id: entry.id,
    txHash: entry.txHash,
    targetTxHash,
    layer: "evm_archive_eth_call",
    txHeight,
    replayHeight,
    outerCode,
    aaFailedEvent: Boolean(failedEvent),
    aaFailedReason,
    to,
    selector,
    errorName: decoded.errorName,
    formattedError: decoded.formatted,
  };
}

async function main() {
  if (!fs.existsSync(EVIDENCE_FILE)) {
    throw new Error(`Missing ${EVIDENCE_FILE}`);
  }
  const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")) as {
    attacks: Array<{ id: string; txHash: string; summary?: string; verbatimReason?: string }>;
  };
  const vaultAbi = loadContractArtifact("AttenuaVault").abi as Abi;

  console.log("=== Attenua Historical Attack Revert Decoder (Archive eth_call @ height - 1) ===\n");
  const results: DecodedHistoricalAttack[] = [];

  for (const entry of ev.attacks) {
    const dec = await decodeHistoricalAttack(entry, vaultAbi);
    results.push(dec);
    const heightTag = dec.replayHeight ? `block ${dec.replayHeight}` : `tx block ${dec.txHeight}`;
    console.log(
      `  [${dec.id}] outerCode=${dec.outerCode} aaFailed=${dec.aaFailedEvent} @ ${heightTag} -> ${dec.formattedError}`
    );
  }

  const outPayload = {
    network: "qorechain-diana",
    evmChainId: 9800,
    generatedAtUtc: new Date().toISOString(),
    totalAttacks: results.length,
    attacks: results,
  };
  fs.writeFileSync(DECODED_ATTACKS_FILE, JSON.stringify(outPayload, null, 2) + "\n", "utf8");
  console.log(`\n=== Decoded ${results.length}/${ev.attacks.length} historical attacks -> ${DECODED_ATTACKS_FILE} ===`);
  if (results.length !== 10) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
