# AI Mistakes, Blind Spots, and Catches Log

This log records concrete errors made by AI models during the design and build of **Attenua**, how each error was detected, and the exact architectural or test fix applied.

> Cross-model review pair: **Model A (Gemini 4 Neon)** & **Model B (Claude Opus 5.5)**.

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

## Build, Live Deployment & Verification Phase (2026-11-22)

10. **EIP-7623 Calldata Floor Gas Masking `A3`, `A5`, and `A6` Refusals**
    - *Mistake*: In the first live run of `02-run-swarm-and-attacks.ts`, attacks `A3` (Confused Deputy), `A5` (Unlisted Vendor), and `A6` (Duplicate Invoice Replay) — all calling `executePayInvoice` with 3× 4,627-byte `ML-DSA-87` signatures (~14 KB calldata) — were submitted with `evmGasLimit` of `400,000–450,000`. All three reverted and were initially logged as `passed: true`, even though `evmGasUsed` was `0` and `verbatimReason` was `"insufficient gas for floor data gas cost: have 450000, want 581370"`.
    - *Catch*: Manual inspection of `deployments/live-run-evidence.json` before building the web dashboard caught that `A3`, `A5`, and `A6` had failed at the EVM EIP-7623 calldata floor check rather than executing `AttenuaVault`'s `ActionNotPermitted`, `VendorNotRegistered`, and `InvoiceAlreadyPaid` guards.
    - *Fix*: Raised `evmGasLimit` on `A3`, `A5`, and `A6` to `1,200,000` (matching `H6`), added a non-zero gas & non-`"insufficient gas"` assertion directly in `02-run-swarm-and-attacks.ts` AND in the keyless verifier `03-verify.ts`, and re-ran the full live suite on `qorechain-diana` so every single attack refusal (`A1–A9`) is a genuine contract or protocol guard refusal.

11. **`x/abstractaccount` Authenticated EVM Spend Probe Cosmos Gas Overhead**
    - *Mistake*: Initially set Cosmos tx gas for `MsgExecuteEVM` to `evmGasLimit + 250,000`, which caused `OutOfGas` inside `authenticated evm spend probe` when `erc20/<fUSD>` was present in `allowedDenoms`.
    - *Catch*: Live `qorechain-diana` execution logs showed the spend probe consumes ~380k+ Cosmos gas above `evmGasLimit` when checking ERC-20 balance deltas.
    - *Fix*: Updated `relayCall` to allocate `cosmosGas = evmGasLimit + 700,000` and documented the empirical overhead in `docs/HONEST_LIMITS.md`.

12. **OpenZeppelin v5 `mcopy` Under `evmVersion: "paris"` & PowerShell UTF-8 BOM**
    - *Mistake*: Compiling vendored `@qorechain/asset-kit` ERC-4626 vaults (OpenZeppelin v5) with `evmVersion: "paris"` failed on `mcopy`, and PowerShell `Set-Content -Encoding utf8` injected a UTF-8 BOM that tripped `solc`.
    - *Catch*: Immediate `solc 0.8.28` compiler errors during Phase 1 build.
    - *Fix*: Switched compiler config to `evmVersion: "cancun"` (matching `qorechain-diana` Cancun/Pectra EVM) and stripped UTF-8 BOMs with `UTF8Encoding($false)`.

13. **Stale Non-SDK Testnet Hostnames in Browser Dashboard (`evm-diana.qorechain.io` vs `@qorechain/sdk`)**
    - *Mistake*: Hardcoded `https://evm-diana.qorechain.io` and `https://rest-diana.qorechain.io` in `web/src/lib/chain.ts`, causing browser live RPC reads on `https://attenua.vercel.app/` to fail name resolution and stay in `"RPC unreachable · showing recorded run"` fallback.
    - *Catch*: Querying `qorechain-diana` directly via those URLs returned DNS failure; reading `@qorechain/sdk/dist/index.js` revealed QoreChain's official testnet endpoints are `https://evm-testnet.qore.host` (with `access-control-allow-origin: *`) and `https://api-testnet.qore.host`.
    - *Fix*: Updated `web/src/lib/chain.ts` to use `@qorechain/sdk`'s canonical endpoints and made REST status fetches fail gracefully so live EVM state (`blockNumber`, `rootEpoch`, `frozen`, `portfolioSummary`, `HolderGuard`, `keyStatus`) loads cleanly in browsers.

14. **Blind Fresh-Context Audit High Findings (`H-01`, `H-02`, `H-03`) in `AttenuaVault` v1.0**
    - *Mistake*: `AttenuaVault` v1.0 (1) allowed any depth-1 sub-agent to self-delegate a `budget=0, mask=0` child mandate (`H-01`), bypassing independent Research co-signing; (2) allowed reclaiming a parent mandate while grandchildren remained open (`H-02`); and (3) stored classical `monitorSigner` as `immutable` with no frozen-state ERC-4626 redemption path (`H-03`).
    - *Catch*: Independent zero-context blind security audit documented in [`docs/ai/BLIND_RED_TEAM.md`](BLIND_RED_TEAM.md).
    - *Fix*: Patched all three High findings + `M-03` (`bytes32(0)` rejection) + `L-04` (separate `monitorNonce` & constructor checks) in **`AttenuaVault` v1.1** (`0xf585fc6e1e43446f353830e0d11ff44ce747af58`), added Attack **`A10`** proving `H-01` is refused on-chain (`tx=44F6DBDE...8685`, `131,159` gas), and verified `19/19` checks via `npm run verify`.
