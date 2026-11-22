# Blind Red-Team Security Audit & Remediation Report (v1.0 → v1.1)

> Conducted via a **fresh, zero-context read-only audit agent** given only source code (`AttenuaVault.sol`, `PqcVerifier.sol`, `QoreChainHybridHolderGuard.sol`, `signing.ts`, and `mcp-server.ts`) with zero shared design conversation or prior assumptions.

---

## 1. Audited Target (Baseline v1.0)
- `AttenuaVault` v1.0 (`0x4518ef0ddf04b2be51370045bf8154cce8cef7c4`)
- `PqcVerifier.sol`
- `QoreChainHybridHolderGuard.sol` (`@qorechain/asset-kit`, Apache-2.0)
- `agent/src/signing.ts`
- `agent/src/mcp-server.ts`

## 2. Controls Verified Sound in Baseline Review
1. **Zero `msg.sender` trust in `AttenuaVault` & `PqcVerifier`**: Every state mutation authenticates via explicit domain-separated `ML-DSA-87` (`PqcVerifier`) or ECDSA (`freeze()`), with zero `onlyOwner` or `msg.sender` checks.
2. **Domain Separation & TypeScript↔Solidity Parity**: All 12 `attenua-v1|<ACTION>|` tags are prefix-free and followed exclusively by fixed-width scalar types (no dynamic-type `abi.encodePacked` collision).
3. **Fail-Closed Precompile Discipline**: `PqcVerifier` rejects empty/short returndata (`< 160` bytes for `0x0a02`, `< 32` bytes for `0x0a01`) and enforces `registered`, `algorithmId == 1`, `possessionProven == true`, `pubkey.length == 2592`, and `sig.length == 4627`.
4. **Reentrancy & CEI Ordering**: `executeAllocate`, `executePayInvoice`, and `emergencyWithdraw` use `nonReentrant` and update nonces, `usedInvoices`, and `sm.spent` prior to external calls.
5. **Read-Only MCP Key Isolation**: `mcp-server.ts` holds zero signing keys and loads no user-supplied paths.

---

## 3. Findings & v1.1 Remediation Matrix

### High Severity

| ID | Finding | Mitigation / Status | Verification Proof |
|---|---|---|---|
| **H-01** | **Research clearance separation-of-duties bypass**: A depth-1 sub-agent could self-delegate a depth-2 `budget=0, mask=0` sub-mandate under itself and co-sign `executePayInvoice` as both Payables and Research. | **FIXED in v1.1**: `registerSubMandate` rejects `subAgent == issuer` (`SelfDelegationNotAllowed`); `executePayInvoice` enforces `rm.parentId == bytes32(0)` (root-issued Research clearance only) and `rm.subAgent != sm.subAgent && rm.subAgent != vendor && sm.subAgent != vendor` (`SeparationOfDutiesViolated`). | Live Attack **`A10`** on `qorechain-diana` (`tx=44F6DBDE4629417BE76466343CB0DB44D38D1745DE4CC6A67976C2527FE58685`, `131,159` gas, refused on-chain) + 200-run property test in `agent/test/attenua.test.ts` |
| **H-02** | **Hierarchical revocation escape & budget leak**: Closing a parent via `reclaimSubMandate` while children remained active orphaned children and stranded child budgets/spent accounting. | **FIXED in v1.1**: `reclaimSubMandate` blocks `sm.allocated != 0` (`ActiveChildrenExist`); `_requireActiveSubMandate` & `registerSubMandate` walk ancestors via `_requireOpenAncestors`; added `forceReclaimDescendant` (Orchestrator `ML-DSA-87`) for bottom-up leaf cleanup without revoking the entire epoch. | Property/fuzz suite in `agent/test/attenua.test.ts` (`premature reclaim -> ActiveChildrenExist`) |
| **H-03** | **Permanent ERC-4626 funds lockup via immutable `monitorSigner`**: Compromised classical `monitorSigner` could front-run `unfreeze()` / `executeAllocate()`, while `emergencyWithdraw` only moved idle `fUSD`. | **FIXED in v1.1**: Changed `monitorSigner` from `immutable` to mutable + added PQC-authenticated `setMonitorSigner(address)` (supporting `address(0)` disable) and frozen-safe `emergencyRedeemVaults(to)` redeeming both ERC-4626 vaults directly to `fUSD`. | Verified in `AttenuaVault.sol` v1.1 (`0xf585fc6e...47af58`) + `signSetMonitorSigner` / `signEmergencyRedeemVaults` domain tests |
| **H-04** | **Classical `onlyOwner` (`msg.sender`) surface on `QoreChainHybridHolderGuard`**: Standard `@qorechain/asset-kit` guard uses `Ownable2Step`. | **MITIGATED IN DEPLOYMENT**: During deployment, `AttenuaVault` is marked `exempt = true`, `renounceOwnership()` is immediately called inside a scoped EVM window (`owner == 0x0000...0000`), and the EVM window is closed (`live = false`). No admin remains on the guard. | Keyless verifier `npm run verify` + `agent/test/attenua.test.ts` |

