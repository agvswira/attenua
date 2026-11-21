import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEPLOYMENT,
  EVIDENCE,
  explorerTxUrl,
  fetchLiveChainSnapshot,
  formatBps,
  formatFusd,
  shortAddr,
  type EvidenceEntry,
  type LiveChainSnapshot,
} from "./lib/chain";

type ThemeMode = "system" | "light" | "dark";
type FilterMode = "attacks" | "lattice" | "protocol" | "happy";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("attenua-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage errors
  }
  return "system";
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [filter, setFilter] = useState<FilterMode>("attacks");
  const [live, setLive] = useState<LiveChainSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EvidenceEntry | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      delete root.dataset.theme;
      try {
        localStorage.removeItem("attenua-theme");
      } catch {
        // ignore
      }
    } else {
      root.dataset.theme = theme;
      try {
        localStorage.setItem("attenua-theme", theme);
      } catch {
        // ignore
      }
    }
  }, [theme]);

  const refreshChain = useCallback(async () => {
    setLoading(true);
    setRpcError(null);
    try {
      const snap = await fetchLiveChainSnapshot();
      setLive(snap);
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : "Failed to query qorechain-diana");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshChain();
  }, [refreshChain]);

  const openInspector = useCallback((item: EvidenceEntry) => {
    setSelected(item);
    queueMicrotask(() => {
      const dlg = dialogRef.current;
      if (dlg && !dlg.open) {
        dlg.showModal();
      }
    });
  }, []);

  const closeInspector = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const attackEntries = EVIDENCE.attacks as EvidenceEntry[];
  const happyEntries = EVIDENCE.happyPath as EvidenceEntry[];

  const visibleRows = useMemo(() => {
    if (filter === "happy") return happyEntries;
    if (filter === "lattice") {
      return attackEntries.filter((a) => !a.layer.includes("x/abstractaccount") && !a.layer.includes("AA #2"));
    }
    if (filter === "protocol") {
      return attackEntries.filter((a) => a.layer.includes("x/abstractaccount") || a.layer.includes("AA #2"));
    }
    return attackEntries;
  }, [attackEntries, filter, happyEntries]);

  const totalAumMicro = live ? live.idleFusd + live.liquidityAssets + live.reserveAssets : 6_500_000n;
  const liquidityPct = live ? Math.min(100, Math.max(0, live.liquidityBps / 100)) : 50;
  const guardRenounced = live ? live.guardOwner.toLowerCase() === ZERO_ADDR : true;
  const attacksPassed = attackEntries.filter((a) => a.passed).length;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="site-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              At
            </span>
            <div>
              <p className="brand-title">Attenua</p>
              <p className="brand-sub">Post-Quantum Treasury Swarm · qorechain-diana (9800)</p>
            </div>
          </div>

          <div className="header-controls">
            <nav className="nav-links" aria-label="Primary sections">
              <a href="#delegation-tree">Delegation Tree</a>
              <a href="#treasury-desk">Treasury Desk</a>
              <a href="#attack-theatre">Attack Theatre</a>
            </nav>

            <div className="theme-group" role="group" aria-label="Color theme">
              {(["system", "light", "dark"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="theme-btn"
                  aria-pressed={theme === mode}
                  onClick={() => setTheme(mode)}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void refreshChain()}
              disabled={loading}
            >
              {loading ? "Syncing…" : "Refresh Chain"}
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="page-main">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="hero-top">
            <div>
              <h1 id="hero-heading">Hierarchical ML-DSA-87 Capability Attenuation</h1>
              <p className="hero-lead">
                Read-only verification console for Attenua&apos;s 3-sub-agent institutional treasury swarm on
                QoreChain. Every capability narrows monotonically on-chain (budget conservation, IPS weight
                bands, action bitmasks, expiry, and depth) and settles over{" "}
                <code>@qorechain/asset-kit</code> ERC-4626 vaults.
              </p>
            </div>
            <div aria-live="polite">
              {rpcError ? (
                <span className="pill pill-warn">RPC Fallback: {rpcError}</span>
              ) : live ? (
                <span className="pill pill-ok">Live Block #{live.blockNumber}</span>
              ) : (
                <span className="pill pill-neutral">Connecting to qorechain-diana…</span>
              )}
            </div>
          </div>

          <div className="kpi-grid">
            <article className="card">
              <p className="kpi-label">Root Epoch &amp; Vault State</p>
              <p className="kpi-value">
                Epoch {live ? live.rootEpoch : "—"} · {live?.frozen ? "FROZEN" : "Active"}
              </p>
              <p className="kpi-sub">
                Owner EVM window: {live ? (live.ownerWindowLive ? "OPEN" : "Closed (live=false)") : "Closed"} ·
                AA #1 keys: {live ? live.ownerActiveAuthenticators : "—"}
              </p>
            </article>

            <article className="card">
              <p className="kpi-label">Vault AUM &amp; Liquidity Ratio</p>
              <p className="kpi-value">{formatFusd(totalAumMicro)}</p>
              <p className="kpi-sub">
                Liquidity sleeve: {live ? formatBps(live.liquidityBps) : "50.00%"} (IPS band [45%, 65%] ⊆ [40%,
                70%])
              </p>
            </article>

            <article className="card">
              <p className="kpi-label">HolderGuard Hardening</p>
              <p className="kpi-value">{guardRenounced ? "Renounced" : "Owned"}</p>
              <p className="kpi-sub">
                Owner: <span className="mono">{shortAddr(live?.guardOwner ?? ZERO_ADDR)}</span> · Vault exempt:{" "}
                {live ? String(live.vaultExempt) : "true"}
              </p>
            </article>

            <article className="card">
              <p className="kpi-label">Live Attack Theatre</p>
              <p className="kpi-value">
                {attacksPassed}/{attackEntries.length} Refused
              </p>
              <p className="kpi-sub">
                {happyEntries.length}/{happyEntries.length} happy-path txs · Zero private keys in browser
              </p>
            </article>
          </div>
        </section>

        <section id="delegation-tree" className="card" aria-labelledby="tree-heading">
          <div className="section-head">
            <div>
              <h2 id="tree-heading">1. Live Delegation Tree &amp; Account Isolation</h2>
              <p className="section-desc">
                Owner AA #1 holds at most one linked Orchestrator key (single-key invariant from Spike S8);
                Monitor lives on isolated AA #2 with 0 fUSD and freeze-only selector scope.
              </p>
            </div>
            <span className="pill pill-ok">Conservation: 6 + 2 + 0 = 8 ≤ 20 fUSD</span>
          </div>

          <div className="tree-grid">
            <div className="tree-root">
              <article className="node-card node-card-accent">
                <div className="node-head">
                  <h3 className="node-title">Owner Treasury (AA #1) → Orchestrator</h3>
                  <span className="pill pill-ok">ML-DSA-87 Root</span>
                </div>
                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Owner Cosmos</dt>
                    <dd className="mono">{shortAddr(DEPLOYMENT.abstractAccounts.ownerTreasuryAA1.cosmos, 10, 6)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Root IPS Budget</dt>
                    <dd>20.00 fUSD (maxDepth = 2)</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Root Liquidity Band</dt>
                    <dd>[40.00%, 70.00%]</dd>
                  </div>
                  <div className="spec-row">
                    <dt>JIT x/abstractaccount Cap</dt>
                    <dd>10 fUSD/tx · 25 fUSD/day (no standing allowance)</dd>
                  </div>
                </dl>
              </article>

              <article className="node-card node-card-danger">
                <div className="node-head">
                  <h3 className="node-title">Isolated Monitor Account (AA #2)</h3>
                  <span className="pill pill-danger">Freeze-Only · 0 fUSD</span>
                </div>
                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Monitor Cosmos</dt>
                    <dd className="mono">{shortAddr(DEPLOYMENT.abstractAccounts.monitorAA2.cosmos, 10, 6)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Live fUSD Balance</dt>
                    <dd>{live ? formatFusd(live.monitorFusdBalance) : "0.00 fUSD"}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Protocol Selector Lock</dt>
                    <dd className="mono">freeze() ({DEPLOYMENT.selectors.freeze})</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Monotonic Recovery</dt>
                    <dd>Cannot unfreeze; requires Owner ML-DSA-87</dd>
                  </div>
                </dl>
              </article>
            </div>

            <div className="conservation-bar" aria-label="Sub-agent budget conservation">
              <div className="spec-row">
                <span className="kpi-label">Attenuated Budget Conservation (20.00 fUSD Root Pool)</span>
                <span className="mono">Allocated 8.00 / 20.00 fUSD (0.50 reclaimed in H7)</span>
              </div>
              <div className="progress-track" role="img" aria-label="Allocator 30%, Payables 10%, Unallocated 60%">
                <div className="progress-fill-alloc" style={{ inlineSize: "30%" }} />
                <div className="progress-fill-pay" style={{ inlineSize: "10%" }} />
              </div>
            </div>

            <div className="children-grid">
              <article className="node-card node-card-accent">
                <div className="node-head">
                  <h3 className="node-title">Allocator Sub-Agent</h3>
                  <span className="pill pill-ok">BIT_ALLOCATE (1)</span>
                </div>
                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Signer (ML-DSA-87)</dt>
                    <dd className="mono">{shortAddr(DEPLOYMENT.actors.allocator.evm)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Budget</dt>
                    <dd>6.00 fUSD</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Narrowed IPS Band</dt>
                    <dd>[45.00%, 65.00%] ⊆ [40%, 70%]</dd>
                  </div>
                </dl>
              </article>

              <article className="node-card node-card-ok">
                <div className="node-head">
                  <h3 className="node-title">Payables Sub-Agent</h3>
                  <span className="pill pill-ok">BIT_PAY_INVOICE (2)</span>
                </div>
                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Signer (ML-DSA-87)</dt>
                    <dd className="mono">{shortAddr(DEPLOYMENT.actors.payables.evm)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Budget</dt>
                    <dd>2.00 fUSD (1.50 spent, 0.50 reclaimed)</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Settlement Proof</dt>
                    <dd>3× Atomic ML-DSA-87 (Payables + Vendor + Research)</dd>
                  </div>
                </dl>
              </article>

              <article className="node-card node-card-warn">
                <div className="node-head">
                  <h3 className="node-title">Research Sub-Agent</h3>
                  <span className="pill pill-warn">Zero-Budget (0 fUSD)</span>
                </div>
                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Signer (ML-DSA-87)</dt>
                    <dd className="mono">{shortAddr(DEPLOYMENT.actors.research.evm)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Budget &amp; Action Mask</dt>
                    <dd>0.00 fUSD · mask = 0</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Role</dt>
                    <dd>Read-only MCP risk clearance co-signer</dd>
                  </div>
                </dl>
              </article>
            </div>
          </div>
        </section>

        <section id="treasury-desk" className="card" aria-labelledby="desk-heading">
          <div className="section-head">
            <div>
              <h2 id="desk-heading">2. Institutional Treasury Desk (@qorechain/asset-kit)</h2>
              <p className="section-desc">
                Dual ERC-4626 fUSD sleeves protected by QoreChainHybridHolderGuard (Apache-2.0) with renounced
                admin ownership.
              </p>
            </div>
            <span className="pill pill-neutral">Compiler: solc 0.8.28 (viaIR, cancun)</span>
          </div>

          <div className="desk-grid">
            <article className="node-card">
              <div className="node-head">
                <h3 className="node-title">Live ERC-4626 Sleeve Allocation</h3>
                <span className="pill pill-ok">
                  {live ? formatBps(live.liquidityBps) : "50.00%"} Liquidity
                </span>
              </div>
              <dl className="spec-list">
                <div className="spec-row">
                  <dt>LiquidityVault (ERC-4626)</dt>
                  <dd>{live ? formatFusd(live.liquidityAssets) : "3.00 fUSD"}</dd>
                </div>
                <div className="spec-row">
                  <dt>ReserveVault (ERC-4626)</dt>
                  <dd>{live ? formatFusd(live.reserveAssets) : "3.00 fUSD"}</dd>
                </div>
                <div className="spec-row">
                  <dt>Idle Vault fUSD</dt>
                  <dd>{live ? formatFusd(live.idleFusd) : "0.50 fUSD"}</dd>
                </div>
              </dl>

              <div className="band-meter">
                <div
                  className="band-track"
                  role="img"
                  aria-label={`Current liquidity ratio ${liquidityPct.toFixed(1)}% inside child band 45% to 65% and root band 40% to 70%`}
                >
                  <div className="band-root-range" title="Root IPS Band: 40% – 70%" />
                  <div className="band-child-range" title="Allocator Narrowed Band: 45% – 65%" />
                  <div className="band-marker" style={{ insetInlineStart: `${liquidityPct}%` }} />
                </div>
                <div className="band-labels">
                  <span>0%</span>
                  <span>Root [40%–70%]</span>
                  <span>Child [45%–65%]</span>
                  <span>100%</span>
                </div>
              </div>
            </article>

            <article className="node-card">
              <div className="node-head">
                <h3 className="node-title">Verified Testnet Contracts</h3>
                <span className="pill pill-ok">qorechain-diana</span>
              </div>
              <dl className="spec-list">
                <div className="spec-row">
                  <dt>AttenuaVault</dt>
                  <dd className="mono">
                    <a
                      href={explorerTxUrl(DEPLOYMENT.contracts.attenuaVault.deployTx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(DEPLOYMENT.contracts.attenuaVault.address, 8, 6)}
                    </a>
                  </dd>
                </div>
                <div className="spec-row">
                  <dt>QoreChainHybridHolderGuard</dt>
                  <dd className="mono">
                    <a
                      href={explorerTxUrl(DEPLOYMENT.contracts.holderGuard.renounceOwnershipTx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(DEPLOYMENT.contracts.holderGuard.address, 8, 6)}
                    </a>
                  </dd>
                </div>
                <div className="spec-row">
                  <dt>LiquidityVault (ERC-4626)</dt>
                  <dd className="mono">
                    <a
                      href={explorerTxUrl(DEPLOYMENT.contracts.liquidityVault.deployTx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(DEPLOYMENT.contracts.liquidityVault.address, 8, 6)}
                    </a>
                  </dd>
                </div>
                <div className="spec-row">
                  <dt>ReserveVault (ERC-4626)</dt>
                  <dd className="mono">
                    <a
                      href={explorerTxUrl(DEPLOYMENT.contracts.reserveVault.deployTx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(DEPLOYMENT.contracts.reserveVault.address, 8, 6)}
                    </a>
                  </dd>
                </div>
                <div className="spec-row">
                  <dt>fUSD ERC-20</dt>
                  <dd className="mono">{shortAddr(DEPLOYMENT.contracts.fusd, 8, 6)}</dd>
                </div>
              </dl>
            </article>
          </div>
        </section>

        <section id="attack-theatre" className="card" aria-labelledby="theatre-heading">
          <div className="section-head">
            <div>
              <h2 id="theatre-heading">3. Read-Only Live Attack Theatre &amp; Swarm Evidence</h2>
              <p className="section-desc">
                Every row below is backed by a real transaction on qorechain-diana. Click Inspect to view
                verbatim chain/contract refusal diagnostics or open the transaction on QoreChain Explorer.
              </p>
            </div>
            <span className="pill pill-neutral">Recorded {EVIDENCE.runAt.slice(0, 19).replace("T", " ")} UTC</span>
          </div>

          <div className="filter-bar" role="group" aria-label="Filter evidence table">
            <button
              type="button"
              className="btn filter-btn"
              aria-pressed={filter === "attacks"}
              onClick={() => setFilter("attacks")}
            >
              All Attacks ({attackEntries.length})
            </button>
            <button
              type="button"
              className="btn filter-btn"
              aria-pressed={filter === "lattice"}
              onClick={() => setFilter("lattice")}
            >
              Lattice &amp; Vault Guards
            </button>
            <button
              type="button"
              className="btn filter-btn"
              aria-pressed={filter === "protocol"}
              onClick={() => setFilter("protocol")}
            >
              x/abstractaccount Protocol
            </button>
            <button
              type="button"
              className="btn filter-btn"
              aria-pressed={filter === "happy"}
              onClick={() => setFilter("happy")}
            >
              Happy Path ({happyEntries.length})
            </button>
          </div>

          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="theatre-heading">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Scenario</th>
                  <th scope="col">Enforcement Layer</th>
                  <th scope="col">EVM Gas</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Proof</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((item) => {
                  const isAttack = item.id.startsWith("A");
                  return (
                    <tr key={item.id}>
                      <td data-label="ID" className="mono">
                        <strong>{item.id}</strong>
                      </td>
                      <td data-label="Scenario">
                        <div className="cell-title">{item.title}</div>
                        <div className="cell-sub">{item.summary}</div>
                      </td>
                      <td data-label="Layer">
                        <div>{item.layer}</div>
                        <div className="cell-sub">{item.actor}</div>
                      </td>
                      <td data-label="EVM Gas" className="mono">
                        {Number(item.evmGasUsed).toLocaleString()}
                      </td>
                      <td data-label="Outcome">
                        {isAttack ? (
                          <span className={item.passed ? "pill pill-ok" : "pill pill-danger"}>
                            {item.passed ? "Refused On-Chain" : "Failed"}
                          </span>
                        ) : (
                          <span className={item.passed ? "pill pill-ok" : "pill pill-danger"}>
                            {item.passed ? "Verified" : "Failed"}
                          </span>
                        )}
                      </td>
                      <td data-label="Proof">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => openInspector(item)}
                          aria-label={`Inspect ${item.id} transaction details`}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <p>
          Attenua · Apache-2.0 · Prior art credited: UCAN &amp; Biscuit · Built for Build Before Q-Day on
          QoreChain.
        </p>
        <p>
          <a href="https://github.com/agvswira/attenua" target="_blank" rel="noreferrer">
            GitHub Repository
          </a>{" "}
          · Keyless CLI verification: <code>cd agent &amp;&amp; npm run verify</code>
        </p>
      </footer>

      <dialog
        ref={dialogRef}
        className="inspector-dialog"
        aria-labelledby="dialog-title"
        onClick={(e) => {
          if (e.target === dialogRef.current) {
            closeInspector();
          }
        }}
      >
        {selected && (
          <>
            <div className="dialog-head">
              <div>
                <p className="kpi-label">
                  {selected.id} · {selected.layer}
                </p>
                <h3 id="dialog-title" className="node-title">
                  {selected.title}
                </h3>
              </div>
              <button
                type="button"
                className="btn"
                onClick={closeInspector}
                aria-label="Close transaction inspector"
              >
                Close
              </button>
            </div>
            <div className="dialog-body">
              <dl className="spec-list">
                <div className="spec-row">
                  <dt>Actor</dt>
                  <dd>{selected.actor}</dd>
                </div>
                <div className="spec-row">
                  <dt>EVM Gas Used</dt>
                  <dd className="mono">{Number(selected.evmGasUsed).toLocaleString()}</dd>
                </div>
                <div className="spec-row">
                  <dt>Transaction Hash</dt>
                  <dd className="mono">
                    <a href={explorerTxUrl(selected.txHash)} target="_blank" rel="noreferrer">
                      {shortAddr(selected.txHash, 12, 10)} ↗
                    </a>
                  </dd>
                </div>
              </dl>

              <div>
                <p className="kpi-label">Summary</p>
                <p>{selected.summary}</p>
              </div>

              {selected.verbatimReason && (
                <div>
                  <p className="kpi-label">Verbatim On-Chain Diagnostic</p>
                  <pre className="verbatim-box">{selected.verbatimReason}</pre>
                </div>
              )}

              <div>
                <a
                  className="btn btn-primary"
                  href={explorerTxUrl(selected.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on QoreChain Explorer ↗
                </a>
              </div>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
