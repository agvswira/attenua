import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  decodeAuthenticatorExecutions,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  registerAuthenticatorMsg,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { encodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT_FILE,
  ERC20_ABI,
  EVIDENCE_FILE,
  EVM_CHAIN_ID,
  FUSD_EVM_ADDRESS,
  REST_URL,
  broadcastNative,
  createEvmPublicClient,
  fetchTxRest,
  hexToBytes,
  loadOrCreateSwarmAccounts,
  sleep,
} from "./config.js";
import {
  signAllocate,
  signMonitorFreeze,
  signPayInvoice,
  signReclaimSubMandate,
  signResearchClearance,
  signRevokeRootEpoch,
  signSetRootMandate,
  signSetVendor,
  signSubMandate,
  signUnfreeze,
  signVendorInvoice,
} from "./signing.js";

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function monitorNonce() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function nonces(address) view returns (uint64)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
  "function setRootMandate(address,uint256,uint16,uint16,uint8,uint8,uint64,uint64,uint64,bytes)",
  "function setVendor(address,bool,uint64,uint64,bytes)",
  "function registerSubMandate(bytes32,bytes32,address,uint256,uint16,uint16,uint8,uint64,uint64,uint64,bytes)",
  "function reclaimSubMandate(bytes32,uint64,uint64,bytes)",
  "function executeAllocate(bytes32,uint256,bool,uint256,bool,uint64,uint64,bytes)",
  "function executePayInvoice(bytes32,bytes32,address,bytes32,uint256,uint64,uint64,bytes,bytes,bytes)",
  "function freeze(uint64,uint64,bytes)",
  "function unfreeze(uint64,uint64,bytes)",
  "function revokeRootEpoch(uint64,uint64,bytes)",
]);

interface EvidenceItem {
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
  await sleep(3000);

  const restTx = await fetchTxRest(res.transactionHash);
  const decoded = decodeAuthenticatorExecutions({ msgResponses: res.msgResponses, events: restTx.events }, [msg])[0];
  const failedEv = restTx.events.find((e) => e.type === "abstractaccount_execution_failed");
  const reason =
    failedEv?.attributes.find((a) => a.key === "reason")?.value ?? decoded?.reason ?? decoded?.vmError ?? "";

