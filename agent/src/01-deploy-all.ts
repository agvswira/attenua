import fs from "node:fs";
import {
  bank,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchAuthenticators,
  fetchEvmWindow,
  fetchPqcStatus,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { formatUnits, parseAbi } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT_FILE,
  ERC20_ABI,
  EVM_CHAIN_ID,
  FUSD_BANK_DENOM,
  FUSD_EVM_ADDRESS,
  FUSD_RULE_DENOM,
  REST_URL,
  broadcastNative,
  bytesToHex,
  convertCoinMsg,
  createEvmPublicClient,
  createEvmWalletClient,
  fetchUqorBalance,
  hexToBytes,
  loadContractArtifact,
  loadOrCreateSwarmAccounts,
  sleep,
} from "./config.js";

const GUARD_ABI = parseAbi([
  "function setExempt(address account, bool value, string calldata reason) external",
  "function renounceOwnership() external",
  "function owner() external view returns (address)",
  "function exempt(address account) external view returns (bool)",
]);

async function registerPqcIfNeeded(label: string, account: UnifiedAccount) {
  const status = await fetchPqcStatus({ rest: REST_URL, address: account.cosmos }).catch(() => null);
  if (status?.registered) {
    console.log(`[PQC] ${label} already registered.`);
    return;
  }
  const pop = signProofOfPossession({
    chainId: CHAIN_ID,
    account: account.cosmos,
    keypair: account.pqc,
  });
  const msg = buildRegisterPqcKeyMsg(account.cosmos, {
    pqcKeypair: account.pqc,
    ecdsaPubkey: hexToBytes(account.publicKey),
    proofOfPossession: pop,
  });
  const res = await broadcastNative(account, [msg], {
    signMode: "classical",
    gas: 400_000,
    memo: `attenua: register PQC (${label})`,
  });
  if (res.code !== 0) throw new Error(`PQC reg failed for ${label}: ${res.rawLog}`);
  console.log(`[PQC] ${label} registered with PoP: tx=${res.transactionHash}`);
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
    console.log(`[FUND] ${label} has ${formatUnits(bal, 6)} QOR.`);
    return;
  }
  const res = await broadcastNative(
    owner,
    [
      bank.send({
        fromAddress: owner.cosmos,
        toAddress: target.cosmos,
        amount: [{ denom: "uqor", amount: sendUqor.toString() }],
      }),
    ],
    { signMode: "hybrid", gas: 300_000, memo: `attenua: fund ${label}` }
  );
  if (res.code !== 0) throw new Error(`Fund ${label} failed: ${res.rawLog}`);
  console.log(`[FUND] Sent ${formatUnits(sendUqor, 6)} QOR to ${label}: tx=${res.transactionHash}`);
  await sleep(3500);
}

