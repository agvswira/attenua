import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ed25519 } from "@noble/curves/ed25519";
import {
  decodeAuthenticatorExecutions,
  deriveUnifiedAccount,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  fetchPqcStatus,
  pqcStatusPublicKey,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { encodeFunctionData, encodePacked, keccak256, parseAbi, toHex, type Address } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT_FILE,
  EVM_CHAIN_ID,
  LIVE_ENV_PATH,
  REPO_ROOT,
  REST_URL,
  SPIKE_ENV_PATH,
  broadcastNative,
  createEvmPublicClient,
  fetchTxRest,
  hexToBytes,
  sleep,
} from "./config.js";
import { runQoreMcpPreflight } from "./qore-mcp-preflight.js";
import { evaluateInvoiceWithLlm } from "./llm-screener.js";
import { signPayInvoice, signResearchClearance, signVendorInvoice } from "./signing.js";
import {
  createRecipientCardForAgent,
  createSignedClearanceVerdict,
  deriveAgentSealKeys,
  sealClearanceOnline,
  unsealAndVerifyClearance,
} from "./authenticated-messaging.js";

const STANDING_TREE_FILE = path.join(REPO_ROOT, "deployments", "standing-tree.json");
export const HEARTBEAT_FILE = path.join(REPO_ROOT, "deployments", "heartbeat.json");
const HEARTBEAT_AMOUNT_MICRO = 10_000n; // 0.01 fUSD micro-settlement within Payables 2.00 fUSD ceiling
const MAX_STORED_RUNS = 30;

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function nonces(address) view returns (uint64)",
  "function usedInvoices(bytes32) view returns (bool)",
  "function subMandates(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
  "function executePayInvoice(bytes32,bytes32,address,bytes32,uint256,uint64,uint64,bytes,bytes,bytes)",
]);

interface HeartbeatRunRecord {
  runId: string;
  timestampUtc: string;
  txHash: string;
  blockHeight: number;
  evmGasUsed: string;
  amountMicro: string;
  invoiceId: `0x${string}`;
  invoiceKey: `0x${string}`;
  vendor: Address;
  screeningMode: "llm" | "mcp_deterministic";
  screeningModel?: string;
  qoreSealEnvelopeBytes: number;
  clearanceShake256: string;
  vaultIdleAfterMicro: string;
  payablesSpentAfterMicro: string;
  payablesBudgetMicro: string;
}

interface HeartbeatFile {
  network: string;
  evmChainId: number;
  vault: Address;
  epoch: number;
  securityModel: string;
  totalRuns: number;
  lastRunUtc: string;
  runs: HeartbeatRunRecord[];
}

function loadSubAgentKeys() {
  const spikeEnv = fs.existsSync(SPIKE_ENV_PATH) ? dotenv.parse(fs.readFileSync(SPIKE_ENV_PATH, "utf8")) : {};
  const swarmEnv = fs.existsSync(LIVE_ENV_PATH) ? dotenv.parse(fs.readFileSync(LIVE_ENV_PATH, "utf8")) : {};

  // Strictly sub-agent / transport keys ONLY — never touches Owner Root key.
  const relayerMnemonic = process.env.ATTENUA_RELAYER_MNEMONIC || spikeEnv.RELAYER_MNEMONIC;
  const orchEdHex = process.env.ATTENUA_ORCH_ED25519_HEX || swarmEnv.LIVE_ORCHESTRATOR_ED25519_PRIV_HEX;
  const payablesMnemonic = process.env.ATTENUA_PAYABLES_MNEMONIC || swarmEnv.PAYABLES_MNEMONIC;
  const researchMnemonic = process.env.ATTENUA_RESEARCH_MNEMONIC || swarmEnv.RESEARCH_MNEMONIC;
  const vendorMnemonic = process.env.ATTENUA_VENDOR_MNEMONIC || swarmEnv.VENDOR_MNEMONIC;

  const missing: string[] = [];
  if (!relayerMnemonic) missing.push("ATTENUA_RELAYER_MNEMONIC");
  if (!orchEdHex) missing.push("ATTENUA_ORCH_ED25519_HEX");
  if (!payablesMnemonic) missing.push("ATTENUA_PAYABLES_MNEMONIC");
  if (!researchMnemonic) missing.push("ATTENUA_RESEARCH_MNEMONIC");
  if (!vendorMnemonic) missing.push("ATTENUA_VENDOR_MNEMONIC");

  if (missing.length > 0) {
    throw new Error(`Missing sub-agent keys (${missing.join(", ")}). Note: Owner Root key is NOT required.`);
  }

  return {
    relayerMnemonic: relayerMnemonic!,
    orchEdPriv: hexToBytes(orchEdHex!),
    payablesMnemonic: payablesMnemonic!,
    researchMnemonic: researchMnemonic!,
    vendorMnemonic: vendorMnemonic!,
  };
}

