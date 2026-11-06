import { invoke } from "@tauri-apps/api/core";

/** The saved report, exactly as the native side stores it. It holds no meeting content (#47). */
export type CrashReport = {
  format: number;
  id: string;
  kind: "panic" | "unexpectedExit" | string;
  appVersion: string;
  os: string;
  day: string;
  location?: string;
  thread?: string;
  frames: string[];
};
export type PendingCrash = {
  report: CrashReport | null;
  /** The exact text that "Send report" would transmit. */
  preview: string;
  /** False in builds without a crash endpoint: the report can only be discarded. */
  sendAvailable: boolean;
};

export const pendingCrashReport = () => invoke<PendingCrash>("public_pending_crash_report");
export const resolveCrashReport = (id: string, send: boolean) =>
  invoke<{ sent?: boolean; discarded?: boolean }>("public_resolve_crash_report", { id, send });

export const crashHeadline = (kind: string) =>
  kind === "panic"
    ? "Live Interview hit an internal error last time."
    : "Live Interview did not close normally last time.";

export const crashExplanation = (kind: string) =>
  (kind === "panic"
    ? "A small report was saved on this Mac. "
    : "That can be a crash, a force quit or a power loss. A small report was saved on this Mac. ") +
  "It holds only the app and macOS versions, the day and technical function names. It never holds meeting audio, transcripts, notes, names, file paths or your account.";

export const sendNote = (sendAvailable: boolean) =>
  sendAvailable
    ? "Nothing is sent unless you choose Send report. Recording and everything else works either way."
    : "This build cannot send reports, so it stays on this Mac until you discard it.";

export const sentMessage = "Report sent. Thank you.";
export const sendFailedMessage = "Could not send the report. It is still saved on this Mac; try again later or discard it.";
export const discardFailedMessage = "Could not remove the report. It stays on this Mac.";

/** Shared by the notice so the behaviour can be tested without a DOM. Never throws. */
export async function resolveReport(
  report: CrashReport,
  send: boolean,
  resolve: typeof resolveCrashReport = resolveCrashReport,
): Promise<{ done: boolean; message: string }> {
  try {
    const result = await resolve(report.id, send);
    if (send) return result.sent ? { done: true, message: sentMessage } : { done: false, message: sendFailedMessage };
    return result.discarded === false ? { done: false, message: discardFailedMessage } : { done: true, message: "" };
  } catch {
    return { done: false, message: send ? sendFailedMessage : discardFailedMessage };
  }
}
