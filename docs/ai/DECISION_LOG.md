# Architecture Decision Log (Cross-Model Adversarial Review)

This log records the candidate architectures evaluated before writing production code, why weak ideas were rejected on first-principles technical or product-coherence grounds, and the live QoreChain findings that shaped **Attenua**.

## Round 1 — Rejected Candidates

| Candidate | Core Premise | Why It Was Rejected |
|---|---|---|
| **AegisPulse** | Parametric disaster relief using public HTTPS APIs + self-held ML-DSA "sensor quorum" | **Trust-model theater**: Public HTTPS APIs are not ML-DSA-signed; holding all quorum keys yourself proves only relayer authorship, not physical reality. Rare events also prevent organic routine on-chain agent activity. |
| **HelixWard** | Autonomous wet-lab research grant agent | Relies on simulated lab outputs with weak on-chain verifiability compared to native cryptographic invariants. |
| **VeriToll** | Bilateral ML-DSA API procurement with on-chain slashing | LLM inference outputs are non-deterministic and cannot be slashed deterministically on-chain; RPC fraud proofs require a live post-quantum light client, and QoreChain's checkpoint light client does not verify live networks yet. |
| **QorePilot** | Gas-tank & Native AMM rebalancing keeper | `x/abstractaccount` authenticators support `MsgExecuteEVM` and `MsgExecuteCosmos` (bank send), not native AMM swaps cleanly; narrow internal-ops scope. |
| **Lumbung** | Communal rural solar microgrid (Rp 50k/month village dues) with energy-conservation firewall | **Product-market coherence veto (Human)**: Post-quantum L1 + autonomous AI agent is disproportionate to low-value rural cash collection, despite strong social storytelling. |
| **SealRFQ** | Confidential vendor RFQ via QoreSeal + ML-DSA | Having an autonomous agent hold decryption keys and parse untrusted SLA prose directly expands the prompt-injection attack surface without solving a deeper protocol primitive. |

## Round 2 — Selected Architecture: **Attenua** (Hierarchical Capability Attenuation + Institutional Treasury Swarm)

- **Engine (`Attenua`)**: Post-quantum hierarchical capability attenuation (crediting **UCAN** and **Biscuit** as prior art).
- **Flagship Application**: Institutional treasury desk managing `fUSD`-denominated restricted ERC-4626 vaults (`@qorechain/asset-kit`, Apache-2.0 files only), ML-DSA-signed vendor payables, and a zero-budget read-only MCP research analyst.
- **Live Verification Evidence (2026-11-22 on `qorechain-diana`)**:
  - `GET https://api-testnet.qore.host/cosmos/evm/vm/v1/params` → active precompiles: `0x...0901`, `0x...0C01`, `0x...0a01` (`pqcVerify`), `0x...0a02` (`pqcKeyStatus`). Inactive: `0x...0b01`, `0x...0b02`.
  - `GET https://api-testnet.qore.host/qorechain/abstractaccount/v1/config` → `enabled: true`, `max_session_keys: 10`, `max_spending_rules: 5`, `default_session_ttl: "86400"`.
- **Execution Order Rule**: Run **Step 0 Testnet Spike (S1–S7)** in `spike/` BEFORE freezing the final specification document.
