# Attenua — Build Before Q-Day Submission Pack

> Ready-to-copy fields for updating the project page on `https://build.qorechain.io/`, verifying on-chain features, and recording the demo video (≤ 3 minutes).

---

## 1. Project Form Fields

- **Project Name**: `Attenua`
- **Tagline**: `Post-quantum hierarchical capability attenuation for autonomous institutional treasury swarms — every agent holds less than its parent.`
- **Category**: `Post-Quantum AI Agents`
- **Public GitHub Repository**: `https://github.com/agvswira/attenua` (Public, Apache-2.0)
- **Live Demo URL**: `https://attenua.vercel.app/`
- **Cover Image (16:9, `1600×900` PNG)**: `docs/assets/attenua-cover-16x9.png`
- **Special Awards / Bounties**:
  - `AI-Native` (`AI_USAGE.md` + `docs/ai/DECISION_LOG.md` + `docs/ai/MISTAKES_AND_CATCHES.md` + `docs/ai/BLIND_RED_TEAM.md` + `docs/ai/AGENT_SESSION.md`)
  - `Regional`: `Indonesia`

---

## 2. Testnet Addresses on `qorechain-diana` (Paste up to 5 lines)

```text
qor1k4xryjqufhdh44hgsqdpj5llr7y3dwyfenxfqg
qor10vv75f5qwca5hra7ye0vxwemz2t6q6lv28m7d4
qor123ss4muqpmc6vzh2fmelawahzfvrgggsfqxunw
qor1f5emshdp3pth6rj6y0skrncqcvhdtn9njql2e0
qor19nukelxkewjx66v08lx3kunqylsyczqgflfzhq
```

*(Role mapping: `Owner AA #1`, `Isolated Monitor AA #2`, `Relayer`, `Orchestrator PQC`, `Allowlisted Vendor`.)*

---

## 3. Kits, SDKs & Network Features Checklists

**Kits and SDKs used (all present in `package.json`):**
- QoreChain SDK (TypeScript) — `@qorechain/sdk` `^0.14.0`
- `qorechain-pqc` (TypeScript) — `@qorechain/pqc` `^0.2.3`
- QoreSign (TypeScript) — `@qorechain/qoresign` `^0.2.0`
- Asset Kit (TypeScript, Solidity) — `@qorechain/asset-kit` `^0.1.0` + Apache-2.0 `QoreChainHybridHolderGuard` & `QoreChainRwaVault`
- MCP + `qore` CLI (TypeScript Node.js server) — `agent/src/mcp-server.ts` (`@modelcontextprotocol/sdk`)

**Network features used (verified live on `qorechain-diana`):**
- Hybrid `ML-DSA-87` transactions
- PQC key registration with proof of possession
- EVM window (incl. scoped)
- Solidity PQC signature check (`0x...0a01`)
- Solidity PQC key status (`0x...0a02`)
- Smart accounts and spending rules (`x/abstractaccount` AA #1 + AA #2)
- Test tokens `fUSD` (`0x97143B771D34ddb9130b807b135Ae675A5a963CA`)
- MCP server (`agent/src/mcp-server.ts`)
- Asset Kit (`QoreChainHybridHolderGuard` + dual `QoreChainRwaVault` ERC-4626)

---

## 3a. Hallmark Verified Source Records (`qorechain-diana`)

All 4 deployed Solidity contracts are source-verified (`full match`, `solc 0.8.28+commit.7893614a`) and ML-DSA-87 claimed to `https://github.com/agvswira/attenua`:

- `AttenuaVault` (PQ-guarded: `pqcVerify` + `pqcKeyStatus`): `https://hallmark-jade.vercel.app/c/0xf585fc6e1e43446f353830e0d11ff44ce747af58`
- `QoreChainHybridHolderGuard` (PQ-guarded: `pqcKeyStatus`): `https://hallmark-jade.vercel.app/c/0xf70c001e482a1112ec76684ddec4ffe3bff4c652`
- `LiquidityVault` (`QoreChainRwaVault`): `https://hallmark-jade.vercel.app/c/0xb5cf1d53872255bed60ebb731e9043b7c9ff2c8b`
- `ReserveVault` (`QoreChainRwaVault`): `https://hallmark-jade.vercel.app/c/0x5b914270db69cee65762c75edf1e1ce2856cc72b`
- Trustless CLI verification: `npx @agvswira/hallmark check 0xf585fc6e1e43446f353830e0d11ff44ce747af58`

---

## 4. Final Demo Video Chapter Timing (`2:49.6` — Under Strict ≤ 3m Limit)

| Time | Scene / Visual | Summary |
|---|---|---|
| **0:00 – 0:27** | Intro cards (`s06`, `s07`, `s08`) | Autonomous treasury swarms, `MsgExecuteEVM` shared-key leak risk, and Attenua thesis (*"Every agent holds less than its parent."*) |
| **0:27 – 0:43** | **Overview** (`s01`) | Live `attenua.vercel.app` Root epoch 2, vault active pill, and live `qorechain-diana` RPC block refresh |
| **0:43 – 1:24** | **Capability tree** (`s02` + H1 explainer `s10`) | Owner root mandate (`20 fUSD`), Orchestrator (`8 fUSD`), narrowed Allocator/Payables/Research (`0 fUSD`), `registerSubMandate()` explainer, and isolated Monitor AA #2 |
| **1:24 – 2:05** | **Invariants** (`s03` + H2 explainer `s11`) | 9 invariants ledger, live Attack `A5` (`VendorNotRegistered`) revert inspector, 3-signature `ML-DSA-87` settlement system map, and `A10` (`H-01` fix) |
| **2:05 – 2:35** | **Treasury** (`s04`) | Oracle-free `6.50 fUSD` ERC-4626 sleeve meter (`50.00%` liquidity), 9-tx happy-path timeline, and keyless QoreX PQC / `HolderGuard` posture inspector |
| **2:35 – 2:50** | Wrap-Up & Links (`s09`, `s05`) | Full loop summary, live app, GitHub source, and Hallmark verified links |
