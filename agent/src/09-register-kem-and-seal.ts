import fs from "node:fs";
import path from "node:path";
import { fetchPqcStatus, pqcStatusPublicKey } from "@qorechain/sdk";
import {
  CHAIN_ID,
  DEPLOYMENT_FILE,
  REPO_ROOT,
  REST_URL,
  loadOrCreateSwarmAccounts,
} from "./config.js";
import {
  CLEARANCE_PURPOSE,
  createRecipientCardForAgent,
  createSignedClearanceVerdict,
  deriveAgentSealKeys,
  fetchKemKey,
  parseEnvelope,
  registerKemKeyIfNeeded,
  sealClearanceOnline,
  unsealAndVerifyClearance,
  verifyRecipientCard,
} from "./authenticated-messaging.js";

const STANDING_TREE_FILE = path.join(REPO_ROOT, "deployments", "standing-tree.json");
export const AUTHENTICATED_MESSAGE_FILE = path.join(
  REPO_ROOT,
  "deployments",
  "authenticated-message.json"
);

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE) || !fs.existsSync(STANDING_TREE_FILE)) {
    throw new Error("Expected deployments/qorechain-diana.json and deployments/standing-tree.json");
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const tree = JSON.parse(fs.readFileSync(STANDING_TREE_FILE, "utf8"));

  console.log("=== Attenua Live QoreSign + QoreSeal Inter-Agent Messaging Setup ===\n");

  const accounts = await loadOrCreateSwarmAccounts();
  if (!accounts.orchestratorPqc.mnemonic || !accounts.payables.mnemonic) {
    throw new Error("Missing mnemonics for OrchestratorPqc or Payables in swarm.env");
  }

  const orchSeal = deriveAgentSealKeys(accounts.orchestratorPqc.mnemonic);
  const paySeal = deriveAgentSealKeys(accounts.payables.mnemonic);

  // 1. Register ML-KEM-1024 keys on QoreChain Diana Encryption Key Registry
  // OrchestratorPqc (qor1f5em...) is listed in portal addresses so QoreSeal verifies on-chain.
  const orchReg = await registerKemKeyIfNeeded("OrchestratorPqc", accounts.orchestratorPqc, orchSeal);
  const payReg = await registerKemKeyIfNeeded("Payables", accounts.payables, paySeal);

  const [orchKemStatus, payKemStatus, resPqcStatus] = await Promise.all([
    fetchKemKey({ rest: REST_URL, address: accounts.orchestratorPqc.cosmos }),
    fetchKemKey({ rest: REST_URL, address: accounts.payables.cosmos }),
    fetchPqcStatus({ rest: REST_URL, address: accounts.research.cosmos }),
  ]);

  if (!orchKemStatus.registered || !payKemStatus.registered) {
    throw new Error("Expected both OrchestratorPqc and Payables ML-KEM-1024 keys to be registered on-chain");
  }
  const resPqPubKey = pqcStatusPublicKey(resPqcStatus);
  if (!resPqcStatus.registered || !resPqPubKey) {
    throw new Error("Expected Research ML-DSA-87 key to be registered on-chain");
  }

  // 2. Sign RecipientCards (QoreSign hybrid secp256k1 + ML-DSA-87 binding X25519 + ML-KEM-1024)
  const orchCard = createRecipientCardForAgent(accounts.orchestratorPqc, orchSeal, CHAIN_ID);
  const payCard = createRecipientCardForAgent(accounts.payables, paySeal, CHAIN_ID);

  // 3. Research creates & signs a canonical clearance verdict using ML-DSA-87 (@qorechain/qoresign + @qorechain/pqc)
  const nowUnix = Math.floor(Date.now() / 1000);
  const validUntil = Math.min(Number(tree.rootMandate.expiryUnix), nowUnix + 45 * 86400);
  const signedVerdict = createSignedClearanceVerdict({
    researchAccount: accounts.research,
    payload: {
      schema: "attenua-clearance-v1",
      chainId: CHAIN_ID,
      vault: dep.contracts.attenuaVault.address,
      rootEpoch: Number(tree.epoch),
      invoiceId: tree.paidInvoiceId,
      vendor: dep.actors.vendor.evm,
      amountMicro: "1500000",
      researchMandateId: tree.mandates.research.id,
      payablesMandateId: tree.mandates.payables.id,
      verdict: "CLEAR",
      screeningSummary:
        "Verified allowlisted vendor via @qorechain/mcp; zero prompt-injection overrides; 1.50 fUSD within 2.00 fUSD Payables cap.",
      validUntil,
      issuedAt: new Date(nowUnix * 1000).toISOString(),
    },
  });

  // 4. Seal online via @qorechain/qoreseal/network using on-chain KEM registry keys + signed RecipientCards
  const sealed = await sealClearanceOnline({
    signed: signedVerdict,
    recipients: [
      { address: accounts.payables.cosmos, card: payCard },
      { address: accounts.orchestratorPqc.cosmos, card: orchCard },
    ],
  });

  // 5. Verify both recipients can open the QoreSeal envelope & verify Research's on-chain ML-DSA-87 signature
  const payOpened = unsealAndVerifyClearance({
    envelopeTextOrBytes: sealed.envelopeText,
    recipientKeys: paySeal,
    expectedVault: dep.contracts.attenuaVault.address,
    expectedEpoch: Number(tree.epoch),
    expectedInvoiceId: tree.paidInvoiceId,
    researchCosmos: accounts.research.cosmos,
    researchPqPublicKey: resPqPubKey,
    nowUnix,
  });

  const orchOpened = unsealAndVerifyClearance({
    envelopeTextOrBytes: sealed.envelopeText,
    recipientKeys: orchSeal,
    expectedVault: dep.contracts.attenuaVault.address,
    expectedEpoch: Number(tree.epoch),
    expectedInvoiceId: tree.paidInvoiceId,
    researchCosmos: accounts.research.cosmos,
    researchPqPublicKey: resPqPubKey,
    nowUnix,
  });

  // Keyless cross-check RecipientCard against on-chain ML-DSA-87 + ML-KEM-1024 keys
  const [orchPqcOnChain, payPqcOnChain] = await Promise.all([
    fetchPqcStatus({ rest: REST_URL, address: accounts.orchestratorPqc.cosmos }),
    fetchPqcStatus({ rest: REST_URL, address: accounts.payables.cosmos }),
  ]);
  const orchPqPub = pqcStatusPublicKey(orchPqcOnChain);
  const payPqPub = pqcStatusPublicKey(payPqcOnChain);
  if (!orchPqPub || !payPqPub) {
    throw new Error("On-chain ML-DSA-87 public keys missing for OrchestratorPqc or Payables");
  }
  verifyRecipientCard({
    card: orchCard,
    chainId: CHAIN_ID,
    address: accounts.orchestratorPqc.cosmos,
    pqPublicKey: orchPqPub,
    mlkemPublicKey: orchKemStatus.publicKey!,
  });
  verifyRecipientCard({
    card: payCard,
    chainId: CHAIN_ID,
    address: accounts.payables.cosmos,
    pqPublicKey: payPqPub,
    mlkemPublicKey: payKemStatus.publicKey!,
  });

  const parsedEnv = parseEnvelope(sealed.envelopeBytes);

  const output = {
    network: CHAIN_ID,
    purpose: CLEARANCE_PURPOSE,
    mode: parsedEnv.mode,
    createdAtUtc: new Date(nowUnix * 1000).toISOString(),
    sender: {
      role: "Research",
      cosmos: accounts.research.cosmos,
      evm: accounts.research.evm,
      pqPubKeyHash: signedVerdict.researchPqPubKeyHash,
    },
    kemRegistry: {
      orchestratorPqc: {
        cosmos: accounts.orchestratorPqc.cosmos,
        algorithmId: orchKemStatus.algorithmId,
        algorithmName: orchKemStatus.algorithmName ?? "ML-KEM-1024",
        registeredHeight: String(orchKemStatus.registeredHeight ?? ""),
        txHash: orchReg.txHash,
      },
      payables: {
        cosmos: accounts.payables.cosmos,
        algorithmId: payKemStatus.algorithmId,
        algorithmName: payKemStatus.algorithmName ?? "ML-KEM-1024",
        registeredHeight: String(payKemStatus.registeredHeight ?? ""),
        txHash: payReg.txHash,
      },
    },
    recipientCards: {
      orchestratorPqc: orchCard,
      payables: payCard,
    },
    envelope: {
      version: parsedEnv.version,
      recipientCount: parsedEnv.entries.length,
      byteLength: sealed.envelopeBytes.length,
      ciphertextByteLength: parsedEnv.ciphertext.length,
      text: sealed.envelopeText,
    },
    verifiedClearance: {
      shake256Digest: payOpened.verifiedShake256Digest,
      payablesVerified: payOpened.signed.payload.verdict === "CLEAR",
      orchestratorVerified: orchOpened.signed.payload.verdict === "CLEAR",
      payload: payOpened.signed.payload,
    },
  };

  fs.writeFileSync(AUTHENTICATED_MESSAGE_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\n[PASS] KEM registry + QoreSign + QoreSeal roundtrip verified!`);
  console.log(`       Envelope size: ${sealed.envelopeBytes.length} bytes (${parsedEnv.entries.length} recipients, mode=${parsedEnv.mode})`);
  console.log(`       SHAKE-256:     ${payOpened.verifiedShake256Digest}`);
  console.log(`       Saved proof:   ${AUTHENTICATED_MESSAGE_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
