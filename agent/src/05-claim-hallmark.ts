import fs from "node:fs";
import { closeEvmWindowMsg, fetchEvmWindow, openEvmWindowMsg } from "@qorechain/sdk";
import { parseAbi } from "viem";
import {
  DEPLOYMENT_FILE,
  REST_URL,
  broadcastNative,
  createEvmPublicClient,
  createEvmWalletClient,
  loadOrCreateSwarmAccounts,
  sleep,
} from "./config.js";

const HALLMARK_REGISTRY = "0xa901ee7138266abc456c8d717fa94b043078b8c4" as const;
const REPO_URL = "https://github.com/agvswira/attenua";

const HALLMARK_ABI = parseAbi([
  "function claim(address target, string calldata repo) external",
]);

function loadDeployedTargets(): ReadonlyArray<{ name: string; address: `0x${string}` }> {
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")) as {
    contracts: {
      attenuaVault: { address: `0x${string}` };
      holderGuard: { address: `0x${string}` };
      liquidityVault: { address: `0x${string}` };
      reserveVault: { address: `0x${string}` };
    };
  };
  return [
    { name: "AttenuaVault", address: dep.contracts.attenuaVault.address },
    { name: "QoreChainHybridHolderGuard", address: dep.contracts.holderGuard.address },
    { name: "LiquidityVault", address: dep.contracts.liquidityVault.address },
    { name: "ReserveVault", address: dep.contracts.reserveVault.address },
  ];
}

async function main() {
  const TARGETS = loadDeployedTargets();
  const acc = await loadOrCreateSwarmAccounts();
  const evmPublic = createEvmPublicClient();
  const evmWallet = createEvmWalletClient(acc.owner.privateKey);

  console.log("=== Claiming 4 Attenua Contracts on HallmarkRegistry ===");
  console.log(`Owner / Deployer: ${acc.owner.evm} (${acc.owner.cosmos})`);
  console.log(`HallmarkRegistry: ${HALLMARK_REGISTRY}`);
  console.log(`Repo:             ${REPO_URL}\n`);

  const openRes = await broadcastNative(
    acc.owner,
    [
      openEvmWindowMsg({
        sender: acc.owner.cosmos,
        blocks: 60,
        maxTxs: 4,
        maxValue: "1000000",
        allowedTargets: [HALLMARK_REGISTRY],
      }),
    ],
    { signMode: "hybrid", gas: 350_000, memo: "attenua: open scoped hallmark claim window" }
  );
  if (openRes.code !== 0) {
    throw new Error(`Open scoped EVM window failed: ${openRes.rawLog}`);
  }
  console.log(`[WINDOW] Opened scoped window for HallmarkRegistry: tx=${openRes.transactionHash}`);
  await sleep(6000);

  try {
    for (const target of TARGETS) {
      const txHash = await evmWallet.writeContract({
        address: HALLMARK_REGISTRY,
        abi: HALLMARK_ABI,
        functionName: "claim",
        args: [target.address, REPO_URL],
        gas: 250_000n,
      });
      const receipt = await evmPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error(`claim() failed for ${target.name} (${target.address}): tx=${txHash}`);
      }
      console.log(
        `[CLAIM] ${target.name} (${target.address}) -> tx=${txHash} gasUsed=${receipt.gasUsed}`
      );
    }
  } finally {
    const closeRes = await broadcastNative(
      acc.owner,
      [closeEvmWindowMsg(acc.owner.cosmos)],
      { signMode: "hybrid", gas: 300_000, memo: "attenua: close hallmark claim window" }
    );
    if (closeRes.code !== 0) {
      throw new Error(`Close EVM window failed: ${closeRes.rawLog}`);
    }
    await sleep(3500);
    const winAfter = await fetchEvmWindow({ rest: REST_URL, address: acc.owner.cosmos });
    console.log(`\n[WINDOW] Closed cleanly: closeTx=${closeRes.transactionHash}, window.live=${winAfter.live}`);
    if (winAfter.live) {
      throw new Error("Owner EVM window remained live after close!");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
