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

## 4. Timed Demo Video Script (Target: 2m 45s — Strict ≤ 3m Limit)

| Time | Scene / Visual | Voiceover / Talking Points |
|---|---|---|
| **0:00 – 0:25** | Open [`https://attenua.vercel.app/`](https://attenua.vercel.app/) showing thesis heading *"Every agent holds less than its parent."* + live RPC badge `Live · block #...` | *"AI agent teams don't operate as a single script—an Orchestrator spawns Allocator, Payables, and Research sub-agents. On QoreChain, all `MsgExecuteEVM` calls share the same `msg.sender`, so sharing one key lets a prompt-injected sub-agent drain the treasury. Attenua solves this with post-quantum hierarchical capability attenuation."* |
| **0:25 – 1:05** | Scroll smoothly into **Capability tree**, hover cards, point to `Owner · root mandate`, `Orchestrator`, 3 children (`Allocator`, `Payables`, `Research [0 fUSD]`), `Owner kill-switch`, and `Monitor · AA #2`. | *"Everything starts with three hardware barriers: zero `msg.sender` trust inside `AttenuaVault`, an Orchestrator on Owner AA #1 with Just-in-Time 10 fUSD transfers instead of standing approval, and an isolated freeze-only Monitor on AA #2 holding zero fUSD. Every child narrows budget, ERC-4626 liquidity bands, actions, expiry, and depth."* |
| **1:05 – 1:50** | Click **`A5`**, **`A7`**, and **`A10`** evidence chips to open the native `<dialog>` inspector; open one tx hash in **QoreChain Explorer**. | *"All 10 adversarial attacks were tested live on `qorechain-diana`. In `A5`, a prompt-injected invoice trying to pay an unlisted attacker is blocked by `VendorNotRegistered`. `A7` shows an 11 fUSD over-cap transfer stopped at the `x/abstractaccount` layer. And `A10` proves our response to an independent blind audit finding (`H-01`), blocking self-delegated zero-budget Research clearance bypasses on-chain."* |
| **1:50 – 2:15** | Click **Connect QoreX wallet** in the navbar → click `Owner`, `Vendor`, and `Attacker` preset pills in **Wallet & address posture**. | *"Even without a wallet extension, judges can inspect live `pqcKeyStatus` (`0x...0a02`), `HolderGuard` eligibility, and `AttenuaVault` roles directly on-chain."* |
| **2:15 – 2:45** | Terminal side-by-side: run `cd agent && npm run verify` (`19 PASSED, 0 FAILED`) and `npm test` (`7/7 PASS`), show `AI_USAGE.md` & repo link. | *"Zero keys needed to reproduce: `npm run verify` confirms renounced HolderGuard ownership (`0x0`), closed EVM windows, `9/9` swarm settlements including 3 atomic `ML-DSA-87` signatures per invoice, and `10/10` genuine non-OOG on-chain attack refusals. Built transparently with dual-model adversarial review in `AI_USAGE.md`."* |
