/** How far local processing of a saved record got, for the meeting lists and the record page. */
export type ProcessingState = "pending" | "translationUnavailable" | "complete";

/**
 * `translationStatus` is "pending", "complete" or "unavailable" (no English could be made; the source text is kept).
 * Anything still waiting (status pending or segments left) is pending; only an explicit "complete" is complete, so a
 * new status is never shown as done.
 */
export function processingState(record: { translationStatus: string; pendingSegments?: number }): ProcessingState {
  if (record.translationStatus === "pending" || (record.pendingSegments ?? 0) > 0) return "pending";
  return record.translationStatus === "complete" ? "complete" : "translationUnavailable";
}

export const processingLabel: Record<ProcessingState, string> = {
  pending: "Processing pending",
  translationUnavailable: "Translation unavailable",
  complete: "Complete",
};

/** Plain text classes: muted for pending and unavailable, the accent only for complete. */
export const processingClass: Record<ProcessingState, string> = {
  pending: "pending-status",
  translationUnavailable: "pending-status",
  complete: "complete-status",
};
