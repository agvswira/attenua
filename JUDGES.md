# 5-Minute Keyless Judge Walkthrough — Attenua

No private keys, wallet extensions, or API keys are required to verify every security claim in **Attenua** against the live deployed `AttenuaVault` v1.1 contract (`0xf585fc6e1e43446f353830e0d11ff44ce747af58` on `qorechain-diana`, Chain ID `9800`).

---

## Track Requirements → Direct Evidence (`Post-Quantum AI Agents`)

| Track Requirement | Implementation (`file:line`) | On-Chain Tx / Live State | Keyless Check Command |
|---|---|---|---|
| **Scoped EVM window** | [`agent/src/01-deploy-all.ts:342-352`](agent/src/01-deploy-all.ts), [`03-verify.ts:86-89`](agent/src/03-verify.ts), [`05-claim-hallmark.ts`](agent/src/05-claim-hallmark.ts) | Owner AA #1 EVM window opened scoped for deploy & closed (`live=false`) | `cd agent && npm run verify` |
| **Tx / value / duration / target limits** | [`AttenuaVault.sol:455-575`](contracts/src/AttenuaVault.sol), [`01-deploy-all.ts:342-352`](agent/src/01-deploy-all.ts) | Root `20 fUSD`, `maxDepth 2`, `expiry` & per-child lattice (`H1–H7`, `A1–A10`) | `cd agent && npm run lab -- ALL` |
| **Smart-account spending rules** | `AA #1` (`10 fUSD/tx`, `25 fUSD/day`, zero ERC-20 allowance) + `AA #2` (`0 fUSD`, `1 uqor/day`, `freeze()` selector `0xbd2d305f` only) in [`03-verify.ts:90-108`](agent/src/03-verify.ts) | `A7` (`BD069AFF...8B7D6`), `A8` (`8111C7BD...5B88`) | `cd agent && npm run verify` |
| **Authenticated inter-agent messaging** | Research → Payables + Orchestrator clearance signed with `@qorechain/qoresign` (`ML-DSA-87`) & `@qorechain/pqc` (`SHAKE-256`), sealed via `@qorechain/qoreseal` (`ML-KEM-1024 + X25519`) in [`authenticated-messaging.ts`](agent/src/authenticated-messaging.ts) & [`09-register-kem-and-seal.ts`](agent/src/09-register-kem-and-seal.ts) | Live `MsgRegisterKEMKey` txs `A84387CE...79DCCCEF` (block `10924190`, `OrchestratorPqc`) & `7CD72E4A...501F5D9EB` (block `10924196`, `Payables`) + [`deployments/authenticated-message.json`](deployments/authenticated-message.json) | `cd agent && npm test && npm run verify` |

> **Why Attack Txs Show Cosmos `code = 0` on Explorer:** In QoreChain `x/abstractaccount` `MsgExecuteEVM`, an inner EVM contract revert marks the transaction with an `abstractaccount_execution_failed` event while the outer Cosmos wrapper keeps `code = 0` so gas/replay accounting holds cleanly. Run `cd agent && npm run decode:attacks` (replays each historical tx via `eth_call` at block `height - 1` against Diana's archive EVM RPC) to decode exact Solidity custom errors into [`deployments/decoded-attacks.json`](deployments/decoded-attacks.json).
> **QoreScan CBOM Usage:** `@qorechain/qorescan` runs directly via the `cbom` CLI script (`cd agent && npm run cbom`) to generate [`docs/cbom.json`](docs/cbom.json) (16 CycloneDX components), verified by [`03-verify.ts:204-211`](agent/src/03-verify.ts).

---

## 0:00 — Architecture & Live Capability Tree
Open [`https://attenua.vercel.app/`](https://attenua.vercel.app/):
- The **Capability Tree** reflects live `AttenuaVault` Epoch `2`, showing `Owner (20 fUSD)` -> `Orchestrator` -> `Allocator (6 fUSD, [45%, 65%])`, `Payables (2 fUSD)`, `Research (0 fUSD, mask 0)`, and a depth-2 child (`AllocatorLeaf`, `2 fUSD`, `[48%, 62%]`), flanked by the O(1) `revokeRootEpoch()` kill-switch and isolated classical `Monitor` (`AA #2`, `0 fUSD`).
- Click **"Attack the lattice"** in the hero header.

## 0:30 — Interactive Attack Lab & Two-Wall Proof (`eth_call` Without Keys)
In the **Attack the lattice** section, all calls fire straight from your browser to `https://evm-testnet.qore.host` (`AttenuaVault` v1.1):
1. **`Depth-2 Transitivity` preset**: Pretend `Allocator` (`[45%, 65%]`) is compromised and try delegating `[41%, 69%]`. Even though `[41%, 69%]` is inside Root's `[40%, 70%]`, the live contract reverts with **`AttenuationBandWidened(4100, 6900, 4500, 6500)`** (`I4`).
2. **`Depth-3 Overflow` preset**: Delegate under depth-2 `AllocatorLeaf` (`maxDepth = 2`) -> reverts **`AttenuationDepthExceeded(3, 2)`**.
3. **`A10 · H-01 Self-Delegate`**: Payables tries delegating a 0-budget clearance key to itself -> reverts **`SelfDelegationNotAllowed()`**.
4. **Click "Make it legal (test Wall 2)"**: Parameters auto-narrow strictly inside parent bounds so **Wall 1 (Lattice) ALLOWS the shape**, then live precompile `0x...0a01` immediately stops execution at **Wall 2 with `PqcSignatureInvalid(issuer)`**.

## 2:30 — AI Replay (Untrusted LLM Calldata vs On-Chain Guard)
- The **AI Replay** bar lets you fire exact `executePayInvoice(...)` calldata from an injected prompt (`unlistedAttacker` / replayed `invoiceId`) directly against `AttenuaVault` via live `eth_call` -> reverts `VendorNotRegistered` / `InvoiceAlreadyPaid`, moving **`0 fUSD`**.

## 3:30 — O(1) Kill-Switch & Classical Freeze Proof
- Click chip **`A9`** (`212,347` EVM gas) in the Capability Tree to inspect the live `revokeRootEpoch()` transaction that bumped `rootEpoch` `1 -> 2` in O(1) and immediately rejected active sub-agent execution, plus **`A8`** proving `AA #2` can trigger monotonic `freeze()` yet is blocked at protocol layer from calling `unfreeze()`.

## 4:00 — Terminal Verification (Keyless)

```bash
# 1. 32 read-only live checks on qorechain-diana (KEM registry, live heartbeat, archive decoder, @qorechain/mcp & QoreScan CBOM)
cd agent && npm ci && npm run verify

# 2. 10 live keyless eth_call Attack Lab presets + 10 historical height-1 archive attack decoders
npm run lab -- ALL
npm run decode:attacks

# 3. Agent unit, fuzz (200 runs) & 120-step differential model sync
npm test

# 4. Foundry contract suite (48 unit + 256x32 stateful invariants + 120-step Solidity/TS differential)
cd ../contracts && forge test -vv --no-dynamic-test-linking
```

> **PQC Verification Disclosure:** `forge test` mocks precompiles `0x...0a01` / `0x...0a02` (`contracts/test/mocks/PqcPrecompileMock.sol`) because local Forge EVM does not run QoreChain's Go FIPS 204 precompiles; real `ML-DSA-87` verification (`2,592`-byte pubkeys / `4,627`-byte sigs) is proven live on `qorechain-diana` (`deployments/live-run-evidence.json`, `npm run verify`, and `npm run lab -- ALL`).
