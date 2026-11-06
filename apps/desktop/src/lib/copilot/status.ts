// The assistance status model. Producers (the guidance runtime, shortcut registration, settings panels) report a code,
// a severity and, at most, a technical detail. `describeStatus` is the one place that turns that into the calm words a
// person sees. Healthy states have no words at all: they show nothing on the live page, and their detail (timings,
// path) is kept only for Settings › Diagnostics. Nothing here touches recording.
import { shortcutText } from "./shortcuts";

/** `ok`: working as intended, nothing to show. `info`: worth a passing note. `degraded`: assistance is impaired. */
export type StatusSeverity = "ok" | "info" | "degraded";

const coded = {
  notConnected: { severity: "ok", text: "" },
  guidanceReady: { severity: "ok", text: "" },
  refinementPending: { severity: "ok", text: "" },
  clarificationProvisional: { severity: "ok", text: "" },
  /** Background preparation used its per-meeting budget; help requests still work. Diagnostics only. */
  preparationBudgetSpent: { severity: "ok", text: "" },
  workspaceRefreshing: { severity: "info", text: "Refreshing workspace context." },
  contextPending: { severity: "info", text: "Workspace context is catching up. Suggestions use what is ready." },
  summaryPending: { severity: "info", text: "The conversation summary is catching up. Suggestions use the latest lines." },
  profilePending: { severity: "info", text: "The meeting type changed here and will be saved shortly." },
  publicEvidence: { severity: "info", text: "Public sources found. Suggestions may refine." },
  clarificationOnly: { severity: "degraded", text: "Suggestions are limited right now. Recording continues." },
  staleWithheld: { severity: "degraded", text: "The conversation moved on, so an older suggestion was held back." },
  refinementUnavailable: { severity: "degraded", text: "The earlier suggestion is kept. It could not be refined." },
  reasoningUnavailable: { severity: "degraded", text: "Suggestions are unavailable right now. Recording continues." },
  publicResearchUnavailable: { severity: "degraded", text: "Public research is unavailable right now." },
  decisionsUnavailable: { severity: "degraded", text: "Automatic suggestions are paused for now. Help requests still work and recording continues." },
  // A saved meeting the app closed during (crash or force quit). Recording is not involved: these describe a record.
  recordRecovering: { severity: "info", text: "The app closed during this meeting. What it saved is being processed now." },
  recordRecovered: { severity: "info", text: "Recovered after the app closed unexpectedly." },
  recordInterrupted: { severity: "info", text: "The app closed during this meeting. Use Retry processing to finish what it saved." },
} as const satisfies Record<string, { severity: StatusSeverity; text: string }>;

export type CodedStatus = keyof typeof coded;
/** What a producer reports. `message` carries already-plain words from a settings or review panel. */
export type StatusEvent =
  | { code: CodedStatus; detail?: string }
  /** `detail`: the accelerators that could not register, joined with ", ". */
  | { code: "shortcutUnavailable"; detail: string }
  | { code: "message"; text: string; severity?: StatusSeverity; detail?: string };
export type StatusCode = StatusEvent["code"];

/** An assistance status as shown: `id` is unique per report, so the same words reported again are a new event. */
export interface AssistanceStatus {
  id: number;
  code: StatusCode;
  severity: StatusSeverity;
  /** Plain words for the person; empty for healthy states. */
  text: string;
  /** Technical detail for Settings › Diagnostics only (timings, accelerator, path). Never shown on the live page. */
  detail?: string;
  /** `severity === "degraded"`. What is spoken is decided in announcements.ts (`assistanceAnnouncement`). */
  degraded: boolean;
}

export function describeStatus(event: StatusEvent, id: number): AssistanceStatus {
  const make = (severity: StatusSeverity, text: string, detail?: string): AssistanceStatus => ({ id, code: event.code, severity, text, detail, degraded: severity === "degraded" });
  if (event.code === "message") return make(event.severity ?? "info", event.text, event.detail);
  if (event.code === "shortcutUnavailable") return make("degraded", unavailableShortcutsText(event.detail.split(", ")), event.detail);
  const entry = coded[event.code];
  return make(entry.severity, entry.text, event.detail);
}

export const initialAssistanceStatus = describeStatus({ code: "notConnected" }, 0);

/** The status of a saved meeting's launch recovery, if it had one. */
export function recoveryStatus(recovery: { state: string } | undefined): StatusEvent | undefined {
  switch (recovery?.state) {
    case "recovering": return { code: "recordRecovering" };
    case "recovered": return { code: "recordRecovered" };
    case "interrupted": return { code: "recordInterrupted" };
    default: return undefined;
  }
}

/** The line under the live page heading: only an impaired assistant is worth the person's attention mid-meeting. */
export function liveStatusLine(status: AssistanceStatus): string | undefined {
  return status.severity === "degraded" && status.text ? status.text : undefined;
}

/** A passing note away from the live page: anything with words. Healthy states have none. */
export function statusNotice(status: AssistanceStatus): { id: number; text: string } | undefined {
  return status.severity !== "ok" && status.text ? { id: status.id, text: status.text } : undefined;
}

/** "The shortcut ⌘⌥⎋ is unavailable. The buttons still work." for one key, a list for several. */
export function unavailableShortcutsText(accelerators: string[]): string {
  const keys = accelerators.filter(Boolean).map(shortcutText);
  return keys.length === 1
    ? `The shortcut ${keys[0]} is unavailable. The buttons still work.`
    : `The shortcuts ${keys.join(", ")} are unavailable. The buttons still work.`;
}

/** Shown and spoken after the first Stop & save key press, until the second press or STOP_CONFIRM_MS. */
export const stopConfirmLine = (accelerator: string) => `Press ${shortcutText(accelerator)} again to stop and save.`;
/** When the confirming press came while a start or stop was still running; the request stays armed. */
export const stopRefusedLine = (accelerator: string) => `Not ready to stop yet. Press ${shortcutText(accelerator)} again in a moment.`;
/** The Stop & save key line for the page, the widget and the announcer, or undefined when no request is armed. */
export const stopPromptLine = (accelerator: string, state: { stopPending: boolean; stopRefused: boolean }) =>
  !state.stopPending ? undefined : state.stopRefused ? stopRefusedLine(accelerator) : stopConfirmLine(accelerator);

/**
 * The calm line on the live page while any shortcut could not register. Unlike the assistance status, which the next
 * report replaces, this comes from the registrar's last completed apply, so it stays until a later apply succeeds.
 */
export function shortcutAvailabilityLine(unavailable: readonly string[]): string | undefined {
  return unavailable.length ? unavailableShortcutsText([...unavailable]) : undefined;
}
