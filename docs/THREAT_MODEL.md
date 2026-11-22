# Attenua Threat Model

This document defines the adversary model, trust boundaries, security invariants, and empirical on-chain verification for **Attenua** on QoreChain (`qorechain-diana`, EVM Chain ID `9800`).

---

## 1. Adversary Capabilities

We assume a strong adversary who can compromise any subset of the following simultaneously:
1. **Prompt-injected or hijacked sub-agent** (`Allocator`, `Payables`, or `Research`) — including full exfiltration of its `ML-DSA-87` sub-agent signing key.
2. **Compromised Orchestrator** — including full exfiltration of its Ed25519 `x/abstractaccount` session key on Owner AA #1 and its `ML-DSA-87` orchestrator key.
3. **Compromised Classical Monitor** — full control of the Monitor's secp256k1/Ed25519 key on isolated AA #2.
4. **Malicious Relayer** — full control of the gas-paying relayer (`qor123ss...`), attempting to replay, reorder, front-run, or submit forged calldata.
5. **Future Cryptographically Relevant Quantum Computer (CRQC)** — capable of forging classical ECDSA/secp256k1 and Ed25519 signatures, but **unable** to forge NIST FIPS 204 `ML-DSA-87` (Level 5) signatures.

### Out of Scope
- Compromise of the **Owner's hardware/cold `ML-DSA-87` root key** (this is the root of trust).
- Consensus-level liveness or safety failure of QoreChain validators.

---

## 2. Trust Boundaries & Key Architectural Invariants

