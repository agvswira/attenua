import { mldsa87, pubkeyHash, shake256 } from "@qorechain/pqc";
import {
  buildRegisterKemKeyMessage,
  deriveSealKeys,
  envelopeFromText,
  envelopeToText,
  open,
  parseEnvelope,
  recipientOf,
  seal,
  signRecipientCard,
  verifyRecipientCard,
  type RecipientCard,
  type SealKeyPair,
} from "@qorechain/qoreseal";
import { fetchKemKey, sealToAddresses } from "@qorechain/qoreseal/network";
import {
  classicalKeyFromPrivate,
  signMessage,
  verifyMessage,
  type MessageSignature,
} from "@qorechain/qoresign";
import { qorechainRegistry, type UnifiedAccount } from "@qorechain/sdk";
import {
  CHAIN_ID,
  REST_URL,
  broadcastNative,
  bytesToHex,
  hexToBytes,
  sleep,
} from "./config.js";

export const CLEARANCE_PURPOSE = "attenua-clearance-v1";

export interface ClearanceVerdictPayload {
  schema: "attenua-clearance-v1";
  chainId: string;
  vault: `0x${string}`;
  rootEpoch: number;
  invoiceId: `0x${string}`;
  vendor: `0x${string}`;
  amountMicro: string;
  researchMandateId: `0x${string}`;
  payablesMandateId: `0x${string}`;
  verdict: "CLEAR" | "REFUSE";
  screeningSummary: string;
  validUntil: number;
  issuedAt: string;
}

export interface SignedClearanceMessage {
  payload: ClearanceVerdictPayload;
  canonicalJson: string;
  shake256Digest: string;
  researchCosmos: string;
  researchPqPubKeyHash: string;
  signature: MessageSignature;
}

export interface UnsealedClearanceResult {
  signed: SignedClearanceMessage;
  verifiedShake256Digest: string;
  verifiedResearchCosmos: string;
  openedAtUnix: number;
}

export function deriveAgentSealKeys(mnemonic: string, index = 0): SealKeyPair {
  return deriveSealKeys({ mnemonic, index });
}

export function classicalKeyForAccount(account: UnifiedAccount) {
  return classicalKeyFromPrivate(hexToBytes(account.privateKey), "eth_secp256k1");
}

export function createRecipientCardForAgent(
  account: UnifiedAccount,
  sealKeys: SealKeyPair,
  chainId = CHAIN_ID
): RecipientCard {
  return signRecipientCard({
    chainId,
    address: account.cosmos,
    keys: sealKeys,
    classicalKey: classicalKeyForAccount(account),
    pqKey: { secretKey: account.pqc.secretKey },
  });
}

export function createSignedClearanceVerdict(args: {
  payload: ClearanceVerdictPayload;
  researchAccount: UnifiedAccount;
}): SignedClearanceMessage {
  const { payload, researchAccount } = args;
  const canonicalJson = JSON.stringify(payload);
  const digest = bytesToHex(shake256(new TextEncoder().encode(canonicalJson), 32));
  const pqPubHash = bytesToHex(pubkeyHash(researchAccount.pqc.publicKey, 32));

  // Cross-verify deterministic FIPS 204 key integrity via @qorechain/pqc before signing
  const signature = signMessage({
    chainId: payload.chainId,
    signer: researchAccount.cosmos,
    data: canonicalJson,
    classicalKey: classicalKeyForAccount(researchAccount),
    pqKey: { secretKey: researchAccount.pqc.secretKey },
  });

  const pqSigBytes = signature.pq?.signature
    ? Uint8Array.from(Buffer.from(signature.pq.signature, "base64"))
    : new Uint8Array();
  const domainMsg = new TextEncoder().encode(`qorechain-msg-v1|${payload.chainId}|${canonicalJson}`);
  if (!mldsa87.verify(researchAccount.pqc.publicKey, domainMsg, pqSigBytes)) {
    throw new Error("Self-check failed: ML-DSA-87 clearance signature did not verify via @qorechain/pqc");
  }

  return {
    payload,
    canonicalJson,
    shake256Digest: digest,
    researchCosmos: researchAccount.cosmos,
    researchPqPubKeyHash: pqPubHash,
    signature,
  };
}

export async function sealClearanceOnline(args: {
  signed: SignedClearanceMessage;
  recipients: Array<{ address: string; card: RecipientCard }>;
  rest?: string;
  chainId?: string;
}): Promise<{ envelopeBytes: Uint8Array; envelopeText: string }> {
  const chainId = args.chainId ?? CHAIN_ID;
  const rest = args.rest ?? REST_URL;
  const plaintext = new TextEncoder().encode(JSON.stringify(args.signed));
  const aad = new TextEncoder().encode(
    `${args.signed.payload.vault}|${args.signed.payload.rootEpoch}|${args.signed.payload.invoiceId}`
  );

  const envelopeBytes = await sealToAddresses({
    rest,
    chainId,
    purpose: CLEARANCE_PURPOSE,
    recipients: args.recipients,
    plaintext,
    aad,
  });

  return {
    envelopeBytes,
    envelopeText: envelopeToText(envelopeBytes),
  };
}

