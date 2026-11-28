import fs from "node:fs";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  decodeAuthenticatorExecutions,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  fetchAuthenticators,
  registerAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  type UnifiedAccount,
} from "@qorechain/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT_FILE,
  EVIDENCE_FILE,
  EVM_CHAIN_ID,
  REPO_ROOT,
  REST_URL,
  broadcastNative,
  createEvmPublicClient,
  fetchTxRest,
  fetchUqorBalance,
  hexToBytes,
  loadOrCreateSwarmAccounts,
  sleep,
} from "./config.js";
import { signSetRootMandate, signSetVendor, signSubMandate } from "./signing.js";

export const STANDING_TREE_FILE = path.join(REPO_ROOT, "deployments", "standing-tree.json");

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function rootMandate() view returns (address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function registeredVendors(address) view returns (bool)",
  "function nonces(address) view returns (uint64)",
  "function usedInvoices(bytes32) view returns (bool)",
  "function subMandates(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function setRootMandate(address,uint256,uint16,uint16,uint8,uint8,uint64,uint64,uint64,bytes)",
  "function setVendor(address,bool,uint64,uint64,bytes)",
  "function registerSubMandate(bytes32,bytes32,address,uint256,uint16,uint16,uint8,uint64,uint64,uint64,bytes)",
  "function executePayInvoice(bytes32,bytes32,address,bytes32,uint256,uint64,uint64,uint64,uint64,bytes,bytes,bytes)",
  // Errors for keyless decoding
  "error RootMandateInactive()",
  "error VaultIsFrozen()",
  "error SelfDelegationNotAllowed()",
  "error SeparationOfDutiesViolated()",
  "error AttenuationBudgetExceeded(uint256 requested, uint256 available)",
  "error AttenuationBandWidened(uint16 childMin, uint16 childMax, uint16 parentMin, uint16 parentMax)",
  "error AttenuationMaskWidened(uint8 childMask, uint8 parentMask)",
  "error AttenuationExpiryWidened(uint64 childExpiry, uint64 parentExpiry)",
  "error AttenuationDepthExceeded(uint8 childDepth, uint8 maxDepth)",
  "error VendorNotRegistered(address vendor)",
  "error InvoiceAlreadyPaid(bytes32 invoiceKey)",
  "error PqcKeyNotRegistered(address account)",
  "error PqcKeyNotProven(address account)",
  "error PqcSignatureInvalid(address account)",
]);

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
    failed: Boolean(failedEv) || decoded?.success === false || restTx.code !== 0,
    evmGasUsed: (decoded?.gasUsed ?? 0n).toString(),
    reason,
  };
}

