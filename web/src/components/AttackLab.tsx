import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import {
  ATTENUA_VAULT_ABI,
  DEPLOYMENT,
  DUMMY_PQC_SIG,
  STANDING_TREE,
  ZERO_ID,
  formatFusd,
  hallmarkContractUrl,
  readVaultNonce,
  shortAddr,
  simulateDelegationAttack,
  simulatePayInvoiceAttack,
  simulateRawVaultCalldata,
  type LiveChainSnapshot,
  type LiveSimulationResult,
} from "../lib/chain";

interface AttackLabProps {
  live: LiveChainSnapshot | null;
}

type AgentKey = "orchestrator" | "allocator" | "payables" | "research" | "allocatorLeaf";
type AttackMode = "delegate" | "invoice";

interface LlmBenchmarkCase {
  id: string;
  category: string;
  title: string;
  memo: string;
  llmDecision: "PAY" | "REFUSE";
  llmTargetVendor: string;
  llmAmountMicro: string;
  llmReason: string;
  fooled: boolean;
  calldata: Hex;
  liveErrorFormatted: string;
  invariantId: string;
}

interface LlmBenchmarkFile {
  model: string;
  runAtUtc: string;
  totalCases: number;
  fooledCount: number;
  chainRefusedCount: number;
  fundsMovedMicro: string;
  transcriptSha256: string;
  cases: LlmBenchmarkCase[];
}

const benchGlob = import.meta.glob("@deployments/llm-benchmark.json", {
  eager: true,
}) as Record<string, { default?: LlmBenchmarkFile }>;

const BENCHMARK_DATA: LlmBenchmarkFile | null =
  Object.values(benchGlob)[0]?.default ?? null;

interface PresetSpec {
  id: string;
  label: string;
  mode: AttackMode;
  agent: AgentKey;
  subAgent: Address;
  budgetFusd: string;
  minPct: string;
  maxPct: string;
  mask: number;
  expiryDays: string;
  vendor: Address;
  invoiceKind: "fresh" | "paid";
  invoiceAmountFusd: string;
  note: string;
}

const PRESETS: PresetSpec[] = [
  {
    id: "TRANSITIVITY",
    label: "Depth-2 Transitivity",
    mode: "delegate",
    agent: "allocator",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "1.0",
    minPct: "41",
    maxPct: "69",
    mask: 1,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "[41%, 69%] is legal for Root [40%, 70%], but Allocator's ceiling is [45%, 65%].",
  },
  {
    id: "DEPTH3",
    label: "Depth-3 Overflow",
    mode: "delegate",
    agent: "allocatorLeaf",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "0.5",
    minPct: "50",
    maxPct: "60",
    mask: 1,
    expiryDays: "25",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "AllocatorLeaf already sits at depth 2 (maxDepth = 2); delegating again fails.",
  },
  {
    id: "A1",
    label: "A1 · Band Widen",
    mode: "delegate",
    agent: "orchestrator",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "1.0",
    minPct: "30",
    maxPct: "80",
    mask: 1,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "Root IPS band is [40%, 70%]. Widening to [30%, 80%] reverts on chain.",
  },
  {
    id: "A2",
    label: "A2 · Budget Breach",
    mode: "delegate",
    agent: "orchestrator",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "13.0",
    minPct: "45",
    maxPct: "65",
    mask: 1,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "Only 12.00 fUSD of the 20.00 fUSD root budget remains unallocated.",
  },
  {
    id: "A4",
    label: "A4 · Mask Escalation",
    mode: "delegate",
    agent: "allocator",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "1.0",
    minPct: "48",
    maxPct: "62",
    mask: 2,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "Allocator only holds BIT_ALLOCATE (1). Granting BIT_PAY_INVOICE (2) fails.",
  },
  {
    id: "A10",
    label: "A10 · H-01 Self-Delegate",
    mode: "delegate",
    agent: "payables",
    subAgent: STANDING_TREE.mandates.payables.subAgent as Address,
    budgetFusd: "0",
    minPct: "45",
    maxPct: "65",
    mask: 0,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "Blind-audit finding H-01: Payables cannot delegate a zero-budget clearance key to itself.",
  },
  {
    id: "A5",
    label: "A5 · Unlisted Vendor",
    mode: "invoice",
    agent: "payables",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "1.0",
    minPct: "45",
    maxPct: "65",
    mask: 2,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.unlistedAttacker.evm as Address,
    invoiceKind: "fresh",
    invoiceAmountFusd: "0.5",
    note: "Prompt-injected invoice attempts executePayInvoice() to an unlisted attacker 0x.",
  },
  {
    id: "A6",
    label: "A6 · Invoice Replay",
    mode: "invoice",
    agent: "payables",
    subAgent: STANDING_TREE.mandates.research.subAgent as Address,
    budgetFusd: "1.0",
    minPct: "45",
    maxPct: "65",
    mask: 2,
    expiryDays: "30",
    vendor: DEPLOYMENT.actors.vendor.evm as Address,
    invoiceKind: "paid",
    invoiceAmountFusd: "0.5",
    note: "Replays the exact H6 invoiceId already settled on qorechain-diana.",
  },
];