export function sealClearanceOffline(args: {
  signed: SignedClearanceMessage;
  recipientKeys: SealKeyPair[];
  chainId?: string;
}): { envelopeBytes: Uint8Array; envelopeText: string } {
  const chainId = args.chainId ?? CHAIN_ID;
  const plaintext = new TextEncoder().encode(JSON.stringify(args.signed));
  const aad = new TextEncoder().encode(
    `${args.signed.payload.vault}|${args.signed.payload.rootEpoch}|${args.signed.payload.invoiceId}`
  );

  const envelopeBytes = seal({
    chainId,
    purpose: CLEARANCE_PURPOSE,
    recipients: args.recipientKeys.map((k) => recipientOf(k)),
    plaintext,
    aad,
  });

  return {
    envelopeBytes,
    envelopeText: envelopeToText(envelopeBytes),
  };
}

export function unsealAndVerifyClearance(args: {
  envelopeTextOrBytes: string | Uint8Array;
  recipientKeys: SealKeyPair;
  expectedVault: `0x${string}`;
  expectedEpoch: number;
  expectedInvoiceId: `0x${string}`;
  researchCosmos: string;
  researchPqPublicKey: Uint8Array;
  chainId?: string;
  nowUnix?: number;
}): UnsealedClearanceResult {
  const chainId = args.chainId ?? CHAIN_ID;
  const envelope =
    typeof args.envelopeTextOrBytes === "string"
      ? envelopeFromText(args.envelopeTextOrBytes)
      : args.envelopeTextOrBytes;
  const aad = new TextEncoder().encode(
    `${args.expectedVault}|${args.expectedEpoch}|${args.expectedInvoiceId}`
  );

  const plaintext = open({
    chainId,
    purpose: CLEARANCE_PURPOSE,
    envelope,
    keys: args.recipientKeys,
    aad,
  });

  const signed = JSON.parse(new TextDecoder().decode(plaintext)) as SignedClearanceMessage;
  const nowUnix = args.nowUnix ?? Math.floor(Date.now() / 1000);

  if (signed.payload.validUntil < nowUnix) {
    throw new Error(`Clearance verdict expired: validUntil=${signed.payload.validUntil} < now=${nowUnix}`);
  }
  if (signed.researchCosmos !== args.researchCosmos) {
    throw new Error(`Unexpected Research signer: ${signed.researchCosmos}`);
  }

  const expectedCanonical = JSON.stringify(signed.payload);
  if (signed.canonicalJson !== expectedCanonical) {
    throw new Error("Canonical clearance payload mismatch (tampered JSON)");
  }

  const recomputedDigest = bytesToHex(shake256(new TextEncoder().encode(signed.canonicalJson), 32));
  if (recomputedDigest !== signed.shake256Digest) {
    throw new Error(`SHAKE-256 clearance digest mismatch: ${recomputedDigest} !== ${signed.shake256Digest}`);
  }

  verifyMessage({
    chainId,
    signer: args.researchCosmos,
    data: signed.canonicalJson,
    signature: signed.signature,
    pqPublicKey: args.researchPqPublicKey,
    requirePq: true,
  });

  return {
    signed,
    verifiedShake256Digest: recomputedDigest,
    verifiedResearchCosmos: args.researchCosmos,
    openedAtUnix: nowUnix,
  };
}

export async function registerKemKeyIfNeeded(
  label: string,
  account: UnifiedAccount,
  sealKeys: SealKeyPair
): Promise<{ alreadyRegistered: boolean; txHash: string | null }> {
  const status = await fetchKemKey({ rest: REST_URL, address: account.cosmos });
  if (
    status.registered &&
    status.algorithmId === 2 &&
    status.publicKey &&
    Buffer.from(status.publicKey).equals(Buffer.from(sealKeys.mlkemPublicKey))
  ) {
    console.log(`[KEM] ${label} (${account.cosmos}) already registered ML-KEM-1024 on chain.`);
    return { alreadyRegistered: true, txHash: null };
  }

  const built = buildRegisterKemKeyMessage({
    sender: account.cosmos,
    mlkemPublicKey: sealKeys.mlkemPublicKey,
  });
  const registry = qorechainRegistry();
  const decodedValue = registry.decode(built) as Record<string, unknown>;

  const res = await broadcastNative(
    account,
    [{ typeUrl: built.typeUrl, value: decodedValue }],
    {
      signMode: "hybrid",
      gas: 350_000,
      memo: `attenua: register ML-KEM-1024 key (${label})`,
    }
  );
  if (res.code !== 0) {
    throw new Error(`KEM registration failed for ${label}: ${res.rawLog ?? "code " + res.code}`);
  }
  console.log(`[KEM] ${label} registered ML-KEM-1024 on chain: tx=${res.transactionHash}`);
  await sleep(3500);
  return { alreadyRegistered: false, txHash: res.transactionHash };
}

export { parseEnvelope, verifyRecipientCard, fetchKemKey };
