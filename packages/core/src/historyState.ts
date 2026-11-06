import type { MeetingState } from "./contracts";
export interface HistorySummary {
  text: string;
  evidence: { segmentId: string; revision: number }[];
  throughSequence: number;
  revision: number;
}
export function applyHistorySummary(
  state: MeetingState,
  summary: HistorySummary,
): MeetingState {
  if (
    !summary.text.trim() ||
    summary.text.length > 5000 ||
    summary.evidence.some(
      (ref) =>
        !state.segments.some(
          (e) =>
            e.segmentId === ref.segmentId &&
            e.revision === ref.revision &&
            e.kind === "final",
        ),
    )
  )
    throw new Error("unsupportedSummaryEvidence");
  return {
    ...state,
    historySummary: structuredClone(summary),
    revision: state.revision + 1,
  };
}
export const historySchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    coveredObjectives: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "evidence", "coveredObjectives"],
  additionalProperties: false,
};
