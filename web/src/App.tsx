import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAddress, type Address } from "viem";
import logoMarkLight from "./assets/logo-mark-light.svg";
import logoMarkDark from "./assets/logo-mark-dark.svg";
import timelineDotLight from "./assets/timeline-dot-light.svg";
import timelineDotDark from "./assets/timeline-dot-dark.svg";
import { CapabilityTree } from "./components/CapabilityTree";
import { AttackLab } from "./components/AttackLab";
import { EvidenceChip } from "./components/EvidenceChip";
import { InspectorDialog } from "./components/InspectorDialog";
import { WalletPostureDialog } from "./components/WalletPostureDialog";
import {
  AUTHENTICATED_MESSAGE,
  DEPLOYMENT,
  EVIDENCE,
  EVM_RPC_URL,
  EXPLORER_BASE,
  QORE_CHAIN_HEX,
  explorerTxUrl,
  fetchLiveChainSnapshot,
  formatBps,
  formatFusd,
  formatRecordedRunUtc,
  getInspectorItem,
  hallmarkContractUrl,
  loadCachedSnapshot,
  shortAddr,
  type EvidenceEntry,
  type InspectorItem,
  type LiveChainSnapshot,
} from "./lib/chain";
import { INVARIANTS } from "./lib/invariants";

type ThemeMode = "light" | "dark" | "system";
type SectionId = "overview" | "capability-tree" | "attack-lab" | "invariants" | "treasury";

interface InjectedProvider {
  isQoreX?: boolean;
  isMetaMask?: boolean;
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface Eip6963AnnounceDetail {
  info: {
    uuid: string;
    name: string;
    rdns?: string;
  };
  provider: InjectedProvider;
}

const TIMELINE_DESCRIPTIONS: Record<string, string> = {
  H1: "Owner installs the root mandate",
  H2: "Owner registers a proven vendor",
  H3: "Orchestrator funds the vault, 8 fUSD",
  H4: "Orchestrator delegates 3 sub-mandates",
  H5: "Allocator rebalances to 50.00%",
  H6: "Payables pays 1.50 fUSD with 3 signatures",
  H7: "Orchestrator reclaims 0.50 fUSD",
};

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("attenua-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage errors
  }
  return "system";
}

function getSystemDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [live, setLive] = useState<LiveChainSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [connectedAddress, setConnectedAddress] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<string | null>(null);
  const [detectedWalletName, setDetectedWalletName] = useState<string | null>(null);
  const [lastWalletCheckAt, setLastWalletCheckAt] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [switchingChain, setSwitchingChain] = useState(false);
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InspectorItem | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const walletDialogRef = useRef<HTMLDialogElement | null>(null);
  const discoveredProvidersRef = useRef<Array<{ name: string; provider: InjectedProvider }>>([]);
  const activeProviderRef = useRef<InjectedProvider | null>(null);

  const effectiveTheme: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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

  const scrollSpyLockUntilRef = useRef<number>(0);

  useEffect(() => {
    const sectionIds: SectionId[] = ["overview", "capability-tree", "attack-lab", "invariants", "treasury"];
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
      if (Date.now() < scrollSpyLockUntilRef.current) return;

      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24;
      if (atBottom) {
        const treasuryEl = document.getElementById("treasury");
        const invariantsEl = document.getElementById("invariants");
        // Keep Invariants vs Treasury distinction clean on stacked mobile vs desktop
        if (treasuryEl && invariantsEl && Math.abs(treasuryEl.offsetTop - invariantsEl.offsetTop) > 40) {
          setActiveSection("treasury");
          return;
        }
      }

      let current: SectionId = "overview";
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= 150) {
          current = id;
        }
      }
      setActiveSection(current);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const refreshChain = useCallback(async () => {
    setLoading(true);
    setRpcError(null);
    try {
      const snap = await fetchLiveChainSnapshot();
      setLive(snap);
    } catch (err) {
      const cached = loadCachedSnapshot();
      if (cached) setLive(cached);
      setRpcError(err instanceof Error ? err.message : "RPC unreachable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshChain();
  }, [refreshChain]);

  const showModal = useCallback(() => {
    queueMicrotask(() => {
      const dlg = dialogRef.current;
      if (dlg && !dlg.open) {
        dlg.showModal();
      }
    });
  }, []);

  const handleInspect = useCallback(
    (chipId: string) => {
      const item = getInspectorItem(chipId, live);
      if (!item) return;
      setSelectedItem(item);
      showModal();
    },
    [live, showModal],
  );

  const handleCloseDialog = useCallback(() => {
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, []);

  const showWalletModal = useCallback(() => {
    setWalletDialogOpen(true);
    queueMicrotask(() => {
      const dlg = walletDialogRef.current;
      if (dlg && !dlg.open) {
        dlg.showModal();
      }
    });
  }, []);

  const handleCloseWalletDialog = useCallback(() => {
    if (walletDialogRef.current?.open) {
      walletDialogRef.current.close();
    }
    setWalletDialogOpen(false);
  }, []);

  const resolveWalletProvider = useCallback((): { name: string; provider: InjectedProvider } | null => {
    const win = window as Window & { qorex?: InjectedProvider; ethereum?: InjectedProvider };
    if (win.qorex?.request) {
      return { name: "QoreX", provider: win.qorex };
    }
    const eip6963 = discoveredProvidersRef.current;
    const qorexDiscovered = eip6963.find((p) => /qorex/i.test(p.name));
    if (qorexDiscovered) return qorexDiscovered;
    if (eip6963.length > 0) return eip6963[0];
    if (win.ethereum?.request) {
      const name = win.ethereum.isQoreX
        ? "QoreX"
        : win.ethereum.isMetaMask
          ? "MetaMask"
          : "EVM wallet";
      return { name, provider: win.ethereum };
    }
    return null;
  }, []);

  useEffect(() => {
    const syncDetected = () => {
      const resolved = resolveWalletProvider();
      setDetectedWalletName(resolved ? resolved.name : null);
    };

    const onAnnounce = (event: Event) => {
      const custom = event as CustomEvent<Eip6963AnnounceDetail>;
      const detail = custom.detail;
      if (!detail?.provider?.request) return;
      const exists = discoveredProvidersRef.current.some(
        (p) => p.provider === detail.provider || p.name === detail.info?.name,
      );
      if (!exists) {
        discoveredProvidersRef.current.push({
          name: detail.info?.name || "EVM wallet",
          provider: detail.provider,
        });
      }
      syncDetected();
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    syncDetected();

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, [resolveWalletProvider]);

  useEffect(() => {
    const provider = activeProviderRef.current;
    if (!provider?.on || !connectedAddress) return;
    const handleAccountsChanged = (accs: unknown) => {
      const list = Array.isArray(accs) ? accs : [];
      const first = typeof list[0] === "string" ? list[0] : null;
      if (first && isAddress(first)) {
        setConnectedAddress(first);
      } else {
        setConnectedAddress(null);
        setWalletChainId(null);
        activeProviderRef.current = null;
      }
    };
    const handleChainChanged = (cid: unknown) => {
      if (typeof cid === "string") setWalletChainId(cid.toLowerCase());
    };
    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [connectedAddress]);

  const connectBrowserWallet = useCallback(async () => {
    const resolved = resolveWalletProvider();
    setDetectedWalletName(resolved ? resolved.name : null);

    if (!resolved?.provider.request) {
      setWalletError(
        "No QoreX or EIP-1193 browser wallet extension found. Use the keyless inspector below.",
      );
      return;
    }

    setConnectingWallet(true);
    setWalletError(null);
    try {
      const accounts = (await resolved.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const first = accounts?.[0];
      if (first && isAddress(first)) {
        activeProviderRef.current = resolved.provider;
        setConnectedAddress(first);
        try {
          const cid = (await resolved.provider.request({ method: "eth_chainId" })) as string;
          if (typeof cid === "string") setWalletChainId(cid.toLowerCase());
        } catch {
          // non-fatal if eth_chainId is unsupported
        }
      } else {
        setWalletError("Wallet returned no EVM address.");
      }
    } catch (err) {
      setWalletError(
        err instanceof Error ? `Wallet declined: ${err.message}` : "Wallet connection cancelled.",
      );
    } finally {
      setConnectingWallet(false);
    }
  }, [resolveWalletProvider]);

  const recheckWalletProvider = useCallback(() => {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const resolved = resolveWalletProvider();
    setDetectedWalletName(resolved ? resolved.name : null);
    setWalletError(null);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    setLastWalletCheckAt(`${hh}:${mm}:${ss}`);
  }, [resolveWalletProvider]);

  const switchToQoreChain = useCallback(async () => {
    const provider = activeProviderRef.current ?? resolveWalletProvider()?.provider;
    if (!provider?.request) return;
    setSwitchingChain(true);
    setWalletError(null);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: QORE_CHAIN_HEX }],
      });
      setWalletChainId(QORE_CHAIN_HEX);
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 4902) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: QORE_CHAIN_HEX,
                chainName: "QoreChain Diana Testnet",
                rpcUrls: [EVM_RPC_URL],
                nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
                blockExplorerUrls: [EXPLORER_BASE],
              },
            ],
          });
          setWalletChainId(QORE_CHAIN_HEX);
        } catch (addErr) {
          setWalletError(
            addErr instanceof Error ? addErr.message : "Failed to add qorechain-diana network.",
          );
        }
      } else {
        setWalletError(err instanceof Error ? err.message : "Network switch declined.");
      }
    } finally {
      setSwitchingChain(false);
    }
  }, [resolveWalletProvider]);

  const handleNavbarWalletClick = useCallback(() => {
    showWalletModal();
    const resolved = resolveWalletProvider();
    setDetectedWalletName(resolved ? resolved.name : null);
    if (!connectedAddress && resolved) {
      void connectBrowserWallet();
    }
  }, [connectedAddress, connectBrowserWallet, resolveWalletProvider, showWalletModal]);

  const handleDisconnectWallet = useCallback(() => {
    activeProviderRef.current = null;
    setConnectedAddress(null);
    setWalletChainId(null);
    setWalletError(null);
  }, []);

  const logoSrc = effectiveTheme === "dark" ? logoMarkDark : logoMarkLight;
  const dotSrc = effectiveTheme === "dark" ? timelineDotDark : timelineDotLight;

  const timelineRows = useMemo(() => {
    const happy = EVIDENCE.happyPath as EvidenceEntry[];
    const hMap = new Map(happy.map((h) => [h.id, h]));
    const h4Gas =
      Number(hMap.get("H4a")?.evmGasUsed ?? 0) +
      Number(hMap.get("H4b")?.evmGasUsed ?? 0) +
      Number(hMap.get("H4c")?.evmGasUsed ?? 0);

    return [
      { id: "H1", gas: Number(hMap.get("H1")?.evmGasUsed ?? 235655) },
      { id: "H2", gas: Number(hMap.get("H2")?.evmGasUsed ?? 212973) },
      { id: "H3", gas: Number(hMap.get("H3")?.evmGasUsed ?? 34453) },
      { id: "H4", gas: h4Gas || 978142 },
      { id: "H5", gas: Number(hMap.get("H5")?.evmGasUsed ?? 383071) },
      { id: "H6", gas: Number(hMap.get("H6")?.evmGasUsed ?? 638947) },
      { id: "H7", gas: Number(hMap.get("H7")?.evmGasUsed ?? 249171) },
    ];
  }, []);

  const liquidityAssets = live ? live.liquidityAssets : 3_000_000n;
  const reserveAssets = live ? live.reserveAssets : 3_000_000n;
  const idleAssets = live ? live.idleFusd : 500_000n;
  const totalAum = liquidityAssets + reserveAssets + idleAssets;
  const liquidityPct = live ? Math.min(100, Math.max(0, live.liquidityBps / 100)) : 50;
  const liquidityPctText = live ? formatBps(live.liquidityBps) : "50.00%";
  const rootEpoch = live ? live.rootEpoch : 2;
  const isFrozen = live ? live.frozen : false;

  return (
    <>
      <a className="skip-link" href="#overview">
        Skip to main content
      </a>

      <div className="scroll-progress" aria-hidden="true" />

      <header className={`site-header${scrolled ? " is-scrolled" : ""}`}>
        <div className="shell navbar-inner">
          <div className="navbar-left">
            <div className="brand">
              <a href="#overview" className="brand-lockup">
                <img src={logoSrc} alt="" width={22} height={22} />
                <span className="brand-name">Attenua</span>
              </a>
              <span className="pill pill-neutral">
                {DEPLOYMENT.network} · {DEPLOYMENT.evmChainId}
              </span>
            </div>

            <nav className="nav-pills" aria-label="Primary sections">
              {(
                [
                  ["overview", "Overview"],
                  ["capability-tree", "Capability tree"],
                  ["attack-lab", "Attack lab"],
                  ["invariants", "Invariants"],
                  ["treasury", "Treasury"],
                ] as const
              ).map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="nav-link"
                  aria-current={activeSection === id ? "location" : undefined}
                  onClick={() => {
                    scrollSpyLockUntilRef.current = Date.now() + 700;
                    setActiveSection(id);
                  }}
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>

          <div className="navbar-right">
            <div className="theme-switch" role="group" aria-label="Color theme">
              {(["light", "dark", "system"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="theme-tab"
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
              onClick={handleNavbarWalletClick}
            >
              {connectedAddress
                ? `QoreX · ${shortAddr(connectedAddress, 6, 4)}`
                : "Connect QoreX wallet"}
            </button>
          </div>
        </div>
      </header>

      <main className="shell page-stack">
        {/* Page Header (Figma Overview 11:413 + Data states 9:684) */}
        <section id="overview" className="page-header" aria-labelledby="thesis-title">
          <div className="title-block">
            <h1 id="thesis-title" className="thesis-heading">
              <span>Every agent holds</span>
              <span className="thesis-highlight">less</span>
              <span>than its parent.</span>
            </h1>
            <p className="page-subtitle">
              Treasury swarm on {DEPLOYMENT.network}: who can move fUSD, how far each agent may go, and
              which transaction stopped each attack.
            </p>
          </div>

          <div className="vault-state-row" aria-live="polite">
            <a href="#attack-lab" className="btn btn-primary">
              Attack the lattice
            </a>

            <div className="meta-pill">
              <span className="meta-label">Root epoch</span>
              <span className="meta-value">{rootEpoch}</span>
            </div>

            <span className={`pill ${isFrozen ? "pill-danger" : "pill-ok"}`}>
              {isFrozen ? "Vault frozen" : "Vault active"}
            </span>

            <div className="meta-pill">
              <span className="meta-label">Recorded run</span>
              <span className="meta-value">{formatRecordedRunUtc(EVIDENCE.runAt)}</span>
            </div>

            {loading ? (
              <span className="pill pill-neutral">Connecting to {DEPLOYMENT.network}</span>
            ) : rpcError ? (
              <span className="pill pill-warn">
                {live?.isCachedFallback ? "Cached snapshot · RPC unreachable" : "RPC unreachable · showing recorded run"}
              </span>
            ) : live ? (
              <span className="pill pill-ok">Live · block #{live.blockNumber}</span>
            ) : null}

            <button
              type="button"
              className="btn btn-secondary"
              disabled={loading}
              onClick={() => void refreshChain()}
            >
              {loading ? "Syncing" : rpcError ? "Retry RPC" : "Refresh chain"}
            </button>
          </div>
        </section>

        {/* Capability Tree (Figma 12:20) */}
        <CapabilityTree effectiveTheme={effectiveTheme} live={live} onInspect={handleInspect} />

        {/* Live Keyless Interactive Attack Lab + AI Replay */}
        <AttackLab live={live} />

        {/* Authenticated Inter-Agent Messaging (QoreSign + QoreSeal) */}
        <section
          id="messaging"
          className="surface-card reveal-card"
          aria-labelledby="messaging-heading"
        >
          <div className="card-head">
            <div className="card-title-group">
              <h2 id="messaging-heading" className="card-title">
                Authenticated Inter-Agent Messaging · QoreSign + QoreSeal
              </h2>
              <p className="card-desc">
                Off-chain invoice memos &amp; Research LLM clearance verdicts stay confidential via hybrid{" "}
                <code>ML-KEM-1024 + X25519</code> (<code>@qorechain/qoreseal</code>) and domain-separated{" "}
                <code>ML-DSA-87</code> signatures (<code>@qorechain/qoresign</code> +{" "}
                <code>@qorechain/pqc</code>).
              </p>
            </div>
            <span className="pill pill-ok">ML-DSA-87 + ML-KEM-1024 Verified</span>
          </div>

          <div className="holdings-list">
            <div className="holding-row">
              <span className="holding-name">Sender · Research (ML-DSA-87 + SHAKE-256)</span>
              <span className="holding-amount">
                {AUTHENTICATED_MESSAGE.verifiedClearance.payload.verdict} ·{" "}
                {AUTHENTICATED_MESSAGE.verifiedClearance.shake256Digest.slice(0, 14)}…
              </span>
              <span className="holding-addr mono">{shortAddr(AUTHENTICATED_MESSAGE.sender.cosmos)}</span>
            </div>
            <div className="holding-row">
              <span className="holding-name">Recipient 1 · OrchestratorPqc (ML-KEM-1024)</span>
              <span className="holding-amount">
                block #{AUTHENTICATED_MESSAGE.kemRegistry.orchestratorPqc.registeredHeight}
              </span>
              <a
                className="holding-addr"
                href={explorerTxUrl(AUTHENTICATED_MESSAGE.kemRegistry.orchestratorPqc.txHash)}
                target="_blank"
                rel="noreferrer"
                title={`MsgRegisterKEMKey tx · ${AUTHENTICATED_MESSAGE.kemRegistry.orchestratorPqc.txHash}`}
              >
                {shortAddr(AUTHENTICATED_MESSAGE.kemRegistry.orchestratorPqc.txHash)} ↗
              </a>
            </div>
            <div className="holding-row">
              <span className="holding-name">Recipient 2 · Payables (ML-KEM-1024)</span>
              <span className="holding-amount">
                block #{AUTHENTICATED_MESSAGE.kemRegistry.payables.registeredHeight}
              </span>
              <a
                className="holding-addr"
                href={explorerTxUrl(AUTHENTICATED_MESSAGE.kemRegistry.payables.txHash)}
                target="_blank"
                rel="noreferrer"
                title={`MsgRegisterKEMKey tx · ${AUTHENTICATED_MESSAGE.kemRegistry.payables.txHash}`}
              >
                {shortAddr(AUTHENTICATED_MESSAGE.kemRegistry.payables.txHash)} ↗
              </a>
            </div>
            <div className="holding-row">
              <span className="holding-name">QoreSeal Hybrid Envelope</span>
              <span className="holding-amount">
                {AUTHENTICATED_MESSAGE.envelope.byteLength.toLocaleString()} bytes ·{" "}
                {AUTHENTICATED_MESSAGE.envelope.recipientCount} recipients · RecipientCards verified
              </span>
              <span className="holding-addr mono">{AUTHENTICATED_MESSAGE.purpose}</span>
            </div>
          </div>

          <pre className="verbatim-box">
            {`${AUTHENTICATED_MESSAGE.envelope.text.slice(0, 140)}…\nSHAKE-256: ${AUTHENTICATED_MESSAGE.verifiedClearance.shake256Digest} · Payables & OrchestratorPqc unsealed + ML-DSA-87 verified on-chain`}
          </pre>
        </section>

        {/* Lower Section: Invariants (Left) | Treasury + Run Timeline (Right) */}
        <div className="lower-grid">
          <section
            id="invariants"
            className="surface-card reveal-card"
            aria-labelledby="invariants-heading"
          >
            <div className="card-head">
              <div className="card-title-group">
                <h2 id="invariants-heading" className="card-title">
                  Invariants
                </h2>
                <p className="card-desc">
                  The rules Attenua promises, who enforces each one, and the transactions that prove it.
                </p>
              </div>
              <span className="pill pill-ok">All 9 held in the recorded run</span>
            </div>

            <div
              className="ledger-wrap"
              tabIndex={0}
              role="region"
              aria-labelledby="invariants-heading"
            >
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Invariant</th>
                    <th scope="col">Enforced by</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {INVARIANTS.map((inv) => (
                    <tr key={inv.id}>
                      <td className="inv-id">{inv.id}</td>
                      <td>
                        <div className="inv-title">{inv.title}</div>
                        <p className="inv-desc">{inv.description}</p>
                      </td>
                      <td className="inv-enforced">{inv.enforcedBy}</td>
                      <td className="inv-evidence">
                        <div className="chip-row">
                          {inv.chips.map((c) => (
                            <EvidenceChip
                              key={`${inv.id}-${c.id}`}
                              id={c.id}
                              kind={c.kind}
                              onInspect={handleInspect}
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="card-footnote">
              Select any A or H chip to see the transaction and the verbatim chain diagnostic.{" "}
              <code>verify</code> means the check runs keyless with <code>npm run verify</code> in{" "}
              <code>agent/</code>.
            </p>
          </section>

          <div id="treasury" className="lower-right-col">
            <section className="surface-card reveal-card" aria-labelledby="treasury-heading">
              <div className="card-head">
                <div className="card-title-group">
                  <h2 id="treasury-heading" className="card-title">
                    Treasury within mandate
                  </h2>
                  <p className="card-desc">
                    Allocator keeps the liquidity sleeve inside its band.
                  </p>
                </div>
                {live && <span className="pill pill-ok">Live RPC</span>}
              </div>

              <div className="aum-hero">
                <span className="aum-figure">{formatFusd(totalAum)}</span>
                <span className="aum-caption">under management</span>
              </div>

              <div className="treasury-meter">
                <div
                  className="treasury-tooltip"
                  style={{ insetInlineStart: `${liquidityPct}%` }}
                >
                  {liquidityPctText} liquidity
                </div>
                <div
                  className="treasury-track"
                  role="img"
                  aria-label={`Liquidity sleeve at ${liquidityPctText}, inside Allocator band 45% to 65% and Root band 40% to 70%`}
                >
                  <div
                    className="treasury-root-band"
                    style={{ insetInlineStart: "40%", inlineSize: "30%" }}
                  />
                  <div
                    className="treasury-child-band"
                    style={{ insetInlineStart: "45%", inlineSize: "20%" }}
                  />
                  <div
                    className="treasury-needle"
                    style={{ insetInlineStart: `${liquidityPct}%` }}
                  />
                </div>
                <div className="treasury-ticks" aria-hidden="true">
                  <span style={{ insetInlineStart: "0%" }}>0%</span>
                  <span style={{ insetInlineStart: "40%", transform: "translateX(-50%)" }}>40%</span>
                  <span style={{ insetInlineStart: "70%", transform: "translateX(-50%)" }}>70%</span>
                  <span style={{ insetInlineEnd: "0%" }}>100%</span>
                </div>
              </div>

              <div className="legend-row">
                <span className="legend-item">
                  <span
                    className="legend-swatch"
                    style={{ background: "var(--chart-band-root)" }}
                    aria-hidden="true"
                  />
                  <span>Root [40%, 70%]</span>
                </span>
                <span className="legend-item">
                  <span
                    className="legend-swatch"
                    style={{ background: "var(--chart-band-child)" }}
                    aria-hidden="true"
                  />
                  <span>Allocator [45%, 65%]</span>
                </span>
              </div>

              <div className="holdings-list">
                <div className="holding-row">
                  <span className="holding-name">LiquidityVault · ERC-4626</span>
                  <span className="holding-amount">{formatFusd(liquidityAssets)}</span>
                  <a
                    className="holding-addr"
                    href={hallmarkContractUrl(DEPLOYMENT.contracts.liquidityVault.address)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Hallmark verified source · ${DEPLOYMENT.contracts.liquidityVault.address}`}
                  >
                    {shortAddr(DEPLOYMENT.contracts.liquidityVault.address)}
                  </a>
                </div>
                <div className="holding-row">
                  <span className="holding-name">ReserveVault · ERC-4626</span>
                  <span className="holding-amount">{formatFusd(reserveAssets)}</span>
                  <a
                    className="holding-addr"
                    href={hallmarkContractUrl(DEPLOYMENT.contracts.reserveVault.address)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Hallmark verified source · ${DEPLOYMENT.contracts.reserveVault.address}`}
                  >
                    {shortAddr(DEPLOYMENT.contracts.reserveVault.address)}
                  </a>
                </div>
                <div className="holding-row">
                  <span className="holding-name">Idle in AttenuaVault</span>
                  <span className="holding-amount">{formatFusd(idleAssets)}</span>
                  <a
                    className="holding-addr"
                    href={hallmarkContractUrl(DEPLOYMENT.contracts.attenuaVault.address)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Hallmark verified source · ${DEPLOYMENT.contracts.attenuaVault.address}`}
                  >
                    {shortAddr(DEPLOYMENT.contracts.attenuaVault.address)}
                  </a>
                </div>
              </div>

              <p className="card-footnote">
                Weights come from <code>convertToAssets()</code> on-chain, with no price oracle. Both
                sleeves sit behind a HolderGuard whose owner is renounced.
              </p>
            </section>

            <section className="surface-card reveal-card" aria-labelledby="timeline-heading">
              <div className="card-head">
                <div className="card-title-group">
                  <h2 id="timeline-heading" className="card-title">
                    Happy-path run
                  </h2>
                  <p className="card-desc">The swarm doing its job, in order.</p>
                </div>
                <span className="pill pill-ok">
                  {(EVIDENCE.happyPath?.length ?? 9)} transactions verified
                </span>
              </div>

              <ul className="timeline-list">
                {timelineRows.map((row, idx) => (
                  <li key={row.id} className="timeline-item">
                    <div className="timeline-rail" aria-hidden="true">
                      <img src={dotSrc} alt="" width={10} height={10} />
                      {idx < timelineRows.length - 1 && <span className="timeline-stem" />}
                    </div>
                    <div className="timeline-content">
                      <EvidenceChip id={row.id} kind="run" onInspect={handleInspect} />
                      <span className="timeline-text">{TIMELINE_DESCRIPTIONS[row.id]}</span>
                      <span className="timeline-gas">{row.gas.toLocaleString()}</span>
                    </div>
                  </li>
                ))}
              </ul>

              <p className="card-footnote">
                Gas is EVM gas per transaction. H4 is the sum of H4a, H4b and H4c.
              </p>
            </section>
          </div>
        </div>
      </main>

      <footer className="shell site-footer">
        <p>
          Attenua · Apache-2.0 · Prior art credited: UCAN &amp; Biscuit · Built on QoreChain (
          {DEPLOYMENT.network}).
        </p>
        <p>
          <a href="https://github.com/agvswira/attenua" target="_blank" rel="noreferrer">
            GitHub Repository
          </a>{" "}
          · Keyless check: <code>cd agent &amp;&amp; npm run verify</code>
        </p>
      </footer>

      <InspectorDialog
        dialogRef={dialogRef}
        item={selectedItem}
        onClose={handleCloseDialog}
      />

      <WalletPostureDialog
        dialogRef={walletDialogRef}
        isOpen={walletDialogOpen}
        connectedAddress={connectedAddress}
        walletChainId={walletChainId}
        detectedWalletName={detectedWalletName}
        lastCheckedAt={lastWalletCheckAt}
        walletError={walletError}
        connecting={connectingWallet}
        switchingChain={switchingChain}
        onConnect={() => void connectBrowserWallet()}
        onRecheckWallet={recheckWalletProvider}
        onSwitchChain={() => void switchToQoreChain()}
        onDisconnect={handleDisconnectWallet}
        onClose={handleCloseWalletDialog}
      />
    </>
  );
}
