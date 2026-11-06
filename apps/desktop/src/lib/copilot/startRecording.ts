import type { PublicMeetingPlan } from "@live-interview/core";
import { acceptedCallPlan as unsavedAcceptedCallPlan } from "../public/capture";

/** What the public product offers the start path; a narrow seam so the fallback is testable. */
export interface PlanSaver {
  save: () => Promise<unknown>;
  acceptedCallPlan: (title: string) => Promise<PublicMeetingPlan>;
  current?: PublicMeetingPlan;
}

/**
 * The plan a recording starts with. Saving the plan is local bookkeeping and must never block recording: when the
 * save fails, recording starts with the unsaved plan and `saveFailed` lets the caller say so separately.
 */
export async function capturePlanForStart(
  product: PlanSaver,
  purposeOverride?: string,
): Promise<{ plan?: PublicMeetingPlan; saveFailed: boolean }> {
  if (purposeOverride) {
    try {
      return { plan: await product.acceptedCallPlan(purposeOverride), saveFailed: false };
    } catch {
      return { plan: unsavedAcceptedCallPlan(purposeOverride, crypto.randomUUID()), saveFailed: true };
    }
  }
  try {
    await product.save();
    return { plan: product.current, saveFailed: false };
  } catch {
    return { plan: product.current, saveFailed: true };
  }
}

export const planSaveFailedStatus =
  "Recording. The meeting plan could not be saved; your edits remain here, so save it again later.";

/**
 * A test meeting replaces the shown session, so it must never start over a live recording or while a start or stop
 * is still running: it would take the screen and the guidance runtime away from the meeting being recorded.
 */
export function replayRefusal(state: { meetingActive: boolean; operationActive: boolean }): "meetingActive" | undefined {
  return state.meetingActive || state.operationActive ? "meetingActive" : undefined;
}

/** Shown by a second copy of the app: the first copy owns recording and launch recovery. */
export const anotherInstanceStatus =
  "Live Interview is already open. Record and review meetings in that window; this one does not record.";

/** Plain words for a rejected `start_local_meeting`. */
export function startErrorMessage(error: unknown): string {
  switch (error) {
    case "diskSpaceInsufficient":
      return "Recording could not start: less than 0.5 GB is free on this Mac. Free some disk space and try again.";
    case "captureFlushPending":
      return "Finishing the previous recording. Try again in a moment.";
    case "startInProgress":
      return "A recording is already starting. Wait a moment.";
    case "anotherInstance":
      return anotherInstanceStatus;
    case "updateInProgress":
      return "An app update is being installed. Try again once it finishes.";
    default:
      return "Recording could not start. Check microphone and system-audio permissions.";
  }
}

/** A second copy of the app is a calm notice, not an alarm; every other rejected start is an alert. */
export const startErrorTone = (error: unknown): "notice" | "alert" => (error === "anotherInstance" ? "notice" : "alert");

/** Plain words and tone for a rejected `stop_local_meeting`; the meeting stays open either way. */
export function stopErrorStatus(error: unknown): { text: string; tone: "notice" | "alert" } {
  if (error === "anotherInstance") return { text: anotherInstanceStatus, tone: "notice" };
  return {
    text: "Stop did not finish and needs attention. The meeting is still open and the local journal is preserved; try Stop again.",
    tone: "alert",
  };
}

/**
 * The part of a start after the native recording may already be running. Once `startNative` resolves, the meeting is
 * marked live whatever happens next, so Stop & save and the meeting keys exist for the recording: a guidance runtime
 * that cannot be built or started is reported, never allowed to leave native recording running with no meeting state.
 * A rejected `startNative` propagates (nothing is recording), and the meeting is not marked live.
 */
export async function startRecordingSession<R>(steps: {
  startNative: () => Promise<unknown>;
  startGuidance: () => R;
  markLive: () => void;
}): Promise<{ guidance?: R; guidanceFailed: boolean }> {
  await steps.startNative();
  let guidance: R | undefined;
  let guidanceFailed = false;
  try {
    guidance = steps.startGuidance();
  } catch {
    guidanceFailed = true;
  }
  steps.markLive();
  return { guidance, guidanceFailed };
}

export const guidanceStartFailedStatus =
  "Recording locally. Live assistance could not start; Stop & save still works and the recording is kept.";
