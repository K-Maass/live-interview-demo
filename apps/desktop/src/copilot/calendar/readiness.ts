// Brief readiness of a calendar item, as a tone for styling and plain words for people (moved out of MeetingsPage, #123).
//
//   readinessFor(id, plans, enabled) -> { tone, text }
//     tone: 'ready' (accent) | 'draft' (blue) | 'none' (outlined grey) | 'unsynced' (dashed, "Only in this app")
//
// The plan saved for an event decides it. Plan rows made in the app ("plan:" ids) are always 'unsynced'. When the
// public product is not enabled there are no plans, so every event reads "No brief".
import type { PublicMeetingPlan } from "@live-interview/core";
import { isPlanRow } from "../../lib/public/calendarSave";

export type Readiness = "ready" | "draft" | "none" | "unsynced";

export function readinessFor(id: string, plans: Pick<PublicMeetingPlan, "eventId" | "status" | "automaticPreparation">[], enabled: boolean): { tone: Readiness; text: string } {
  if (isPlanRow(id)) return { tone: "unsynced", text: "Only in this app" };
  const plan = enabled ? plans.find((p) => p.eventId === id) : undefined;
  if (plan?.status === "prepared") return { tone: "ready", text: "Brief ready" };
  if (plan?.automaticPreparation) return { tone: "draft", text: "Auto-prep on" };
  if (plan) return { tone: "draft", text: "Plan started" };
  return { tone: "none", text: "No brief" };
}
