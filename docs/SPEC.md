# Attenua — Architecture Specification (v1.0, Post-Spike)

> Every protocol assumption in this specification is backed by empirical measurements on `qorechain-diana` (EVM Chain ID `9800`) recorded in [`docs/SPIKE_RESULTS.md`](SPIKE_RESULTS.md) (S1–S8).

## 1. Thesis & Prior Art

**"Quantum-safe infrastructure is a fiduciary requirement."**

Modern AI treasury operations run as **multi-agent swarms** (an Orchestrator delegating specialized tasks to sub-agents). Existing on-chain agent guardrails only bind a single agent key to an owner. Sharing one key across sub-agents lets a single prompt-injected sub-agent drain the entire allowance; requiring a human owner's cold `ML-DSA-87` signature for every sub-task destroys autonomy.

**Attenua** brings **hierarchical cryptographic capability attenuation** (crediting **UCAN** and **Biscuit** as prior art) to QoreChain's post-quantum EVM + Cosmos `x/abstractaccount` architecture, demonstrated through a flagship **Autonomous Institutional Treasury Swarm** managing `fUSD`-denominated restricted ERC-4626 vaults (`@qorechain/asset-kit`, Apache-2.0 files only).

---

## 2. Empirical Protocol Constraints Locked by Step 0 Spike (S1–S8)

| Spike | Measured Finding on `qorechain-diana` | Enforced Design Rule |
|---|---|---|
| **S1** | `MsgExecuteEVM` arrives with `msg.sender == Owner 0x` | **Zero `msg.sender` / `onlyOwner` trust** in `AttenuaVault.sol`. Every authorization is a domain-separated signature verified in calldata. |
| **S2** | Direct `fUSD.transfer` is capped by `x/abstractaccount` `denom_limits` (`outer code: 0`, `abstractaccount_execution_failed` on breach) | **Just-in-Time (JIT) funding** via direct `fUSD.transfer(AttenuaVault, x)`. Owner NEVER grants ERC-20 `allowance` to `AttenuaVault`. |
| **S3** | `allowed_evm_calls` enforces selector-level allowlists (`0xVault/0xSelector`) | Orchestrator authenticator can ONLY call `fUSD.transfer` and specific `AttenuaVault` execute/register selectors. |
| **S4 & S8** | `cap = 0` is rejected (`v3.2.8` requires `> 0`); `MsgRegisterAuthenticator` has no per-key rule in SDK v0.14.0, so multiple linked keys on one account inherit the same rule | **Two isolated Abstract Accounts**: **AA #1 (Owner Treasury)** has **exactly ONE linked key (Orchestrator)**; **AA #2 (MonitorAccount, `0 fUSD`)** holds the freeze-only Monitor key (`1 uqor` cap, `freeze()` selector only). |
| **S5** | Live EVM gas for fail-closed `PqcVerifier` (`pqcKeyStatus` → `possessionProven` → `pqcVerify`): **1× = 249,133 gas**, **2× = 430,499 gas**, **3× = 629,738 gas**; `0x...0B02` inactive & fail-closed | **Every spend at every level requires `ML-DSA-87`**. `Payables` verifies **all 3 `ML-DSA-87` signatures atomically on-chain** (~630k gas): `Payables` + `Vendor` + `Research` clearance! |
| **S6** | `MsgRevokeAuthenticator` blocks next `MsgExecuteEVM` immediately | Protocol kill-switch revokes Orchestrator instantly on-chain. |
| **S7** | Unscoped window deploys contracts; scoped window (`allowedTargets`) restricts admin calls; `MsgCloseEVMWindow` closes immediately | Two-phase window discipline: unscoped deploy window closed immediately; scoped admin windows closed immediately. |

---

## 3. Contract Architecture (`contracts/`)

### 3.1 `PqcVerifier.sol` (Library, Apache-2.0)
- `PQC_VERIFY = 0x0000000000000000000000000000000000000a01`
- `PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02`
- **Strict fail-closed verification sequence**:
  1. Require `signature.length == 4627`.
  2. `staticcall` `pqcKeyStatus(signer)` and require `ok && ret.length >= 128` (guards against inactive precompile returning `0x`).
  3. Require `registered && algorithmId == 1 && possessionProven && pubkey.length == 2592`.
  4. `staticcall` `pqcVerify(pubkey, signature, message)` and require `ok && ret.length >= 32`.
  5. Decode `bool valid` and require `valid == true`.

