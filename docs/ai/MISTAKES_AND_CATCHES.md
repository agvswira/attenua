# AI Mistakes, Blind Spots, and Catches Log

This file logs concrete errors made by AI models during the design and build of **Attenua**, how each error was detected, and the exact architectural or test fix applied.

## Pre-Code & Architecture Phase (2026-11-22)

1. **Fake Oracle Quorum (*AegisPulse*)**
   - *Mistake*: Proposed signing public HTTPS API data (USGS/Open-Meteo) with developer-held ML-DSA keys and calling it a "Byzantine sensor quorum."
   - *Catch*: Independent cross-model review pointed out that all keys held by one developer prove only relayer authorship, not physical reality.
   - *Fix*: Abandoned external-oracle designs entirely; moved to native on-chain cryptographic capability attenuation.

2. **Classical Session Key Compromise (*SubLeash* v1)**
   - *Mistake*: Proposed caching an ML-DSA-87 delegation and letting sub-agents sign spends with cheaper classical keys (`ed25519`/`secp256k1`).
   - *Catch*: Independent review flagged that letting classical keys authorize spending weakens the post-quantum guarantee (a quantum attacker breaking the session key could drain up to the session cap).
   - *Fix*: Verified precompile gas (`pqcVerify` = 25,000 + 8/byte; `pqcKeyStatus` = 2,500). Kept **per-action `ML-DSA-87`** for every sub-agent spend and cached only the parent delegation authorization hash.

3. **Misquoted v3.2.2 Docs & Standing `allowance` Hole (`pullJIT`)**
   - *Mistake*: Proposed `AttenuaVault.pullJIT()` via ERC-20 `transferFrom` and assumed `x/abstractaccount` `denom_limits` would cap it.
   - *Catch*: Cross-model review pointed out (a) standing ERC-20 `allowance` from Owner to `AttenuaVault` lets any contract bug drain up to the full allowance outside `x/abstractaccount`, and (b) docs did not guarantee `transferFrom` accounting.
   - *Fix*: Removed `pullJIT` and standing `allowance` completely; Orchestrator sends `fUSD.transfer(AttenuaVault, x)` directly within `denom_limits`.

4. **`QoreChainHybridHolderGuard` Classical `Ownable2Step` Gap**
   - *Mistake*: Assumed `@qorechain/asset-kit`'s `QoreChainHybridHolderGuard` was automatically quantum-safe after deployment.
   - *Catch*: Source-code audit of `qorechain-asset-kit` revealed `AttenuaVault` (a contract, with no ML-DSA key) needs `setExempt(AttenuaVault)` — and `setExempt` is guarded by classical `Ownable2Step` (`onlyOwner`).
   - *Fix*: After calling `setExempt(AttenuaVault)`, transfer guard ownership to an `ML-DSA-87`-gated admin (or renounce ownership).

5. **GPL-3.0 Licence Clash in `qorechain-asset-kit`**
   - *Mistake*: Planned to import ERC-3643 reference implementation files directly from `qorechain-asset-kit`.
   - *Catch*: Reading `qorechain-asset-kit/README.md` revealed `contracts/script/erc3643/` and `contracts/test/erc3643/` are **GPL-3.0-or-later**, which conflicts with the MIT/Apache-2.0 licence requirement.
   - *Fix*: Import strictly Apache-2.0 files (`contracts/src/` guards and ERC-4626 vaults) and keep our repository 100% Apache-2.0.

6. **Calling Inactive Precompile `aiAnomalyCheck` (`0x...0b02`)**
   - *Mistake*: Considered using `0x...0b02` as an on-chain tripwire.
   - *Catch*: Live query to `GET https://api-testnet.qore.host/cosmos/evm/vm/v1/params` confirmed only `0x...0901`, `0x...0C01`, `0x...0a01`, and `0x...0a02` are active on `qorechain-diana`. Calling an inactive precompile returns empty `0x` without reverting.
   - *Fix*: Removed `0x...0b02` from production design; added explicit empty-return fail-closed guards in `SpikeProbe.sol` (S5) and `PqcVerifier`.

7. **Conflicting Docs Claim on `allowed_evm_calls`**
   - *Mistake*: One model read only the SDK guide and concluded selector-level `allowed_evm_calls` did not exist.
   - *Catch*: Live read of `docs.qorechain.io/developer-guide/account-abstraction` confirmed `allowed_evm_calls` (`0x<target>/0x<selector>`) since v3.2.2; verified by both models.
   - *Fix*: Queued live empirical test **S3** in Step 0 Spike.

8. **`msg.sender` Aliasing under `MsgExecuteEVM` & Bare Classical Monitor EOA**
   - *Mistake*: Proposed a bare classical EOA calling `freeze()` on EVM and did not explicitly forbid `msg.sender` authorization inside `AttenuaVault`.
   - *Catch*: Cross-model review flagged that (a) bare classical EOAs cannot send EVM txs without an ML-DSA-opened window, and (b) every `MsgExecuteEVM` call from any linked key arrives from Owner's `0x` address (`msg.sender` aliasing).
   - *Fix*: Zero `msg.sender` / `onlyOwner` logic in `AttenuaVault.sol`, Monitor linked as an `x/abstractaccount` authenticator restricted to `freeze()`, and queued **S1** & **S4** in Step 0 Spike.

9. **Per-Key Rule Binding Gap in `@qorechain/sdk` v0.14.0 & Single-Linked-Key Invariant**
   - *Mistake*: Initially planned to attach both Orchestrator (`fUSD.transfer` + `Vault.execute`) and Monitor (`Vault.freeze` only) to the same Owner abstract account with separate per-key rules.
   - *Catch*: Account Abstraction docs mention per-authenticator rules in the resolution order, and `fetchSpendingRules` includes an `authenticatorRules` field, **but `@qorechain/sdk` v0.14.0 (`MsgRegisterAuthenticator` / `MsgUpdateSpendingRules`) provides no field or message to bind a spending rule to a single key**. Without a per-key binding, every linked key on an account falls back to the account's first enabled account-wide rule — meaning a second key linked to Owner would inherit Orchestrator's `fUSD.transfer` and `allowed_evm_calls` permissions.
   - *Fix*: Isolated Monitor onto its **own dedicated Abstract Account #2** holding `0 fUSD` (`perTxLimit: "1"`, `dailyLimit: "1"`, `allowedDenoms: ["uqor"]`, `allowedEvmCalls: ["0xVault/0x<freeze>"]`), established the design invariant that the **Owner treasury account holds at most ONE linked key (Orchestrator only)**, and added empirical test **S8** to Step 0 Spike to verify that two keys linked to the same account share the same account-wide rule.

---

*(Build, testing, mutation, and blind red-team catches will be appended chronologically below as each milestone lands.)*