async function main() {
  const acc = await loadOrCreateSwarmAccounts();
  const evmPublic = createEvmPublicClient();
  const evmWallet = createEvmWalletClient(acc.owner.privateKey);

  const guardArt = loadContractArtifact("QoreChainHybridHolderGuard");
  const rwaVaultArt = loadContractArtifact("QoreChainRwaVault");
  const attenuaArt = loadContractArtifact("AttenuaVault");

  console.log(`=== Attenua Full Deployment on ${CHAIN_ID} (EVM ${EVM_CHAIN_ID}) ===\n`);

  // 1. Fund peer accounts from Owner (no extra faucet claims needed)
  await fundIfLow(acc.owner, "Relayer", acc.relayer, 12_000_000n, 15_000_000n);
  await fundIfLow(acc.owner, "MonitorAccount", acc.monitorAccount, 1_500_000n, 2_000_000n);
  await fundIfLow(acc.owner, "OrchestratorPqc", acc.orchestratorPqc, 200_000n, 300_000n);
  await fundIfLow(acc.owner, "Allocator", acc.allocator, 200_000n, 300_000n);
  await fundIfLow(acc.owner, "Payables", acc.payables, 200_000n, 300_000n);
  await fundIfLow(acc.owner, "Research", acc.research, 200_000n, 300_000n);
  await fundIfLow(acc.owner, "Vendor", acc.vendor, 200_000n, 300_000n);

  // 2. Register ML-DSA-87 with PoP for all PQC actors
  await registerPqcIfNeeded("Owner", acc.owner);
  await registerPqcIfNeeded("Relayer", acc.relayer);
  await registerPqcIfNeeded("MonitorAccount", acc.monitorAccount);
  await registerPqcIfNeeded("OrchestratorPqc", acc.orchestratorPqc);
  await registerPqcIfNeeded("Allocator", acc.allocator);
  await registerPqcIfNeeded("Payables", acc.payables);
  await registerPqcIfNeeded("Research", acc.research);
  await registerPqcIfNeeded("Vendor", acc.vendor);

  // 3. Ensure Owner holds >= 40 ERC-20 fUSD (convert from bank fUSD if needed)
  const fusdDecimals = await evmPublic.readContract({
    address: FUSD_EVM_ADDRESS,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  const oneFusd = 10n ** BigInt(fusdDecimals);
  const currentFusd = await evmPublic.readContract({
    address: FUSD_EVM_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [acc.owner.evm as `0x${string}`],
  });
  if (currentFusd < 40n * oneFusd) {
    console.log("\n[fUSD] Converting 40 bank fUSD -> ERC-20 fUSD...");
    const convRes = await broadcastNative(
      acc.owner,
      [convertCoinMsg(acc.owner.cosmos, acc.owner.evm, FUSD_BANK_DENOM, (40n * oneFusd).toString())],
      { signMode: "hybrid", gas: 1_200_000, memo: "attenua: convert 40 fUSD bank -> ERC20" }
    );
    if (convRes.code !== 0) throw new Error(`MsgConvertCoin failed: ${convRes.rawLog}`);
    console.log(`[fUSD] Converted 40 fUSD: tx=${convRes.transactionHash}`);
    await sleep(3500);
  }

  // 4. Phase 1 EVM Window: UNSCOPED strictly for 4 contract deployments -> CLOSE IMMEDIATELY
  console.log("\n[PHASE 1] Opening tight UNSCOPED EVM window for contract deployments...");
  const openDeployRes = await broadcastNative(
    acc.owner,
    [
      openEvmWindowMsg({
        sender: acc.owner.cosmos,
        blocks: 200,
        maxTxs: 5,
        maxValue: "10000000", // 10 QOR max fees
      }),
    ],
    { signMode: "hybrid", gas: 350_000, memo: "attenua: open unscoped deploy window" }
  );
  if (openDeployRes.code !== 0) throw new Error(`Open deploy window failed: ${openDeployRes.rawLog}`);
  console.log(`[PHASE 1] Unscoped window opened: tx=${openDeployRes.transactionHash}`);
  await sleep(6000);

  // Deploy 1: QoreChainHybridHolderGuard
  const guardTx = await evmWallet.deployContract({
    abi: guardArt.abi,
    bytecode: guardArt.bytecode,
    args: [acc.owner.evm],
    gas: 1_200_000n,
  });
  const guardRcpt = await evmPublic.waitForTransactionReceipt({ hash: guardTx });
  if (!guardRcpt.contractAddress || guardRcpt.status !== "success") throw new Error("Guard deploy failed");
  const guardAddr = guardRcpt.contractAddress;
  console.log(`[DEPLOY] QoreChainHybridHolderGuard = ${guardAddr} (gasUsed=${guardRcpt.gasUsed})`);

  // Deploy 2: LiquidityVault (QoreChainRwaVault ERC-4626)
  const liqTx = await evmWallet.deployContract({
    abi: rwaVaultArt.abi,
    bytecode: rwaVaultArt.bytecode,
    args: [FUSD_EVM_ADDRESS, "Attenua Liquidity fUSD", "aLiqUSD", guardAddr],
    gas: 2_400_000n,
  });
  const liqRcpt = await evmPublic.waitForTransactionReceipt({ hash: liqTx });
  if (!liqRcpt.contractAddress || liqRcpt.status !== "success") throw new Error("LiquidityVault deploy failed");
  const liquidityVaultAddr = liqRcpt.contractAddress;
  console.log(`[DEPLOY] LiquidityVault (ERC-4626)  = ${liquidityVaultAddr} (gasUsed=${liqRcpt.gasUsed})`);

  // Deploy 3: ReserveVault (QoreChainRwaVault ERC-4626)
  const resTx = await evmWallet.deployContract({
    abi: rwaVaultArt.abi,
    bytecode: rwaVaultArt.bytecode,
    args: [FUSD_EVM_ADDRESS, "Attenua Reserve fUSD", "aResUSD", guardAddr],
    gas: 2_400_000n,
  });
  const resRcpt = await evmPublic.waitForTransactionReceipt({ hash: resTx });
  if (!resRcpt.contractAddress || resRcpt.status !== "success") throw new Error("ReserveVault deploy failed");
  const reserveVaultAddr = resRcpt.contractAddress;
  console.log(`[DEPLOY] ReserveVault (ERC-4626)    = ${reserveVaultAddr} (gasUsed=${resRcpt.gasUsed})`);

  // Deploy 4: AttenuaVault v1.1
  const vaultTx = await evmWallet.deployContract({
    abi: attenuaArt.abi,
    bytecode: attenuaArt.bytecode,
    args: [FUSD_EVM_ADDRESS, liquidityVaultAddr, reserveVaultAddr, acc.owner.evm, acc.monitorAccount.evm],
    gas: 5_200_000n,
  });
  const vaultRcpt = await evmPublic.waitForTransactionReceipt({ hash: vaultTx });
  if (!vaultRcpt.contractAddress || vaultRcpt.status !== "success") throw new Error("AttenuaVault deploy failed");
  const attenuaVaultAddr = vaultRcpt.contractAddress;
  console.log(`[DEPLOY] AttenuaVault               = ${attenuaVaultAddr} (gasUsed=${vaultRcpt.gasUsed})`);

  // Close unscoped deploy window immediately
  const closeDeployRes = await broadcastNative(acc.owner, [closeEvmWindowMsg(acc.owner.cosmos)], {
    signMode: "hybrid",
    gas: 300_000,
    memo: "attenua: close unscoped deploy window",
  });
  console.log(`[PHASE 1] Unscoped window closed: tx=${closeDeployRes.transactionHash}`);
  await sleep(4000);

  // 5. Phase 2 EVM Window: SCOPED strictly to [guardAddr] -> setExempt(AttenuaVault) + renounceOwnership() -> CLOSE
  console.log("\n[PHASE 2] Opening SCOPED EVM window (allowedTargets=[guard]) to exempt AttenuaVault & renounce guard ownership...");
  const openScopedRes = await broadcastNative(
    acc.owner,
    [
      openEvmWindowMsg({
        sender: acc.owner.cosmos,
        blocks: 100,
        maxTxs: 3,
        maxValue: "2000000",
        allowedTargets: [guardAddr],
      }),
    ],
    { signMode: "hybrid", gas: 350_000, memo: "attenua: open scoped guard admin window" }
  );
  if (openScopedRes.code !== 0) throw new Error(`Open scoped window failed: ${openScopedRes.rawLog}`);
  await sleep(6000);

  const exemptTx = await evmWallet.writeContract({
    address: guardAddr,
    abi: GUARD_ABI,
    functionName: "setExempt",
    args: [attenuaVaultAddr, true, "AttenuaVault: controlled strictly by ML-DSA-87"],
    gas: 120_000n,
  });
  await evmPublic.waitForTransactionReceipt({ hash: exemptTx });

  const renounceTx = await evmWallet.writeContract({
    address: guardAddr,
    abi: GUARD_ABI,
    functionName: "renounceOwnership",
    args: [],
    gas: 80_000n,
  });
  await evmPublic.waitForTransactionReceipt({ hash: renounceTx });

  const closeScopedRes = await broadcastNative(acc.owner, [closeEvmWindowMsg(acc.owner.cosmos)], {
    signMode: "hybrid",
    gas: 300_000,
    memo: "attenua: close scoped guard admin window",
  });
  await sleep(3500);

  const guardOwnerAfter = await evmPublic.readContract({
    address: guardAddr,
    abi: GUARD_ABI,
    functionName: "owner",
  });
  const vaultExemptAfter = await evmPublic.readContract({
    address: guardAddr,
    abi: GUARD_ABI,
    functionName: "exempt",
    args: [attenuaVaultAddr],
  });
  const winAfter = await fetchEvmWindow({ rest: REST_URL, address: acc.owner.cosmos });
  console.log(
    `[PHASE 2] Guard hardened: exempt(AttenuaVault)=${vaultExemptAfter}, owner=${guardOwnerAfter} (renounced), window.live=${winAfter.live}`
  );

  // 6. Link Orchestrator (AA #1 — Owner Treasury, single-linked-key invariant!)
  // Revoke any stale active authenticators on Owner first
  const prevOwnerAuths = await fetchAuthenticators({ rest: REST_URL, address: acc.owner.cosmos }).catch(() => []);
  for (const a of prevOwnerAuths) {
    if (!a.revoked) {
      await broadcastNative(
        acc.owner,
        [
          revokeAuthenticatorMsg({
            owner: acc.owner.cosmos,
            account: acc.owner.cosmos,
            scheme: a.scheme as "ed25519" | "secp256k1",
            pubkey: hexToBytes(a.pubkeyHex),
          }),
        ],
        { signMode: "hybrid", gas: 300_000, memo: "attenua: revoke stale owner auth" }
      );
      await sleep(3000);
    }
  }

  const sels = attenuaArt.methodIdentifiers;
  const selSetRoot = `0x${sels["setRootMandate(address,uint256,uint16,uint16,uint8,uint8,uint64,uint64,uint64,bytes)"]}`;
  const selSetVendor = `0x${sels["setVendor(address,bool,uint64,uint64,bytes)"]}`;
  const selRegSub = `0x${sels["registerSubMandate(bytes32,bytes32,address,uint256,uint16,uint16,uint8,uint64,uint64,uint64,bytes)"]}`;
  const selReclaim = `0x${sels["reclaimSubMandate(bytes32,uint64,uint64,bytes)"]}`;
  const selAlloc = `0x${sels["executeAllocate(bytes32,uint256,bool,uint256,bool,uint64,uint64,bytes)"]}`;
  const selPay = `0x${sels["executePayInvoice(bytes32,bytes32,address,bytes32,uint256,uint64,uint64,bytes,bytes,bytes)"]}`;
  const selRevokeEpoch = `0x${sels["revokeRootEpoch(uint64,uint64,bytes)"]}`;
  const selUnfreeze = `0x${sels["unfreeze(uint64,uint64,bytes)"]}`;
  const selFreeze = `0x${sels["freeze(uint64,uint64,bytes)"]}`;
  const selForceReclaim = `0x${sels["forceReclaimDescendant(bytes32,uint64,uint64,bytes)"]}`;
  const selSetMonitor = `0x${sels["setMonitorSigner(address,uint64,uint64,bytes)"]}`;
  const selEmergRedeem = `0x${sels["emergencyRedeemVaults(address,uint64,uint64,bytes)"]}`;

  const expiryUnix = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
  const orchProof = signAuthenticatorLinkEd25519({
    chainId: CHAIN_ID,
    account: acc.owner.cosmos,
    privateKey: acc.orchestratorEdPriv,
  });

  const orchLinkRes = await broadcastNative(
    acc.owner,
    linkAuthenticatorMsgs({
      owner: acc.owner.cosmos,
      account: acc.owner.cosmos,
      chainId: CHAIN_ID,
      scheme: "ed25519",
      pubkey: orchProof.pubkey,
      permissions: ["evm"],
      expiryUnix,
      label: "attenua-orchestrator",
      possessionProof: orchProof.possessionProof,
      spendingRule: {
        id: "attenua-jit-and-vault",
        enabled: true,
        perTxLimit: "100000", // 0.1 QOR
        dailyLimit: "500000", // 0.5 QOR
        allowedDenoms: ["uqor", FUSD_RULE_DENOM],
        denomLimits: [
          {
            denom: FUSD_RULE_DENOM,
            perTxLimit: (10n * oneFusd).toString(), // 10 fUSD per-tx JIT cap
            dailyLimit: (25n * oneFusd).toString(), // 25 fUSD daily JIT cap
          },
        ],
        allowedEvmCalls: [
          `${attenuaVaultAddr}/${selSetRoot}`,
          `${attenuaVaultAddr}/${selSetVendor}`,
          `${attenuaVaultAddr}/${selRegSub}`,
          `${attenuaVaultAddr}/${selReclaim}`,
          `${attenuaVaultAddr}/${selAlloc}`,
          `${attenuaVaultAddr}/${selPay}`,
          `${attenuaVaultAddr}/${selRevokeEpoch}`,
          `${attenuaVaultAddr}/${selUnfreeze}`,
          `${attenuaVaultAddr}/${selForceReclaim}`,
          `${attenuaVaultAddr}/${selSetMonitor}`,
          `${attenuaVaultAddr}/${selEmergRedeem}`,
        ],
      },
    }),
    { signMode: "hybrid", gas: 600_000, memo: "attenua: link orchestrator (AA #1)" }
  );
  if (orchLinkRes.code !== 0) throw new Error(`Orchestrator link failed: ${orchLinkRes.rawLog}`);
  console.log(`[AA #1] Orchestrator linked (single-key invariant): tx=${orchLinkRes.transactionHash}`);
  await sleep(3500);

  // 7. Link Monitor (AA #2 — Isolated MonitorAccount, 0 fUSD, 1 uqor cap, freeze() ONLY)
  const prevMonAuths = await fetchAuthenticators({ rest: REST_URL, address: acc.monitorAccount.cosmos }).catch(() => []);
  for (const a of prevMonAuths) {
    if (!a.revoked) {
      await broadcastNative(
        acc.monitorAccount,
        [
          revokeAuthenticatorMsg({
            owner: acc.monitorAccount.cosmos,
            account: acc.monitorAccount.cosmos,
            scheme: a.scheme as "ed25519" | "secp256k1",
            pubkey: hexToBytes(a.pubkeyHex),
          }),
        ],
        { signMode: "hybrid", gas: 300_000, memo: "attenua: revoke stale monitor auth" }
      );
      await sleep(3000);
    }
  }

  const monProof = signAuthenticatorLinkEd25519({
    chainId: CHAIN_ID,
    account: acc.monitorAccount.cosmos,
    privateKey: acc.monitorEdPriv,
  });
  const monLinkRes = await broadcastNative(
    acc.monitorAccount,
    linkAuthenticatorMsgs({
      owner: acc.monitorAccount.cosmos,
      account: acc.monitorAccount.cosmos,
      chainId: CHAIN_ID,
      scheme: "ed25519",
      pubkey: monProof.pubkey,
      permissions: ["evm"],
      expiryUnix,
      label: "attenua-monitor-freeze-only",
      possessionProof: monProof.possessionProof,
      spendingRule: {
        id: "attenua-monitor-freeze",
        enabled: true,
        perTxLimit: "1",
        dailyLimit: "1",
        allowedDenoms: ["uqor"],
        allowedEvmCalls: [`${attenuaVaultAddr}/${selFreeze}`],
      },
    }),
    { signMode: "hybrid", gas: 550_000, memo: "attenua: link freeze-only monitor (AA #2)" }
  );
  if (monLinkRes.code !== 0) throw new Error(`Monitor link failed: ${monLinkRes.rawLog}`);
  console.log(`[AA #2] Monitor linked (freeze-only, 1 uqor, 0 fUSD): tx=${monLinkRes.transactionHash}`);

  // 8. Save public deployment manifest (zero secrets)
  const manifest = {
    network: CHAIN_ID,
    evmChainId: EVM_CHAIN_ID,
    deployedAt: new Date().toISOString(),
    compiler: attenuaArt.compiler,
    contracts: {
      fusd: FUSD_EVM_ADDRESS,
      holderGuard: {
        address: guardAddr,
        deployTx: guardTx,
        exemptTx,
        renounceOwnershipTx: renounceTx,
        ownerAfterRenounce: guardOwnerAfter,
        attenuaVaultExempt: vaultExemptAfter,
      },
      liquidityVault: { address: liquidityVaultAddr, deployTx: liqTx },
      reserveVault: { address: reserveVaultAddr, deployTx: resTx },
      attenuaVault: {
        address: attenuaVaultAddr,
        deployTx: vaultTx,
        bytecodeHash: attenuaArt.bytecodeHash,
      },
    },
    windows: {
      deployOpenTx: openDeployRes.transactionHash,
      deployCloseTx: closeDeployRes.transactionHash,
      guardAdminOpenTx: openScopedRes.transactionHash,
      guardAdminCloseTx: closeScopedRes.transactionHash,
    },
    abstractAccounts: {
      ownerTreasuryAA1: {
        cosmos: acc.owner.cosmos,
        evm: acc.owner.evm,
        orchestratorPubkeyHex: bytesToHex(orchProof.pubkey),
        linkTx: orchLinkRes.transactionHash,
      },
      monitorAA2: {
        cosmos: acc.monitorAccount.cosmos,
        evm: acc.monitorAccount.evm,
        monitorPubkeyHex: bytesToHex(monProof.pubkey),
        linkTx: monLinkRes.transactionHash,
      },
    },
    actors: {
      relayer: { cosmos: acc.relayer.cosmos, evm: acc.relayer.evm },
      orchestratorPqc: { cosmos: acc.orchestratorPqc.cosmos, evm: acc.orchestratorPqc.evm },
      allocator: { cosmos: acc.allocator.cosmos, evm: acc.allocator.evm },
      payables: { cosmos: acc.payables.cosmos, evm: acc.payables.evm },
      research: { cosmos: acc.research.cosmos, evm: acc.research.evm },
      vendor: { cosmos: acc.vendor.cosmos, evm: acc.vendor.evm },
      unlistedAttacker: { cosmos: acc.unlistedAttacker.cosmos, evm: acc.unlistedAttacker.evm },
    },
    selectors: {
      setRootMandate: selSetRoot,
      setVendor: selSetVendor,
      registerSubMandate: selRegSub,
      reclaimSubMandate: selReclaim,
      executeAllocate: selAlloc,
      executePayInvoice: selPay,
      revokeRootEpoch: selRevokeEpoch,
      unfreeze: selUnfreeze,
      freeze: selFreeze,
      forceReclaimDescendant: selForceReclaim,
      setMonitorSigner: selSetMonitor,
      emergencyRedeemVaults: selEmergRedeem,
    },
  };

  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(manifest, null, 2));
  console.log(`\nSaved public deployment manifest -> ${DEPLOYMENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
