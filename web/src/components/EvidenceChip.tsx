export interface EvidenceChipProps {
  id: string;
  kind?: "attack" | "run" | "check";
  label?: string;
  interactive?: boolean;
  onInspect?: (id: string) => void;
}

export function EvidenceChip({
  id,
  kind = "attack",
  label,
  interactive = true,
  onInspect,
}: EvidenceChipProps) {
  const display = label ?? id;
  const cls = `chip chip-${kind}`;

  if (!interactive) {
    return (
      <span className={cls} aria-hidden="true">
        {display}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      onClick={() => onInspect?.(id)}
      aria-label={`Inspect ${display} evidence`}
    >
      {display}
    </button>
  );
}
