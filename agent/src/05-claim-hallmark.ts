import { closeEvmWindowMsg, fetchEvmWindow, openEvmWindowMsg } from "@qorechain/sdk";
import { parseAbi } from "viem";
import {
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

const TARGETS: ReadonlyArray<{ name: string; address: `0x${string}` }> = [
  { name: "AttenuaVault", address: "0xf585fc6e1e43446f353830e0d11ff44ce747af58" },
  { name: "QoreChainHybridHolderGuard", address: "0xf70c001e482a1112ec76684ddec4ffe3bff4c652" },
  { name: "LiquidityVault", address: "0xb5cf1d53872255bed60ebb731e9043b7c9ff2c8b" },
  { name: "ReserveVault", address: "0x5b914270db69cee65762c75edf1e1ce2856cc72b" },
];

async function main() {
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