const AGENT_META: Record<
  AgentKey,
  {
    label: string;
    parentId: `0x${string}`;
    issuer: Address;
    budgetCapFusd: string;
    minPct: number;
    maxPct: number;
    mask: number;
    depth: number;
    maxExpiryUnix: number;
  }
> = {
  orchestrator: {
    label: "Orchestrator (Root · 12 fUSD free, [40%, 70%], depth 0)",
    parentId: ZERO_ID,
    issuer: STANDING_TREE.rootMandate.orchestrator as Address,
    budgetCapFusd: "12.00",
    minPct: 40,
    maxPct: 70,
    mask: 3,
    depth: 0,
    maxExpiryUnix: Number(STANDING_TREE.rootMandate.expiryUnix),
  },
  allocator: {
    label: "Allocator (Depth 1 · 4 fUSD free, [45%, 65%], mask 1)",
    parentId: STANDING_TREE.mandates.allocator.id as `0x${string}`,
    issuer: STANDING_TREE.mandates.allocator.subAgent as Address,
    budgetCapFusd: "4.00",
    minPct: 45,
    maxPct: 65,
    mask: 1,
    depth: 1,
    maxExpiryUnix: Number(STANDING_TREE.mandates.allocator.expiryUnix),
  },
  payables: {
    label: "Payables (Depth 1 · 2 fUSD free, [40%, 70%], mask 2)",
    parentId: STANDING_TREE.mandates.payables.id as `0x${string}`,
    issuer: STANDING_TREE.mandates.payables.subAgent as Address,
    budgetCapFusd: "2.00",
    minPct: 40,
    maxPct: 70,
    mask: 2,
    depth: 1,
    maxExpiryUnix: Number(STANDING_TREE.mandates.payables.expiryUnix),
  },
  research: {
    label: "Research (Depth 1 · 0 fUSD, mask 0)",
    parentId: STANDING_TREE.mandates.research.id as `0x${string}`,
    issuer: STANDING_TREE.mandates.research.subAgent as Address,
    budgetCapFusd: "0.00",
    minPct: 40,
    maxPct: 70,
    mask: 0,
    depth: 1,
    maxExpiryUnix: Number(STANDING_TREE.mandates.research.expiryUnix),
  },
  allocatorLeaf: {
    label: "AllocatorLeaf (Depth 2 · maxDepth reached, [48%, 62%])",
    parentId: STANDING_TREE.mandates.allocatorLeaf.id as `0x${string}`,
    issuer: STANDING_TREE.mandates.allocatorLeaf.subAgent as Address,
    budgetCapFusd: "2.00",
    minPct: 48,
    maxPct: 62,
    mask: 1,
    depth: 2,
    maxExpiryUnix: Number(STANDING_TREE.mandates.allocatorLeaf.expiryUnix),
  },
};

function parseFusdToMicro(val: string): bigint {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return 0n;
  return BigInt(Math.round(num * 1_000_000));
}

