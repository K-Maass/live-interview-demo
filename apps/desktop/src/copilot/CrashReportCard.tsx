import {
  crashExplanation,
  crashHeadline,
  sendNote,
  type PendingCrash,
} from "../lib/public/crashReport";

/** The wording and buttons of the crash-report notice. No state, so its markup can be tested. */
export function CrashReportCard({
  pending,
  busy,
  message,
  onSend,
  onDiscard,
  onNotNow,
}: {
  pending: PendingCrash & { report: NonNullable<PendingCrash["report"]> };
  busy: boolean;
  message: string;
  onSend: () => void;
  onDiscard: () => void;
  onNotNow: () => void;
}) {
  const report = pending.report;
  return (
    <section className="notice" aria-label="Crash report">
      <strong>{crashHeadline(report.kind)}</strong>
      <p>{crashExplanation(report.kind)}</p>
      <details>
        <summary>Show exactly what would be sent</summary>
        <pre className="crash-preview" tabIndex={0}>{pending.preview}</pre>
      </details>
      <p>{sendNote(pending.sendAvailable)}</p>
      <div className="crash-actions">
        {pending.sendAvailable && (
          <button className="copilot-button" disabled={busy} onClick={onSend}>Send report</button>
        )}
        <button className="copilot-button" disabled={busy} onClick={onDiscard}>Discard</button>
        <button className="copilot-button" disabled={busy} onClick={onNotNow}>Not now</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
