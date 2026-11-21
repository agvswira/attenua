import crypto from "node:crypto";
import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  bank,
  closeEvmWindowMsg,
  decodeAuthenticatorExecutions,
  evmAuthSignBytes,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchEvmWindow,
  fetchSpendingRules,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  pqcSign,
  registerAuthenticatorMsg,
  resolveEvmAuthDigestVersion,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { encodeFunctionData, formatUnits, parseAbi } from "viem";
import {
  CHAIN_ID,
  DEPLOY_PATH,
  ERC20_ABI,
  EVM_CHAIN_ID,
  FUSD_BANK_DENOM,
  FUSD_EVM_ADDRESS,
  FUSD_RULE_DENOM,
  REPORT_PATH,
  REST_URL,
  broadcastNative,
  bytesToHex,
  convertCoinMsg,
  createEvmPublicClient,
  createEvmWalletClient,
  fetchTxRest,
  fetchUqorBalance,
  hexToBytes,
  loadProbeArtifact,
  loadSpikeAccounts,
  sleep,
} from "./common.js";

const PROBE_ABI = parseAbi([
  "function whoCalled() external returns (address)",
  "function allowedAction() external returns (uint256)",
  "function forbiddenAction() external returns (uint256)",
  "function freeze() external returns (bool)",
  "function lastCaller() external view returns (address)",
  "function allowedCalls() external view returns (uint256)",
  "function forbiddenCalls() external view returns (uint256)",
  "function frozen() external view returns (bool)",
  "function freezeCount() external view returns (uint256)",
  "function verifiedCount() external view returns (uint256)",
  "function probeInactivePrecompile(address account, uint256 amount) external view returns (uint256, bool)",
  "function verifyBatch((address signer, bytes signature, bytes message)[] checks) external returns (bool)",
]);

interface SpikeRecord {
  id: string;
  title: string;
  passed: boolean;
  txHash?: string;
  summary: string;
  details: string;
}

async function relayExecuteEvm(params: {
  relayer: UnifiedAccount;
  accountCosmos: string;
  authPriv: Uint8Array;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  evmGasLimit: bigint;
  cosmosGas?: number;
  digestVersion: "v1" | "v2";
  memo: string;
}) {
  const authPub = ed25519.getPublicKey(params.authPriv);
  const { nonce } = await fetchAuthNonce({
    rest: REST_URL,
    address: params.accountCosmos,
    pubkey: authPub,
  });
  const dataBytes = hexToBytes(params.data);
  const value = params.value ?? "0";
  const digest =
    params.digestVersion === "v2"
      ? evmAuthSignBytesV2({
          chainId: CHAIN_ID,
          account: params.accountCosmos,
          pubkey: authPub,
          to: params.to,
          value,
          data: dataBytes,
          nonce,
          gasLimit: params.evmGasLimit,
        })
      : evmAuthSignBytes({
          chainId: CHAIN_ID,
          account: params.accountCosmos,
          pubkey: authPub,
          to: params.to,
          value,
          data: dataBytes,
          nonce,
        });

  const sig = ed25519.sign(digest, params.authPriv);
  const msg = executeEvmMsg({
    relayer: params.relayer.cosmos,
    account: params.accountCosmos,
    scheme: "ed25519",
    pubkey: authPub,
    signature: sig,
    to: params.to,
    value,
    data: dataBytes,
    gasLimit: params.evmGasLimit,
    nonce,
  });

  const res = await broadcastNative(params.relayer, [msg], {
    signMode: "hybrid",
    gas: params.cosmosGas ?? Number(params.evmGasLimit + 700_000n),
    memo: params.memo,
  });
  await sleep(3000);

  const restTx = await fetchTxRest(res.transactionHash);
  const decoded = decodeAuthenticatorExecutions(
    {
      msgResponses: res.msgResponses,
      events: restTx.events,
    },
    [msg]
  );
  const failedEvent = restTx.events.find((e) => e.type === "abstractaccount_execution_failed");
  const failReason =
    failedEvent?.attributes.find((a) => a.key === "reason")?.value ??
    decoded[0]?.reason ??
    decoded[0]?.vmError ??
    "";

  return {
    txHash: res.transactionHash,
    outerCode: restTx.code,
    cosmosGasUsed: restTx.gasUsed,
    decoded: decoded[0] ?? null,
    hasFailedEvent: Boolean(failedEvent),
    failReason,
    rawLog: restTx.rawLog,
  };
}

