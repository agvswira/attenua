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
  - `AI-Native` (`AI_USAGE.md` + `docs/ai/DECISION_LOG.md` + `docs/ai/MISTAKES_AND_CATCHES.md` + `docs/ai/BLIND_RED_TEAM.md` + `docs/ai/LLM_BENCHMARK.md` + `docs/ai/AGENT_SESSION.md`)
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
- QoreSeal (TypeScript) — `@qorechain/qoreseal` `^0.1.0` (`ML-KEM-1024` + `X25519` encrypted Research → Payables clearance)
- Asset Kit (TypeScript, Solidity) — `@qorechain/asset-kit` `^0.1.0` + Apache-2.0 `QoreChainHybridHolderGuard` & `QoreChainRwaVault`
- MCP + `qore` CLI (`@modelcontextprotocol/sdk` server in `agent/src/mcp-server.ts` + `@qorechain/mcp` preflight audit in `agent/src/qore-mcp-preflight.ts`)
- `@qorechain/qorescan` (CycloneDX 1.6 CBOM inventory in `docs/cbom.json`)

**Network features used (verified live on `qorechain-diana`):**
- Hybrid `ML-DSA-87` transactions
- PQC key registration with proof of possession
- QoreSeal and the encryption key registry (`MsgRegisterKEMKey` tx `A84387CE0B0CE54E813A29E17174D506799A72523157A4C6172C2F5E79DCCCEF` from `qor1f5em...l2e0` + `7CD72E4A...501F5D9EB` from `qor1yqpm...czxy`)
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

## 4. Final Demo Video Chapter Timing (`2:52.1` — Under Strict ≤ 3m Limit)

| Time | Scene / Visual | Summary |
|---|---|---|
| **0:00 – 0:22** | Intro cards (`s01–s03`) | Autonomous treasury swarms, `MsgExecuteEVM` shared-key leak risk, and Attenua thesis (*"Every agent holds less than its parent."*) |
| **0:22 – 0:34** | **Overview** (`s04`) | Live `attenua.vercel.app` Epoch 2 Standing Tree, active vault badge, and live `qorechain-diana` RPC telemetry |
| **0:34 – 1:11** | **Capability tree** (`s05` + H1 explainer `s11`) | Owner root (`20 fUSD`), Orchestrator (`AA #1`), Allocator (`6 fUSD`, `[45%, 65%]`) → `AllocatorLeaf` (Depth 2, `2 fUSD`, `[48%, 62%]`), Payables (`2 fUSD`), Research (`0 fUSD`), `registerSubMandate()` explainer, and isolated Monitor (`AA #2`) |
| **1:11 – 1:55** | **Attack lab & AI Replay** (`s06` + H2 explainer `s12`) | Live keyless `eth_call` reverts, `Make it legal (test Wall 2)` clearing Wall 1 Lattice and hitting Wall 2 `PqcSignatureInvalid` (`0x...0a01`), and live `AI Replay` (`2/20` LLM fooled, `20/20` chain refused, `0 fUSD`) |
| **1:55 – 2:13** | **Invariants** (`s07`) | 9-invariant ledger, `A10` (`H-01` self-delegation fix) modal inspector, and QoreChain Explorer evidence links |
| **2:13 – 2:33** | **Treasury** (`s08`) | Oracle-free `6.50 fUSD` ERC-4626 sleeve meter (`50.00%` liquidity inside Allocator `[45%, 65%]`) and 9-tx happy-path run |
| **2:33 – 2:52** | Wrap-Up & Links (`s09`, `s10`) | Recap of `50/50` Foundry, `26/26` verify, `20/20` LLM refused, `4/4` Hallmark match, plus live app, GitHub & Hallmark URLs |