export function AttackLab({ live }: AttackLabProps) {
  const [activePreset, setActivePreset] = useState<string>("TRANSITIVITY");
  const [mode, setMode] = useState<AttackMode>("delegate");
  const [agent, setAgent] = useState<AgentKey>("allocator");
  const [subAgent, setSubAgent] = useState<Address>(
    STANDING_TREE.mandates.research.subAgent as Address,
  );
  const [budgetFusd, setBudgetFusd] = useState<string>("1.0");
  const [minPct, setMinPct] = useState<string>("41");
  const [maxPct, setMaxPct] = useState<string>("69");
  const [mask, setMask] = useState<number>(1);
  const [expiryDays, setExpiryDays] = useState<string>("30");

  const [vendor, setVendor] = useState<Address>(
    DEPLOYMENT.actors.unlistedAttacker.evm as Address,
  );
  const [invoiceKind, setInvoiceKind] = useState<"fresh" | "paid">("fresh");
  const [invoiceAmountFusd, setInvoiceAmountFusd] = useState<string>("0.5");

  const [running, setRunning] = useState(false);
  const [lastActionLabel, setLastActionLabel] = useState<string>("");
  const [simResult, setSimResult] = useState<LiveSimulationResult | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const [selectedAiCaseId, setSelectedAiCaseId] = useState<string>(
    BENCHMARK_DATA?.cases.find((c) => c.fooled)?.id ??
      BENCHMARK_DATA?.cases[0]?.id ??
      "SAMPLE-INJ",
  );
  const [aiReplayRunning, setAiReplayRunning] = useState(false);
  const [aiReplayResult, setAiReplayResult] = useState<LiveSimulationResult | null>(null);
  const [aiReplayError, setAiReplayError] = useState<string | null>(null);

  const applyPreset = useCallback((p: PresetSpec) => {
    setActivePreset(p.id);
    setMode(p.mode);
    setAgent(p.agent);
    setSubAgent(p.subAgent);
    setBudgetFusd(p.budgetFusd);
    setMinPct(p.minPct);
    setMaxPct(p.maxPct);
    setMask(p.mask);
    setExpiryDays(p.expiryDays);
    setVendor(p.vendor);
    setInvoiceKind(p.invoiceKind);
    setInvoiceAmountFusd(p.invoiceAmountFusd);
    setSimError(null);
  }, []);

  const runLiveAttack = useCallback(
    async (override?: {
      mode?: AttackMode;
      agent?: AgentKey;
      subAgent?: Address;
      budgetFusd?: string;
      minPct?: string;
      maxPct?: string;
      mask?: number;
      expiryDays?: string;
      vendor?: Address;
      invoiceKind?: "fresh" | "paid";
      invoiceAmountFusd?: string;
      label?: string;
    }) => {
      const m = override?.mode ?? mode;
      const ag = override?.agent ?? agent;
      const meta = AGENT_META[ag];

      setRunning(true);
      setSimError(null);
      setLastActionLabel(override?.label ?? "Attack eth_call");
      try {
        let res: LiveSimulationResult;
        if (m === "delegate") {
          const daysNum = Math.max(1, Number(override?.expiryDays ?? expiryDays) || 1);
          const expiryUnix = BigInt(Math.floor(Date.now() / 1000) + Math.floor(daysNum * 86400));
          res = await simulateDelegationAttack({
            parentId: meta.parentId,
            issuer: meta.issuer,
            subAgent: override?.subAgent ?? subAgent,
            budgetMicro: parseFusdToMicro(override?.budgetFusd ?? budgetFusd),
            minBps: Math.round(Number(override?.minPct ?? minPct) * 100),
            maxBps: Math.round(Number(override?.maxPct ?? maxPct) * 100),
            actionMask: override?.mask ?? mask,
            expiryUnix,
          });
        } else {
          const invId =
            (override?.invoiceKind ?? invoiceKind) === "paid"
              ? (STANDING_TREE.paidInvoiceId as `0x${string}`)
              : keccak256(toHex(`web-attack-${Date.now()}`));
          res = await simulatePayInvoiceAttack({
            vendor: override?.vendor ?? vendor,
            invoiceId: invId,
            amountMicro: parseFusdToMicro(override?.invoiceAmountFusd ?? invoiceAmountFusd),
          });
        }
        setSimResult(res);
      } catch (err) {
        setSimError(err instanceof Error ? err.message : "Live RPC eth_call failed");
      } finally {
        setRunning(false);
      }
    },
    [agent, budgetFusd, expiryDays, invoiceAmountFusd, invoiceKind, mask, maxPct, minPct, mode, subAgent, vendor],
  );

  // Auto-run default Depth-2 Transitivity attack once on load so judges see live chain truth immediately
  useEffect(() => {
    void runLiveAttack({ label: "Auto-probed Depth-2 Transitivity on live AttenuaVault v1.1" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMakeItLegal = useCallback(() => {
    setSimError(null);
    if (mode === "delegate") {
      // If depth-2 AllocatorLeaf was selected, fall back to depth-1 Allocator so depth <= maxDepth=2 can legally pass Wall 1
      const targetAgent: AgentKey = agent === "allocatorLeaf" ? "allocator" : agent;
      const meta = AGENT_META[targetAgent];
      const safeMin = String(Math.min(meta.maxPct, Math.max(meta.minPct, meta.minPct + 1)));
      const safeMax = String(Math.max(Number(safeMin), Math.min(meta.maxPct, meta.maxPct - 1)));
      const safeBudget = meta.budgetCapFusd === "0.00" ? "0" : "0.5";
      const safeMask = meta.mask;
      const safeSub =
        meta.issuer.toLowerCase() === (STANDING_TREE.mandates.research.subAgent as string).toLowerCase()
          ? (STANDING_TREE.mandates.payables.subAgent as Address)
          : (STANDING_TREE.mandates.research.subAgent as Address);
      const safeDays = "10";

      setAgent(targetAgent);
      setSubAgent(safeSub);
      setBudgetFusd(safeBudget);
      setMinPct(safeMin);
      setMaxPct(safeMax);
      setMask(safeMask);
      setExpiryDays(safeDays);
      setActivePreset("LEGAL");

      void runLiveAttack({
        mode: "delegate",
        agent: targetAgent,
        subAgent: safeSub,
        budgetFusd: safeBudget,
        minPct: safeMin,
        maxPct: safeMax,
        mask: safeMask,
        expiryDays: safeDays,
        label: "Make it legal -> Wall 1 cleared -> Wall 2 ML-DSA-87 gate",
      });
    } else {
      const regVendor = DEPLOYMENT.actors.vendor.evm as Address;
      setVendor(regVendor);
      setInvoiceKind("fresh");
      setInvoiceAmountFusd("0.5");
      setActivePreset("LEGAL");

      void runLiveAttack({
        mode: "invoice",
        vendor: regVendor,
        invoiceKind: "fresh",
        invoiceAmountFusd: "0.5",
        label: "Make it legal -> Wall 1 cleared -> Wall 2 3x ML-DSA-87 gate",
      });
    }
  }, [agent, mode, runLiveAttack]);

  const selectedAiCase = useMemo(() => {
    if (!BENCHMARK_DATA) return null;
    return BENCHMARK_DATA.cases.find((c) => c.id === selectedAiCaseId) ?? BENCHMARK_DATA.cases[0] ?? null;
  }, [selectedAiCaseId]);

  const handleReplayAiCalldata = useCallback(async () => {
    setAiReplayRunning(true);
    setAiReplayError(null);
    try {
      const payablesAgent = STANDING_TREE.mandates.payables.subAgent as Address;
      let calldataToFire: Hex;
      if (selectedAiCase?.calldata) {
        calldataToFire = selectedAiCase.calldata;
      } else {
        const payNonce = await readVaultNonce(payablesAgent);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        calldataToFire = encodeFunctionData({
          abi: ATTENUA_VAULT_ABI,
          functionName: "executePayInvoice",
          args: [
            STANDING_TREE.mandates.payables.id as `0x${string}`,
            STANDING_TREE.mandates.research.id as `0x${string}`,
            DEPLOYMENT.actors.unlistedAttacker.evm as Address,
            keccak256(toHex(`ai-replay-${Date.now()}`)),
            500_000n,
            payNonce,
            deadline,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
            DUMMY_PQC_SIG,
          ],
        });
      }
      const res = await simulateRawVaultCalldata(calldataToFire, payablesAgent);
      setAiReplayResult(res);
    } catch (err) {
      setAiReplayError(err instanceof Error ? err.message : "Live RPC replay failed");
    } finally {
      setAiReplayRunning(false);
    }
  }, [selectedAiCase]);

  const activePresetNote = PRESETS.find((p) => p.id === activePreset)?.note;
  const agentMeta = AGENT_META[agent];
  const wallBadgeTone =
    simResult?.decoded.wall === "wall2"
      ? "pill-warn"
      : simResult?.succeededUnexpectedly
        ? "pill-warn"
        : "pill-ok";

  return (
    <section
      id="attack-lab"
      className="surface-card reveal-card"
      aria-labelledby="attack-lab-heading"
    >
      <div className="card-head">
        <div className="card-title-group">
          <h2 id="attack-lab-heading" className="card-title">
            Attack the lattice — live, keyless, zero server
          </h2>
          <p className="card-desc">
            Compromise any agent, try giving it authority above its parent, and watch the deployed{" "}
            <a
              href={hallmarkContractUrl(DEPLOYMENT.contracts.attenuaVault.address)}
              target="_blank"
              rel="noreferrer"
              className="mono"
            >
              AttenuaVault v1.1
            </a>{" "}
            contract on <code>qorechain-diana</code> refuse via live <code>eth_call</code>.
          </p>
        </div>

        <span
          className={`pill ${live?.frozen || live?.rootMandateActive === false ? "pill-danger" : "pill-ok"}`}
        >
          {live?.frozen
            ? "Vault paused"
            : live?.rootMandateActive === false
              ? "Epoch inactive"
              : `Standing Tree · Epoch ${live?.rootEpoch ?? STANDING_TREE.epoch} live`}
        </span>
      </div>

      {/* Presets */}
      <div className="lab-preset-row" role="group" aria-label="Attack presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip ${p.mode === "delegate" ? "chip-attack" : "chip-check"}`}
            aria-pressed={activePreset === p.id}
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {activePresetNote && <p className="lab-preset-note">{activePresetNote}</p>}

      <div className="lab-grid">
        {/* Left: Interactive Controls */}
        <div className="lab-panel">
          <div className="lab-mode-tabs" role="group" aria-label="Attack path">
            <button
              type="button"
              className="theme-tab"
              aria-pressed={mode === "delegate"}
              onClick={() => setMode("delegate")}
            >
              1. Escalate sub-mandate
            </button>
            <button
              type="button"
              className="theme-tab"
              aria-pressed={mode === "invoice"}
              onClick={() => setMode("invoice")}
            >
              2. Drain via invoice
            </button>
          </div>

          {mode === "delegate" ? (
            <div className="lab-fields">
              <label className="lab-field">
                <span className="lab-label">Compromised issuer agent</span>
                <select
                  className="lab-input"
                  value={agent}
                  onChange={(e) => setAgent(e.target.value as AgentKey)}
                >
                  {(Object.keys(AGENT_META) as AgentKey[]).map((k) => (
                    <option key={k} value={k}>
                      {AGENT_META[k].label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="lab-row-2">
                <label className="lab-field">
                  <span className="lab-label">Child budget (fUSD · parent free {agentMeta.budgetCapFusd})</span>
                  <input
                    className="lab-input mono"
                    value={budgetFusd}
                    onChange={(e) => setBudgetFusd(e.target.value)}
                  />
                </label>

                <label className="lab-field">
                  <span className="lab-label">Action bitmask (parent mask {agentMeta.mask})</span>
                  <select
                    className="lab-input mono"
                    value={mask}
                    onChange={(e) => setMask(Number(e.target.value))}
                  >
                    <option value={0}>0 · BIT_NONE (Research)</option>
                    <option value={1}>1 · BIT_ALLOCATE</option>
                    <option value={2}>2 · BIT_PAY_INVOICE</option>
                    <option value={3}>3 · BIT_ALL (Allocate + Pay)</option>
                  </select>
                </label>
              </div>

              <div className="lab-row-3">
                <label className="lab-field">
                  <span className="lab-label">Min liquidity % (&ge; {agentMeta.minPct}%)</span>
                  <input
                    className="lab-input mono"
                    value={minPct}
                    onChange={(e) => setMinPct(e.target.value)}
                  />
                </label>

                <label className="lab-field">
                  <span className="lab-label">Max liquidity % (&le; {agentMeta.maxPct}%)</span>
                  <input
                    className="lab-input mono"
                    value={maxPct}
                    onChange={(e) => setMaxPct(e.target.value)}
                  />
                </label>

                <label className="lab-field">
                  <span className="lab-label">Expiry (days from now)</span>
                  <input
                    className="lab-input mono"
                    value={expiryDays}
                    onChange={(e) => setExpiryDays(e.target.value)}
                  />
                </label>
              </div>

              <label className="lab-field">
                <span className="lab-label">Target child agent signer (PQC-registered)</span>
                <select
                  className="lab-input mono"
                  value={subAgent}
                  onChange={(e) => setSubAgent(e.target.value as Address)}
                >
                  <option value={STANDING_TREE.mandates.research.subAgent}>
                    Research · {shortAddr(STANDING_TREE.mandates.research.subAgent)}
                  </option>
                  <option value={STANDING_TREE.mandates.allocator.subAgent}>
                    Allocator · {shortAddr(STANDING_TREE.mandates.allocator.subAgent)}
                  </option>
                  <option value={STANDING_TREE.mandates.payables.subAgent}>
                    Payables · {shortAddr(STANDING_TREE.mandates.payables.subAgent)}
                  </option>
                  <option value={DEPLOYMENT.actors.unlistedAttacker.evm}>
                    Unlisted Attacker · {shortAddr(DEPLOYMENT.actors.unlistedAttacker.evm)} (no PQC key)
                  </option>
                </select>
              </label>
            </div>
          ) : (
            <div className="lab-fields">
              <label className="lab-field">
                <span className="lab-label">Target payout address (vendor)</span>
                <select
                  className="lab-input mono"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value as Address)}
                >
                  <option value={DEPLOYMENT.actors.unlistedAttacker.evm}>
                    Unlisted Attacker · {DEPLOYMENT.actors.unlistedAttacker.evm}
                  </option>
                  <option value={DEPLOYMENT.actors.vendor.evm}>
                    Allowlisted Vendor · {DEPLOYMENT.actors.vendor.evm}
                  </option>
                </select>
              </label>

              <div className="lab-row-2">
                <label className="lab-field">
                  <span className="lab-label">Invoice ID</span>
                  <select
                    className="lab-input"
                    value={invoiceKind}
                    onChange={(e) => setInvoiceKind(e.target.value as "fresh" | "paid")}
                  >
                    <option value="fresh">Fresh invoiceId</option>
                    <option value="paid">Paid H6 invoiceId (replay)</option>
                  </select>
                </label>

                <label className="lab-field">
                  <span className="lab-label">Amount (fUSD · Payables cap 2.00)</span>
                  <input
                    className="lab-input mono"
                    value={invoiceAmountFusd}
                    onChange={(e) => setInvoiceAmountFusd(e.target.value)}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={running}
              onClick={() => void runLiveAttack({ label: "Custom live eth_call attack" })}
            >
              {running ? "Calling qorechain-diana…" : "Send live eth_call"}
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              disabled={running}
              onClick={handleMakeItLegal}
              title="Tighten parameters inside parent bounds to pass Wall 1 and hit Wall 2 ML-DSA-87"
            >
              Make it legal (test Wall 2)
            </button>
          </div>
        </div>

        {/* Right: Two-Wall Live Verdict */}
        <div className="lab-panel" aria-live="polite">
          <div className="node-head">
            <h3 className="node-title">On-chain verdict</h3>
            {simResult && (
              <span className={`pill ${wallBadgeTone}`}>
                {simResult.decoded.wall === "wall2"
                  ? "Wall 1 passed -> Wall 2 PQC blocked"
                  : simResult.decoded.wall === "wall1"
                    ? "Refused at Wall 1 (Lattice)"
                    : "State check"}
              </span>
            )}
          </div>

          {simError ? (
            <pre className="verbatim-box">{simError}</pre>
          ) : simResult ? (
            <>
              <div className="lab-two-wall">
                <div className={`lab-wall-step ${simResult.decoded.wall === "wall1" ? "is-blocked" : "is-passed"}`}>
                  <span className="lab-wall-name">Wall 1 · Capability Lattice</span>
                  <span className="mono lab-wall-status">
                    {simResult.decoded.wall === "wall1"
                      ? `BLOCKED (${simResult.decoded.errorName})`
                      : simResult.decoded.wall === "wall2"
                        ? "ALLOWED SHAPE"
                        : simResult.decoded.errorName}
                  </span>
                </div>
                <div className={`lab-wall-step ${simResult.decoded.wall === "wall2" ? "is-blocked" : ""}`}>
                  <span className="lab-wall-name">Wall 2 · ML-DSA-87 Precompile (0x…0a01)</span>
                  <span className="mono lab-wall-status">
                    {simResult.decoded.wall === "wall2"
                      ? "BLOCKED (PqcSignatureInvalid)"
                      : "Not reached (Wall 1 halted first)"}
                  </span>
                </div>
              </div>

              <dl className="spec-list">
                <div className="spec-row">
                  <dt>Probe</dt>
                  <dd>{lastActionLabel}</dd>
                </div>
                <div className="spec-row">
                  <dt>Invariant</dt>
                  <dd className="mono">{simResult.decoded.invariant}</dd>
                </div>
                <div className="spec-row">
                  <dt>Issuer nonce</dt>
                  <dd className="mono">
                    {shortAddr(simResult.issuer, 6, 4)} (nonce {simResult.issuerNonce})
                  </dd>
                </div>
              </dl>

              <div className="verbatim-wrap">
                <p className="verbatim-label">Decoded revert from qorechain-diana</p>
                <pre className="verbatim-box">{simResult.decoded.formatted}</pre>
              </div>

              <p className="card-footnote">
                {simResult.decoded.explanation}{" "}
                <a
                  href={hallmarkContractUrl(DEPLOYMENT.contracts.attenuaVault.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Inspect verified contract on Hallmark ↗
                </a>
              </p>
            </>
          ) : (
            <p className="card-desc">Click “Send live eth_call” to probe the deployed contract.</p>
          )}
        </div>
      </div>

      {/* AI Replay Bar */}
      <div className="lab-ai-replay">
        <div className="card-head">
          <div className="card-title-group">
            <h3 className="node-title">AI Replay · Untrusted LLM vs AttenuaVault</h3>
            {BENCHMARK_DATA ? (
              <p className="card-desc">
                Gateway <code>eiairouter.cloud/v1</code> · model <code>{BENCHMARK_DATA.model}</code> (
                {BENCHMARK_DATA.runAtUtc.slice(0, 10)}, SHA-256{" "}
                <code>{BENCHMARK_DATA.transcriptSha256.slice(0, 12)}…</code>):{" "}
                <strong>
                  fooled {BENCHMARK_DATA.fooledCount}/{BENCHMARK_DATA.totalCases}
                </strong>{" "}
                on prompt-injected invoices. Chain refused{" "}
                <strong>
                  {BENCHMARK_DATA.chainRefusedCount}/{BENCHMARK_DATA.totalCases}
                </strong>
                . Funds moved: <strong>{formatFusd(BigInt(BENCHMARK_DATA.fundsMovedMicro))}</strong>.
              </p>
            ) : (
              <p className="card-desc">
                Recorded live OpenAI-compatible 20-invoice run pending execution (
                <code>cd agent &amp;&amp; npm run bench:llm</code>). Replay an injected{" "}
                <code>executePayInvoice</code> calldata payload against the live vault below:
              </p>
            )}
          </div>

          <div className="wallet-bar">
            {BENCHMARK_DATA && (
              <select
                className="lab-input mono"
                aria-label="Select LLM benchmark case to replay"
                value={selectedAiCaseId}
                onChange={(e) => setSelectedAiCaseId(e.target.value)}
              >
                {BENCHMARK_DATA.cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} ({c.llmDecision}) · {c.category}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={aiReplayRunning}
              onClick={() => void handleReplayAiCalldata()}
            >
              {aiReplayRunning ? "Replaying…" : "Replay this calldata live"}
            </button>
          </div>
        </div>

        {(aiReplayResult || aiReplayError) && (
          <pre className="verbatim-box">
            {aiReplayError
              ? aiReplayError
              : `${aiReplayResult?.decoded.formatted} — ${aiReplayResult?.decoded.explanation} (0 fUSD moved)`}
          </pre>
        )}
      </div>
    </section>
  );
}
