# Attenua — Honest Engineering Limits

We explicitly document what Attenua **does** and **does not** prove, to avoid overclaiming.

---

## 1. Cryptographic & Protocol Boundaries
- **Classical Transport vs. Post-Quantum Authorization**: On QoreChain `qorechain-diana` v3.2.8, `x/abstractaccount` authenticators use classical `ed25519` or `secp256k1` keys to pay/route `MsgExecuteEVM` transactions. Attenua does **not** rely on those classical keys for vault authorization: every value-moving or policy-changing call inside `AttenuaVault` requires one to three NIST FIPS 204 `ML-DSA-87` signatures verified via the `0x...0a01` precompile.
- **Residual Classical Surface (JIT Funding & Monotonic Freeze)**:
  - **JIT `fUSD.transfer`**: Governed by `x/abstractaccount` `denom_limits` (`10 fUSD/tx`, `25 fUSD/day`) on Owner AA #1. A future CRQC that breaks Ed25519 could trigger transfers up to the daily cap until Owner revokes the authenticator via hybrid `ML-DSA-87` `MsgRevokeAuthenticator`. This is a bounded exposure window, not zero.
  - **Monotonic `freeze()`**: Intentionally callable by the classical Monitor for fast incident response. A compromised/quantum-broken monitor can freeze the vault (a temporary liveness DoS), which Owner can reverse via `ML-DSA-87` `unfreeze()` and rotate/disable via `setMonitorSigner()` + `emergencyRedeemVaults()` (added in v1.1 after our blind audit finding `H-03`). It cannot steal funds or modify mandates.
- **No On-Chain Zero-Knowledge Privacy**: Mandates, vendor addresses, invoice hashes, and allocation amounts are public on `qorechain-diana`. Only invoice off-chain memos/PDFs remain off-chain (represented on-chain by `bytes32 invoiceId`).

## 2. Gas & Calldata Constraints (EIP-7623)
- Each `ML-DSA-87` signature is **4,627 bytes**. Under EIP-7623 calldata floor pricing on Cancun/Pectra EVMs, a 3-signature `executePayInvoice` call carries ~14 KB of calldata and requires a **calldata floor of ~582,000 EVM gas** even before execution begins.
- `x/abstractaccount`'s authenticated EVM spend probe adds ~380k+ Cosmos gas overhead when `erc20/...` denoms are listed in `allowedDenoms`.
- Consequence: Callers must set `evmGasLimit >= 1,200,000` for 3-signature `executePayInvoice` calls and `cosmosGas = evmGasLimit + 700,000`. Setting lower EVM gas limits causes transactions to fail at the EIP-7623 floor before reaching `AttenuaVault` logic.

## 3. Single-Linked-Key Operational Constraint
- Because `@qorechain/sdk` v0.14.0 does not expose per-authenticator spending rule binding (verified in Spike S8), **Owner AA #1 must never have more than one active linked authenticator**. Operators who want multiple distinct agent transport keys with different protocol limits must isolate them into separate Abstract Accounts (as Attenua does with AA #2 for the Monitor).

## 4. Scope of Verification, Deferred Audit Items & Known Trade-Offs
- **Not a Third-Party External Audit**: Attenua has been verified via an empirical testnet spike (`S1–S8`), a full live 3-sub-agent swarm + 10-attack suite (`H1–H7`, `A1–A10`) on `qorechain-diana`, an automated Node test suite (`npm test`: 14 PQC helpers, 200 property/fuzz runs, prompt-injection screener, and live chain assertions), a keyless read-only verifier (`npm run verify`, `19/19 PASS`), and an internal zero-context blind security audit ([`docs/ai/BLIND_RED_TEAM.md`](ai/BLIND_RED_TEAM.md)). It has **not** undergone an independent human third-party smart contract audit and is deployed on **testnet (`qorechain-diana`)** using test `fUSD`, not mainnet real-world assets.
- **Explicitly Deferred Blind-Audit Medium/Low Items**:
  - **`M-01` ERC-4626 Slippage Bounds**: `executeAllocate` relies on ERC-4626 vault `convertToAssets()` without per-call `minSharesOut` / `maxSharesBurned` slippage parameters, leaving theoretical sensitivity to direct ERC-20 balance donations near band edges. Production mainnet deployments should add signed slippage bounds.
  - **`M-02` Vendor Signature Deadline**: `VENDOR_INVOICE` signatures do not carry an independent `vendorDeadline` / `rootEpoch` (reusing paid invoices is blocked by `usedInvoices`, but unpaid vendor quotes do not expire unless epoch/mandates are rotated).
  - **`L-01 / L-02 / L-03 / L-05`**: The IPS band measures the invested `LiquidityVault / (LiquidityVault + ReserveVault)` ratio excluding `idleFusd` (allowing full unwind to idle cash); unmodified vendored `QoreChainHybridHolderGuard.sol` retains its upstream `PRECOMPILE_GAS = 50_000` and `MAX_PUBKEY_LENGTH = 4096` bounds; and `payablesDigest` does not bind a specific `researchMandateId`.
- **Dashboard Live Reads & Evidence Theatre**: The web dashboard reads live EVM contract/account state (`rootEpoch`, `frozen`, `portfolioSummary`, `HolderGuard`, `keyStatus`) directly from QoreChain's official testnet EVM RPC (`evm-testnet.qore.host`), while recorded swarm/attack cards reference explorer-verifiable testnet proofs from `deployments/live-run-evidence.json` (zero private keys in the browser).