### Medium Severity

| ID | Finding | Status & Rationale |
|---|---|---|
| **M-01** | Missing ERC-4626 `minShares`/`maxShares` slippage bounds in `executeAllocate` (theoretical first-depositor / balance-donation griefing near band boundaries). | **DEFERRED (Documented in [`docs/HONEST_LIMITS.md`](../HONEST_LIMITS.md))**: Preserves compact `executeAllocate` calldata footprint on `qorechain-diana`; `QoreChainRwaVault` wraps OpenZeppelin `ERC4626` in a controlled testnet deployment. Production mainnet should add signed slippage bounds. |
| **M-02** | Vendor invoice signatures (`VENDOR_INVOICE`) lack `vendorDeadline` and `rootEpoch` binding. | **DEFERRED (Documented in [`docs/HONEST_LIMITS.md`](../HONEST_LIMITS.md))**: Paid invoices are permanently blocked via `usedInvoices`; unpaid cancelled vendor quotes require multi-party collusion with both compromised `Payables` and `Research` in the active epoch. Production should add `vendorDeadline`. |
| **M-03** | Global `mandateId` namespace allowed `bytes32(0)` sentinel collision and potential cross-branch ID squatting. | **PARTIALLY FIXED in v1.1 (`bytes32(0)` blocked)**; deterministic ID derivation left optional cleanly in [`docs/HONEST_LIMITS.md`](../HONEST_LIMITS.md) to keep explicit caller-chosen IDs readable in telemetry. |

### Low & Informational Summary

| ID | Item | Status |
|---|---|---|
| **L-04** | Shared per-address nonces & missing constructor sanity checks | **FIXED in v1.1**: Dedicated monotonic `monitorNonce` separated from PQC `nonces`; constructor checks `rootOwner_ != monitorSigner_`, `liquidityVault_ != reserveVault_`, and `asset() == fusd_`. |
| **I-03** | `signing.ts` omitted `signEmergencyWithdraw`; `mcp-server.ts` eagerly read `DEPLOYMENT_FILE` | **FIXED**: Added `signEmergencyWithdraw`, `signSetMonitorSigner`, `signEmergencyRedeemVaults`, and `signForceReclaimDescendant` in `agent/src/signing.ts`; moved manifest read inside relevant handlers in `mcp-server.ts`. |
| **L-01, L-02, L-03, L-05, I-01, I-02** | Band excludes `idleFusd`, upstream vendored `HolderGuard` `PRECOMPILE_GAS`/`2592` check, `payablesDigest` without `researchMandateId`, strict `verifyRet.length == 32` check | **ACKNOWLEDGED / DEFERRED** in [`docs/HONEST_LIMITS.md`](../HONEST_LIMITS.md); untouched vendored `@qorechain/asset-kit` contract (`QoreChainHybridHolderGuard.sol`) kept unmodified per Apache-2.0 upstream parity. |

---

## 4. Redeployed Hardened Contract (v1.1)
- **`AttenuaVault` v1.1**: `0xf585fc6e1e43446f353830e0d11ff44ce747af58` (`16,406` deployed bytes on `qorechain-diana`, tx `0xb115277bd91cc5b43d1a84a22c87d4dc8cc324c28d698d66aea3e416e52ec349`)
- **All live checks after v1.1 redeploy**:
  - `npm run verify`: **19 PASSED, 0 FAILED** (`9/9` happy path + `10/10` genuine non-OOG refusals `A1–A10`)
  - `npm test`: **7/7 tests PASS** across 4 suites (including 14 `ML-DSA-87` helpers + 200 property/fuzz trials + Research screener + live chain assertions)
