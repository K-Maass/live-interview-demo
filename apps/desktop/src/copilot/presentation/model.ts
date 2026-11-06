import type { StatusTone } from "../../lib/copilot/announcements";
export type MeetingPresentation = "setup" | "preparation" | "live" | "review";
export interface StageInput { activeMeetingId?: string; selectedRecordId?: string; targetId: string; preparationOpen?: boolean }
export interface CaptureRow { lane: "me" | "remote"; label: string; status: "idle" | "starting" | "active" | "paused" | "unavailable"; detail?: string | null; /** What to tell the person about this lane while recording, when it needs attention. */ message?: LaneMessage }
export interface LaneMessage { text: string; tone: StatusTone }
export interface WidgetAction { version: 1; requestId: string; ownerId: string; meetingId?: string; kind: "pin" | "dismiss" | "evidence" | "answered" | "outdated" | "openMain"; cardId?: string }
export function deriveMeetingPresentation(input: StageInput): MeetingPresentation {
  if (input.activeMeetingId === input.targetId) return "live";
  if (input.selectedRecordId === input.targetId) return "review";
  return input.preparationOpen ? "preparation" : "setup";
}
/** Codes for a lane that is still capturing: recovered after a fault, or a warning that never stops recording. */
const capturingCodes = new Set(["captureStarted", "captureRecovered", "journalRetrying", "diskSpaceLow", "mic-silent", "microphoneSignal"]);
/**
 * Plain words and a tone for a lane health code. Starting, started and recovered are information. A journal retry,
 * low disk space or a microphone sending only silence is a notice: recording continues. A lane that stopped capturing (stalled, interrupted, silent
 * system audio, ended, journal failed, unavailable or an unknown code) is an alert. The raw code is never shown.
 */
export function laneHealthMessage(lane: string, code: string, detail?: string | null): LaneMessage {
  const name = lane === "me" ? "Microphone" : lane === "remote" ? "System audio" : "Audio";
  const lower = name.toLocaleLowerCase();
  switch (code) {
    case "captureStarting": return { tone: "info", text: `${name} is starting.` };
    case "captureStarted": return { tone: "info", text: `${name} is recording.` };
    case "captureRecovered": return { tone: "info", text: `${name} recovered and is recording again.` };
    case "microphoneSignal": return { tone: "info", text: "Microphone is recording." };
    case "mic-silent": return { tone: "notice", text: "Your microphone is sending silence. Check mute or input device." };
    case "microphoneDenied": return { tone: "alert", text: "Microphone access is off, so the microphone records silence. Turn it on in System Settings › Privacy & Security › Microphone. Recording continues." };
    case "diskSpaceLow": return { tone: "notice", text: detail || "Disk space is low on the recording disk. Recording continues; free space soon." };
    case "journalRetrying": return { tone: "notice", text: `Saving ${lower} to disk is being retried. Recording continues.` };
    case "captureStalled": return { tone: "alert", text: `${name} stopped delivering sound. Reconnecting.` };
    case "captureInterrupted": return { tone: "alert", text: `${name} was interrupted. Reconnecting.` };
    case "system-audio-silent": return { tone: "alert", text: "System audio is silent. Check that the call plays its sound on this Mac." };
    case "captureEnded": return { tone: "alert", text: `${name} stopped unexpectedly and is not recording.` };
    case "journalFailed": return { tone: "alert", text: `${name} could not be saved to disk.` };
    default: return { tone: "alert", text: `${name} is not recording. ${detail || "Check input permissions and availability."}` };
  }
}
export function captureRows(health: Record<string, { code: string; detail?: string | null }>, frames: Record<string, number>, paused: boolean, recording: boolean): CaptureRow[] {
  return (["me", "remote"] as const).map((lane) => {
    const current = health[lane];
    const failed = current && !capturingCodes.has(current.code) && current.code !== "captureStarting";
    const status = !recording ? "idle" : failed ? "unavailable" : paused ? "paused" : current?.code === "captureStarting" ? "starting" : (current && capturingCodes.has(current.code)) || frames[lane] > 0 ? "active" : "starting";
    const message = recording && current ? laneHealthMessage(lane, current.code, current.detail) : undefined;
    return { lane, label: lane === "me" ? "Microphone" : "System audio", status, detail: current?.detail, ...(message && message.tone !== "info" ? { message } : {}) };
  });
}
/**
 * The lane messages to show, once each: a disk-wide notice (low disk space) arrives on both lanes with the same words
 * and is shown once. Same words with different tones keep the alert.
 */
export function captureMessages(rows: CaptureRow[]): LaneMessage[] {
  const byText = new Map<string, LaneMessage>();
  for (const { message } of rows) {
    if (!message) continue;
    const earlier = byText.get(message.text);
    if (!earlier || (message.tone === "alert" && earlier.tone !== "alert")) byText.set(message.text, message);
  }
  return [...byText.values()];
}
/** `pinnedIds` are the visible cards that are saved pins: only those can be marked answered or outdated from the widget. */
export function validateWidgetAction(data: unknown, ownerId: string, meetingId: string | undefined, cardIds: string[], pinnedIds: string[] = []): WidgetAction | undefined {
  if (!data || typeof data !== "object") return undefined;
  const action = data as Partial<WidgetAction>;
  if (action.version !== 1 || typeof action.requestId !== "string" || !action.requestId || action.ownerId !== ownerId || action.meetingId !== meetingId) return undefined;
  if (action.kind === "openMain") return { version: 1, requestId: action.requestId, ownerId, meetingId, kind: "openMain" };
  if (!meetingId || !["pin", "dismiss", "evidence", "answered", "outdated"].includes(action.kind ?? "") || typeof action.cardId !== "string" || !cardIds.includes(action.cardId)) return undefined;
  if ((action.kind === "answered" || action.kind === "outdated") && !pinnedIds.includes(action.cardId)) return undefined;
  return { version: 1, requestId: action.requestId, ownerId, meetingId, kind: action.kind as WidgetAction["kind"], cardId: action.cardId };
}
export function consumeWidgetAction(data: unknown, ownerId: string, meetingId: string | undefined, cardIds: string[], seen: Set<string>, pinnedIds: string[] = []): WidgetAction | undefined {
  const action = validateWidgetAction(data, ownerId, meetingId, cardIds, pinnedIds);
  if (!action || seen.has(action.requestId)) return undefined;
  seen.add(action.requestId);
  return action;
}
const detectionWords: Record<string, string> = {
  noVerifiedCall: "No Teams call detected right now",
  ambiguousCalls: "Several Teams calls are open; choose one when offered",
  accessibilityTraversalIncomplete: "Teams call check incomplete; manual start remains available",
  accessibilitySetupRequired: "Teams detection needs Accessibility permission",
  unsupportedPlatform: "Teams detection is not available on this system",
};
/** Plain words for a detection result code. Unknown values are already sentences and pass through unchanged. */
export function detectionStatusText(status: string): string {
  return detectionWords[status] ?? status;
}