  return {
    txHash: res.transactionHash,
    outerCode: restTx.code,
    failed: Boolean(failedEv) || decoded?.success === false || restTx.code !== 0,
    evmGasUsed: (decoded?.gasUsed ?? 0n).toString(),
    reason,
  };
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Missing ${DEPLOYMENT_FILE}. Run "npm run deploy" first.`);
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const vault = dep.contracts.attenuaVault.address as `0x${string}`;
  const acc = await loadOrCreateSwarmAccounts();
  const evm = createEvmPublicClient();
  const chainId = BigInt(EVM_CHAIN_ID);
  const oneFusd = 1_000_000n; // 6 decimals
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const rootExpiry = now + 7n * 24n * 3600n;
  const childExpiry = now + 3n * 24n * 3600n;

  const happyPath: EvidenceItem[] = [];
  const attacks: EvidenceItem[] = [];

  const getNonce = (addr: `0x${string}`) =>
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonces", args: [addr] });
  const getEpoch = () =>
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "rootEpoch" });
  const getMonitorNonce = () =>
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "monitorNonce" });

  console.log(`=== Attenua Live Swarm + 9-Attack Suite on ${CHAIN_ID} ===`);
  console.log(`AttenuaVault: ${vault}\n`);

  // Ensure AA #1 has Orchestrator linked (e.g. if a previous run ended with A9 revoke)
  {
    const authRes = await fetch(
      `${REST_URL}/qorechain/abstractaccount/v1/account/${acc.owner.cosmos}/authenticators`,
    );
    const authJson = (await authRes.json()) as {
      authenticators?: Array<{ id?: string; active?: boolean }>;
    };
    const activeAuths = (authJson.authenticators ?? []).filter((a) => a.active);
    if (activeAuths.length === 0) {
      console.log("[Pre-flight] AA #1 has 0 active authenticators (revoked in prior run); re-linking Orchestrator...");
      const orchProof = signAuthenticatorLinkEd25519({
        chainId: CHAIN_ID,
        account: acc.owner.cosmos,
        privateKey: acc.orchestratorEdPriv,
      });
      const regMsg = registerAuthenticatorMsg({
        owner: acc.owner.cosmos,
        account: acc.owner.cosmos,
        scheme: "ed25519",
        pubkey: orchProof.pubkey,
        permissions: ["evm"],
        expiryUnix: Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
        label: "attenua-orchestrator",
        possessionProof: orchProof.possessionProof,
      });
      await broadcastNative(acc.owner, [regMsg], {
        signMode: "hybrid",
        gas: 350_000,
        memo: "attenua: re-link orchestrator on AA #1",
      });
      await sleep(3500);
    }
  }

  // =========================================================================
  // HAPPY PATH — Institutional Treasury Swarm Lifecycle
  // =========================================================================

  // H1: Owner installs Root IPS Mandate (20 fUSD budget, liquidity band 40%..70%, BIT_ALL, maxDepth 2)
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.owner.evm as `0x${string}`);
    const sig = signSetRootMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      orchestrator: acc.orchestratorPqc.evm as `0x${string}`,
      rootBudget: 20n * oneFusd,
      minLiquidityBps: 4000,
      maxLiquidityBps: 7000,
      actionMask: 3, // BIT_ALLOCATE | BIT_PAY_INVOICE
      maxDepth: 2,
      expiry: rootExpiry,
      nonce,
      deadline,
      ownerPqcSecret: acc.owner.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "setRootMandate",
      args: [
        acc.orchestratorPqc.evm as `0x${string}`,
        20n * oneFusd,
        4000,
        7000,
        3,
        2,
        rootExpiry,
        nonce,
        deadline,
        sig,
      ],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 450_000n,
      memo: "attenua: H1 setRootMandate (ML-DSA-87)",
    });
    happyPath.push({
      id: "H1",
      title: "Owner installs Root IPS Mandate (ML-DSA-87)",
      actor: "Owner",
      layer: "AttenuaVault + pqcVerify",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "rootBudget=20 fUSD, liquidityBand=[40%, 70%], maxDepth=2",
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H1] ${!r.failed ? "PASS" : "FAIL"} — Root IPS Mandate set (gas=${r.evmGasUsed}) tx=${r.txHash}`);
    if (r.failed) throw new Error(`H1 failed: ${r.reason}`);
  }

  // H2: Owner registers allowlisted Vendor (requires vendor possessionProven == true)
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.owner.evm as `0x${string}`);
    const sig = signSetVendor({
      chainId,
      vault,
      rootEpoch: epoch,
      vendor: acc.vendor.evm as `0x${string}`,
      allowed: true,
      nonce,
      deadline,
      ownerPqcSecret: acc.owner.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "setVendor",
      args: [acc.vendor.evm as `0x${string}`, true, nonce, deadline, sig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 400_000n,
      memo: "attenua: H2 register vendor",
    });
    happyPath.push({
      id: "H2",
      title: "Owner registers ML-DSA-87 proven Vendor",
      actor: "Owner",
      layer: "AttenuaVault + pqcKeyStatus",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: `Vendor ${acc.vendor.evm} registered (possessionProven verified)`,
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H2] ${!r.failed ? "PASS" : "FAIL"} — Vendor registered (gas=${r.evmGasUsed}) tx=${r.txHash}`);
    if (r.failed) throw new Error(`H2 failed: ${r.reason}`);
  }

  // H3: Orchestrator pulls 8 fUSD Just-in-Time via direct fUSD.transfer inside x/abstractaccount denom_limits
  {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [vault, 8n * oneFusd],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: FUSD_EVM_ADDRESS,
      data,
      evmGasLimit: 120_000n,
      memo: "attenua: H3 JIT fUSD transfer (8 fUSD)",
    });
    happyPath.push({
      id: "H3",
      title: "Orchestrator Just-in-Time fUSD funding (no standing allowance)",
      actor: "Orchestrator (AA #1)",
      layer: "x/abstractaccount denom_limits",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Transferred 8 fUSD directly from Owner Treasury -> AttenuaVault (cap 10/tx, 25/day)",
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H3] ${!r.failed ? "PASS" : "FAIL"} — JIT 8 fUSD transferred tx=${r.txHash}`);
    if (r.failed) throw new Error(`H3 failed: ${r.reason}`);
  }

  // H4: Orchestrator registers 3 attenuated sub-mandates: Allocator (6 fUSD, [45%,65%]), Payables (2 fUSD), Research (0 fUSD)
  const allocMandateId = keccak256(toHex(`attenua-alloc-${Date.now()}`));
  const payMandateId = keccak256(toHex(`attenua-pay-${Date.now()}`));
  const researchMandateId = keccak256(toHex(`attenua-research-${Date.now()}`));
  const zeroParent = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

  for (const spec of [
    {
      id: "H4a",
      name: "Allocator (6 fUSD, narrowed band [45%, 65%])",
      mandateId: allocMandateId,
      subAgent: acc.allocator.evm as `0x${string}`,
      budget: 6n * oneFusd,
      minBps: 4500,
      maxBps: 6500,
      mask: 1,
    },
    {
      id: "H4b",
      name: "Payables (2 fUSD, invoice-only)",
      mandateId: payMandateId,
      subAgent: acc.payables.evm as `0x${string}`,
      budget: 2n * oneFusd,
      minBps: 4500,
      maxBps: 6500,
      mask: 2,
    },
    {
      id: "H4c",
      name: "Research (0 fUSD, zero-budget MCP clearance)",
      mandateId: researchMandateId,
      subAgent: acc.research.evm as `0x${string}`,
      budget: 0n,
      minBps: 4500,
      maxBps: 6500,
      mask: 0,
    },
  ]) {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
    const sig = signSubMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: spec.mandateId,
      parentId: zeroParent,
      subAgent: spec.subAgent,
      budget: spec.budget,
      minLiquidityBps: spec.minBps,
      maxLiquidityBps: spec.maxBps,
      actionMask: spec.mask,
      expiry: childExpiry,
      nonce,
      deadline,
      issuerPqcSecret: acc.orchestratorPqc.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "registerSubMandate",
      args: [
        spec.mandateId,
        zeroParent,
        spec.subAgent,
        spec.budget,
        spec.minBps,
        spec.maxBps,
        spec.mask,
        childExpiry,
        nonce,
        deadline,
        sig,
      ],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 480_000n,
      memo: `attenua: ${spec.id} register ${spec.name}`,
    });
    happyPath.push({
      id: spec.id,
      title: `Orchestrator delegates ${spec.name}`,
      actor: "Orchestrator (ML-DSA-87)",
      layer: "AttenuaVault Attenuation Lattice",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: `mandateId=${spec.mandateId.slice(0, 14)}...`,
      verbatimReason: r.reason || undefined,
    });
    console.log(`[${spec.id}] ${!r.failed ? "PASS" : "FAIL"} — ${spec.name} (gas=${r.evmGasUsed}) tx=${r.txHash}`);
    if (r.failed) throw new Error(`${spec.id} failed: ${r.reason}`);
  }

  // H5: Allocator deploys 3 fUSD to LiquidityVault + 3 fUSD to ReserveVault (50% = 5000 bps inside [4500, 6500])
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.allocator.evm as `0x${string}`);
    const sig = signAllocate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: allocMandateId,
      liqAmount: 3n * oneFusd,
      liqIsDeposit: true,
      resAmount: 3n * oneFusd,
      resIsDeposit: true,
      nonce,
      deadline,
      subAgentPqcSecret: acc.allocator.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executeAllocate",
      args: [allocMandateId, 3n * oneFusd, true, 3n * oneFusd, true, nonce, deadline, sig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 750_000n,
      memo: "attenua: H5 Allocator dual-sleeve ERC-4626 rebalance",
    });
    const summary = await evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "portfolioSummary" });
    happyPath.push({
      id: "H5",
      title: "Allocator rebalances 3 fUSD Liquidity + 3 fUSD Reserve (ERC-4626 + HolderGuard)",
      actor: "Allocator (ML-DSA-87)",
      layer: "AttenuaVault + @qorechain/asset-kit",
      passed: !r.failed && summary[3] === 5000n,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: `postLiquidityBps=${summary[3]} (50.00%, strictly inside [45%, 65%])`,
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H5] ${!r.failed ? "PASS" : "FAIL"} — Allocator 50/50 ERC-4626 (bps=${summary[3]}, gas=${r.evmGasUsed}) tx=${r.txHash}`);
    if (r.failed) throw new Error(`H5 failed: ${r.reason}`);
  }

  // H6: Payables pays 1.5 fUSD vendor invoice with 3x atomic ML-DSA-87 verification (Payables + Vendor + Research)
  const paidInvoiceId = keccak256(toHex(`INV-2026-001-${Date.now()}`));
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.payables.evm as `0x${string}`);
    const amount = 1_500_000n; // 1.5 fUSD
    const paySig = signPayInvoice({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: payMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      nonce,
      deadline,
      payablesPqcSecret: acc.payables.pqc.secretKey,
    });
    const vendorSig = signVendorInvoice({
      chainId,
      vault,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      vendorPqcSecret: acc.vendor.pqc.secretKey,
    });
    const researchSig = signResearchClearance({
      chainId,
      vault,
      rootEpoch: epoch,
      researchMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      researchPqcSecret: acc.research.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executePayInvoice",
      args: [
        payMandateId,
        researchMandateId,
        acc.vendor.evm as `0x${string}`,
        paidInvoiceId,
        amount,
        nonce,
        deadline,
        paySig,
        vendorSig,
        researchSig,
      ],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 900_000n,
      memo: "attenua: H6 Payables 3x ML-DSA-87 invoice payout",
    });
    happyPath.push({
      id: "H6",
      title: "Payables settles 1.5 fUSD invoice (3x atomic ML-DSA-87: Payables + Vendor + Research)",
      actor: "Payables + Vendor + Research",
      layer: "AttenuaVault + 3x pqcVerify",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: `Paid 1.5 fUSD to registered vendor; 3x ML-DSA-87 verified on-chain (gas=${r.evmGasUsed})`,
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H6] ${!r.failed ? "PASS" : "FAIL"} — 3x ML-DSA-87 invoice paid (gas=${r.evmGasUsed}) tx=${r.txHash}`);
    if (r.failed) throw new Error(`H6 failed: ${r.reason}`);
  }

  // =========================================================================
  // 9 ADVERSARIAL ATTACKS — ALL MUST BE REFUSED ON-CHAIN
  // =========================================================================

  // A1: Band widening attempt ([30%, 80%] > root [40%, 70%])
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
    const badId = keccak256(toHex(`attenua-a1-${Date.now()}`));
    const sig = signSubMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: badId,
      parentId: zeroParent,
      subAgent: acc.allocator.evm as `0x${string}`,
      budget: 1n * oneFusd,
      minLiquidityBps: 3000,
      maxLiquidityBps: 8000,
      actionMask: 1,
      expiry: childExpiry,
      nonce,
      deadline,
      issuerPqcSecret: acc.orchestratorPqc.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "registerSubMandate",
      args: [badId, zeroParent, acc.allocator.evm as `0x${string}`, 1n * oneFusd, 3000, 8000, 1, childExpiry, nonce, deadline, sig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 400_000n,
      memo: "attenua: A1 band widening attack",
    });
    attacks.push({
      id: "A1",
      title: "IPS Weight-Band Widening ([30%, 80%] vs root [40%, 70%])",
      actor: "Compromised Orchestrator",
      layer: "AttenuaVault Lattice (AttenuationBandWidened)",
      passed: r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: child band cannot widen parent IPS band",
      verbatimReason: r.reason,
    });
    console.log(`[A1] ${r.failed ? "REFUSED (PASS)" : "UNEXPECTED PASS"} — tx=${r.txHash}`);
  }

  // A2: Sibling Collusion / Budget Conservation Breach (requesting 15 fUSD when only 12 fUSD remains of 20 fUSD root)
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
    const badId = keccak256(toHex(`attenua-a2-${Date.now()}`));
    const sig = signSubMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: badId,
      parentId: zeroParent,
      subAgent: acc.payables.evm as `0x${string}`,
      budget: 15n * oneFusd,
      minLiquidityBps: 4500,
      maxLiquidityBps: 6500,
      actionMask: 2,
      expiry: childExpiry,
      nonce,
      deadline,
      issuerPqcSecret: acc.orchestratorPqc.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "registerSubMandate",
      args: [badId, zeroParent, acc.payables.evm as `0x${string}`, 15n * oneFusd, 4500, 6500, 2, childExpiry, nonce, deadline, sig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 400_000n,
      memo: "attenua: A2 sibling conservation breach",
    });
    attacks.push({
      id: "A2",
      title: "Sibling Collusion / Budget Conservation Breach (8 + 15 > 20 fUSD root)",
      actor: "Compromised Orchestrator",
      layer: "AttenuaVault Lattice (AttenuationBudgetExceeded)",
      passed: r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: sum(child budgets) cannot exceed rootBudget",
      verbatimReason: r.reason,
    });
    console.log(`[A2] ${r.failed ? "REFUSED (PASS)" : "UNEXPECTED PASS"} — tx=${r.txHash}`);
  }

  // A3: Confused Deputy — Payables tries to spend using Allocator's mandateId
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.payables.evm as `0x${string}`);
    const inv = keccak256(toHex(`INV-CONFUSED-${Date.now()}`));
    const paySig = signPayInvoice({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: allocMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      nonce,
      deadline,
      payablesPqcSecret: acc.payables.pqc.secretKey,
    });
    const vendorSig = signVendorInvoice({
      chainId,
      vault,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      vendorPqcSecret: acc.vendor.pqc.secretKey,
    });
    const resSig = signResearchClearance({
      chainId,
      vault,
      rootEpoch: epoch,
      researchMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      researchPqcSecret: acc.research.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executePayInvoice",
      args: [allocMandateId, researchMandateId, acc.vendor.evm as `0x${string}`, inv, 100_000n, nonce, deadline, paySig, vendorSig, resSig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 1_200_000n,
      memo: "attenua: A3 confused deputy cross-sibling mandate",
    });
    const genuineRefusal = r.failed && BigInt(r.evmGasUsed) > 0n && !r.reason.toLowerCase().includes("insufficient gas");
    attacks.push({
      id: "A3",
      title: "Confused Deputy (Payables using Allocator's sibling mandateId)",
      actor: "Hijacked Payables",
      layer: "AttenuaVault (ActionNotPermitted / Mandate Binding)",
      passed: genuineRefusal,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: sibling mandate action mask & signer binding rejected",
      verbatimReason: r.reason,
    });
    console.log(`[A3] ${genuineRefusal ? "REFUSED (PASS)" : "FAIL/GAS-FLOOR"} (gas=${r.evmGasUsed}) — tx=${r.txHash}`);
  }

  // A4: Zero-Budget Breakout — Research (budget = 0) attempts executeAllocate
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.research.evm as `0x${string}`);
    const sig = signAllocate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: researchMandateId,
      liqAmount: 100_000n,
      liqIsDeposit: true,
      resAmount: 0n,
      resIsDeposit: true,
      nonce,
      deadline,
      subAgentPqcSecret: acc.research.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executeAllocate",
      args: [researchMandateId, 100_000n, true, 0n, true, nonce, deadline, sig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 350_000n,
      memo: "attenua: A4 zero-budget breakout",
    });
    attacks.push({
      id: "A4",
      title: "Zero-Budget Breakout (Research sub-agent attempts spend)",
      actor: "Hijacked Research (budget=0)",
      layer: "AttenuaVault (ActionNotPermitted / ZeroBudgetCapability)",
      passed: r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: zero-budget read-only analyst cannot move funds",
      verbatimReason: r.reason,
    });
    console.log(`[A4] ${r.failed ? "REFUSED (PASS)" : "UNEXPECTED PASS"} — tx=${r.txHash}`);
  }

  // A5: Prompt-Injected Invoice diverting payout to unlisted attacker address
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.payables.evm as `0x${string}`);
    const inv = keccak256(toHex(`INV-PROMPT-INJECT-${Date.now()}`));
    const paySig = signPayInvoice({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: payMandateId,
      vendor: acc.unlistedAttacker.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      nonce,
      deadline,
      payablesPqcSecret: acc.payables.pqc.secretKey,
    });
    const fakeVendorSig = signVendorInvoice({
      chainId,
      vault,
      vendor: acc.unlistedAttacker.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      vendorPqcSecret: acc.unlistedAttacker.pqc.secretKey,
    });
    const resSig = signResearchClearance({
      chainId,
      vault,
      rootEpoch: epoch,
      researchMandateId,
      vendor: acc.unlistedAttacker.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      researchPqcSecret: acc.research.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executePayInvoice",
      args: [payMandateId, researchMandateId, acc.unlistedAttacker.evm as `0x${string}`, inv, 100_000n, nonce, deadline, paySig, fakeVendorSig, resSig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 1_200_000n,
      memo: "attenua: A5 prompt-injected unlisted vendor",
    });
    const genuineRefusal = r.failed && BigInt(r.evmGasUsed) > 0n && !r.reason.toLowerCase().includes("insufficient gas");
    attacks.push({
      id: "A5",
      title: "Prompt-Injected Invoice to Unlisted Attacker Address",
      actor: "Prompt-Injected Payables",
      layer: "AttenuaVault (VendorNotRegistered)",
      passed: genuineRefusal,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: unlisted recipient blocked before any transfer",
      verbatimReason: r.reason,
    });
    console.log(`[A5] ${genuineRefusal ? "REFUSED (PASS)" : "FAIL/GAS-FLOOR"} (gas=${r.evmGasUsed}) — tx=${r.txHash}`);
  }

  // A6: Replay Attack — attempting to pay the already-paid invoiceId a second time
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.payables.evm as `0x${string}`);
    const amount = 1_500_000n;
    const paySig = signPayInvoice({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: payMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      nonce,
      deadline,
      payablesPqcSecret: acc.payables.pqc.secretKey,
    });
    const vendorSig = signVendorInvoice({
      chainId,
      vault,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      vendorPqcSecret: acc.vendor.pqc.secretKey,
    });
    const resSig = signResearchClearance({
      chainId,
      vault,
      rootEpoch: epoch,
      researchMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: paidInvoiceId,
      amount,
      researchPqcSecret: acc.research.pqc.secretKey,
    });
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "executePayInvoice",
      args: [payMandateId, researchMandateId, acc.vendor.evm as `0x${string}`, paidInvoiceId, amount, nonce, deadline, paySig, vendorSig, resSig],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data,
      evmGasLimit: 1_200_000n,
      memo: "attenua: A6 duplicate invoice replay",
    });
    const genuineRefusal = r.failed && BigInt(r.evmGasUsed) > 0n && !r.reason.toLowerCase().includes("insufficient gas");
    attacks.push({
      id: "A6",
      title: "Duplicate Invoice Replay Attack (reusing paid invoiceId)",
      actor: "Replay Attacker",
      layer: "AttenuaVault (InvoiceAlreadyPaid)",
      passed: genuineRefusal,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: invoiceKey permanently marked paid",
      verbatimReason: r.reason,
    });
    console.log(`[A6] ${genuineRefusal ? "REFUSED (PASS)" : "FAIL/GAS-FLOOR"} (gas=${r.evmGasUsed}) — tx=${r.txHash}`);
  }

  // A10: Self-Delegated Zero-Budget Clearance Bypass (Blind Audit H-01 regression guard)
  {
    const epoch = await getEpoch();
    const pNonce = await getNonce(acc.payables.evm as `0x${string}`);
    const forgedResearchId = keccak256(toHex(`attenua-forged-res-${Date.now()}`));
    const selfSig = signSubMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: forgedResearchId,
      parentId: payMandateId,
      subAgent: acc.payables.evm as `0x${string}`,
      budget: 0n,
      minLiquidityBps: 4500,
      maxLiquidityBps: 6500,
      actionMask: 0,
      expiry: childExpiry,
      nonce: pNonce,
      deadline,
      issuerPqcSecret: acc.payables.pqc.secretKey,
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          forgedResearchId,
          payMandateId,
          acc.payables.evm as `0x${string}`,
          0n,
          4500,
          6500,
          0,
          childExpiry,
          pNonce,
          deadline,
          selfSig,
        ],
      }),
      evmGasLimit: 480_000n,
      memo: "attenua: A10 self-delegated zero-budget clearance bypass (H-01)",
    });
    const genuineRefusal = r.failed && BigInt(r.evmGasUsed) > 0n && !r.reason.toLowerCase().includes("insufficient gas");
    attacks.push({
      id: "A10",
      title: "Self-Delegated Zero-Budget Clearance Bypass (Audit H-01)",
      actor: "Hijacked Payables",
      layer: "AttenuaVault (SelfDelegationNotAllowed / SeparationOfDuties)",
      passed: genuineRefusal,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused on-chain: Payables cannot self-delegate a zero-budget Research mandate",
      verbatimReason: r.reason,
    });
    console.log(`[A10] ${genuineRefusal ? "REFUSED (PASS)" : "FAIL/GAS-FLOOR"} (gas=${r.evmGasUsed}) — tx=${r.txHash}`);
  }

  // A7: JIT Protocol Ceiling Breach (11 fUSD > 10 fUSD per-tx denom_limits on Owner AA #1)
  {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [vault, 11n * oneFusd],
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: FUSD_EVM_ADDRESS,
      data,
      evmGasLimit: 120_000n,
      memo: "attenua: A7 JIT over-cap fUSD transfer",
    });
    attacks.push({
      id: "A7",
      title: "JIT Protocol Ceiling Breach (11 fUSD > 10 fUSD per-tx denom_limits)",
      actor: "Compromised Orchestrator (AA #1)",
      layer: "x/abstractaccount (spending limit exceeded)",
      passed: r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Refused by chain protocol (outer code=0 + abstractaccount_execution_failed)",
      verbatimReason: r.reason,
    });
    console.log(`[A7] ${r.failed ? "REFUSED (PASS)" : "UNEXPECTED PASS"} — reason="${r.reason}" tx=${r.txHash}`);
  }

  // A8: Monotonic Classical Freeze via Isolated AA #2 Monitor -> blocks spend -> Monitor cannot unfreeze -> Owner ML-DSA unfreezes
  {
    const epoch = await getEpoch();
    const monNonce = await getMonitorNonce();
    const freezeSig = await signMonitorFreeze({
      chainId,
      vault,
      rootEpoch: epoch,
      nonce: monNonce,
      deadline,
      monitorPrivateKeyHex: acc.monitorAccount.privateKey,
    });
    const freezeData = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "freeze",
      args: [monNonce, deadline, freezeSig],
    });
    const rFreeze = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: acc.monitorEdPriv,
      to: vault,
      data: freezeData,
      evmGasLimit: 150_000n,
      memo: "attenua: A8a monotonic classical freeze via AA #2",
    });

    // Attempt spend while frozen -> must fail
    const pNonce = await getNonce(acc.payables.evm as `0x${string}`);
    const inv = keccak256(toHex(`INV-FROZEN-${Date.now()}`));
    const pSig = signPayInvoice({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: payMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      nonce: pNonce,
      deadline,
      payablesPqcSecret: acc.payables.pqc.secretKey,
    });
    const vSig = signVendorInvoice({
      chainId,
      vault,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      vendorPqcSecret: acc.vendor.pqc.secretKey,
    });
    const resSig = signResearchClearance({
      chainId,
      vault,
      rootEpoch: epoch,
      researchMandateId,
      vendor: acc.vendor.evm as `0x${string}`,
      invoiceId: inv,
      amount: 100_000n,
      researchPqcSecret: acc.research.pqc.secretKey,
    });
    const rSpendFrozen = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "executePayInvoice",
        args: [payMandateId, researchMandateId, acc.vendor.evm as `0x${string}`, inv, 100_000n, pNonce, deadline, pSig, vSig, resSig],
      }),
      evmGasLimit: 300_000n,
      memo: "attenua: A8b spend rejected while frozen",
    });

    // Monitor tries to call unfreeze() -> blocked by AA #2 selector allowlist
    const oNonce = await getNonce(acc.owner.evm as `0x${string}`);
    const rMonUnfreeze = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: acc.monitorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "unfreeze",
        args: [oNonce, deadline, "0x00"],
      }),
      evmGasLimit: 150_000n,
      memo: "attenua: A8c monitor unfreeze refused by AA #2",
    });

    // Owner ML-DSA-87 unfreezes cleanly so we can test reclaim + A9
    const unfreezeSig = signUnfreeze({
      chainId,
      vault,
      rootEpoch: epoch,
      nonce: oNonce,
      deadline,
      ownerPqcSecret: acc.owner.pqc.secretKey,
    });
    const rOwnerUnfreeze = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "unfreeze",
        args: [oNonce, deadline, unfreezeSig],
      }),
      evmGasLimit: 400_000n,
      memo: "attenua: A8d owner ML-DSA-87 unfreeze",
    });

    const passed = !rFreeze.failed && rSpendFrozen.failed && rMonUnfreeze.failed && !rOwnerUnfreeze.failed;
    attacks.push({
      id: "A8",
      title: "Monotonic Classical Freeze (AA #2) blocks spend & cannot unfreeze",
      actor: "Classical Monitor (AA #2) vs Owner (ML-DSA-87)",
      layer: "AA #2 Protocol Lock + AttenuaVault (VaultIsFrozen)",
      passed,
      txHash: rSpendFrozen.txHash,
      evmGasUsed: rFreeze.evmGasUsed,
      summary: `freeze=${!rFreeze.failed}, spendBlocked=${rSpendFrozen.failed}, monitorUnfreezeRefused=${rMonUnfreeze.failed}, ownerPqcUnfreeze=${!rOwnerUnfreeze.failed}`,
      verbatimReason: rMonUnfreeze.reason,
    });
    console.log(`[A8] ${passed ? "REFUSED (PASS)" : "FAIL"} — freeze=${!rFreeze.failed}, spendBlocked=${rSpendFrozen.failed}, monUnfreezeRefused=${rMonUnfreeze.failed}`);
  }

  // H7: Orchestrator reclaims unused 0.5 fUSD from Payables back to Root budget
  {
    const epoch = await getEpoch();
    const nonce = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
    const sig = signReclaimSubMandate({
      chainId,
      vault,
      rootEpoch: epoch,
      mandateId: payMandateId,
      nonce,
      deadline,
      issuerPqcSecret: acc.orchestratorPqc.pqc.secretKey,
    });
    const r = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "reclaimSubMandate",
        args: [payMandateId, nonce, deadline, sig],
      }),
      evmGasLimit: 400_000n,
      memo: "attenua: H7 reclaim unspent Payables budget",
    });
    happyPath.push({
      id: "H7",
      title: "Orchestrator reclaims unspent 0.5 fUSD from Payables sub-mandate",
      actor: "Orchestrator (ML-DSA-87)",
      layer: "AttenuaVault Conservation Accounting",
      passed: !r.failed,
      txHash: r.txHash,
      evmGasUsed: r.evmGasUsed,
      summary: "Reclaimed 0.5 fUSD unspent allocation back to root pool",
      verbatimReason: r.reason || undefined,
    });
    console.log(`[H7] ${!r.failed ? "PASS" : "FAIL"} — Reclaimed 0.5 fUSD tx=${r.txHash}`);
  }

  // A9: O(1) Cascading Post-Quantum Kill-Switch (revokeRootEpoch invalidates ALL active sub-agents immediately)
  {
    const epoch = await getEpoch();
    const oNonce = await getNonce(acc.owner.evm as `0x${string}`);
    const revSig = signRevokeRootEpoch({
      chainId,
      vault,
      rootEpoch: epoch,
      nonce: oNonce,
      deadline,
      ownerPqcSecret: acc.owner.pqc.secretKey,
    });
    const rRevoke = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "revokeRootEpoch",
        args: [oNonce, deadline, revSig],
      }),
      evmGasLimit: 400_000n,
      memo: "attenua: A9a O(1) cascading ML-DSA-87 revokeRootEpoch",
    });

    // Allocator tries to execute after O(1) epoch bump -> immediately rejected (EpochMismatch)
    const newEpoch = await getEpoch();
    const aNonce = await getNonce(acc.allocator.evm as `0x${string}`);
    const allocSig = signAllocate({
      chainId,
      vault,
      rootEpoch: newEpoch,
      mandateId: allocMandateId,
      liqAmount: 100_000n,
      liqIsDeposit: false,
      resAmount: 100_000n,
      resIsDeposit: true,
      nonce: aNonce,
      deadline,
      subAgentPqcSecret: acc.allocator.pqc.secretKey,
    });
    const rAfterRevoke = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "executeAllocate",
        args: [allocMandateId, 100_000n, false, 100_000n, true, aNonce, deadline, allocSig],
      }),
      evmGasLimit: 350_000n,
      memo: "attenua: A9b Allocator refused after O(1) revokeRootEpoch",
    });

    // Also revoke Orchestrator authenticator at protocol layer (AA #1) to leave Owner clean
    const orchPub = ed25519.getPublicKey(acc.orchestratorEdPriv);
    await broadcastNative(
      acc.owner,
      [
        revokeAuthenticatorMsg({
          owner: acc.owner.cosmos,
          account: acc.owner.cosmos,
          scheme: "ed25519",
          pubkey: orchPub,
        }),
      ],
      { signMode: "hybrid", gas: 300_000, memo: "attenua: A9c protocol MsgRevokeAuthenticator" }
    );

    const passed = !rRevoke.failed && newEpoch === epoch + 1n && rAfterRevoke.failed;
    attacks.push({
      id: "A9",
      title: "O(1) Cascading Post-Quantum Kill-Switch (revokeRootEpoch + MsgRevokeAuthenticator)",
      actor: "Owner (ML-DSA-87) vs Active Sub-Agent",
      layer: "AttenuaVault Epoch Counter + x/abstractaccount",
      passed,
      txHash: rRevoke.txHash,
      evmGasUsed: rRevoke.evmGasUsed,
      summary: `rootEpoch ${epoch} -> ${newEpoch} in O(1) gas (${rRevoke.evmGasUsed}); Allocator immediately refused (${rAfterRevoke.txHash})`,
      verbatimReason: rAfterRevoke.reason,
    });
    console.log(`[A9] ${passed ? "REFUSED (PASS)" : "FAIL"} — epoch ${epoch}->${newEpoch}, subAgentRefused=${rAfterRevoke.failed}`);
  }

  const evidence = {
    network: CHAIN_ID,
    evmChainId: EVM_CHAIN_ID,
    runAt: new Date().toISOString(),
    vault,
    mandates: {
      allocator: allocMandateId,
      payables: payMandateId,
      research: researchMandateId,
    },
    happyPath,
    attacks,
  };
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
  console.log(`\nSaved live evidence ledger -> ${EVIDENCE_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
