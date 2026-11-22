import { useCallback, useEffect, useState, type FormEvent, type RefObject } from "react";
import { isAddress, type Address } from "viem";
import {
  ADDRESS_PRESETS,
  DEPLOYMENT,
  QORE_CHAIN_HEX,
  fetchAddressPosture,
  formatFusd,
  shortAddr,
  type AddressPosture,
} from "../lib/chain";

interface WalletPostureDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  isOpen: boolean;
  connectedAddress: Address | null;
  walletChainId: string | null;
  detectedWalletName: string | null;
  lastCheckedAt: string | null;
  walletError: string | null;
  connecting: boolean;
  switchingChain: boolean;
  onConnect: () => void;
  onRecheckWallet: () => void;
  onSwitchChain: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}

export function WalletPostureDialog({
  dialogRef,
  isOpen,
  connectedAddress,
  walletChainId,
  detectedWalletName,
  lastCheckedAt,
  walletError,
  connecting,
  switchingChain,
  onConnect,
  onRecheckWallet,
  onSwitchChain,
  onDisconnect,
  onClose,
}: WalletPostureDialogProps) {
  const [targetAddr, setTargetAddr] = useState<Address>(ADDRESS_PRESETS[0].address);
  const [inputAddr, setInputAddr] = useState<string>("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [posture, setPosture] = useState<AddressPosture | null>(null);
  const [loading, setLoading] = useState(false);
  const [rpcError, setRpcError] = useState<string | null>(null);

  const inspectAddress = useCallback(async (addr: Address) => {
    setTargetAddr(addr);
    setInputError(null);
    setRpcError(null);
    setLoading(true);
    try {
      const res = await fetchAddressPosture(addr);
      setPosture(res);
    } catch (err) {
      setPosture(null);
      setRpcError(err instanceof Error ? err.message : "Failed to query qorechain-diana");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void inspectAddress(connectedAddress ?? targetAddr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connectedAddress]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = inputAddr.trim();
    if (!isAddress(trimmed)) {
      setInputError("Enter a valid 0x EVM address.");
      return;
    }
    void inspectAddress(trimmed);
  };

  const pqcBadge = posture
    ? posture.guardExempt
      ? { tone: "neutral", label: "Contract exempt" }
      : posture.pqcRegistered && posture.pqcAlgorithmId === 1 && posture.pqcPossessionProven
        ? { tone: "ok", label: "ML-DSA-87 · Proven" }
        : { tone: "warn", label: "No ML-DSA-87 key" }
    : null;

  return (
    <dialog
      ref={dialogRef}
      className="inspector-dialog"
      aria-labelledby="wallet-dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <div>
            <p className="dialog-eyebrow">QoreX · Live PQC &amp; HolderGuard inspector</p>
            <h3 id="wallet-dialog-title" className="dialog-title">
              Wallet &amp; address posture
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close wallet posture inspector"
          >
            Close
          </button>
        </div>

        {/* Browser Wallet Connection Bar */}
        <div className="wallet-bar">
          {connectedAddress ? (
            <>
              <span className="pill pill-ok">
                Connected · {shortAddr(connectedAddress, 6, 4)}
              </span>
              {walletChainId === QORE_CHAIN_HEX ? (
                <span className="pill pill-neutral">qorechain-diana · 9800</span>
              ) : (
                <>
                  <span className="pill pill-warn">Wrong network</span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={switchingChain}
                    onClick={onSwitchChain}
                  >
                    {switchingChain ? "Switching…" : "Switch to Diana (9800)"}
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void inspectAddress(connectedAddress)}
              >
                Inspect my wallet
              </button>
              <button type="button" className="btn btn-secondary" onClick={onDisconnect}>
                Disconnect
              </button>
              {walletError && <span className="dialog-status-sub">{walletError}</span>}
            </>
          ) : detectedWalletName ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={connecting}
                onClick={onConnect}
              >
                {connecting ? `Connecting ${detectedWalletName}…` : `Connect ${detectedWalletName}`}
              </button>
              <span className="dialog-status-sub">
                {walletError ??
                  "Read-only account & chain check (no signing required), or inspect any address keyless below."}
              </span>
            </>
          ) : (
            <>
              <span className="pill pill-warn">No wallet extension detected</span>
              <button type="button" className="btn btn-secondary" onClick={onRecheckWallet}>
                Re-check wallet
              </button>
              <span className="dialog-status-sub">
                {lastCheckedAt
                  ? `Checked at ${lastCheckedAt} — no QoreX / EIP-1193 extension in this browser. Install a browser wallet or inspect any live QoreChain address keyless below.`
                  : "Install QoreX or an EVM wallet extension to auto-connect your address, or inspect any live QoreChain address keyless below (no wallet required)."}
              </span>
            </>
          )}
        </div>

        {/* Keyless Preset Pills */}
        <div className="verbatim-wrap">
          <p className="verbatim-label">Inspect swarm actor or contract on {DEPLOYMENT.network}</p>
          <div className="chip-row" role="group" aria-label="Preset addresses">
            {ADDRESS_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="chip chip-run"
                aria-pressed={targetAddr.toLowerCase() === preset.address.toLowerCase()}
                onClick={() => {
                  setInputAddr("");
                  void inspectAddress(preset.address);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom Address Lookup */}
        <form className="address-form" onSubmit={handleSubmit}>
          <label htmlFor="custom-qore-address" className="visually-hidden">
            Custom QoreChain EVM address
          </label>
          <input
            id="custom-qore-address"
            type="text"
            className="address-input mono"
            placeholder="0x… inspect any QoreChain EVM address"
            value={inputAddr}
            onChange={(e) => {
              setInputAddr(e.target.value);
              if (inputError) setInputError(null);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="btn btn-secondary" disabled={loading}>
            Inspect
          </button>
        </form>
        {inputError && <p className="dialog-status-sub">{inputError}</p>}

        {/* Live Readout */}
        <div aria-live="polite">
          {loading ? (
            <p className="dialog-status-sub">Querying HolderGuard &amp; AttenuaVault on-chain…</p>
          ) : rpcError ? (
            <div className="verbatim-wrap">
              <span className="pill pill-warn">RPC unreachable</span>
              <pre className="verbatim-box">{rpcError}</pre>
            </div>
          ) : (
            posture && (
              <div className="dialog-inner">
                <div className="dialog-status-row">
                  {pqcBadge && (
                    <span className={`pill pill-${pqcBadge.tone}`}>{pqcBadge.label}</span>
                  )}
                  <span className={`pill ${posture.guardEligible ? "pill-ok" : "pill-danger"}`}>
                    {posture.guardEligible ? "ERC-4626 eligible" : "Blocked by HolderGuard"}
                  </span>
                </div>

                <dl className="spec-list">
                  <div className="spec-row">
                    <dt>Address</dt>
                    <dd className="mono">{shortAddr(posture.address, 10, 8)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>AttenuaVault role</dt>
                    <dd>{posture.role}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>pqcKeyStatus</dt>
                    <dd className="mono">
                      registered={String(posture.pqcRegistered)}, alg=
                      {posture.pqcAlgorithmId === 1 ? "1 (ML-DSA-87)" : posture.pqcAlgorithmId},
                      proven={String(posture.pqcPossessionProven)}
                    </dd>
                  </div>
                  <div className="spec-row">
                    <dt>HolderGuard</dt>
                    <dd className="mono">
                      isEligible={String(posture.guardEligible)}, exempt=
                      {String(posture.guardExempt)}
                    </dd>
                  </div>
                  <div className="spec-row">
                    <dt>Vendor allowlist</dt>
                    <dd>{posture.isVendor ? "Yes (allowlisted)" : "No"}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>fUSD balance</dt>
                    <dd className="mono">{formatFusd(posture.fusdBalance)}</dd>
                  </div>
                  <div className="spec-row">
                    <dt>Vault nonce</dt>
                    <dd className="mono">{posture.vaultNonce.toString()}</dd>
                  </div>
                </dl>
              </div>
            )
          )}
        </div>
      </div>
    </dialog>
  );
}
