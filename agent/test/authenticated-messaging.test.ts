import assert from "node:assert/strict";
import test from "node:test";
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";
import { envelopeToText } from "@qorechain/qoreseal";
import {
  createRecipientCardForAgent,
  createSignedClearanceVerdict,
  deriveAgentSealKeys,
  parseEnvelope,
  sealClearanceOffline,
  unsealAndVerifyClearance,
  verifyRecipientCard,
} from "../src/authenticated-messaging.js";

const TEST_MNEMONIC_RESEARCH = generateMnemonic(128);
const TEST_MNEMONIC_PAYABLES = generateMnemonic(128);
const TEST_MNEMONIC_ORCH = generateMnemonic(128);
const TEST_MNEMONIC_ATTACKER = generateMnemonic(128);

const VAULT = "0xf585fc6e1e43446f353830e0d11ff44ce747af58" as const;
const INVOICE_ID = "0x4dc0e87a212b9c6eb532b4d70a082be1695c28590265615182672de8a5e7aba5" as const;

test("QoreSign + QoreSeal hybrid ML-KEM-1024 roundtrip & tamper/expiry guards", async () => {
  const [research, payables, orch, attacker] = await Promise.all([
    deriveUnifiedAccount(TEST_MNEMONIC_RESEARCH),
    deriveUnifiedAccount(TEST_MNEMONIC_PAYABLES),
    deriveUnifiedAccount(TEST_MNEMONIC_ORCH),
    deriveUnifiedAccount(TEST_MNEMONIC_ATTACKER),
  ]);

  const paySeal = deriveAgentSealKeys(TEST_MNEMONIC_PAYABLES);
  const orchSeal = deriveAgentSealKeys(TEST_MNEMONIC_ORCH);
  const attackerSeal = deriveAgentSealKeys(TEST_MNEMONIC_ATTACKER);

  // 1. RecipientCard hybrid QoreSign binding matches registered keys
  const payCard = createRecipientCardForAgent(payables, paySeal, "qorechain-diana");
  verifyRecipientCard({
    card: payCard,
    chainId: "qorechain-diana",
    address: payables.cosmos,
    pqPublicKey: payables.pqc.publicKey,
    mlkemPublicKey: paySeal.mlkemPublicKey,
  });

  // 2. Research signs clearance verdict with ML-DSA-87 + SHAKE-256 and seals to Payables + Orchestrator
  const nowUnix = 1_800_000_000;
  const signed = createSignedClearanceVerdict({
    researchAccount: research,
    payload: {
      schema: "attenua-clearance-v1",
      chainId: "qorechain-diana",
      vault: VAULT,
      rootEpoch: 2,
      invoiceId: INVOICE_ID,
      vendor: "0x2cF96cFCd6cba46D698f3fcd1B726027E04C0808",
      amountMicro: "1500000",
      researchMandateId: "0x095a0c18e6f1537b6e6dd2b22b8d267169e413bad52443eb509cb168b29db81d",
      payablesMandateId: "0x18b21825f0ef919efe976ab16f3c1b978f758151a1a88dd823c805a0d5a8082a",
      verdict: "CLEAR",
      screeningSummary: "Clean invoice",
      validUntil: nowUnix + 3600,
      issuedAt: new Date(nowUnix * 1000).toISOString(),
    },
  });

  const sealed = sealClearanceOffline({
    signed,
    recipientKeys: [paySeal, orchSeal],
    chainId: "qorechain-diana",
  });
  const parsed = parseEnvelope(sealed.envelopeBytes);
  assert.equal(parsed.mode, "hybrid");
  assert.equal(parsed.entries.length, 2);

  // 3. Both authorized recipients open & verify Research signature
  const payOpen = unsealAndVerifyClearance({
    envelopeTextOrBytes: sealed.envelopeText,
    recipientKeys: paySeal,
    expectedVault: VAULT,
    expectedEpoch: 2,
    expectedInvoiceId: INVOICE_ID,
    researchCosmos: research.cosmos,
    researchPqPublicKey: research.pqc.publicKey,
    nowUnix,
  });
  assert.equal(payOpen.signed.payload.verdict, "CLEAR");

  const orchOpen = unsealAndVerifyClearance({
    envelopeTextOrBytes: sealed.envelopeBytes,
    recipientKeys: orchSeal,
    expectedVault: VAULT,
    expectedEpoch: 2,
    expectedInvoiceId: INVOICE_ID,
    researchCosmos: research.cosmos,
    researchPqPublicKey: research.pqc.publicKey,
    nowUnix,
  });
  assert.equal(orchOpen.verifiedShake256Digest, payOpen.verifiedShake256Digest);

  // 4. Unauthorized recipient is blocked (NOT_A_RECIPIENT)
  assert.throws(() =>
    unsealAndVerifyClearance({
      envelopeTextOrBytes: sealed.envelopeText,
      recipientKeys: attackerSeal,
      expectedVault: VAULT,
      expectedEpoch: 2,
      expectedInvoiceId: INVOICE_ID,
      researchCosmos: research.cosmos,
      researchPqPublicKey: research.pqc.publicKey,
      nowUnix,
    })
  );

  // 5. Tampered ciphertext fails AES-GCM / KEM authentication
  const tamperedBytes = Uint8Array.from(sealed.envelopeBytes);
  tamperedBytes[tamperedBytes.length - 3] ^= 0xff;
  assert.throws(() =>
    unsealAndVerifyClearance({
      envelopeTextOrBytes: envelopeToText(tamperedBytes),
      recipientKeys: paySeal,
      expectedVault: VAULT,
      expectedEpoch: 2,
      expectedInvoiceId: INVOICE_ID,
      researchCosmos: research.cosmos,
      researchPqPublicKey: research.pqc.publicKey,
      nowUnix,
    })
  );

  // 6. Expired verdict is rejected even when validly encrypted
  assert.throws(() =>
    unsealAndVerifyClearance({
      envelopeTextOrBytes: sealed.envelopeText,
      recipientKeys: paySeal,
      expectedVault: VAULT,
      expectedEpoch: 2,
      expectedInvoiceId: INVOICE_ID,
      researchCosmos: research.cosmos,
      researchPqPublicKey: research.pqc.publicKey,
      nowUnix: nowUnix + 7200,
    })
  );

  // 7. Wrong Research ML-DSA-87 public key fails QoreSign verification
  assert.throws(() =>
    unsealAndVerifyClearance({
      envelopeTextOrBytes: sealed.envelopeText,
      recipientKeys: paySeal,
      expectedVault: VAULT,
      expectedEpoch: 2,
      expectedInvoiceId: INVOICE_ID,
      researchCosmos: research.cosmos,
      researchPqPublicKey: attacker.pqc.publicKey,
      nowUnix,
    })
  );
});
