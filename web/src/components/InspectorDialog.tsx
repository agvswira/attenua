import { useEffect, useState, type RefObject } from "react";
import { explorerTxUrl, shortAddr, type InspectorItem } from "../lib/chain";

interface InspectorDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  item: InspectorItem | null;
  onClose: () => void;
}

export function InspectorDialog({
  dialogRef,
  item,
  onClose,
}: InspectorDialogProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [item?.id, item?.txHash]);

  const handleCopyHash = async () => {
    if (!item?.txHash) return;
    try {
      await navigator.clipboard.writeText(item.txHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable in restricted contexts
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="inspector-dialog"
      aria-labelledby="inspector-title"
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      {item && (
        <div className="dialog-inner">
          <div className="dialog-head">
            <div>
              <p className="dialog-eyebrow">{item.eyebrow}</p>
              <h3 id="inspector-title" className="dialog-title">
                {item.title}
              </h3>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              aria-label="Close evidence inspector"
            >
              Close
            </button>
          </div>

          <div className="dialog-status-row">
            <span className={`pill pill-${item.pillTone}`}>{item.pillLabel}</span>
            <span className="dialog-status-sub">{item.subtitle}</span>
          </div>

          <dl className="spec-list">
            <div className="spec-row">
              <dt>{item.actorLabel}</dt>
              <dd>{item.actorValue}</dd>
            </div>
            <div className="spec-row">
              <dt>{item.layerLabel}</dt>
              <dd>{item.layerValue}</dd>
            </div>
            {item.gasUsed !== undefined && (
              <div className="spec-row">
                <dt>EVM gas used</dt>
                <dd className="mono">{Number(item.gasUsed).toLocaleString()}</dd>
              </div>
            )}
            {item.txHash && (
              <div className="spec-row">
                <dt>Transaction</dt>
                <dd className="mono">{shortAddr(item.txHash, 12, 12)}</dd>
              </div>
            )}
          </dl>

          <div className="verbatim-wrap">
            <p className="verbatim-label">{item.diagnosticTitle}</p>
            <pre className="verbatim-box">{item.diagnostic}</pre>
          </div>

          {item.extraTxs && item.extraTxs.length > 0 && (
            <div className="verbatim-wrap">
              <p className="verbatim-label">Explorer links</p>
              <div className="chip-row">
                {item.extraTxs.map((tx) => (
                  <a
                    key={tx.id}
                    href={explorerTxUrl(tx.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="chip chip-run"
                  >
                    {tx.id} ↗
                  </a>
                ))}
              </div>
            </div>
          )}

          {item.txHash && (
            <div className="dialog-actions">
              <a
                className="btn btn-primary"
                href={explorerTxUrl(item.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                Open on QoreChain Explorer
              </a>
              <button type="button" className="btn btn-secondary" onClick={() => void handleCopyHash()}>
                {copied ? "Copied ✓" : "Copy tx hash"}
              </button>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
