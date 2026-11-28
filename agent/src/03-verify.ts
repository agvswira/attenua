import fs from "node:fs";
import { fetchAuthenticators, fetchEvmWindow, fetchPqcStatus, fetchSpendingRules, pqcStatusPublicKey } from "@qorechain/sdk";
import { parseAbi } from "viem";
import {
  DEPLOYMENT_FILE,
  ERC20_ABI,
  EVIDENCE_FILE,
  FUSD_EVM_ADDRESS,
  REPO_ROOT,
  REST_URL,
  createEvmPublicClient,
} from "./config.js";
import path from "node:path";
import { envelopeFromText, parseEnvelope, verifyRecipientCard, type RecipientCard } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { runQoreMcpPreflight } from "./qore-mcp-preflight.js";
import { DECODED_ATTACKS_FILE, decodeHistoricalAttack } from "./decode-historical-attacks.js";
import { CHAIN_ID } from "./config.js";

const STANDING_TREE_FILE = path.join(REPO_ROOT, "deployments", "standing-tree.json");
const CBOM_FILE = path.join(REPO_ROOT, "docs", "cbom.json");
const AUTH_MSG_FILE = path.join(REPO_ROOT, "deployments", "authenticated-message.json");

const GUARD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function exempt(address) view returns (bool)",
  "function isEligible(address) view returns (bool)",
]);

