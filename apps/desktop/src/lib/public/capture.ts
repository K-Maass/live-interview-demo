import {
  inferProfile,
  type PublicMeetingPlan,
  type LocalMeetingOptions,
} from "@live-interview/core";
import { newMeetingPlan } from "./state";
import { meetingOptions } from "./reasoning";
/** Accepting a detected call is explicit capture consent, not consent to reuse another client's context. */
export function acceptedCallPlan(
  title: string,
  id: string,
  now = Date.now(),
): PublicMeetingPlan {
  return {
    ...newMeetingPlan(id, now),
    title: title.trim() || "Unprepared Teams call",
    profileId: inferProfile(title),
    workspaceId: "default",
    sourceSelection: "selected",
    sourceIds: [],
    sharedLibraryIds: [],
    retainAudio: false,
    inputDevice: "",
  };
}
/** The signed-in account's display name for the `me` lane; undefined (neutral "You") when none is known. */
export function accountSelfName(
  account?: { signedIn?: boolean; user?: { name?: string } },
): string | undefined {
  const name = account?.signedIn ? account.user?.name?.trim() : undefined;
  return name || undefined;
}
export function publicCaptureOptions(
  plan: PublicMeetingPlan,
  captureId: string,
): LocalMeetingOptions {
  return {
    ...meetingOptions(plan),
    id: captureId,
    retainAudio: plan.retainAudio === true,
  };
}