### 3.2 `QoreChainHybridHolderGuard` + 2× `ERC-4626` `fUSD` Vaults (`@qorechain/asset-kit`, Apache-2.0)
- Two `fUSD`-denominated restricted ERC-4626 vaults:
  - **`LiquidityVault`** (short-duration `fUSD` liquidity sleeve)
  - **`ReserveVault`** (term `fUSD` reserve sleeve)
- Both vaults enforce `QoreChainHybridHolderGuard` (`pqcKeyStatus` with `possessionProven == true`).
- **Closing the classical `Ownable2Step` gap**: Right after calling `guard.setExempt(address(attenuaVault), true)` during deployment, **guard ownership is renounced (or transferred to `AttenuaVault`'s ML-DSA-87-gated admin)** so no classical key can ever call `setExempt(attacker)`.
- Because both vaults share the exact same underlying (`fUSD`), portfolio weights are computed **purely on-chain via `convertToAssets()`** with zero external price oracle.

### 3.3 `AttenuaVault.sol` (Core Capability Attenuation Engine, Apache-2.0)
- **Zero `msg.sender` / `onlyOwner` checks anywhere.**
- **Immutable `rootOwner` (`address`)** — whose registered `ML-DSA-87` key (`pqcKeyStatus`) is the root of trust.
- **State**:
  - `uint64 public rootEpoch` — incremented by Owner's `ML-DSA-87` `revokeRootEpoch()` for **O(1) cascading revocation** of the entire delegation tree.
  - `bool public frozen` — set to `true` monotonically by `freeze()` (authenticated by registered `monitorSigner` classical ECDSA sig OR Owner `ML-DSA-87`); **can ONLY be unfrozen by Owner's `ML-DSA-87` `unfreeze()`**.
  - `RootMandate`: `orchestrator`, `rootBudget`, `rootAllocated`, `rootSpent`, `minLiquidityBps`, `maxLiquidityBps`, `expiry`, `maxDepth`, `epoch`, `active`.
  - `SubMandate` (keyed by `bytes32 mandateId`): `parentId`, `subAgent`, `actionMask` (`BIT_ALLOCATE = 1`, `BIT_PAY_INVOICE = 2`, `BIT_RESEARCH = 0`), `budget`, `spent`, `minLiquidityBps`, `maxLiquidityBps`, `expiry`, `depth`, `rootEpoch`, `revoked`.
  - `mapping(address => bool) public registeredVendors` — updated ONLY via Owner's `ML-DSA-87` signature (verifying vendor has `pqcKeyStatus` `possessionProven == true`).
  - `mapping(address => uint64) public nonces` — per-signer replay protection.
  - `mapping(bytes32 => bool) public usedInvoices` — prevents double-payment of vendor invoices.

- **5 On-Chain Lattice Attenuation Invariants (enforced in `registerSubMandate`)**:
  1. **Budget Conservation**: `childBudget <= parentRemaining`; `rootAllocated` reserves `childBudget` atomically so $\sum \text{activeChildren} + \text{parentDirectSpent} \le \text{rootBudget}$. Unused child budget is reclaimed via `closeSubMandate()` or after `expiry`.
  2. **Weight-Band Attenuation**: `childMinBps >= parentMinBps && childMaxBps <= parentMaxBps && childMinBps <= childMaxBps`.
  3. **Action-Mask Subset**: `(childActionMask & ~parentActionMask) == 0`.
  4. **Time & Depth Monotonicity**: `childExpiry <= parentExpiry` and `childDepth == parentDepth + 1 <= root.maxDepth`.
  5. **Epoch Binding**: `child.rootEpoch == rootEpoch` (invalidated in O(1) when `rootEpoch` increments).

- **Action Entrypoints (ALL verified via `PqcVerifier`, ZERO `msg.sender` trust)**:
  1. `setRootMandate(params, ownerPqcSig)` — Owner `ML-DSA-87` installs/updates Root IPS Mandate.
  2. `setVendor(vendor, allowed, nonce, deadline, ownerPqcSig)` — Owner `ML-DSA-87` manages vendor allowlist (requires vendor `possessionProven == true`).
  3. `registerSubMandate(params, parentPqcSig)` — Orchestrator `ML-DSA-87` issues attenuated sub-mandate to `Allocator`, `Payables`, or `Research` (`budget = 0`, `actionMask = 0`). Verified once & stored.
  4. `reclaimSubMandate(mandateId, parentPqcSig)` — Reclaims unspent budget from closed/expired child mandate back to parent.
  5. `executeAllocate(mandateId, liqAmount, liqIsDeposit, resAmount, resIsDeposit, nonce, deadline, subAgentPqcSig)`:
     - Checks `!frozen`, `mandate.rootEpoch == rootEpoch`, `block.timestamp <= mandate.expiry`, `(actionMask & BIT_ALLOCATE) != 0`, and `budget - spent >= liqAmount + resAmount` (`grossVolume`, an intentional gross turnover cap at `AttenuaVault.sol:692` that prevents infinite wash-rebalancing inside one mandate).
     - Verifies `Allocator`'s `ML-DSA-87` sig (domain-separated: `chainId`, `vault`, `rootEpoch`, `mandateId`, `liqAmount`, `liqIsDeposit`, `resAmount`, `resIsDeposit`, `nonce`, `deadline`).
     - Executes `withdraw`/`deposit` on the allowlisted ERC-4626 `fUSD` vaults (`LiquidityVault` / `ReserveVault`).
     - **Post-trade IPS weight invariant**: Computes `liquidityBps = liqAssets * 10000 / (liqAssets + resAssets)` via `convertToAssets()` and reverts if outside `[mandate.minLiquidityBps, mandate.maxLiquidityBps]`!
  6. `executePayInvoice(mandateId, vendor, invoiceId, amount, nonce, deadline, payablesPqcSig, vendorPqcSig, researchAgent, researchPqcSig)`:
     - Checks `!frozen`, `mandate.rootEpoch == rootEpoch`, `block.timestamp <= mandate.expiry`, `(actionMask & BIT_PAY_INVOICE) != 0`, `registeredVendors[vendor]`, `!usedInvoices[invoiceKey]`, `budget - spent >= amount`.
     - **3× `ML-DSA-87` Atomic On-Chain Verification (~630k gas)**:
       1. `Payables` sub-agent execution signature (bound to `mandateId` — prevents confused-deputy sibling theft!).
       2. `Vendor` invoice signature (bound to `vendor`, `invoiceId`, `amount`, `vault`, `chainId` — prevents prompt-injected recipient/amount tampering!).
       3. `Research` zero-budget sub-agent clearance signature (`researchAgent` must hold an active `Research` mandate under the same `rootEpoch` — proving authenticated messaging from the zero-budget analyst!).
     - Transfers `amount` `fUSD` directly to `vendor`.
  7. `freeze(nonce, deadline, monitorEcdsaSig)` — Monotonic freeze callable via AA #2 Monitor authenticator (`1 uqor` cap, `freeze()` selector only) with `ecrecover` authentication against `monitorSigner`.
  8. `unfreeze(nonce, deadline, ownerPqcSig)` & `revokeRootEpoch(nonce, deadline, ownerPqcSig)` & `emergencyWithdraw(to, amount, nonce, deadline, ownerPqcSig)` — Owner `ML-DSA-87` ONLY.

---

## 4. Honest Limits (Explicitly Documented in README & UI)

- `x/abstractaccount` and precompiles `0x...0a01`/`0x...0a02` are active on `qorechain-diana` testnet only (not yet enabled on `qorechain-vladi` mainnet).
- `x/abstractaccount` enforces the protocol spending cap at the **root (AA #1 JIT funding)**; hierarchical sub-mandate attenuation lives in `AttenuaVault.sol`. Therefore, the vault's working `fUSD` balance is the hard exposure bound against any vault contract bug.
- Yield accrual on the two testnet ERC-4626 `fUSD` vaults is simulated deterministically (no live DeFi yield sources exist on `qorechain-diana`), while `convertToAssets()` valuation, weight-band enforcement, `QoreChainHybridHolderGuard`, and `ML-DSA-87` checks run live on testnet.
- GPL-3.0 ERC-3643 reference scripts/tests in `qorechain-asset-kit` are intentionally excluded; only Apache-2.0 components are used so the entire repository remains Apache-2.0 compliant.
