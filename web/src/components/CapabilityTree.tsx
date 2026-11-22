import { DEPLOYMENT, EVIDENCE, formatBps, shortAddr, type LiveChainSnapshot } from "../lib/chain";
import { EvidenceChip } from "./EvidenceChip";
import junctionLight from "../assets/junction-light.svg";
import junctionDark from "../assets/junction-dark.svg";
import killSwitchLight from "../assets/kill-switch-light.svg";
import killSwitchDark from "../assets/kill-switch-dark.svg";
import monitorFreezeLight from "../assets/monitor-freeze-light.svg";
import monitorFreezeDark from "../assets/monitor-freeze-dark.svg";
import freezeTargetLight from "../assets/freeze-target-light.svg";
import freezeTargetDark from "../assets/freeze-target-dark.svg";

interface CapabilityTreeProps {
  effectiveTheme: "light" | "dark";
  live: LiveChainSnapshot | null;
  onInspect: (id: string) => void;
}

export function CapabilityTree({ effectiveTheme, live, onInspect }: CapabilityTreeProps) {
  const isDark = effectiveTheme === "dark";
  const junctionSrc = isDark ? junctionDark : junctionLight;
  const killSwitchSrc = isDark ? killSwitchDark : killSwitchLight;
  const monitorFreezeSrc = isDark ? monitorFreezeDark : monitorFreezeLight;
  const freezeTargetSrc = isDark ? freezeTargetDark : freezeTargetLight;

  const liquidityPct = live ? Math.min(100, Math.max(0, live.liquidityBps / 100)) : 50;
  const liquidityPctText = live ? formatBps(live.liquidityBps) : "50.00%";
  const rootEpoch = live ? live.rootEpoch : 2;
  const revokeGas = Number(EVIDENCE.attacks.find((a) => a.id === "A9")?.evmGasUsed ?? "212385").toLocaleString();

  return (
    <section
      id="capability-tree"
      className="surface-card reveal-card"
      aria-labelledby="tree-heading"
    >
      <div className="card-head">
        <div className="card-title-group">
          <h2 id="tree-heading" className="card-title">
            Capability tree
          </h2>
          <p className="card-desc">
            Each child can only hold less than its parent: budget, liquidity band, actions, expiry and depth.
          </p>
        </div>

        <div className="chip-key" aria-label="Evidence chip legend">
          <span className="chip-key-item">
            <EvidenceChip id="A1" kind="attack" interactive={false} />
            <span>attack refused here</span>
          </span>
          <span className="chip-key-item">
            <EvidenceChip id="H1" kind="run" interactive={false} />
            <span>run transaction</span>
          </span>
          <span className="chip-key-item">
            <EvidenceChip id="verify" kind="check" interactive={false} />
            <span>keyless check</span>
          </span>
        </div>
      </div>

      <div className="tree-stage">
        {/* Left: AttenuaVault · mandate lattice */}
        <div className="lattice-boundary">
          <div className="boundary-label">
            <span className="boundary-name">AttenuaVault · mandate lattice</span>
            <span className="boundary-note">
              {shortAddr(DEPLOYMENT.contracts.attenuaVault.address, 6, 4)} · every change verifies an
              ML-DSA-87 signature, no msg.sender trust
            </span>
            <EvidenceChip id="H1 to H7" kind="run" label="H1 to H7" onInspect={onInspect} />
          </div>

          {/* Tier 1: Owner · root mandate */}
          <article className="agent-node agent-node-center">
            <div className="node-head">
              <h3 className="node-title">Owner · root mandate</h3>
              <span className="pill pill-neutral">ML-DSA-87</span>
            </div>

            <div className="budget-block">
              <div className="budget-figures">
                <span className="budget-main">20.00 fUSD</span>
                <span className="budget-sub">of 20.00 root</span>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div className="bar-fill" style={{ inlineSize: "100%" }} />
              </div>
            </div>

            <div className="budget-block">
              <div className="mini-band-track" aria-hidden="true">
                <div className="mini-band-root" style={{ inlineSize: "30%", insetInlineStart: "40%" }} />
              </div>
              <p className="budget-sub">Liquidity band [40%, 70%]</p>
            </div>

            <div className="node-kv-row">
              <span className="node-kv-key">Actions</span>
              <span className="node-kv-val mono">ALLOCATE, PAY_INVOICE</span>
            </div>
            <div className="node-kv-row">
              <span className="node-kv-key">Max depth</span>
              <span className="node-kv-val">2</span>
            </div>

            <div className="chip-row">
              <span className="chip-row-label">Installed in</span>
              <EvidenceChip id="H1" kind="run" onInspect={onInspect} />
            </div>
          </article>

          {/* Stem Root -> Orchestrator */}
          <div className="stem-vertical" aria-hidden="true">
            <span className="stem-line" />
            <img src={junctionSrc} alt="" width={7} height={7} className="junction-dot" />
          </div>

          {/* Tier 2: Orchestrator */}
          <article className="agent-node agent-node-center">
            <div className="node-head">
              <h3 className="node-title">Orchestrator</h3>
              <span className="pill pill-neutral">linked key + ML-DSA-87</span>
            </div>

            <p className="node-copy">
              Holds the root capability. Funds the vault just in time and delegates narrower sub-mandates.
            </p>

            <div className="node-kv-row">
              <span className="node-kv-key">AA #1 cap</span>
              <span className="node-kv-val">
                1 linked key, 10 fUSD/tx, 25 fUSD/day, no standing allowance
              </span>
            </div>

            <div className="budget-block">
              <div className="budget-figures">
                <span className="budget-main">8.00 fUSD</span>
                <span className="budget-sub">of 20.00 root</span>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div className="bar-fill" style={{ inlineSize: "40%" }} />
              </div>
              <p className="budget-sub">
                8.00 delegated, 12.00 unallocated. 0.50 came back from Payables in H7.
              </p>
            </div>

            <div className="chip-row">
              <span className="chip-row-label">Refused</span>
              <EvidenceChip id="A1" kind="attack" onInspect={onInspect} />
              <EvidenceChip id="A2" kind="attack" onInspect={onInspect} />
              <EvidenceChip id="A7" kind="attack" onInspect={onInspect} />
            </div>

            <div className="chip-row">
              <span className="chip-row-label">Ran</span>
              <EvidenceChip id="H3" kind="run" onInspect={onInspect} />
              <EvidenceChip id="H4a" kind="run" onInspect={onInspect} />
              <EvidenceChip id="H4b" kind="run" onInspect={onInspect} />
              <EvidenceChip id="H4c" kind="run" onInspect={onInspect} />
              <EvidenceChip id="H7" kind="run" onInspect={onInspect} />
              <EvidenceChip id="verify" kind="check" onInspect={onInspect} />
            </div>
          </article>

          {/* 3-way horizontal bus */}
          <div className="bus-branch-wrap" aria-hidden="true">
            <span className="bus-stem-top" />
            <div className="bus-drops">
              <div className="bus-drop-col">
                <span className="stem-line" />
                <img src={junctionSrc} alt="" width={7} height={7} className="junction-dot" />
              </div>
              <div className="bus-drop-col">
                <span className="stem-line" />
                <img src={junctionSrc} alt="" width={7} height={7} className="junction-dot" />
              </div>
              <div className="bus-drop-col">
                <span className="stem-line" />
                <img src={junctionSrc} alt="" width={7} height={7} className="junction-dot" />
              </div>
            </div>
          </div>

          {/* Tier 3: Sub-Agents */}
          <div className="subagents-grid">
            {/* Allocator */}
            <article className="agent-node">
              <div className="node-head">
                <h3 className="node-title">Allocator</h3>
                <span className="pill pill-neutral">BIT_ALLOCATE</span>
              </div>

              <div className="budget-block">
                <div className="budget-figures">
                  <span className="budget-main">6.00 fUSD</span>
                  <span className="budget-sub">of 20.00 root</span>
                </div>
                <div className="bar-track" aria-hidden="true">
                  <div className="bar-fill bar-fill-lattice" style={{ inlineSize: "30%" }} />
                </div>
              </div>

              <div className="budget-block">
                <div className="mini-band-track" aria-hidden="true">
                  <div className="mini-band-root" style={{ inlineSize: "30%", insetInlineStart: "40%" }} />
                  <div className="mini-band-child" style={{ inlineSize: "20%", insetInlineStart: "45%" }} />
                  <div className="mini-band-now" style={{ insetInlineStart: `${liquidityPct}%` }} />
                </div>
                <p className="budget-sub">
                  Liquidity band [45%, 65%] inside root [40%, 70%], now {liquidityPctText}
                </p>
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Ran</span>
                <EvidenceChip id="H5" kind="run" onInspect={onInspect} />
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Refused</span>
                <EvidenceChip id="A9" kind="attack" onInspect={onInspect} />
              </div>
            </article>

            {/* Payables */}
            <article className="agent-node">
              <div className="node-head">
                <h3 className="node-title">Payables</h3>
                <span className="pill pill-neutral">BIT_PAY_INVOICE</span>
              </div>

              <div className="budget-block">
                <div className="budget-figures">
                  <span className="budget-main">2.00 fUSD</span>
                  <span className="budget-sub">of 20.00 root</span>
                </div>
                <div className="bar-track" aria-hidden="true">
                  <div className="bar-fill bar-fill-mandate" style={{ inlineSize: "10%" }} />
                </div>
                <p className="budget-sub">1.50 paid to a registered vendor, 0.50 reclaimed.</p>
              </div>

              <div className="node-kv-row">
                <span className="node-kv-key">Settlement</span>
                <span className="node-kv-val">
                  3 ML-DSA-87 signatures per invoice: Payables, Vendor, Research
                </span>
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Ran</span>
                <EvidenceChip id="H6" kind="run" onInspect={onInspect} />
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Refused</span>
                <EvidenceChip id="A3" kind="attack" onInspect={onInspect} />
                <EvidenceChip id="A5" kind="attack" onInspect={onInspect} />
                <EvidenceChip id="A6" kind="attack" onInspect={onInspect} />
                <EvidenceChip id="A10" kind="attack" onInspect={onInspect} />
              </div>
            </article>

            {/* Research */}
            <article className="agent-node">
              <div className="node-head">
                <h3 className="node-title">Research</h3>
                <span className="pill pill-warn">mask 0</span>
              </div>

              <div className="budget-block">
                <div className="budget-figures">
                  <span className="budget-main">0.00 fUSD</span>
                  <span className="budget-sub">of 20.00 root</span>
                </div>
                <div className="bar-track" aria-hidden="true" />
                <p className="budget-sub">
                  Zero budget: it can sign a clearance verdict but cannot move 1 uqor.
                </p>
              </div>

              <div className="node-kv-row">
                <span className="node-kv-key">Role</span>
                <span className="node-kv-val">
                  Screens invoices for prompt injection through @qorechain/mcp
                </span>
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Co-signed</span>
                <EvidenceChip id="H6" kind="run" onInspect={onInspect} />
              </div>

              <div className="chip-row">
                <span className="chip-row-label">Refused</span>
                <EvidenceChip id="A4" kind="attack" onInspect={onInspect} />
              </div>
            </article>
          </div>
        </div>

        {/* Right: External Kill-Switch & Monitor AA #2 */}
        <aside className="tree-side-panel" aria-label="External emergency controls">
          <article className="agent-node-side">
            <div className="side-connector-kill" aria-hidden="true">
              <img src={killSwitchSrc} alt="" width={342} height={1} />
              <span className="revoke-badge">revokeRootEpoch()</span>
            </div>

            <div className="node-head">
              <h3 className="node-title">Owner kill-switch</h3>
              <span className="pill pill-neutral">epoch {rootEpoch}</span>
            </div>

            <p className="node-copy">
              revokeRootEpoch() voids every sub-mandate in one call ({revokeGas} gas) and revokes the
              linked key.
            </p>

            <div className="chip-row">
              <span className="chip-row-label">Proven by</span>
              <EvidenceChip id="A9" kind="attack" onInspect={onInspect} />
            </div>
          </article>

          <article className="agent-node-side">
            <div className="side-connector-freeze" aria-hidden="true">
              <span className="freeze-label">freeze()</span>
              <img src={freezeTargetSrc} alt="" width={7} height={7} className="freeze-target-dot" />
              <img src={monitorFreezeSrc} alt="" width={32} height={1} className="freeze-line" />
            </div>

            <div className="node-head">
              <h3 className="node-title">Monitor · AA #2</h3>
              <span className="pill pill-danger">freeze only</span>
            </div>

            <div className="node-kv-row">
              <span className="node-kv-key">Balance</span>
              <span className="node-kv-val">0 fUSD, 1 uqor/day</span>
            </div>
            <div className="node-kv-row">
              <span className="node-kv-key">Allowed call</span>
              <span className="node-kv-val mono">AttenuaVault.freeze()</span>
            </div>
            <div className="node-kv-row">
              <span className="node-kv-key">Unfreeze</span>
              <span className="node-kv-val">Owner ML-DSA-87 only</span>
            </div>

            <div className="chip-row">
              <span className="chip-row-label">Proven by</span>
              <EvidenceChip id="A8" kind="attack" onInspect={onInspect} />
              <EvidenceChip id="verify" kind="check" onInspect={onInspect} />
            </div>
          </article>
        </aside>
      </div>
    </section>
  );
}
