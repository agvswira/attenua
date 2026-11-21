import fs from "node:fs";
import {
  bank,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchEvmWindow,
  fetchPqcStatus,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import {
  CHAIN_ID,
  DEPLOY_PATH,
  REST_URL,
  broadcastNative,
  createEvmPublicClient,
  createEvmWalletClient,
  fetchUqorBalance,
  hexToBytes,
  loadProbeArtifact,
  loadSpikeAccounts,
  sleep,
} from "./common.js";

async function registerPqcIfNeeded(label: string, account: UnifiedAccount) {
  const status = await fetchPqcStatus({ rest: REST_URL, address: account.cosmos }).catch(() => null);
  if (status?.registered) {
    console.log(`[PQC] ${label} (${account.cosmos}) already registered.`);
    return;
  }
  const pop = signProofOfPossession({
    chainId: CHAIN_ID,
    account: account.cosmos,
    keypair: account.pqc,
  });
  const regMsg = buildRegisterPqcKeyMsg(account.cosmos, {
    pqcKeypair: account.pqc,
    ecdsaPubkey: hexToBytes(account.publicKey),
    proofOfPossession: pop,
  });
  const res = await broadcastNative(account, [regMsg], {
    signMode: "classical",
    gas: 400_000,
    memo: `attenua-spike: register PQC (${label})`,
  });
  if (res.code !== 0) {
    throw new Error(`PQC registration failed for ${label}: code=${res.code} log=${res.rawLog}`);
  }
  console.log(`[PQC] ${label} registered (with PoP): tx=${res.transactionHash}`);
  await sleep(3500);
}

async function fundIfLow(
  owner: UnifiedAccount,
  label: string,
  target: UnifiedAccount,
  minUqor: bigint,
  sendUqor: bigint
) {
  const bal = await fetchUqorBalance(target.cosmos);
  if (bal >= minUqor) {
    console.log(`[FUND] ${label} already has ${bal} uqor.`);
    return;
  }
  const msgSend = bank.send({
    fromAddress: owner.cosmos,
    toAddress: target.cosmos,
    amount: [{ denom: "uqor", amount: sendUqor.toString() }],
  });
  const res = await broadcastNative(owner, [msgSend], {
    signMode: "hybrid",
    gas: 300_000,
    memo: `attenua-spike: fund ${label}`,
  });
  if (res.code !== 0) {
    throw new Error(`Funding ${label} failed: code=${res.code} log=${res.rawLog}`);
  }
  console.log(`[FUND] Sent ${sendUqor} uqor to ${label} (${target.cosmos}): tx=${res.transactionHash}`);
  await sleep(3500);
}

async function main() {
  const acc = await loadSpikeAccounts();
  const artifact = loadProbeArtifact();
  const evmPublic = createEvmPublicClient();

  const ownerBal = await fetchUqorBalance(acc.owner.cosmos);
  if (ownerBal < 5_000_000n) {
    throw new Error(
      `Owner (${acc.owner.cosmos}) has only ${ownerBal} uqor. Claim free test QOR + fUSD from Diana faucet first.`
    );
  }

  // 1. Register Owner PQC key first (so all Owner txs are hybrid-signed)
  await registerPqcIfNeeded("Owner", acc.owner);

  // 2. Auto-fund peer accounts from Owner so only ONE faucet claim is required
  await fundIfLow(acc.owner, "Relayer", acc.relayer, 1_500_000n, 2_500_000n);
  await fundIfLow(acc.owner, "MonitorAccount", acc.monitorAccount, 300_000n, 500_000n);
  await fundIfLow(acc.owner, "Signer2", acc.signer2, 150_000n, 250_000n);
  await fundIfLow(acc.owner, "Signer3", acc.signer3, 150_000n, 250_000n);

  // 3. Register PQC keys (with PoP) for peers
  await registerPqcIfNeeded("Relayer", acc.relayer);
  await registerPqcIfNeeded("MonitorAccount", acc.monitorAccount);
  await registerPqcIfNeeded("Signer2", acc.signer2);
  await registerPqcIfNeeded("Signer3", acc.signer3);

  // 4. Two-phase EVM window: Phase 1 = Unscoped window strictly for contract deployment, then CLOSE immediately
  console.log("\n[DEPLOY] Opening tight UNSCOPED EVM window for SpikeProbe deployment...");
  const openMsg = openEvmWindowMsg({
    sender: acc.owner.cosmos,
    blocks: 120,
    maxTxs: 2,
    maxValue: "2000000", // 2 QOR max (fees only)
  });
  const openRes = await broadcastNative(acc.owner, [openMsg], {
    signMode: "hybrid",
    gas: 350_000,
    memo: "attenua-spike: open unscoped deploy window",
  });
  if (openRes.code !== 0) {
    throw new Error(`Failed to open deploy window: code=${openRes.code} log=${openRes.rawLog}`);
  }
  console.log(`[DEPLOY] Unscoped deploy window opened: tx=${openRes.transactionHash}`);
  await sleep(6000); // Wait for block inclusion so EVM nonce advances cleanly

  const evmWallet = createEvmWalletClient(acc.owner.privateKey);
  const deployTxHash = await evmWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [],
    gas: 1_800_000n,
  });
  console.log(`[DEPLOY] SpikeProbe tx submitted: ${deployTxHash}`);
  const receipt = await evmPublic.waitForTransactionReceipt({ hash: deployTxHash });
  if (!receipt.contractAddress || receipt.status !== "success") {
    throw new Error(`SpikeProbe deploy failed: status=${receipt.status}`);
  }
  console.log(
    `[DEPLOY] SpikeProbe LIVE at ${receipt.contractAddress} (block=${receipt.blockNumber}, gasUsed=${receipt.gasUsed})`
  );

  // 5. Immediately close the unscoped deploy window
  const closeMsg = closeEvmWindowMsg(acc.owner.cosmos);
  const closeRes = await broadcastNative(acc.owner, [closeMsg], {
    signMode: "hybrid",
    gas: 300_000,
    memo: "attenua-spike: close deploy window immediately",
  });
  if (closeRes.code !== 0) {
    throw new Error(`Failed to close deploy window: code=${closeRes.code} log=${closeRes.rawLog}`);
  }
  await sleep(3500);
  const winAfter = await fetchEvmWindow({ rest: REST_URL, address: acc.owner.cosmos });
  console.log(
    `[DEPLOY] Deploy window closed: tx=${closeRes.transactionHash}, live=${winAfter.live}`
  );

  const deployment = {
    network: CHAIN_ID,
    deployedAt: new Date().toISOString(),
    spikeProbeAddress: receipt.contractAddress,
    deployTxHash,
    deployBlock: receipt.blockNumber.toString(),
    deployGasUsed: receipt.gasUsed.toString(),
    openWindowTx: openRes.transactionHash,
    closeWindowTx: closeRes.transactionHash,
    selectors: artifact.methodIdentifiers,
    accounts: {
      owner: { cosmos: acc.owner.cosmos, evm: acc.owner.evm },
      monitorAccount: { cosmos: acc.monitorAccount.cosmos, evm: acc.monitorAccount.evm },
      relayer: { cosmos: acc.relayer.cosmos, evm: acc.relayer.evm },
      signer2: { cosmos: acc.signer2.cosmos, evm: acc.signer2.evm },
      signer3: { cosmos: acc.signer3.cosmos, evm: acc.signer3.evm },
    },
  };

  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(deployment, null, 2));
  console.log(`\nSaved deployment metadata to ${DEPLOY_PATH}`);
  console.log('Next step: npm run spike');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