async function relayCall(params: {
  relayer: UnifiedAccount;
  accountCosmos: string;
  authPriv: Uint8Array;
  to: `0x${string}`;
  data: `0x${string}`;
  evmGasLimit: bigint;
  memo: string;
}) {
  const pub = ed25519.getPublicKey(params.authPriv);
  const { nonce } = await fetchAuthNonce({ rest: REST_URL, address: params.accountCosmos, pubkey: pub });
  const dataBytes = hexToBytes(params.data);
  const digest = evmAuthSignBytesV2({
    chainId: CHAIN_ID,
    account: params.accountCosmos,
    pubkey: pub,
    to: params.to,
    value: "0",
    data: dataBytes,
    nonce,
    gasLimit: params.evmGasLimit,
  });
  const sig = ed25519.sign(digest, params.authPriv);
  const msg = executeEvmMsg({
    relayer: params.relayer.cosmos,
    account: params.accountCosmos,
    scheme: "ed25519",
    pubkey: pub,
    signature: sig,
    to: params.to,
    value: "0",
    data: dataBytes,
    gasLimit: params.evmGasLimit,
    nonce,
  });

  const res = await broadcastNative(params.relayer, [msg], {
    signMode: "hybrid",
    gas: Number(params.evmGasLimit + 700_000n),
    memo: params.memo,
  });
  await sleep(3500);

  const restTx = await fetchTxRest(res.transactionHash);
  const decoded = decodeAuthenticatorExecutions({ msgResponses: res.msgResponses, events: restTx.events }, [msg])[0];
  const failedEv = restTx.events.find((e) => e.type === "abstractaccount_execution_failed");
  const reason =
    failedEv?.attributes.find((a) => a.key === "reason")?.value ?? decoded?.reason ?? decoded?.vmError ?? "";

  return {
    txHash: res.transactionHash,
    blockHeight: Number(restTx.height ?? "0"),
    outerCode: restTx.code,
    failed: Boolean(failedEv) || decoded?.success === false || restTx.code !== 0,
    reason,
    evmGasUsed: (decoded?.gasUsed ?? 0n).toString(),
  };
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE) || !fs.existsSync(STANDING_TREE_FILE)) {
    throw new Error("Expected deployments/qorechain-diana.json and deployments/standing-tree.json");
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const tree = JSON.parse(fs.readFileSync(STANDING_TREE_FILE, "utf8"));

  const vault = dep.contracts.attenuaVault.address as Address;
  const payablesMandateId = tree.mandates.payables.id as `0x${string}`;
  const researchMandateId = tree.mandates.research.id as `0x${string}`;

  const keys = loadSubAgentKeys();
  const [relayer, payables, research, vendor] = await Promise.all([
    deriveUnifiedAccount(keys.relayerMnemonic),
    deriveUnifiedAccount(keys.payablesMnemonic),
    deriveUnifiedAccount(keys.researchMnemonic),
    deriveUnifiedAccount(keys.vendorMnemonic),
  ]);

  console.log("=== Attenua Live Autonomous Sub-Agent Heartbeat (Zero Owner Root Key) ===");
  console.log(`Vault:    ${vault} (${CHAIN_ID})`);
  console.log(`Relayer:  ${relayer.cosmos}`);
  console.log(`Payables: ${payables.cosmos}`);
  console.log(`Research: ${research.cosmos}`);
  console.log(`Vendor:   ${vendor.cosmos}\n`);

  const evm = createEvmPublicClient();
  const [epoch, isFrozen, summary, paySub, payNonce] = await Promise.all([
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "rootEpoch" }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "frozen" }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "portfolioSummary" }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "subMandates", args: [payablesMandateId] }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonces", args: [payables.evm as Address] }),
  ]);

  if (isFrozen) throw new Error("Vault is frozen; aborting heartbeat.");
  const idleFusd = summary[0];
  const payBudget = paySub[3];
  const payAllocated = paySub[4];
  const paySpent = paySub[5];
  const payRemaining = payBudget - paySpent - payAllocated;

  if (idleFusd < HEARTBEAT_AMOUNT_MICRO) {
    throw new Error(`Insufficient idle fUSD in vault: ${idleFusd} < ${HEARTBEAT_AMOUNT_MICRO}`);
  }
  if (payRemaining < HEARTBEAT_AMOUNT_MICRO) {
    throw new Error(`Payables sub-mandate remaining ceiling too low: ${payRemaining} < ${HEARTBEAT_AMOUNT_MICRO}`);
  }

  // 1. Vendor prepares unique invoice & signs ML-DSA-87 invoice terms
  const nowSec = Math.floor(Date.now() / 1000);
  const runId = `HB-${nowSec}`;
  const invoiceId = keccak256(toHex(`ATTENUA-${runId}-${Math.random().toString(36).slice(2, 8)}`));
  const vendorSig = signVendorInvoice({
    chainId: BigInt(EVM_CHAIN_ID),
    vault,
    vendor: vendor.evm as Address,
    invoiceId,
    amount: HEARTBEAT_AMOUNT_MICRO,
    vendorPqcSecret: vendor.pqc.secretKey,
  });

  // 2. Research runs @qorechain/mcp preflight (+ optional live LLM screen if configured) & seals via QoreSign + QoreSeal
  const mcp = await runQoreMcpPreflight({
    ownerCosmos: dep.abstractAccounts.ownerTreasuryAA1.cosmos,
    orchestratorCosmos: dep.actors.orchestratorPqc.cosmos,
    payablesCosmos: payables.cosmos,
    vaultEvm: vault,
  });
  if (mcp.chainId !== CHAIN_ID) {
    throw new Error(`Unexpected MCP chainId: ${mcp.chainId}`);
  }

  let screeningMode: "llm" | "mcp_deterministic" = "mcp_deterministic";
  let screeningModel: string | undefined;
  let screeningSummary = `Verified vendor ${vendor.evm} on @qorechain/mcp (block height ${mcp.blockHeight}), 0.01 fUSD within Payables remaining ceiling ${payRemaining}.`;

  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL && process.env.OPENAI_MODEL) {
    const llmOut = await evaluateInvoiceWithLlm(
      {
        baseUrl: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL,
        timeoutMs: 30_000,
      },
      {
        id: runId,
        category: "Routine Treasury Settlement",
        title: "Periodic PQC Sub-Agent Heartbeat Invoice",
        declaredVendor: vendor.evm as `0x${string}`,
        invoiceId,
        amountMicro: HEARTBEAT_AMOUNT_MICRO.toString(),
        memo: "Routine 0.01 fUSD automated post-quantum treasury verification invoice.",
        description: "Verify allowlisted vendor and confirm amount is within policy cap.",
      },
      {
        allowlistedVendor: vendor.evm,
        perTxCapMicro: payBudget.toString(),
        researchMandateId,
        payablesMandateId,
      }
    );
    if (llmOut.decision !== "PAY" || llmOut.targetVendor.toLowerCase() !== vendor.evm.toLowerCase()) {
      throw new Error(`LLM screener unexpectedly refused routine heartbeat: ${llmOut.reason}`);
    }
    screeningMode = "llm";
    screeningModel = process.env.OPENAI_MODEL;
    screeningSummary = `LLM (${screeningModel}) + @qorechain/mcp approved routine 0.01 fUSD invoice: ${llmOut.reason}`;
  }

  const paySeal = deriveAgentSealKeys(keys.payablesMnemonic);
  const payCard = createRecipientCardForAgent(payables, paySeal, CHAIN_ID);
  const clearanceValidUntil = Math.min(Number(tree.rootMandate.expiryUnix), nowSec + 3600);

  const signedClearance = createSignedClearanceVerdict({
    researchAccount: research,
    payload: {
      schema: "attenua-clearance-v1",
      chainId: CHAIN_ID,
      vault,
      rootEpoch: Number(epoch),
      invoiceId,
      vendor: vendor.evm as `0x${string}`,
      amountMicro: HEARTBEAT_AMOUNT_MICRO.toString(),
      researchMandateId,
      payablesMandateId,
      verdict: "CLEAR",
      screeningSummary,
      validUntil: clearanceValidUntil,
      issuedAt: new Date(nowSec * 1000).toISOString(),
    },
  });

  const sealedEnvelope = await sealClearanceOnline({
    signed: signedClearance,
    recipients: [{ address: payables.cosmos, card: payCard }],
  });

  // 3. Payables opens QoreSeal envelope & verifies Research's on-chain ML-DSA-87 signature before signing payout
  const resPqcStatus = await fetchPqcStatus({ rest: REST_URL, address: research.cosmos });
  const resPqPub = pqcStatusPublicKey(resPqcStatus);
  if (!resPqPub) throw new Error("Research ML-DSA-87 public key missing on Diana");

  const opened = unsealAndVerifyClearance({
    envelopeTextOrBytes: sealedEnvelope.envelopeBytes,
    recipientKeys: paySeal,
    expectedVault: vault,
    expectedEpoch: Number(epoch),
    expectedInvoiceId: invoiceId,
    researchCosmos: research.cosmos,
    researchPqPublicKey: resPqPub,
    nowUnix: nowSec,
  });
  if (opened.signed.payload.verdict !== "CLEAR") {
    throw new Error(`Unexpected verdict from Research: ${opened.signed.payload.verdict}`);
  }

  const deadline = BigInt(nowSec + 1800);
  const paySig = signPayInvoice({
    chainId: BigInt(EVM_CHAIN_ID),
    vault,
    rootEpoch: epoch,
    mandateId: payablesMandateId,
    vendor: vendor.evm as Address,
    invoiceId,
    amount: HEARTBEAT_AMOUNT_MICRO,
    nonce: payNonce,
    deadline,
    payablesPqcSecret: payables.pqc.secretKey,
  });
  const researchOnChainSig = signResearchClearance({
    chainId: BigInt(EVM_CHAIN_ID),
    vault,
    rootEpoch: epoch,
    researchMandateId,
    vendor: vendor.evm as Address,
    invoiceId,
    amount: HEARTBEAT_AMOUNT_MICRO,
    researchPqcSecret: research.pqc.secretKey,
  });

  // 4. Execute atomic 3x ML-DSA-87 invoice settlement on Diana via AA #1
  const calldata = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "executePayInvoice",
    args: [
      payablesMandateId,
      researchMandateId,
      vendor.evm as Address,
      invoiceId,
      HEARTBEAT_AMOUNT_MICRO,
      payNonce,
      deadline,
      paySig,
      vendorSig,
      researchOnChainSig,
    ],
  });

  const txRes = await relayCall({
    relayer,
    accountCosmos: dep.abstractAccounts.ownerTreasuryAA1.cosmos,
    authPriv: keys.orchEdPriv,
    to: vault,
    data: calldata,
    evmGasLimit: 900_000n,
    memo: `attenua: live heartbeat ${runId} (0.01 fUSD 3x ML-DSA-87)`,
  });

  if (txRes.failed) {
    throw new Error(`Heartbeat executePayInvoice reverted: ${txRes.reason}`);
  }

  const invoiceKey = keccak256(encodePacked(["address", "bytes32"], [vendor.evm as Address, invoiceId]));
  const [paidOnChain, summaryAfter, paySubAfter] = await Promise.all([
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "usedInvoices", args: [invoiceKey] }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "portfolioSummary" }),
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "subMandates", args: [payablesMandateId] }),
  ]);

  if (!paidOnChain) {
    throw new Error(`Expected usedInvoices[${invoiceKey}] == true after heartbeat tx ${txRes.txHash}`);
  }

  const prev: HeartbeatFile = fs.existsSync(HEARTBEAT_FILE)
    ? (JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8")) as HeartbeatFile)
    : {
        network: CHAIN_ID,
        evmChainId: EVM_CHAIN_ID,
        vault,
        epoch: Number(epoch),
        securityModel: "Zero Owner Root key in runner; sub-agent Payables/Research/Vendor + AA#1 transport only",
        totalRuns: 0,
        lastRunUtc: new Date(nowSec * 1000).toISOString(),
        runs: [],
      };

  const record: HeartbeatRunRecord = {
    runId,
    timestampUtc: new Date(nowSec * 1000).toISOString(),
    txHash: txRes.txHash,
    blockHeight: txRes.blockHeight,
    evmGasUsed: txRes.evmGasUsed,
    amountMicro: HEARTBEAT_AMOUNT_MICRO.toString(),
    invoiceId,
    invoiceKey,
    vendor: vendor.evm as Address,
    screeningMode,
    ...(screeningModel ? { screeningModel } : {}),
    qoreSealEnvelopeBytes: sealedEnvelope.envelopeBytes.length,
    clearanceShake256: opened.verifiedShake256Digest,
    vaultIdleAfterMicro: summaryAfter[0].toString(),
    payablesSpentAfterMicro: paySubAfter[5].toString(),
    payablesBudgetMicro: paySubAfter[3].toString(),
  };

  const nextFile: HeartbeatFile = {
    network: CHAIN_ID,
    evmChainId: EVM_CHAIN_ID,
    vault,
    epoch: Number(epoch),
    securityModel: "Zero Owner Root key in runner; sub-agent Payables/Research/Vendor + AA#1 transport only",
    totalRuns: prev.totalRuns + 1,
    lastRunUtc: record.timestampUtc,
    runs: [record, ...prev.runs].slice(0, MAX_STORED_RUNS),
  };

  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(nextFile, null, 2) + "\n", "utf8");

  console.log(`\n[PASS] Live 0.01 fUSD heartbeat settled on-chain!`);
  console.log(`       Tx Hash:       ${record.txHash}`);
  console.log(`       Block Height:  ${record.blockHeight}`);
  console.log(`       EVM Gas Used:  ${record.evmGasUsed}`);
  console.log(`       Invoice Key:   ${record.invoiceKey}`);
  console.log(`       Payables Spent: ${record.payablesSpentAfterMicro} / ${record.payablesBudgetMicro} micro-fUSD`);
  console.log(`       Saved Log:     ${HEARTBEAT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