async function main() {
  if (!fs.existsSync(DEPLOY_PATH)) {
    throw new Error(`Missing ${DEPLOY_PATH}. Run "npm run deploy" first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf8")) as {
    spikeProbeAddress: `0x${string}`;
    selectors: Record<string, string>;
  };
  const probeAddr = deployment.spikeProbeAddress;
  const acc = await loadSpikeAccounts();
  const evm = createEvmPublicClient();
  const artifact = loadProbeArtifact();
  const digestVersion = await resolveEvmAuthDigestVersion({ rest: REST_URL });

  const selWhoCalled = `0x${artifact.methodIdentifiers["whoCalled()"]}`;
  const selAllowed = `0x${artifact.methodIdentifiers["allowedAction()"]}`;
  const selFreeze = `0x${artifact.methodIdentifiers["freeze()"]}`;
  const selVerifyBatch = `0x${artifact.methodIdentifiers["verifyBatch((address,bytes,bytes)[])"]}`;

  console.log(`=== Attenua Step 0 Testnet Spike on ${CHAIN_ID} ===`);
  console.log(`SpikeProbe     : ${probeAddr}`);
  console.log(`Auth Digest    : ${digestVersion}`);
  console.log(`Selectors      : whoCalled=${selWhoCalled}, allowed=${selAllowed}, freeze=${selFreeze}, verifyBatch=${selVerifyBatch}\n`);

  const records: SpikeRecord[] = [];
  const expiryUnix = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

  // Read fUSD decimals & owner balance; auto-convert 10 bank fUSD -> ERC-20 fUSD if needed
  const fusdDecimals = await evm.readContract({
    address: FUSD_EVM_ADDRESS,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  let ownerFusdStart = await evm.readContract({
    address: FUSD_EVM_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [acc.owner.evm as `0x${string}`],
  });
  const oneFusd = 10n ** BigInt(fusdDecimals);
  if (ownerFusdStart < 5n * oneFusd) {
    console.log("[SETUP] Converting 10 bank fUSD -> ERC-20 fUSD via MsgConvertCoin...");
    const convMsg = convertCoinMsg(
      acc.owner.cosmos,
      acc.owner.evm,
      FUSD_BANK_DENOM,
      (10n * oneFusd).toString()
    );
    const convRes = await broadcastNative(acc.owner, [convMsg], {
      signMode: "hybrid",
      gas: 1_200_000,
      memo: "attenua-spike: convert 10 fUSD bank -> ERC20",
    });
    if (convRes.code !== 0) {
      console.warn(`[WARN] MsgConvertCoin failed: code=${convRes.code} log=${convRes.rawLog}`);
    } else {
      console.log(`[SETUP] Converted 10 fUSD -> ERC-20: tx=${convRes.transactionHash}`);
      await sleep(3500);
      ownerFusdStart = await evm.readContract({
        address: FUSD_EVM_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [acc.owner.evm as `0x${string}`],
      });
    }
  }
  console.log(`Owner fUSD balance: ${formatUnits(ownerFusdStart, fusdDecimals)} fUSD (raw=${ownerFusdStart})`);

  // Ensure Relayer has plenty of QOR for ~14 MsgExecuteEVM broadcasts
  const relayerBal = await fetchUqorBalance(acc.relayer.cosmos);
  if (relayerBal < 6_000_000n) {
    const topUpMsg = bank.send({
      fromAddress: acc.owner.cosmos,
      toAddress: acc.relayer.cosmos,
      amount: [{ denom: "uqor", amount: "8000000" }],
    });
    const topRes = await broadcastNative(acc.owner, [topUpMsg], {
      signMode: "hybrid",
      gas: 300_000,
      memo: "attenua-spike: top up relayer gas",
    });
    console.log(`[SETUP] Topped up Relayer (+8 QOR): tx=${topRes.transactionHash}`);
    await sleep(3500);
  }

  // Link Orchestrator ed25519 authenticator to Owner (AA #1) if not already active
  // Allowed: fUSD transfers capped at 1.0 fUSD/tx, 2.0 fUSD/day + SpikeProbe selectors (whoCalled, allowedAction, verifyBatch)
  const twoFusd = 2n * oneFusd;
  const orchProof = signAuthenticatorLinkEd25519({
    chainId: CHAIN_ID,
    account: acc.owner.cosmos,
    privateKey: acc.orchestratorEdPriv,
  });
  const orchPubHex = Buffer.from(orchProof.pubkey).toString("hex").toLowerCase();
  const existingOwnerAuths = await fetchAuthenticators({ rest: REST_URL, address: acc.owner.cosmos }).catch(() => []);
  const orchAlreadyActive = existingOwnerAuths.some(
    (a) => a.pubkeyHex.toLowerCase() === orchPubHex && !a.revoked
  );

  if (!orchAlreadyActive) {
    const orchLinkMsgs = linkAuthenticatorMsgs({
      owner: acc.owner.cosmos,
      account: acc.owner.cosmos,
      chainId: CHAIN_ID,
      scheme: "ed25519",
      pubkey: orchProof.pubkey,
      permissions: ["evm"],
      expiryUnix,
      label: "attenua-spike-orchestrator",
      possessionProof: orchProof.possessionProof,
      spendingRule: {
        id: "orchestrator-jit-and-exec",
        enabled: true,
        perTxLimit: "100000", // 0.1 QOR
        dailyLimit: "500000", // 0.5 QOR
        allowedDenoms: ["uqor", FUSD_RULE_DENOM],
        denomLimits: [
          {
            denom: FUSD_RULE_DENOM,
            perTxLimit: oneFusd.toString(),
            dailyLimit: twoFusd.toString(),
          },
        ],
        allowedEvmCalls: [
          `${probeAddr}/${selWhoCalled}`,
          `${probeAddr}/${selAllowed}`,
          `${probeAddr}/${selVerifyBatch}`,
        ],
      },
    });

    const linkOrchRes = await broadcastNative(acc.owner, orchLinkMsgs, {
      signMode: "hybrid",
      gas: 550_000,
      memo: "attenua-spike: link orchestrator authenticator",
    });
    if (linkOrchRes.code !== 0) {
      throw new Error(`Orchestrator link failed: code=${linkOrchRes.code} log=${linkOrchRes.rawLog}`);
    }
    console.log(`[SETUP] Orchestrator linked to Owner AA #1: tx=${linkOrchRes.transactionHash}\n`);
    await sleep(4000);
  } else {
    console.log("[SETUP] Orchestrator already active on Owner AA #1 — reusing.\n");
  }

  // =========================================================================
  // S1: Confirm msg.sender during MsgExecuteEVM
  // =========================================================================
  {
    const data = encodeFunctionData({ abi: PROBE_ABI, functionName: "whoCalled" });
    const r = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S1 whoCalled",
    });
    const observed = await evm.readContract({
      address: probeAddr,
      abi: PROBE_ABI,
      functionName: "lastCaller",
    });
    const matchesOwner = observed.toLowerCase() === acc.owner.evm.toLowerCase();
    const ok = r.outerCode === 0 && !r.hasFailedEvent && matchesOwner;
    records.push({
      id: "S1",
      title: "msg.sender identity under MsgExecuteEVM",
      passed: ok,
      txHash: r.txHash,
      summary: `Observed msg.sender = ${observed} (equals Owner 0x=${matchesOwner})`,
      details: `outerCode=${r.outerCode}, failedEvent=${r.hasFailedEvent}, evmGasUsed=${r.decoded?.gasUsed ?? "?"}`,
    });
    console.log(`[S1] ${ok ? "PASS" : "FAIL"} — observed msg.sender=${observed} (owner=${acc.owner.evm}) tx=${r.txHash}`);
  }

  // =========================================================================
  // S2: Direct fUSD.transfer + denom_limits (under cap PASS, over cap FAIL)
  // =========================================================================
  if (ownerFusdStart >= 2n * oneFusd) {
    const halfFusd = oneFusd / 2n;
    const overFusd = oneFusd + 1n;
    const balBefore = await evm.readContract({
      address: FUSD_EVM_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [probeAddr],
    });

    const okData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [probeAddr, halfFusd],
    });
    const rPass = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: FUSD_EVM_ADDRESS,
      data: okData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S2A fUSD under cap",
    });
    const balAfterPass = await evm.readContract({
      address: FUSD_EVM_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [probeAddr],
    });

    const overData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [probeAddr, overFusd],
    });
    const rFail = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: FUSD_EVM_ADDRESS,
      data: overData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S2B fUSD over cap",
    });
    const balAfterFail = await evm.readContract({
      address: FUSD_EVM_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [probeAddr],
    });

    const passed =
      !rPass.hasFailedEvent &&
      balAfterPass === balBefore + halfFusd &&
      rFail.outerCode === 0 &&
      rFail.hasFailedEvent &&
      balAfterFail === balAfterPass;

    records.push({
      id: "S2",
      title: "Direct fUSD.transfer bounded by x/abstractaccount denom_limits",
      passed,
      txHash: `${rPass.txHash} / ${rFail.txHash}`,
      summary: `0.5 fUSD succeeded (delta=+${balAfterPass - balBefore}); >1.0 fUSD refused with outer code=0 + abstractaccount_execution_failed (delta=0)`,
      details: `refusalReason="${rFail.failReason}"`,
    });
    console.log(`[S2] ${passed ? "PASS" : "FAIL"} — under-cap ok (${rPass.txHash}), over-cap refused (${rFail.txHash}) reason="${rFail.failReason}"`);
  } else {
    records.push({
      id: "S2",
      title: "Direct fUSD.transfer bounded by x/abstractaccount denom_limits",
      passed: false,
      summary: `SKIPPED: Owner ERC-20 fUSD balance is ${formatUnits(ownerFusdStart, fusdDecimals)} (< 2 fUSD). Convert bank fUSD or claim faucet.`,
      details: "Re-run after funding Owner with >= 2 ERC-20 fUSD.",
    });
    console.log(`[S2] SKIPPED — Owner needs >= 2 ERC-20 fUSD (currently ${formatUnits(ownerFusdStart, fusdDecimals)})`);
  }

  // =========================================================================
  // S3: Selector lock (allowedAction PASS vs forbiddenAction FAIL)
  // =========================================================================
  {
    const allowData = encodeFunctionData({ abi: PROBE_ABI, functionName: "allowedAction" });
    const forbidData = encodeFunctionData({ abi: PROBE_ABI, functionName: "forbiddenAction" });

    const rAllow = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: allowData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S3A allowedAction",
    });
    const rForbid = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: forbidData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S3B forbiddenAction",
    });

    const allowedCount = await evm.readContract({ address: probeAddr, abi: PROBE_ABI, functionName: "allowedCalls" });
    const forbiddenCount = await evm.readContract({ address: probeAddr, abi: PROBE_ABI, functionName: "forbiddenCalls" });

    const passed =
      !rAllow.hasFailedEvent &&
      allowedCount >= 1n &&
      rForbid.outerCode === 0 &&
      rForbid.hasFailedEvent &&
      forbiddenCount === 0n;

    records.push({
      id: "S3",
      title: "Selector-level allowed_evm_calls enforcement",
      passed,
      txHash: `${rAllow.txHash} / ${rForbid.txHash}`,
      summary: `allowedAction=${allowedCount}, forbiddenAction=${forbiddenCount} (refused on-chain)`,
      details: `refusalReason="${rForbid.failReason}"`,
    });
    console.log(`[S3] ${passed ? "PASS" : "FAIL"} — allowed=${allowedCount}, forbidden=${forbiddenCount}, reason="${rForbid.failReason}"`);
  }

  // =========================================================================
  // S4: Dedicated MonitorAccount (AA #2) freeze-only + cap=0 vs cap=1 + isolation
  // =========================================================================
  {
    const monProof = signAuthenticatorLinkEd25519({
      chainId: CHAIN_ID,
      account: acc.monitorAccount.cosmos,
      privateKey: acc.monitorEdPriv,
    });

    // S4a: Check whether cap=0 is rejected client-side / chain-side
    let zeroCapOutcome = "unexpectedly accepted";
    try {
      const zeroMsgs = linkAuthenticatorMsgs({
        owner: acc.monitorAccount.cosmos,
        account: acc.monitorAccount.cosmos,
        chainId: CHAIN_ID,
        scheme: "ed25519",
        pubkey: monProof.pubkey,
        permissions: ["evm"],
        expiryUnix,
        label: "attenua-spike-monitor-zero",
        possessionProof: monProof.possessionProof,
        spendingRule: {
          id: "monitor-zero",
          enabled: true,
          perTxLimit: "0",
          dailyLimit: "0",
          allowedDenoms: ["uqor"],
          allowedEvmCalls: [`${probeAddr}/${selFreeze}`],
        },
      });
      const zRes = await broadcastNative(acc.monitorAccount, zeroMsgs, {
        signMode: "hybrid",
        gas: 450_000,
        memo: "attenua-spike: S4a test zero cap",
      });
      zeroCapOutcome = `broadcast code=${zRes.code} log=${zRes.rawLog}`;
    } catch (e) {
      zeroCapOutcome = `rejected before broadcast: ${(e as Error).message}`;
    }

    // S4b: Link Monitor on dedicated MonitorAccount (AA #2) with 1 uqor cap + freeze selector ONLY
    const monMsgs = linkAuthenticatorMsgs({
      owner: acc.monitorAccount.cosmos,
      account: acc.monitorAccount.cosmos,
      chainId: CHAIN_ID,
      scheme: "ed25519",
      pubkey: monProof.pubkey,
      permissions: ["evm"],
      expiryUnix,
      label: "attenua-spike-monitor",
      possessionProof: monProof.possessionProof,
      spendingRule: {
        id: "monitor-freeze-only",
        enabled: true,
        perTxLimit: "1",
        dailyLimit: "1",
        allowedDenoms: ["uqor"],
        allowedEvmCalls: [`${probeAddr}/${selFreeze}`],
      },
    });
    const linkMonRes = await broadcastNative(acc.monitorAccount, monMsgs, {
      signMode: "hybrid",
      gas: 500_000,
      memo: "attenua-spike: S4b link monitor freeze-only",
    });
    if (linkMonRes.code !== 0) {
      throw new Error(`Monitor link failed: code=${linkMonRes.code} log=${linkMonRes.rawLog}`);
    }
    await sleep(4000);

    const freezeData = encodeFunctionData({ abi: PROBE_ABI, functionName: "freeze" });
    const allowData = encodeFunctionData({ abi: PROBE_ABI, functionName: "allowedAction" });

    const rFreeze = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: acc.monitorEdPriv,
      to: probeAddr,
      data: freezeData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S4c monitor freeze()",
    });
    const rMonOther = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: acc.monitorEdPriv,
      to: probeAddr,
      data: allowData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S4d monitor forbidden selector",
    });

    const isFrozen = await evm.readContract({ address: probeAddr, abi: PROBE_ABI, functionName: "frozen" });
    const passed = !rFreeze.hasFailedEvent && isFrozen && rMonOther.hasFailedEvent;
    records.push({
      id: "S4",
      title: "Dedicated freeze-only Monitor authenticator (AA #2) & cap=0 vs cap=1 uqor",
      passed,
      txHash: `${rFreeze.txHash} / ${rMonOther.txHash}`,
      summary: `cap=0: (${zeroCapOutcome}); cap=1 uqor: freeze() succeeded (frozen=${isFrozen}), non-freeze selector refused`,
      details: `nonFreezeReason="${rMonOther.failReason}"`,
    });
    console.log(`[S4] ${passed ? "PASS" : "FAIL"} — zeroCap=[${zeroCapOutcome}], freeze=${isFrozen}, otherSelectorRefused=${rMonOther.hasFailedEvent}`);
  }

  // =========================================================================
  // S5: PqcVerifier wrapper (1x, 2x, 3x live gas) + forged sig + inactive 0x0B02
  // =========================================================================
  {
    const msg1 = new TextEncoder().encode(`attenua-spike-v1|${EVM_CHAIN_ID}|${probeAddr}|check-1`);
    const msg2 = new TextEncoder().encode(`attenua-spike-v1|${EVM_CHAIN_ID}|${probeAddr}|check-2`);
    const msg3 = new TextEncoder().encode(`attenua-spike-v1|${EVM_CHAIN_ID}|${probeAddr}|check-3`);

    const sig1 = pqcSign(acc.owner.pqc.secretKey, msg1);
    const sig2 = pqcSign(acc.signer2.pqc.secretKey, msg2);
    const sig3 = pqcSign(acc.signer3.pqc.secretKey, msg3);

    const check1 = { signer: acc.owner.evm as `0x${string}`, signature: bytesToHex(sig1), message: bytesToHex(msg1) };
    const check2 = { signer: acc.signer2.evm as `0x${string}`, signature: bytesToHex(sig2), message: bytesToHex(msg2) };
    const check3 = { signer: acc.signer3.evm as `0x${string}`, signature: bytesToHex(sig3), message: bytesToHex(msg3) };

    const d1 = encodeFunctionData({ abi: PROBE_ABI, functionName: "verifyBatch", args: [[check1]] });
    const d2 = encodeFunctionData({ abi: PROBE_ABI, functionName: "verifyBatch", args: [[check1, check2]] });
    const d3 = encodeFunctionData({ abi: PROBE_ABI, functionName: "verifyBatch", args: [[check1, check2, check3]] });

    const r1 = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: d1,
      evmGasLimit: 400_000n,
      digestVersion,
      memo: "attenua-spike: S5A 1x ML-DSA-87",
    });
    const r2 = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: d2,
      evmGasLimit: 750_000n,
      digestVersion,
      memo: "attenua-spike: S5B 2x ML-DSA-87",
    });
    const r3 = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: d3,
      evmGasLimit: 1_100_000n,
      digestVersion,
      memo: "attenua-spike: S5C 3x ML-DSA-87",
    });

    // Forged signature (1 bit flipped)
    const badSig = new Uint8Array(sig1);
    badSig[0] ^= 0xff;
    const badCheck = { signer: acc.owner.evm as `0x${string}`, signature: bytesToHex(badSig), message: bytesToHex(msg1) };
    const dBad = encodeFunctionData({ abi: PROBE_ABI, functionName: "verifyBatch", args: [[badCheck]] });
    const rBad = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: probeAddr,
      data: dBad,
      evmGasLimit: 400_000n,
      digestVersion,
      memo: "attenua-spike: S5D forged ML-DSA-87",
    });

    // Inactive precompile 0x...0B02 fail-closed check via eth_call
    let inactiveFailedClosed = false;
    let inactiveErr = "";
    try {
      await evm.readContract({
        address: probeAddr,
        abi: PROBE_ABI,
        functionName: "probeInactivePrecompile",
        args: [acc.owner.evm as `0x${string}`, 100n],
      });
    } catch (e) {
      inactiveFailedClosed = true;
      inactiveErr = (e as Error).message.slice(0, 140);
    }

    const passed =
      !r1.hasFailedEvent &&
      !r2.hasFailedEvent &&
      !r3.hasFailedEvent &&
      rBad.hasFailedEvent &&
      inactiveFailedClosed;

    records.push({
      id: "S5",
      title: "PqcVerifier wrapper (1x / 2x / 3x gas benchmarks, forged sig, inactive 0x0B02)",
      passed,
      txHash: `1x=${r1.txHash}, 2x=${r2.txHash}, 3x=${r3.txHash}, bad=${rBad.txHash}`,
      summary: `EVM gasUsed: 1x=${r1.decoded?.gasUsed ?? "?"} | 2x=${r2.decoded?.gasUsed ?? "?"} | 3x=${r3.decoded?.gasUsed ?? "?"}; forgedSigRefused=${rBad.hasFailedEvent}; inactive0x0B02FailClosed=${inactiveFailedClosed}`,
      details: `badSigReason="${rBad.failReason}"; inactive0x0B02="${inactiveErr}"`,
    });
    console.log(
      `[S5] ${passed ? "PASS" : "FAIL"} — gas 1x=${r1.decoded?.gasUsed}, 2x=${r2.decoded?.gasUsed}, 3x=${r3.decoded?.gasUsed}, badRefused=${rBad.hasFailedEvent}, 0x0B02FailClosed=${inactiveFailedClosed}`
    );
  }

  // =========================================================================
  // S6: Instant MsgRevokeAuthenticator
  // =========================================================================
  {
    const orchPub = ed25519.getPublicKey(acc.orchestratorEdPriv);
    const revMsg = revokeAuthenticatorMsg({
      owner: acc.owner.cosmos,
      account: acc.owner.cosmos,
      scheme: "ed25519",
      pubkey: orchPub,
    });
    const revRes = await broadcastNative(acc.owner, [revMsg], {
      signMode: "hybrid",
      gas: 300_000,
      memo: "attenua-spike: S6 revoke orchestrator",
    });
    if (revRes.code !== 0) {
      throw new Error(`Revoke failed: code=${revRes.code} log=${revRes.rawLog}`);
    }
    await sleep(3500);

    let postRevokeRejected = false;
    let postRevokeDetail = "";
    try {
      const data = encodeFunctionData({ abi: PROBE_ABI, functionName: "whoCalled" });
      const rAfter = await relayExecuteEvm({
        relayer: acc.relayer,
        accountCosmos: acc.owner.cosmos,
        authPriv: acc.orchestratorEdPriv,
        to: probeAddr,
        data,
        evmGasLimit: 120_000n,
        digestVersion,
        memo: "attenua-spike: S6 post-revoke attempt",
      });
      postRevokeRejected = rAfter.outerCode !== 0 || rAfter.hasFailedEvent;
      postRevokeDetail = `outerCode=${rAfter.outerCode}, failReason="${rAfter.failReason}", rawLog="${rAfter.rawLog.slice(0, 140)}"`;
    } catch (e) {
      postRevokeRejected = true;
      postRevokeDetail = `rejected at CheckTx/broadcast: ${(e as Error).message.slice(0, 160)}`;
    }

    records.push({
      id: "S6",
      title: "Instant MsgRevokeAuthenticator kill-switch",
      passed: postRevokeRejected,
      txHash: revRes.transactionHash,
      summary: `Post-revoke MsgExecuteEVM rejected immediately=${postRevokeRejected}`,
      details: postRevokeDetail,
    });
    console.log(`[S6] ${postRevokeRejected ? "PASS" : "FAIL"} — revokeTx=${revRes.transactionHash} (${postRevokeDetail})`);
  }

  // =========================================================================
  // S7: Scoped EVM Window (allowedTargets=[SpikeProbe], wrong target rejected, immediate close)
  // =========================================================================
  {
    const openScoped = openEvmWindowMsg({
      sender: acc.owner.cosmos,
      blocks: 60,
      maxTxs: 2,
      maxValue: "1000000",
      allowedTargets: [probeAddr],
    });
    const openRes = await broadcastNative(acc.owner, [openScoped], {
      signMode: "hybrid",
      gas: 350_000,
      memo: "attenua-spike: S7 open scoped window",
    });
    if (openRes.code !== 0) {
      throw new Error(`Open scoped window failed: code=${openRes.code} log=${openRes.rawLog}`);
    }
    await sleep(6000);

    const evmWallet = createEvmWalletClient(acc.owner.privateKey);
    const allowedTx = await evmWallet.writeContract({
      address: probeAddr,
      abi: PROBE_ABI,
      functionName: "whoCalled",
      gas: 100_000n,
    });
    const allowedRcpt = await evm.waitForTransactionReceipt({ hash: allowedTx });

    let unlistedRejected = false;
    let unlistedErr = "";
    try {
      await evmWallet.sendTransaction({
        to: acc.signer2.evm as `0x${string}`,
        value: 1n,
        gas: 30_000n,
      });
    } catch (e) {
      unlistedRejected = true;
      unlistedErr = (e as Error).message.slice(0, 160);
    }

    const closeRes = await broadcastNative(acc.owner, [closeEvmWindowMsg(acc.owner.cosmos)], {
      signMode: "hybrid",
      gas: 300_000,
      memo: "attenua-spike: S7 close scoped window",
    });
    await sleep(3500);
    const winFinal = await fetchEvmWindow({ rest: REST_URL, address: acc.owner.cosmos });

    const passed = allowedRcpt.status === "success" && unlistedRejected && !winFinal.live;
    records.push({
      id: "S7",
      title: "Scoped EVM Window (allowedTargets + unlisted rejection + immediate close)",
      passed,
      txHash: `open=${openRes.transactionHash}, call=${allowedTx}, close=${closeRes.transactionHash}`,
      summary: `Scoped call=${allowedRcpt.status}, unlistedTargetRejected=${unlistedRejected}, closedLive=${winFinal.live}`,
      details: `unlistedErr="${unlistedErr}"`,
    });
    console.log(`[S7] ${passed ? "PASS" : "FAIL"} — allowed=${allowedRcpt.status}, unlistedRejected=${unlistedRejected}, finalLive=${winFinal.live}`);
  }

  // =========================================================================
  // S8: Two linked keys on ONE account share the same account-wide spending rule
  //     (Proves why Owner treasury account must have at most ONE linked key)
  // =========================================================================
  {
    const secondPriv = crypto.randomBytes(32);
    const secondProof = signAuthenticatorLinkEd25519({
      chainId: CHAIN_ID,
      account: acc.monitorAccount.cosmos,
      privateKey: secondPriv,
    });

    const regSecond = registerAuthenticatorMsg({
      owner: acc.monitorAccount.cosmos,
      account: acc.monitorAccount.cosmos,
      scheme: "ed25519",
      pubkey: secondProof.pubkey,
      permissions: ["evm"],
      expiryUnix,
      label: "attenua-spike-second-key",
      possessionProof: secondProof.possessionProof,
    });
    const regRes = await broadcastNative(acc.monitorAccount, [regSecond], {
      signMode: "hybrid",
      gas: 400_000,
      memo: "attenua-spike: S8 link second key to MonitorAccount",
    });
    if (regRes.code !== 0) {
      throw new Error(`S8 second key register failed: code=${regRes.code} log=${regRes.rawLog}`);
    }
    await sleep(3500);

    const rulesView = await fetchSpendingRules({ rest: REST_URL, address: acc.monitorAccount.cosmos });
    const freezeData = encodeFunctionData({ abi: PROBE_ABI, functionName: "freeze" });
    const allowData = encodeFunctionData({ abi: PROBE_ABI, functionName: "allowedAction" });

    const rSecondFreeze = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: secondPriv,
      to: probeAddr,
      data: freezeData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S8 second key inherits freeze rule",
    });
    const rSecondForbid = await relayExecuteEvm({
      relayer: acc.relayer,
      accountCosmos: acc.monitorAccount.cosmos,
      authPriv: secondPriv,
      to: probeAddr,
      data: allowData,
      evmGasLimit: 120_000n,
      digestVersion,
      memo: "attenua-spike: S8 second key refused on non-freeze selector",
    });

    // Clean up: revoke second ephemeral key immediately
    const cleanupRev = revokeAuthenticatorMsg({
      owner: acc.monitorAccount.cosmos,
      account: acc.monitorAccount.cosmos,
      scheme: "ed25519",
      pubkey: secondProof.pubkey,
    });
    await broadcastNative(acc.monitorAccount, [cleanupRev], {
      signMode: "hybrid",
      gas: 300_000,
      memo: "attenua-spike: S8 revoke second key",
    });

    const passed =
      rulesView.authenticatorRules.length === 0 &&
      rulesView.rules.length >= 1 &&
      !rSecondFreeze.hasFailedEvent &&
      rSecondForbid.hasFailedEvent;

    records.push({
      id: "S8",
      title: "Two linked keys on one account inherit the same account-wide spending rule",
      passed,
      txHash: `link=${regRes.transactionHash}, freeze=${rSecondFreeze.txHash}, forbid=${rSecondForbid.txHash}`,
      summary: `authenticatorRules=${rulesView.authenticatorRules.length}, accountRules=${rulesView.rules.length}; second key inherited MonitorAccount rule (freeze ok, non-freeze refused)`,
      details: `secondKeyNonFreezeReason="${rSecondForbid.failReason}"`,
    });
    console.log(
      `[S8] ${passed ? "PASS" : "FAIL"} — authenticatorRules=${rulesView.authenticatorRules.length}, secondKeyFreezeOk=${!rSecondFreeze.hasFailedEvent}, secondKeyOtherRefused=${rSecondForbid.hasFailedEvent}`
    );
  }

  // Write reproducible Markdown report to docs/SPIKE_RESULTS.md
  const lines = [
    "# Step 0 Testnet Spike Results (`qorechain-diana`)",
    "",
    `- **Run timestamp (UTC):** ${new Date().toISOString()}`,
    `- **Network:** \`${CHAIN_ID}\` (EVM Chain ID \`${EVM_CHAIN_ID}\`)`,
    `- **SpikeProbe Contract:** \`${probeAddr}\``,
    `- **Resolved \`MsgExecuteEVM\` Digest Version:** \`${digestVersion}\``,
    "",
    "| Test | Description | Result | Evidence / Measured Numbers |",
    "|---|---|---|---|",
    ...records.map(
      (rec) =>
        `| **${rec.id}** | ${rec.title} | ${rec.passed ? "PASS" : "FAIL"} | ${rec.summary} <br/> \`${rec.txHash ?? "-"}\` |`
    ),
    "",
    "## Verbatim Details & Refusal Logs",
    "",
    ...records.map((rec) => `### ${rec.id} — ${rec.title}\n- **Status:** ${rec.passed ? "PASS" : "FAIL"}\n- **Tx:** \`${rec.txHash ?? "-"}\`\n- **Summary:** ${rec.summary}\n- **Details:** ${rec.details}\n`),
  ];

  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`\nWrote empirical report to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
