import { useEffect, useState } from "react";
import { native } from "../lib/localVoice";
import { chooseNotNow, crashNoticeVisible, notNowThisLaunch, shouldLoadCrashReport } from "../lib/public/crashNotice";
import { pendingCrashReport, resolveReport, type PendingCrash } from "../lib/public/crashReport";
import { CrashReportCard } from "./CrashReportCard";

/**
 * Shown when a local crash report is waiting. The person reads exactly what would be sent and chooses to
 * send it or discard it. It never blocks anything: a plain notice with no timer, hidden while a meeting is
 * active (and asked for again when the meeting ends), and "Not now" hides it until the next launch.
 * Failure to read or send is silent apart from a retry message. The gating rules live in
 * `lib/public/crashNotice.ts`, the wording in `CrashReportCard.tsx`; both are tested.
 */
export function CrashReportNotice({ meetingActive }: { meetingActive: boolean }) {
  const [pending, setPending] = useState<PendingCrash | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notNow, setNotNow] = useState(notNowThisLaunch());
  useEffect(() => {
    if (!shouldLoadCrashReport({ native: native(), meetingActive, notNow: notNowThisLaunch() })) return;
    let current = true;
    pendingCrashReport()
      .then((value) => current && setPending(value.report ? value : null))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [meetingActive]);
  const report = pending?.report;
  if (!pending || !report || !crashNoticeVisible({ hasReport: true, meetingActive, notNow }))
    return message && !meetingActive ? <p className="global-message" role="status">{message}</p> : null;
  async function choose(send: boolean) {
    setBusy(true);
    const result = await resolveReport(report!, send);
    setBusy(false);
    setMessage(result.message);
    if (result.done) setPending(null);
  }
  return (
    <CrashReportCard
      pending={{ ...pending, report }}
      busy={busy}
      message={message}
      onSend={() => void choose(true)}
      onDiscard={() => void choose(false)}
      onNotNow={() => {
        chooseNotNow();
        setNotNow(true);
      }}
    />
  );
}
