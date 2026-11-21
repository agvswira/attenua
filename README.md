# Attenua

**Post-Quantum Hierarchical Capability Attenuation for Autonomous Institutional Treasury Swarms on QoreChain.**

> *"Quantum-safe infrastructure is a fiduciary requirement."*

## Problem

Production AI agents do not operate alone — an **Orchestrator** agent spawns specialized **Sub-Agents** (*Allocator*, *Payables*, *Research*). Sharing one linked key across sub-agents allows a single prompt-injected sub-agent to drain the entire allowance; requiring a human owner's cold `ML-DSA-87` signature for every sub-task breaks autonomy.

**Attenua** brings **hierarchical cryptographic capability attenuation** (crediting **UCAN** and **Biscuit** as prior art) to QoreChain's post-quantum EVM + Cosmos `x/abstractaccount` architecture, applied to an **Autonomous Institutional Treasury Swarm** managing `fUSD`-denominated restricted ERC-4626 vaults (`@qorechain/asset-kit`, Apache-2.0 components only).

## Architecture

1. **Root Protocol Ceiling (`x/abstractaccount`, AA #1 — Owner Treasury)**
   - Treasury `fUSD` remains in the Owner's canonical account; Owner **never** grants ERC-20 `allowance` to `AttenuaVault`.
   - Exactly **one** linked `ed25519` authenticator (Orchestrator) funds `AttenuaVault` **Just-in-Time** via direct `fUSD.transfer(AttenuaVault, x)` bounded by `denom_limits`, and relays sub-agent executions via `MsgExecuteEVM` restricted to allowlisted selectors (`allowed_evm_calls`).
   - The vault's working `fUSD` balance is the hard exposure bound even if a vault contract bug existed.
2. **Isolated Freeze-Only Monitor (`x/abstractaccount`, AA #2 — MonitorAccount)**
   - Dedicated abstract account holding `0 fUSD`, bounded by `perTxLimit: 1 uqor`, `dailyLimit: 1 uqor`, and `allowed_evm_calls: [AttenuaVault.freeze()]`.
   - Classical monitor key can **only** freeze monotonically; unfreezing requires Owner's `ML-DSA-87`.
3. **Zero `msg.sender` Trust & On-Chain Attenuation Lattice (`AttenuaVault.sol`)**
   - No `onlyOwner` or `msg.sender == rootOwner` checks anywhere (empirically mandated by Step 0 Spike **S1**: `MsgExecuteEVM` calls arrive from Owner's `0x` address).
   - Every spending, delegation, and admin loosening action verifies a domain-separated `ML-DSA-87` signature via fail-closed `PqcVerifier` (`pqcKeyStatus` `0x...0a02` with `possessionProven == true` → `pqcVerify` `0x...0a01`).
   - Enforces **5 lattice invariants**: budget conservation ($\sum \text{child} + \text{parent} \le \text{root}$) + reclaim, narrowed IPS weight band (`[childMinBps, childMaxBps] ⊆ [parentMinBps, parentMaxBps]`), action-mask subset, monotonic expiry & depth, and **O(1) cascading kill-switch** (`revokeRootEpoch()`).
4. **Flagship 3-Sub-Agent Treasury Swarm (`@qorechain/asset-kit`)**
   - **`Allocator`**: Rebalances between two `fUSD` `QoreChainRwaVault` (ERC-4626) sleeves guarded by `QoreChainHybridHolderGuard` (ownership renounced after exempting `AttenuaVault` to close the `Ownable2Step` classical-key gap). Portfolio weights are verified on-chain via `convertToAssets()` with zero external price oracle.
   - **`Payables`**: Pays allowlisted vendors only with **3× atomic on-chain `ML-DSA-87` verification** (~630k gas): `Payables` execution + `Vendor` invoice + `Research` clearance verdict.
   - **`Research` (`budget = 0`)**: Read-only analyst using `@qorechain/mcp` that screens unstructured invoices for prompt injections and signs `ML-DSA-87` clearance verdicts while being cryptographically incapable of spending `1 uqor`.

## Step 0 Empirical Testnet Proof (`qorechain-diana`, Chain ID `9800`)

Before locking [`docs/SPEC.md`](docs/SPEC.md), all 8 protocol assumptions were tested live on `qorechain-diana` (see [`docs/SPIKE_RESULTS.md`](docs/SPIKE_RESULTS.md)):
- **S1–S8: 8/8 PASS** on `SpikeProbe` (`0xe4bf5d52d9ea33fcf3515ae3ee55841df847c626`, block `10513230`).
- Measured live EVM gas for fail-closed `PqcVerifier`: **1× = `249,133`**, **2× = `430,499`**, **3× = `629,738`**.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — Post-spike architecture specification & honest limits
- [`docs/SPIKE_RESULTS.md`](docs/SPIKE_RESULTS.md) — Live `qorechain-diana` empirical verification log (S1–S8)
- [`AI_USAGE.md`](AI_USAGE.md) — Cross-model adversarial engineering log, decision log, and caught mistakes

## Credits & License

- Built with official QoreChain kits: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/pqc`, `@qorechain/qoresign`, `@qorechain/asset-kit` (Apache-2.0 files only; GPL-3.0 ERC-3643 scripts/tests excluded), `@qorechain/mcp`, and OpenZeppelin Contracts v5.
- Capability attenuation prior art: **UCAN** and **Biscuit**.
- Licensed under **Apache-2.0** ([`LICENSE`](LICENSE)).