function extractRevertName(err: unknown): string {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data) {
      return `${rev.data.errorName}(${(rev.data.args ?? []).map(String).join(", ")})`;
    }
    const hexMatch = /0x[0-9a-fA-F]{8,}/.exec(err.shortMessage + " " + err.message);
    if (hexMatch) {
      try {
        const d = decodeErrorResult({ abi: VAULT_ABI, data: hexMatch[0] as `0x${string}` });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        return hexMatch[0].slice(0, 10);
      }
    }
    return err.shortMessage;
  }
  return String(err);
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Missing ${DEPLOYMENT_FILE}`);
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const vault = dep.contracts.attenuaVault.address as `0x${string}`;
  const acc = await loadOrCreateSwarmAccounts();
  const evm = createEvmPublicClient();
  const chainId = BigInt(EVM_CHAIN_ID);

  // 1. Balance check
  const [relBal, ownBal, monBal] = await Promise.all([
    fetchUqorBalance(acc.relayer.cosmos),
    fetchUqorBalance(acc.owner.cosmos),
    fetchUqorBalance(acc.monitorAccount.cosmos),
  ]);
  console.log("=== Installing Live Epoch 2 Standing Tree (No Redeploy) ===");
  console.log(`Vault: ${vault}`);
  console.log(`Balances: relayer=${relBal} uqor, owner=${ownBal} uqor, monitor=${monBal} uqor`);
  if (relBal < 1_000_000n || ownBal < 500_000n) {
    throw new Error(`Insufficient gas balance: relayer=${relBal}, owner=${ownBal}`);
  }

  // 2. Ensure Owner AA #1 has Orchestrator authenticator linked
  const auths = await fetchAuthenticators({ rest: REST_URL, address: acc.owner.cosmos });
  const activeAuths = auths.filter((a) => !a.revoked);
  if (activeAuths.length === 0) {
    console.log("[Pre-flight] Linking Orchestrator authenticator on AA #1 (29d expiry, max TTL 720h)...");
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
      expiryUnix: Math.floor(Date.now() / 1000) + 29 * 24 * 3600,
      label: "attenua-orchestrator-standing",
      possessionProof: orchProof.possessionProof,
    });
    const linkRes = await broadcastNative(acc.owner, [regMsg], {
      signMode: "hybrid",
      gas: 350_000,
      memo: "attenua: link orchestrator for Epoch 2 standing tree",
    });
    if (linkRes.code !== 0) throw new Error(`Authenticator link failed: ${linkRes.rawLog}`);
    console.log(`[Pre-flight] Authenticator linked: tx=${linkRes.transactionHash}`);
    await sleep(3500);
  } else {
    console.log(`[Pre-flight] AA #1 already has ${activeAuths.length} active authenticator(s).`);
  }

  const getNonce = (addr: `0x${string}`) =>
    evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonces", args: [addr] });
  const getEpoch = () => evm.readContract({ address: vault, abi: VAULT_ABI, functionName: "rootEpoch" });

  const oneFusd = 1_000_000n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const rootExpiry = now + 45n * 24n * 3600n; // +45 days (past Dec 16 judging)
  const depth1Expiry = now + 40n * 24n * 3600n; // +40 days
  const depth2Expiry = now + 35n * 24n * 3600n; // +35 days
  const zeroParent = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

  // 3. Install Root Mandate on current Epoch (should be 2)
  const epochBefore = await getEpoch();
  const ownerNonce = await getNonce(acc.owner.evm as `0x${string}`);
  const rootSig = signSetRootMandate({
    chainId,
    vault,
    rootEpoch: epochBefore,
    orchestrator: acc.orchestratorPqc.evm as `0x${string}`,
    rootBudget: 20n * oneFusd,
    minLiquidityBps: 4000,
    maxLiquidityBps: 7000,
    actionMask: 3,
    maxDepth: 2,
    expiry: rootExpiry,
    nonce: ownerNonce,
    deadline,
    ownerPqcSecret: acc.owner.pqc.secretKey,
  });
  const setRootRes = await relayCall({
    relayer: acc.relayer,
    accountCosmos: acc.owner.cosmos,
    authPriv: acc.orchestratorEdPriv,
    to: vault,
    data: encodeFunctionData({
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
        ownerNonce,
        deadline,
        rootSig,
      ],
    }),
    evmGasLimit: 550_000n,
    memo: "attenua: standing tree setRootMandate",
  });
  if (setRootRes.failed) throw new Error(`setRootMandate failed: ${setRootRes.reason}`);
  const liveEpoch = await getEpoch();
  console.log(`[Root] Active on epoch ${liveEpoch} (gas=${setRootRes.evmGasUsed}) tx=${setRootRes.txHash}`);

  // Ensure vendor is registered
  const vendorOk = await evm.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "registeredVendors",
    args: [acc.vendor.evm as `0x${string}`],
  });
  if (!vendorOk) {
    const vNonce = await getNonce(acc.owner.evm as `0x${string}`);
    const vSig = signSetVendor({
      chainId,
      vault,
      rootEpoch: liveEpoch,
      vendor: acc.vendor.evm as `0x${string}`,
      allowed: true,
      nonce: vNonce,
      deadline,
      ownerPqcSecret: acc.owner.pqc.secretKey,
    });
    const vr = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "setVendor",
        args: [acc.vendor.evm as `0x${string}`, true, vNonce, deadline, vSig],
      }),
      evmGasLimit: 450_000n,
      memo: "attenua: ensure vendor registered",
    });
    if (vr.failed) throw new Error(`setVendor failed: ${vr.reason}`);
    console.log(`[Vendor] Registered tx=${vr.txHash}`);
  }

  // 4. Delegate Depth-1 Standing Tree (Orchestrator -> Allocator, Payables, Research)
  const tag = `standing-e${liveEpoch}-${Date.now()}`;
  const allocatorId = keccak256(toHex(`${tag}-alloc`));
  const payablesId = keccak256(toHex(`${tag}-pay`));
  const researchId = keccak256(toHex(`${tag}-res`));
  const allocatorLeafId = keccak256(toHex(`${tag}-alloc-leaf`));

  const depth1Specs = [
    {
      role: "allocator",
      mandateId: allocatorId,
      subAgent: acc.allocator.evm as `0x${string}`,
      budget: 6n * oneFusd,
      minBps: 4500,
      maxBps: 6500,
      mask: 1,
    },
    {
      role: "payables",
      mandateId: payablesId,
      subAgent: acc.payables.evm as `0x${string}`,
      budget: 2n * oneFusd,
      minBps: 4000,
      maxBps: 7000,
      mask: 2,
    },
    {
      role: "research",
      mandateId: researchId,
      subAgent: acc.research.evm as `0x${string}`,
      budget: 0n,
      minBps: 4000,
      maxBps: 7000,
      mask: 0,
    },
  ] as const;

  const txs: Record<string, string> = { root: setRootRes.txHash };
  for (const spec of depth1Specs) {
    const nonce = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
    const sig = signSubMandate({
      chainId,
      vault,
      rootEpoch: liveEpoch,
      mandateId: spec.mandateId,
      parentId: zeroParent,
      subAgent: spec.subAgent,
      budget: spec.budget,
      minLiquidityBps: spec.minBps,
      maxLiquidityBps: spec.maxBps,
      actionMask: spec.mask,
      expiry: depth1Expiry,
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
        functionName: "registerSubMandate",
        args: [
          spec.mandateId,
          zeroParent,
          spec.subAgent,
          spec.budget,
          spec.minBps,
          spec.maxBps,
          spec.mask,
          depth1Expiry,
          nonce,
          deadline,
          sig,
        ],
      }),
      evmGasLimit: 600_000n,
      memo: `attenua: standing ${spec.role}`,
    });
    if (r.failed) throw new Error(`${spec.role} registerSubMandate failed: ${r.reason}`);
    txs[spec.role] = r.txHash;
    console.log(`[Depth 1] ${spec.role} id=${spec.mandateId.slice(0, 14)}... (gas=${r.evmGasUsed}) tx=${r.txHash}`);
  }

  // 5. Delegate Depth-2 Standing Child (Allocator -> Payables signer as AllocatorLeaf)
  // Leaves 4 fUSD unallocated under Allocator for transitive depth-2 & depth-3 live attacks.
  {
    const aNonce = await getNonce(acc.allocator.evm as `0x${string}`);
    const leafSig = signSubMandate({
      chainId,
      vault,
      rootEpoch: liveEpoch,
      mandateId: allocatorLeafId,
      parentId: allocatorId,
      subAgent: acc.payables.evm as `0x${string}`, // distinct from Allocator, proven ML-DSA-87 key
      budget: 2n * oneFusd,
      minLiquidityBps: 4800,
      maxLiquidityBps: 6200,
      actionMask: 1,
      expiry: depth2Expiry,
      nonce: aNonce,
      deadline,
      issuerPqcSecret: acc.allocator.pqc.secretKey,
    });
    const rLeaf = await relayCall({
      relayer: acc.relayer,
      accountCosmos: acc.owner.cosmos,
      authPriv: acc.orchestratorEdPriv,
      to: vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          allocatorLeafId,
          allocatorId,
          acc.payables.evm as `0x${string}`,
          2n * oneFusd,
          4800,
          6200,
          1,
          depth2Expiry,
          aNonce,
          deadline,
          leafSig,
        ],
      }),
      evmGasLimit: 650_000n,
      memo: "attenua: standing allocatorLeaf (depth 2)",
    });
    if (rLeaf.failed) throw new Error(`allocatorLeaf registerSubMandate failed: ${rLeaf.reason}`);
    txs.allocatorLeaf = rLeaf.txHash;
    console.log(`[Depth 2] allocatorLeaf id=${allocatorLeafId.slice(0, 14)}... (gas=${rLeaf.evmGasUsed}) tx=${rLeaf.txHash}`);
  }

  // Extract paid H6 invoiceId from H6 Cosmos REST calldata (MsgExecuteEVM logs are unindexed in eth_getLogs)
  let paidInvoiceId = "0x4dc0e87a212b9c6eb532b4d70a082be1695c28590265615182672de8a5e7aba5";
  if (fs.existsSync(EVIDENCE_FILE)) {
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
    const h6 = (ev.happyPath ?? []).find((x: { id: string }) => x.id === "H6");
    if (h6?.txHash) {
      try {
        const restTx = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs/${h6.txHash}`);
        if (restTx.ok) {
          const j = (await restTx.json()) as { tx?: { body?: { messages?: Array<{ data?: string }> } } };
          for (const m of j.tx?.body?.messages ?? []) {
            if (m.data) {
              const hex = Buffer.from(m.data, "base64").toString("hex");
              const paySel = String(dep.selectors?.executePayInvoice ?? "0xce722dd3").replace(/^0x/, "").toLowerCase();
              if (hex.startsWith(paySel) || hex.startsWith("8d513bef")) {
                paidInvoiceId = `0x${hex.slice(8 + 64 * 3, 8 + 64 * 4)}`;
              }
            }
          }
        }
      } catch {
        // Fallback to recorded H6 invoiceId above
      }
    }
  }
  const h6Used = await evm.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "usedInvoices",
    args: [keccak256(("0x" + acc.vendor.evm.slice(2).toLowerCase() + paidInvoiceId.slice(2)) as `0x${string}`)],
  });
  console.log(`[Replay Seed] H6 invoiceId=${paidInvoiceId} usedInvoices=${h6Used}`);

  const standing = {
    network: CHAIN_ID,
    evmChainId: EVM_CHAIN_ID,
    vault,
    installedAt: new Date().toISOString(),
    epoch: Number(liveEpoch),
    rootMandate: {
      orchestrator: acc.orchestratorPqc.evm,
      budgetMicro: (20n * oneFusd).toString(),
      minLiquidityBps: 4000,
      maxLiquidityBps: 7000,
      actionMask: 3,
      maxDepth: 2,
      expiryUnix: rootExpiry.toString(),
      expiryIso: new Date(Number(rootExpiry) * 1000).toISOString(),
    },
    mandates: {
      allocator: {
        id: allocatorId,
        parentId: zeroParent,
        issuer: acc.orchestratorPqc.evm,
        subAgent: acc.allocator.evm,
        budgetMicro: (6n * oneFusd).toString(),
        allocatedMicro: (2n * oneFusd).toString(),
        minLiquidityBps: 4500,
        maxLiquidityBps: 6500,
        actionMask: 1,
        depth: 1,
        expiryUnix: depth1Expiry.toString(),
      },
      payables: {
        id: payablesId,
        parentId: zeroParent,
        issuer: acc.orchestratorPqc.evm,
        subAgent: acc.payables.evm,
        budgetMicro: (2n * oneFusd).toString(),
        allocatedMicro: "0",
        minLiquidityBps: 4000,
        maxLiquidityBps: 7000,
        actionMask: 2,
        depth: 1,
        expiryUnix: depth1Expiry.toString(),
      },
      research: {
        id: researchId,
        parentId: zeroParent,
        issuer: acc.orchestratorPqc.evm,
        subAgent: acc.research.evm,
        budgetMicro: "0",
        allocatedMicro: "0",
        minLiquidityBps: 4000,
        maxLiquidityBps: 7000,
        actionMask: 0,
        depth: 1,
        expiryUnix: depth1Expiry.toString(),
      },
      allocatorLeaf: {
        id: allocatorLeafId,
        parentId: allocatorId,
        issuer: acc.allocator.evm,
        subAgent: acc.payables.evm,
        budgetMicro: (2n * oneFusd).toString(),
        allocatedMicro: "0",
        minLiquidityBps: 4800,
        maxLiquidityBps: 6200,
        actionMask: 1,
        depth: 2,
        expiryUnix: depth2Expiry.toString(),
      },
    },
    txs,
    paidInvoiceId,
  };

  fs.writeFileSync(STANDING_TREE_FILE, JSON.stringify(standing, null, 2));
  console.log(`\nSaved live standing tree manifest -> ${STANDING_TREE_FILE}`);

  // 6. Immediate Keyless eth_call Verification of Two-Wall Behavior on Live v1.1
  console.log("\n=== Keyless Two-Wall Live eth_call Probe (4,627-byte dummy sig) ===");
  const dummySig = ("0x" + "11".repeat(4627)) as `0x${string}`;
  const orchNonceNow = await getNonce(acc.orchestratorPqc.evm as `0x${string}`);
  const allocNonceNow = await getNonce(acc.allocator.evm as `0x${string}`);
  const payNonceNow = await getNonce(acc.payables.evm as `0x${string}`);
  const fakeId = keccak256(toHex(`probe-${Date.now()}`));
  const fakeDead = now + 3600n;

  const probes: Array<{ label: string; to?: `0x${string}`; data: `0x${string}` }> = [
    {
      label: "1. Root Band Widen [30%, 80%] -> expect AttenuationBandWidened",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          fakeId,
          zeroParent,
          acc.research.evm as `0x${string}`,
          1_000_000n,
          3000,
          8000,
          1,
          fakeDead,
          orchNonceNow,
          fakeDead,
          dummySig,
        ],
      }),
    },
    {
      label: "2. Depth-2 Transitivity under Allocator [41%, 69%] (legal for Root!) -> expect AttenuationBandWidened(4100,6900,4500,6500)",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          fakeId,
          allocatorId,
          acc.research.evm as `0x${string}`,
          1_000_000n,
          4100,
          6900,
          1,
          fakeDead,
          allocNonceNow,
          fakeDead,
          dummySig,
        ],
      }),
    },
    {
      label: "3. Depth-3 Overflow under allocatorLeaf -> expect AttenuationDepthExceeded(3, 2)",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          fakeId,
          allocatorLeafId,
          acc.research.evm as `0x${string}`,
          500_000n,
          5000,
          6000,
          1,
          fakeDead,
          payNonceNow,
          fakeDead,
          dummySig,
        ],
      }),
    },
    {
      label: "4. Self-delegation under Allocator -> expect SelfDelegationNotAllowed()",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          fakeId,
          allocatorId,
          acc.allocator.evm as `0x${string}`,
          1_000_000n,
          4800,
          6200,
          1,
          fakeDead,
          allocNonceNow,
          fakeDead,
          dummySig,
        ],
      }),
    },
    {
      label: "5. Unlisted Vendor executePayInvoice -> expect VendorNotRegistered",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "executePayInvoice",
        args: [
          payablesId,
          researchId,
          acc.unlistedAttacker.evm as `0x${string}`,
          fakeId,
          100_000n,
          payNonceNow,
          fakeDead,
          fakeDead,
          fakeDead,
          dummySig,
          dummySig,
          dummySig,
        ],
      }),
    },
    {
      label: "6. 'Make it legal' under Allocator -> passes Wall 1, hits Wall 2 PqcSignatureInvalid(allocator)",
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "registerSubMandate",
        args: [
          fakeId,
          allocatorId,
          acc.research.evm as `0x${string}`,
          1_000_000n,
          4800,
          6000,
          1,
          fakeDead,
          allocNonceNow,
          fakeDead,
          dummySig,
        ],
      }),
    },
  ];

  for (const p of probes) {
    try {
      await evm.call({ to: vault, data: p.data });
      console.log(`  [UNEXPECTED OK] ${p.label}`);
    } catch (e) {
      console.log(`  [PASS] ${p.label}\n         -> ${extractRevertName(e)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
