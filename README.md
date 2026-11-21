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

## Live Deployment on `qorechain-diana` (EVM Chain ID `9800`)

Full manifest in [`deployments/qorechain-diana.json`](deployments/qorechain-diana.json) and live 3-sub-agent swarm + 9-attack proof in [`deployments/live-run-evidence.json`](deployments/live-run-evidence.json):

| Contract / Account | Address | Hardening Status |
|---|---|---|
| `AttenuaVault` | `0x4518ef0ddf04b2be51370045bf8154cce8cef7c4` | Zero `msg.sender` trust; per-action `ML-DSA-87` via `0x...0a01` & `0x...0a02` |
| `QoreChainHybridHolderGuard` | `0x3535f314f62b96a55f584e27257eb8a2001bdfb0` | `exempt(AttenuaVault) = true`; `owner = 0x0000...0000` (renounced); Owner EVM window closed (`live = false`) |
| `LiquidityVault` (ERC-4626 `fUSD`) | `0x89e59628b800ef17b55b7b81891d1de82c4185c3` | Apache-2.0 `@qorechain/asset-kit` `QoreChainRwaVault` |
| `ReserveVault` (ERC-4626 `fUSD`) | `0xf09b664c39457ff01356a35ad2fc6fe5e2113cb3` | Apache-2.0 `@qorechain/asset-kit` `QoreChainRwaVault` |
| Owner Treasury (AA #1) | `qor1k4xryjqufhdh44hgsqdpj5llr7y3dwyfenxfqg` | Single-linked-key invariant (Orchestrator only); `fUSD` cap `10/tx`, `25/day` |
| Isolated Monitor (AA #2) | `qor10vv75f5qwca5hra7ye0vxwemz2t6q6lv28m7d4` | `0 fUSD`, `1 uqor/day`, locked to `AttenuaVault.freeze()` (`0xbd2d305f`) only |

## Quick Keyless Verification (Zero Private Keys Required)

Verify live `qorechain-diana` contract bytecode, renounced guard ownership, closed EVM window, AA #1 / AA #2 isolation, registered `ML-DSA-87` keys, and recorded `H1–H7` + `A1–A9` proofs directly against the testnet:

```bash
cd agent
npm install
npm run verify
```

### Run the Web Dashboard & Read-Only Live Attack Theatre

```bash
cd web
npm install
npm run dev
```

## Step 0 Empirical Testnet Proof (`qorechain-diana`, Chain ID `9800`)

Before locking [`docs/SPEC.md`](docs/SPEC.md), all 8 protocol assumptions were tested live on `qorechain-diana` (see [`docs/SPIKE_RESULTS.md`](docs/SPIKE_RESULTS.md)):
- **S1–S8: 8/8 PASS** on `SpikeProbe` (`0xe4bf5d52d9ea33fcf3515ae3ee55841df847c626`, block `10513230`).
- Measured live EVM gas for fail-closed `PqcVerifier`: **1× = `249,133`**, **2× = `430,499`**, **3× = `629,738`**.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — Post-spike architecture specification
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — Adversary model, trust boundaries, invariants (`I1–I9`), and attack matrix (`A1–A9`)
- [`docs/HONEST_LIMITS.md`](docs/HONEST_LIMITS.md) — Explicit engineering boundaries & EIP-7623 / protocol trade-offs
- [`docs/SPIKE_RESULTS.md`](docs/SPIKE_RESULTS.md) — Live `qorechain-diana` empirical verification log (S1–S8)
- [`AI_USAGE.md`](AI_USAGE.md) — Cross-model adversarial engineering log, decision log, and caught mistakes

## Credits & License

- Built with official QoreChain kits: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/pqc`, `@qorechain/qoresign`, `@qorechain/asset-kit` (Apache-2.0 files only; GPL-3.0 ERC-3643 scripts/tests excluded), `@qorechain/mcp`, and OpenZeppelin Contracts v5.
- Capability attenuation prior art: **UCAN** and **Biscuit**.
- Licensed under **Apache-2.0** ([`LICENSE`](LICENSE)).