| # | Invariant | Mechanism | Empirical Proof |
|---|---|---|---|
| **I1** | **Zero `msg.sender` / `onlyOwner` trust in `AttenuaVault`** | `MsgExecuteEVM` arrives with `msg.sender == Owner 0x` (Spike S1). Every state-changing function in `AttenuaVault` (except monotonic `freeze()`) verifies an explicit `ML-DSA-87` signature via `PqcVerifier` (`0x...0a01`) bound to `(chainId, vault, rootEpoch, action, nonce, deadline)`. | `AttenuaVault.sol`, Spike S1, Live Run `H1–H7` |
| **I2** | **Single-Linked-Key Invariant on Owner AA #1** | SDK v0.14 spending rules apply uniformly to all linked keys on an account (Spike S8). Owner AA #1 therefore holds **at most one** active linked key (`Orchestrator`). Adding any second key would inherit `fUSD` transfer rights. | Spike S8, `npm run verify` (`activeKeys <= 1`) |
| **I3** | **Zero-Balance Isolated Monitor (AA #2)** | The classical `Monitor` lives on a separate account (`qor10vv7...`) holding `0 fUSD`, `1 uqor` daily cap, and `allowed_evm_calls` locked exclusively to `AttenuaVault.freeze()` (`0xbd2d305f`). A compromised or quantum-broken monitor can **only** pause; it cannot move funds or unfreeze. | `A8`, `npm run verify` |
| **I4** | **Monotonic Capability Attenuation Lattice** | For every `registerSubMandate`: `child.budget <= remainingParentBudget`, `child.minLiquidityBps >= parent.minLiquidityBps`, `child.maxLiquidityBps <= parent.maxLiquidityBps`, `(child.actionMask & ~parent.actionMask) == 0`, `child.expiry <= parent.expiry`, `child.depth <= root.maxDepth`. | `A1`, `A2`, `A3`, `A4` |
| **I5** | **Strict Budget Conservation** | `sum(allocated child budgets) <= parent.budget` at every tree level. Unused budget returns to the parent pool only via explicit `reclaimSubMandate`. | `H7`, `A2` |
| **I6** | **3× Atomic `ML-DSA-87` Invoice Settlement** | `executePayInvoice` verifies 3 distinct `ML-DSA-87` signatures atomically in one transaction: `Payables` (authorized sub-mandate), `Vendor` (allowlisted by Owner with `possessionProven == true`), and `Research` (root-issued zero-budget risk clearance co-signer with strict separation of duties `rm.subAgent != sm.subAgent != vendor`). | `H6` (662,807 gas), `A5`, `A6`, `A10` |
| **I7** | **No Standing ERC-20 Allowance** | Owner never grants `fUSD.approve(AttenuaVault, MAX_UINT)`. Orchestrator funds `AttenuaVault` Just-in-Time via direct `fUSD.transfer` capped by `x/abstractaccount` `denom_limits` (`10 fUSD/tx`, `25 fUSD/day`). | `H3`, `A7` |
| **I8** | **Renounced `QoreChainHybridHolderGuard` Ownership** | `QoreChainHybridHolderGuard` (`@qorechain/asset-kit`) uses `Ownable2Step`. During deployment, `AttenuaVault` is marked `exempt = true`, then `renounceOwnership()` is executed inside a scoped EVM window and the window is closed (`live = false`). No admin can later hijack the guard. | `npm run verify` (`owner == 0x0000...0000`, `window.live == false`) |
| **I9** | **O(1) Post-Quantum Kill-Switch** | Owner signs `revokeRootEpoch()` (`ML-DSA-87`), incrementing `rootEpoch` in O(1) gas (~212k) and instantly invalidating all delegated sub-mandates across the entire tree, paired with `MsgRevokeAuthenticator` on AA #1. | `A9` |

---

## 3. Attack Matrix (`A1–A10`)

Every attack below is executed live on `qorechain-diana` by `agent/src/02-run-swarm-and-attacks.ts` and verified keyless by `agent/src/03-verify.ts`:

| ID | Attack Vector | Expected Guard | Enforcement Layer |
|---|---|---|---|
| **A1** | Orchestrator attempts to widen child IPS band `[30%, 80%]` beyond root `[40%, 70%]` | `AttenuationBandWidened` | `AttenuaVault` Lattice |
| **A2** | Orchestrator allocates `8 + 15 > 20 fUSD` across siblings | `AttenuationBudgetExceeded` | `AttenuaVault` Conservation |
| **A3** | Hijacked `Payables` tries to spend using `Allocator`'s `mandateId` | `ActionNotPermitted` / Signer Mismatch | `AttenuaVault` Mandate Binding |
| **A4** | Hijacked `Research` (`budget = 0`, `mask = 0`) attempts `executeAllocate` | `ActionNotPermitted` / `ZeroBudgetCapability` | `AttenuaVault` Capability Mask |
| **A5** | Prompt-injected `Payables` diverts invoice to an unlisted attacker address | `VendorNotRegistered` | `AttenuaVault` Vendor Registry |
| **A6** | Replay attacker re-submits an already-paid `invoiceId` | `InvoiceAlreadyPaid` | `AttenuaVault` Replay Guard |
| **A7** | Compromised Orchestrator attempts `11 fUSD` JIT transfer (> `10 fUSD/tx` cap) | `spending limit exceeded` | `x/abstractaccount` Protocol |
| **A8** | Classical Monitor calls `freeze()`, blocking spend; Monitor `unfreeze()` refused; Owner `ML-DSA-87` unfreezes | `allowed_evm_calls` + `VaultIsFrozen` | AA #2 Protocol + `AttenuaVault` |
| **A9** | Owner triggers `revokeRootEpoch()` + `MsgRevokeAuthenticator`; active `Allocator` immediately refused | `EpochMismatch` / `MandateInactive` | `AttenuaVault` + `x/abstractaccount` |
| **A10** | Hijacked `Payables` self-delegates a depth-2 zero-budget Research mandate (`H-01`) | `SelfDelegationNotAllowed` / `SeparationOfDutiesViolated` | `AttenuaVault` v1.1 Lattice |

---

## 4. Fail-Closed Precompile Discipline

Empirical testing on `qorechain-diana` v3.2.8 (Spike S4) confirmed that inactive precompiles (`0x...0b01`, `0x...0b02`) return `success == true` with empty `0x` returndata rather than reverting. `PqcVerifier.sol` enforces strict returndata length checks (`returndata.length >= 32` for `0x...0a01` and `>= 128` for `0x...0a02`) and reverts closed on any malformed or empty response.
