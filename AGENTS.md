# Agent Engineering Rules — Attenua

Repository-level operating rules followed by AI coding agents working on `agvswira/attenua`:

1. **Zero Secret Material in Repo**: Never commit `.env` files, mnemonics, Ed25519 keys, ML-DSA/ML-KEM secret keys, or API keys. Live testnet keys live exclusively under `~/.config/attenua-live/` or `~/.config/attenua-spike/`. Never place `Owner Root` keys inside CI workflows.
2. **Preserve Fail-Closed PQC Checks**: Never bypass, relax, or short-circuit `PqcVerifier.sol` checks (`pqcKeyStatus` length/algorithm/possession checks or `pqcVerify` 2,592-byte pubkey / 4,627-byte signature / non-empty boolean return). Any test mocking `0x...0a01`/`0x...0a02` (`PqcPrecompileMock.sol`) must be explicitly disclosed as a local mock while live proof runs on `qorechain-diana`.
3. **Protect Hallmark Source Verification (`4/4 full match`)**: Do not modify files under `contracts/src/` unless executing an explicit versioned redeploy, full `forge test` + live `H1–H7`/`A1–A10` rerun, and Hallmark re-verification.
4. **No Empty Kit Padding**: Every `@qorechain/*` dependency listed in `package.json` must be imported directly in source or executed via a documented CLI verification command (e.g. `qorescan scan` via `npm run cbom`).
5. **Mandatory Verification Before Commit**:
   - `cd agent && npm run typecheck && npm test`
   - `cd agent && npm run verify` and `npm run lab -- ALL` (keyless live `qorechain-diana` check)
   - `cd web && npm run build`
   - `cd contracts && forge test --no-dynamic-test-linking` (enforced on CI)
6. **Atomic Attributed Commits**: Set `git config user.name` and `user.email`, keep commits small and per-feature, and log caught AI errors in [`AI_USAGE.md`](AI_USAGE.md) and [`docs/ai/MISTAKES_AND_CATCHES.md`](docs/ai/MISTAKES_AND_CATCHES.md).
