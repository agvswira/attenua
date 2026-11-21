import crypto from "node:crypto";
import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { generateMnemonic } from "@qorechain/sdk";
import { ENV_PATH, STATE_DIR, bytesToHex, loadSpikeAccounts } from "./common.js";

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  if (!fs.existsSync(ENV_PATH)) {
    const ownerMnemonic = generateMnemonic(128);
    const monitorAccMnemonic = generateMnemonic(128);
    const relayerMnemonic = generateMnemonic(128);
    const signer2Mnemonic = generateMnemonic(128);
    const signer3Mnemonic = generateMnemonic(128);

    const orchEdPriv = crypto.randomBytes(32);
    const monEdPriv = crypto.randomBytes(32);

    const content = [
      "# Throwaway qorechain-diana testnet keys ONLY. NEVER fund on mainnet. NEVER commit.",
      `OWNER_MNEMONIC="${ownerMnemonic}"`,
      `MONITOR_ACCOUNT_MNEMONIC="${monitorAccMnemonic}"`,
      `RELAYER_MNEMONIC="${relayerMnemonic}"`,
      `SIGNER2_MNEMONIC="${signer2Mnemonic}"`,
      `SIGNER3_MNEMONIC="${signer3Mnemonic}"`,
      `ORCHESTRATOR_ED25519_PRIV_HEX=${orchEdPriv.toString("hex")}`,
      `MONITOR_ED25519_PRIV_HEX=${monEdPriv.toString("hex")}`,
      "",
    ].join("\n");

    fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
    console.log(`Created throwaway testnet key file outside repo: ${ENV_PATH}`);
  } else {
    console.log(`Using existing throwaway key file: ${ENV_PATH}`);
  }

  const acc = await loadSpikeAccounts();
  const orchPub = ed25519.getPublicKey(acc.orchestratorEdPriv);
  const monPub = ed25519.getPublicKey(acc.monitorEdPriv);

  console.log("\n=== Attenua Step 0 Spike Accounts (qorechain-diana testnet ONLY) ===");
  console.log(`1. Owner (Treasury AA #1)    : ${acc.owner.cosmos}  |  ${acc.owner.evm}`);
  console.log(`2. MonitorAccount (AA #2)    : ${acc.monitorAccount.cosmos}  |  ${acc.monitorAccount.evm}`);
  console.log(`3. Relayer (Gas Wallet)      : ${acc.relayer.cosmos}  |  ${acc.relayer.evm}`);
  console.log(`4. Signer2 (ML-DSA-87 peer)  : ${acc.signer2.cosmos}  |  ${acc.signer2.evm}`);
  console.log(`5. Signer3 (ML-DSA-87 peer)  : ${acc.signer3.cosmos}  |  ${acc.signer3.evm}`);
  console.log(`   Orchestrator ed25519 pub  : ${bytesToHex(orchPub)}`);
  console.log(`   Monitor ed25519 pub       : ${bytesToHex(monPub)}`);

  console.log("\nNEXT STEP:");
  console.log("  Claim free testnet QOR + fUSD from the Diana faucet (https://dashboard.qorechain.io) for:");
  console.log(`    -> Owner : ${acc.owner.cosmos}`);
  console.log("  (Optional: also claim for Relayer, or 02-deploy-probe.ts will auto-fund peers from Owner's QOR.)");
  console.log('  Then run: npm run status');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
