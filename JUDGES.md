# 5-Minute Keyless Judge Walkthrough — Attenua

No private keys, wallet extensions, or API keys are required to verify every security claim in **Attenua** against the live deployed `AttenuaVault` v1.1 contract (`0xf585fc6e1e43446f353830e0d11ff44ce747af58` on `qorechain-diana`, Chain ID `9800`).

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
# 1. 26 read-only live checks on qorechain-diana (+ @qorechain/mcp preflight & QoreScan CBOM)
cd agent && npm ci && npm run verify

# 2. 10 live keyless eth_call Attack Lab presets from terminal
npm run lab -- ALL

# 3. Agent unit, fuzz (200 runs) & 120-step differential model sync
npm test

# 4. Foundry contract suite (48 unit + 256x32 stateful invariants + 120-step Solidity/TS differential)
cd ../contracts && forge test -vv --no-dynamic-test-linking
```

> **PQC Verification Disclosure:** `forge test` mocks precompiles `0x...0a01` / `0x...0a02` (`contracts/test/mocks/PqcPrecompileMock.sol`) because local Forge EVM does not run QoreChain's Go FIPS 204 precompiles; real `ML-DSA-87` verification (`2,592`-byte pubkeys / `4,627`-byte sigs) is proven live on `qorechain-diana` (`deployments/live-run-evidence.json`, `npm run verify`, and `npm run lab -- ALL`).
