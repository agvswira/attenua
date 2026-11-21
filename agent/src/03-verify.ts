import fs from "node:fs";
import { fetchAuthenticators, fetchEvmWindow, fetchPqcStatus, fetchSpendingRules } from "@qorechain/sdk";
import { parseAbi } from "viem";
import {
  DEPLOYMENT_FILE,
  ERC20_ABI,
  EVIDENCE_FILE,
  FUSD_EVM_ADDRESS,
  REST_URL,
  createEvmPublicClient,
} from "./config.js";

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
      attacksOk && (ev.attacks?.length ?? 0) >= 9,
      `${ev.attacks?.filter((x: { passed: boolean; evmGasUsed?: string; verbatimReason?: string }) => x.passed && Number(x.evmGasUsed ?? "0") > 0 && !(x.verbatimReason ?? "").toLowerCase().includes("insufficient gas")).length}/${ev.attacks?.length} genuine refusals`
    );
  }

  console.log(`\n=== Summary: ${pass} PASSED, ${fail} FAILED ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