const VAULT_ABI = parseAbi([
  "function rootOwner() view returns (address)",
  "function monitorSigner() view returns (address)",
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function rootMandate() view returns (address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function subMandates(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
]);

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Missing ${DEPLOYMENT_FILE}`);
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const evm = createEvmPublicClient();

  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    if (ok) {
      pass++;
      console.log(`  [PASS] ${label} — ${detail}`);
    } else {
      fail++;
      console.error(`  [FAIL] ${label} — ${detail}`);
    }
  };

  console.log("=== Attenua Keyless Read-Only On-Chain Verifier (qorechain-diana) ===\n");

  // 1. Verify contract bytecode exists on Diana
  for (const [name, addr] of [
    ["QoreChainHybridHolderGuard", dep.contracts.holderGuard.address],
    ["LiquidityVault (ERC-4626)", dep.contracts.liquidityVault.address],
    ["ReserveVault (ERC-4626)", dep.contracts.reserveVault.address],
    ["AttenuaVault", dep.contracts.attenuaVault.address],
  ] as const) {
    const code = await evm.getCode({ address: addr });
    check(`${name} deployed`, Boolean(code && code.length > 2), `${addr} (${(code?.length ?? 2) / 2 - 1} bytes)`);
  }

  // 2. Verify Guard classical Ownable2Step gap is closed (ownership renounced + AttenuaVault exempt)
  const guardOwner = await evm.readContract({
    address: dep.contracts.holderGuard.address,
    abi: GUARD_ABI,
    functionName: "owner",
  });
  const vaultExempt = await evm.readContract({
    address: dep.contracts.holderGuard.address,
    abi: GUARD_ABI,
    functionName: "exempt",
    args: [dep.contracts.attenuaVault.address],
  });
  check(
    "Guard Ownable2Step renounced",
    guardOwner === "0x0000000000000000000000000000000000000000",
    `owner=${guardOwner}`
  );
  check("AttenuaVault exempt on Guard", vaultExempt === true, `exempt=${vaultExempt}`);

  // 3. Verify Owner EVM window is CLOSED
  const win = await fetchEvmWindow({ rest: REST_URL, address: dep.abstractAccounts.ownerTreasuryAA1.cosmos });
  check("Owner EVM window closed", !win.live, `live=${win.live}`);

  // 4. Verify AA #1 single-linked-key invariant & AA #2 monitor isolation (0 fUSD)
  const aa1Auths = await fetchAuthenticators({ rest: REST_URL, address: dep.abstractAccounts.ownerTreasuryAA1.cosmos });
  const aa1Active = aa1Auths.filter((a) => !a.revoked);
  check("Owner AA #1 <= 1 active linked key", aa1Active.length <= 1, `activeKeys=${aa1Active.length}`);

  const aa2Fusd = await evm.readContract({
    address: FUSD_EVM_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [dep.abstractAccounts.monitorAA2.evm],
  });
  const aa2Rules = await fetchSpendingRules({ rest: REST_URL, address: dep.abstractAccounts.monitorAA2.cosmos });
  check("Monitor AA #2 holds 0 fUSD", aa2Fusd === 0n, `fUSD=${aa2Fusd}`);
  check(
    "Monitor AA #2 locked to freeze() + 1 uqor",
    aa2Rules.rules[0]?.dailyLimit === 1n && aa2Rules.rules[0]?.allowedEvmCalls.length === 1,
    `dailyLimit=${aa2Rules.rules[0]?.dailyLimit}, calls=${aa2Rules.rules[0]?.allowedEvmCalls.join(",")}`
  );

  // 5. Verify ML-DSA-87 registration for all PQC actors
  for (const [role, info] of [
    ["Owner", dep.abstractAccounts.ownerTreasuryAA1],
    ["OrchestratorPqc", dep.actors.orchestratorPqc],
    ["Allocator", dep.actors.allocator],
    ["Payables", dep.actors.payables],
    ["Research", dep.actors.research],
    ["Vendor", dep.actors.vendor],
  ] as const) {
    const pqc = await fetchPqcStatus({ rest: REST_URL, address: info.cosmos });
    check(`PQC key registered (${role})`, Boolean(pqc.registered), `${info.cosmos}`);
  }

  // 6. Verify AttenuaVault live state
  const [epoch, frozen, summary] = await Promise.all([
    evm.readContract({ address: dep.contracts.attenuaVault.address, abi: VAULT_ABI, functionName: "rootEpoch" }),
    evm.readContract({ address: dep.contracts.attenuaVault.address, abi: VAULT_ABI, functionName: "frozen" }),
    evm.readContract({ address: dep.contracts.attenuaVault.address, abi: VAULT_ABI, functionName: "portfolioSummary" }),
  ]);
  check(
    "AttenuaVault state readable",
    epoch >= 1n,
    `rootEpoch=${epoch}, frozen=${frozen}, idle=${summary[0]}, liq=${summary[1]}, res=${summary[2]}, liqBps=${summary[3]}`
  );

  // 7. Verify recorded live-run evidence if present
  if (fs.existsSync(EVIDENCE_FILE)) {
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    const happyOk = (ev.happyPath ?? []).every((x: { passed: boolean }) => x.passed);
    const attacksOk = (ev.attacks ?? []).every(
      (x: { passed: boolean; evmGasUsed?: string; verbatimReason?: string }) =>
        x.passed &&
        Number(x.evmGasUsed ?? "0") > 0 &&
        !(x.verbatimReason ?? "").toLowerCase().includes("insufficient gas")
    );
    check(
      "Happy-path live swarm lifecycle",
      happyOk && (ev.happyPath?.length ?? 0) > 0,
      `${ev.happyPath?.filter((x: { passed: boolean }) => x.passed).length}/${ev.happyPath?.length} passed`
    );
    check(
      "Adversarial Attack Suite (genuine on-chain guard refusals, non-OOG)",
      attacksOk && (ev.attacks?.length ?? 0) >= 10,
      `${ev.attacks?.filter((x: { passed: boolean; evmGasUsed?: string; verbatimReason?: string }) => x.passed && Number(x.evmGasUsed ?? "0") > 0 && !(x.verbatimReason ?? "").toLowerCase().includes("insufficient gas")).length}/${ev.attacks?.length} genuine refusals`
    );
  }

  // 8. Verify live Epoch 2 Standing Tree (keeps Attack Lab live past Dec 16 judging)
  if (fs.existsSync(STANDING_TREE_FILE)) {
    const tree = JSON.parse(fs.readFileSync(STANDING_TREE_FILE, "utf8"));
    const rm = await evm.readContract({
      address: dep.contracts.attenuaVault.address,
      abi: VAULT_ABI,
      functionName: "rootMandate",
    });
    const rmActive = Boolean(rm[10]);
    const rmEpoch = Number(rm[9]);
    const rmExpiry = Number(rm[8]);
    const dec17Utc = Math.floor(Date.parse("2026-12-17T00:00:00Z") / 1000);
    check(
      "Standing Root Mandate active on current epoch past judging",
      rmActive && rmEpoch === Number(epoch) && rmExpiry >= dec17Utc,
      `active=${rmActive}, epoch=${rmEpoch}, expiry=${new Date(rmExpiry * 1000).toISOString()}`
    );

    const mandateEntries = Object.entries(tree.mandates ?? {}) as Array<[string, { id: `0x${string}` }]>;
    for (const [role, m] of mandateEntries) {
      const sub = await evm.readContract({
        address: dep.contracts.attenuaVault.address,
        abi: VAULT_ABI,
        functionName: "subMandates",
        args: [m.id],
      });
      const open = sub[1] !== "0x0000000000000000000000000000000000000000" && !sub[12] && Number(sub[11]) === Number(epoch);
      check(`Standing sub-mandate open (${role})`, open, `id=${m.id.slice(0, 14)}..., depth=${sub[9]}, closed=${sub[12]}`);
    }
  }

  // 9. Official @qorechain/mcp preflight & QoreScan CBOM check
  try {
    const mcp = await runQoreMcpPreflight({
      ownerCosmos: dep.abstractAccounts.ownerTreasuryAA1.cosmos,
      orchestratorCosmos: dep.actors.orchestratorPqc.cosmos,
      payablesCosmos: dep.actors.payables.cosmos,
      vaultEvm: dep.contracts.attenuaVault.address,
    });
    check(
      "@qorechain/mcp read-only preflight audit",
      mcp.chainId === "qorechain-diana" && Boolean(mcp.ownerPqStatus),
      `chainId=${mcp.chainId}, latency=${mcp.latencyMs}ms`
    );
  } catch (err) {
    check("@qorechain/mcp read-only preflight audit", false, err instanceof Error ? err.message : String(err));
  }

  if (fs.existsSync(CBOM_FILE)) {
    const cbom = JSON.parse(fs.readFileSync(CBOM_FILE, "utf8")) as { bomFormat?: string; components?: unknown[] };
    check(
      "QoreScan CycloneDX CBOM present",
      cbom.bomFormat === "CycloneDX" && Array.isArray(cbom.components) && cbom.components.length > 0,
      `format=${cbom.bomFormat}, components=${cbom.components?.length ?? 0}`
    );
  }

  // 10. Historical attack archive revert decoding (height - 1 eth_call)
  if (fs.existsSync(DECODED_ATTACKS_FILE)) {
    const decFile = JSON.parse(fs.readFileSync(DECODED_ATTACKS_FILE, "utf8")) as {
      attacks?: Array<{ id: string; aaFailedEvent?: boolean; errorName?: string }>;
    };
    const decCount = decFile.attacks?.length ?? 0;
    const allAaFailed = (decFile.attacks ?? []).every((a) => Boolean(a.aaFailedEvent));
    check(
      "Historical attack reverts cataloged (A1-A10)",
      decCount === 10 && allAaFailed,
      `${decCount}/10 decoded with abstractaccount_execution_failed`
    );

    const evData = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")) as {
      attacks: Array<{ id: string; txHash: string; summary?: string; verbatimReason?: string }>;
    };
    const a1Entry = evData.attacks.find((a) => a.id === "A1");
    const a10Entry = evData.attacks.find((a) => a.id === "A10");
    if (a1Entry && a10Entry) {
      const [a1Live, a10Live] = await Promise.all([
        decodeHistoricalAttack(a1Entry),
        decodeHistoricalAttack(a10Entry),
      ]);
      check(
        "Live archive height-1 eth_call replay (A1 & A10)",
        a1Live.errorName === "AttenuationBandWidened" && a10Live.errorName === "SelfDelegationNotAllowed",
        `A1=${a1Live.formattedError} (@${a1Live.replayHeight}); A10=${a10Live.formattedError} (@${a10Live.replayHeight})`
      );
    }
  }

  // 11. Authenticated Inter-Agent Messaging (QoreSign + QoreSeal ML-KEM-1024 on-chain KEM registry)
  const [orchKem, payKem, orchPqcStatus, payPqcStatus] = await Promise.all([
    fetchKemKey({ rest: REST_URL, address: dep.actors.orchestratorPqc.cosmos }),
    fetchKemKey({ rest: REST_URL, address: dep.actors.payables.cosmos }),
    fetchPqcStatus({ rest: REST_URL, address: dep.actors.orchestratorPqc.cosmos }),
    fetchPqcStatus({ rest: REST_URL, address: dep.actors.payables.cosmos }),
  ]);
  check(
    "On-chain ML-KEM-1024 key registered (OrchestratorPqc)",
    Boolean(orchKem.registered && orchKem.algorithmId === 2 && orchKem.publicKey?.length === 1568),
    `${dep.actors.orchestratorPqc.cosmos} (alg=${orchKem.algorithmId}, height=${orchKem.registeredHeight ?? "?"})`
  );
  check(
    "On-chain ML-KEM-1024 key registered (Payables)",
    Boolean(payKem.registered && payKem.algorithmId === 2 && payKem.publicKey?.length === 1568),
    `${dep.actors.payables.cosmos} (alg=${payKem.algorithmId}, height=${payKem.registeredHeight ?? "?"})`
  );

  if (fs.existsSync(AUTH_MSG_FILE)) {
    const authDoc = JSON.parse(fs.readFileSync(AUTH_MSG_FILE, "utf8")) as {
      recipientCards?: { orchestratorPqc?: RecipientCard; payables?: RecipientCard };
      envelope?: { text?: string };
      verifiedClearance?: { shake256Digest?: string };
    };
    const orchPqPub = pqcStatusPublicKey(orchPqcStatus);
    const payPqPub = pqcStatusPublicKey(payPqcStatus);
    let cardsValid = false;
    if (
      authDoc.recipientCards?.orchestratorPqc &&
      authDoc.recipientCards?.payables &&
      orchPqPub &&
      payPqPub &&
      orchKem.publicKey &&
      payKem.publicKey
    ) {
      verifyRecipientCard({
        card: authDoc.recipientCards.orchestratorPqc,
        chainId: CHAIN_ID,
        address: dep.actors.orchestratorPqc.cosmos,
        pqPublicKey: orchPqPub,
        mlkemPublicKey: orchKem.publicKey,
      });
      verifyRecipientCard({
        card: authDoc.recipientCards.payables,
        chainId: CHAIN_ID,
        address: dep.actors.payables.cosmos,
        pqPublicKey: payPqPub,
        mlkemPublicKey: payKem.publicKey,
      });
      cardsValid = true;
    }
    const envParsed = authDoc.envelope?.text ? parseEnvelope(envelopeFromText(authDoc.envelope.text)) : null;
    check(
      "QoreSeal + QoreSign clearance envelope & cards verified against live chain keys",
      cardsValid && envParsed?.mode === "hybrid" && envParsed.entries.length === 2,
      `mode=${envParsed?.mode}, recipients=${envParsed?.entries.length}, shake256=${authDoc.verifiedClearance?.shake256Digest?.slice(0, 18)}...`
    );
  }

  console.log(`\n=== Summary: ${pass} PASSED, ${fail} FAILED ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
