import { useEffect, useRef } from "react";

/**
 * The review step for one calendar change, in plain words. Nothing is written until the confirm button is pressed,
 * and the native action executor still checks the exact approved proposal.
 */
export function CalendarConfirmSheet({ heading, lines, confirmLabel, busy, onConfirm, onCancel, secondary }: { heading: string; lines: string[]; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void; secondary?: { label: string; onClick: () => void } }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    confirm.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") cancel.current(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return <div className="sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
    <div className="calendar-sheet" role="dialog" aria-modal="true" aria-labelledby="calendar-sheet-title">
      <h2 id="calendar-sheet-title">{heading}</h2>
      {lines.map((line, i) => <p key={i} className={i ? "muted" : undefined}>{line}</p>)}
      <div className="calendar-sheet-actions">
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        {secondary && <button onClick={secondary.onClick} disabled={busy}>{secondary.label}</button>}
        <button ref={confirm} className="primary" onClick={onConfirm} disabled={busy}>{busy ? "Saving…" : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
