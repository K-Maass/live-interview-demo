import {
  resolveSegmentEvidence,
  type EvidenceStatus,
  type SpeechEvent,
} from "@live-interview/core";
export interface ActionEvidenceView {
  id: string;
  status: EvidenceStatus | "source";
  /** What the action rested on: the cited revision, or the current text for legacy references. */
  text?: string;
  /** Plain-language marker; absent when the citation is current. */
  note?: string;
  /** The corrected text, shown only beside a stale citation. */
  currentText?: string;
}
export function describeActionEvidence(
  segments: SpeechEvent[],
  id: string,
): ActionEvidenceView {
  if (!id.startsWith("segment:")) return { id, status: "source" };
  const { status, cited, current } = resolveSegmentEvidence(segments, id);
  switch (status) {
    case "current":
      return { id, status, text: cited?.text };
    case "stale":
      return {
        id,
        status,
        text: cited?.text,
        currentText: current?.text,
        note: `The source was corrected after this action was created (now revision ${current?.revision}). Regenerate to re-check the action.`,
      };
    case "unversioned":
      return {
        id,
        status,
        text: current?.text,
        note: "Saved before revisions were recorded; this is the current transcript, which may differ from what the action was based on.",
      };
    default:
      return {
        id,
        status,
        note: "This reference does not match the saved record. Regenerate to ground it again.",
      };
  }
}
export const staleEvidenceCount = (views: ActionEvidenceView[]) =>
  views.filter((v) => v.status === "stale" || v.status === "unversioned" || v.status === "missing").length;
/**
 * Whether saved steps should be treated as out of date. A later record revision
 * alone is not enough: only a cited segment with a newer revision, or a versioned
 * citation that no longer resolves to the record, counts. Legacy
 * bare `segment:ID` citations cannot be checked, so they keep the old rule and
 * any later record revision flags them.
 */
export function stepsOutdated(
  segments: SpeechEvent[],
  steps: { evidence: string[] }[],
  savedRevision: number,
  currentRevision: number,
): boolean {
  if (savedRevision === currentRevision) return false;
  return steps.some((s) =>
    s.evidence.some(
      (id) =>
        id.startsWith("segment:") &&
        (!id.includes("@") || ["stale", "missing"].includes(describeActionEvidence(segments, id).status)),
    ),
  );
}

const isMissingVersioned = (segments: SpeechEvent[], id: string) =>
  id.startsWith("segment:") && id.includes("@") && describeActionEvidence(segments, id).status === "missing";

/**
 * Re-ground saved steps for display. Grounding drops any step that cites an ID
 * absent from the record, which would make a step with a vanished source disappear
 * instead of showing the earlier-version warning. So a versioned citation that no
 * longer resolves is set aside for the grounding check and put back afterwards;
 * every other check still applies, and `describeActionEvidence` flags the gap.
 */
export function groundSavedSteps<T extends { evidence: string[] }>(
  saved: unknown[],
  segments: SpeechEvent[],
  ground: (steps: T[]) => T[],
): T[] {
  return saved.flatMap((raw) => {
    const step = raw as T | null;
    if (!step || !Array.isArray(step.evidence)) return ground([raw as T]);
    const present = step.evidence.filter((id) => typeof id !== "string" || !isMissingVersioned(segments, id));
    return ground([{ ...step, evidence: present }]).map((g) => ({ ...g, evidence: step.evidence }));
  });
}
