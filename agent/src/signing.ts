import { pqcSign } from "@qorechain/sdk";
import { encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes } from "./config.js";

function signPackedPqc(secretKey: Uint8Array, packedHex: `0x${string}`): `0x${string}` {
  const sig = pqcSign(secretKey, hexToBytes(packedHex));
  return bytesToHex(sig);
}

export function signSetRootMandate(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  orchestrator: `0x${string}`;
  rootBudget: bigint;
  minLiquidityBps: number;
  maxLiquidityBps: number;
  actionMask: number;
  maxDepth: number;
  expiry: bigint;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    [
      "string",
      "uint256",
      "address",
      "uint64",
      "address",
      "uint256",
      "uint16",
      "uint16",
      "uint8",
      "uint8",
      "uint64",
      "uint64",
      "uint64",
    ],
    [
      "attenua-v1|SET_ROOT|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.orchestrator,
      params.rootBudget,
      params.minLiquidityBps,
      params.maxLiquidityBps,
      params.actionMask,
      params.maxDepth,
      params.expiry,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signSetVendor(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  vendor: `0x${string}`;
  allowed: boolean;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "address", "bool", "uint64", "uint64"],
    [
      "attenua-v1|SET_VENDOR|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.vendor,
      params.allowed,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signSubMandate(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  mandateId: `0x${string}`;
  parentId: `0x${string}`;
  subAgent: `0x${string}`;
  budget: bigint;
  minLiquidityBps: number;
  maxLiquidityBps: number;
  actionMask: number;
  expiry: bigint;
  nonce: bigint;
  deadline: bigint;
  issuerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    [
      "string",
      "uint256",
      "address",
      "uint64",
      "bytes32",
      "bytes32",
      "address",
      "uint256",
      "uint16",
      "uint16",
      "uint8",
      "uint64",
      "uint64",
      "uint64",
    ],
    [
      "attenua-v1|SUB_MANDATE|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.mandateId,
      params.parentId,
      params.subAgent,
      params.budget,
      params.minLiquidityBps,
      params.maxLiquidityBps,
      params.actionMask,
      params.expiry,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.issuerPqcSecret, packed);
}

export function signReclaimSubMandate(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  mandateId: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  issuerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "bytes32", "uint64", "uint64"],
    [
      "attenua-v1|RECLAIM|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.mandateId,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.issuerPqcSecret, packed);
}

export function signAllocate(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  mandateId: `0x${string}`;
  liqAmount: bigint;
  liqIsDeposit: boolean;
  resAmount: bigint;
  resIsDeposit: boolean;
  nonce: bigint;
  deadline: bigint;
  subAgentPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    [
      "string",
      "uint256",
      "address",
      "uint64",
      "bytes32",
      "uint256",
      "bool",
      "uint256",
      "bool",
      "uint64",
      "uint64",
    ],
    [
      "attenua-v1|ALLOCATE|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.mandateId,
      params.liqAmount,
      params.liqIsDeposit,
      params.resAmount,
      params.resIsDeposit,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.subAgentPqcSecret, packed);
}

export function signPayInvoice(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  mandateId: `0x${string}`;
  vendor: `0x${string}`;
  invoiceId: `0x${string}`;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  payablesPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "bytes32", "address", "bytes32", "uint256", "uint64", "uint64"],
    [
      "attenua-v1|PAY_INVOICE|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.mandateId,
      params.vendor,
      params.invoiceId,
      params.amount,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.payablesPqcSecret, packed);
}

export function signVendorInvoice(params: {
  chainId: bigint;
  vault: `0x${string}`;
  vendor: `0x${string}`;
  invoiceId: `0x${string}`;
  amount: bigint;
  vendorPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "address", "bytes32", "uint256"],
    ["attenua-v1|VENDOR_INVOICE|", params.chainId, params.vault, params.vendor, params.invoiceId, params.amount]
  );
  return signPackedPqc(params.vendorPqcSecret, packed);
}

export function signResearchClearance(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  researchMandateId: `0x${string}`;
  vendor: `0x${string}`;
  invoiceId: `0x${string}`;
  amount: bigint;
  researchPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "bytes32", "address", "bytes32", "uint256"],
    [
      "attenua-v1|RESEARCH_CLEAR|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.researchMandateId,
      params.vendor,
      params.invoiceId,
      params.amount,
    ]
  );
  return signPackedPqc(params.researchPqcSecret, packed);
}

export function signRevokeRootEpoch(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "uint64", "uint64"],
    ["attenua-v1|REVOKE_EPOCH|", params.chainId, params.vault, params.rootEpoch, params.nonce, params.deadline]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signUnfreeze(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "uint64", "uint64"],
    ["attenua-v1|UNFREEZE|", params.chainId, params.vault, params.rootEpoch, params.nonce, params.deadline]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export async function signMonitorFreeze(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  nonce: bigint;
  deadline: bigint;
  monitorPrivateKeyHex: string;
}): Promise<`0x${string}`> {
  const rawHash = keccak256(
    encodePacked(
      ["string", "uint256", "address", "uint64", "uint64", "uint64"],
      ["attenua-v1|FREEZE|", params.chainId, params.vault, params.rootEpoch, params.nonce, params.deadline]
    )
  );
  const account = privateKeyToAccount(params.monitorPrivateKeyHex as `0x${string}`);
  return account.signMessage({ message: { raw: rawHash } });
}

export function signEmergencyWithdraw(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  to: `0x${string}`;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "address", "uint256", "uint64", "uint64"],
    [
      "attenua-v1|EMERGENCY_WITHDRAW|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.to,
      params.amount,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signSetMonitorSigner(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  newMonitor: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "address", "uint64", "uint64"],
    [
      "attenua-v1|SET_MONITOR|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.newMonitor,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signEmergencyRedeemVaults(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  to: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  ownerPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "address", "uint64", "uint64"],
    [
      "attenua-v1|EMERGENCY_REDEEM|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.to,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.ownerPqcSecret, packed);
}

export function signForceReclaimDescendant(params: {
  chainId: bigint;
  vault: `0x${string}`;
  rootEpoch: bigint;
  mandateId: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  orchestratorPqcSecret: Uint8Array;
}): `0x${string}` {
  const packed = encodePacked(
    ["string", "uint256", "address", "uint64", "bytes32", "uint64", "uint64"],
    [
      "attenua-v1|FORCE_RECLAIM|",
      params.chainId,
      params.vault,
      params.rootEpoch,
      params.mandateId,
      params.nonce,
      params.deadline,
    ]
  );
  return signPackedPqc(params.orchestratorPqcSecret, packed);
}
