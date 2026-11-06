import type { SpeechEvent } from "./contracts";
import { assembleTranscripts } from "./transcripts";
const pattern = /^segment:(.+?)(?:@(\d+))?$/;
export interface SegmentEvidenceRef {
  segmentId: string;
  /** Absent for legacy references saved before revisions were recorded. */
  revision?: number;
}
export const segmentEvidenceId = (e: Pick<SpeechEvent, "segmentId" | "revision">) =>
  `segment:${e.segmentId}@${e.revision}`;
export function parseSegmentEvidence(id: string): SegmentEvidenceRef | null {
  const m = pattern.exec(id);
  if (!m) return null;
  return m[2] === undefined
    ? { segmentId: m[1] }
    : { segmentId: m[1], revision: Number(m[2]) };
}
/**
 * Events an evidence list cites. A revision-qualified ID cites exactly that
 * revision; a legacy bare ID keeps its old meaning of any revision.
 */
export function citedEvents(
  segments: SpeechEvent[],
  evidence: string[],
): SpeechEvent[] {
  const refs = evidence.flatMap((id) => parseSegmentEvidence(id) ?? []);
  return segments.filter((e) =>
    refs.some(
      (r) =>
        r.segmentId === e.segmentId &&
        (r.revision === undefined || r.revision === e.revision),
    ),
  );
}
/** Rewrites bare IDs in newly generated evidence to the current revision. Other IDs are untouched. */
export function qualifyEvidence(
  evidence: string[],
  segments: SpeechEvent[],
): string[] {
  const current = new Map(
    assembleTranscripts(segments).source.map((e) => [e.segmentId, e]),
  );
  return evidence.map((id) => {
    const ref = parseSegmentEvidence(id);
    const event = ref && ref.revision === undefined && current.get(ref.segmentId);
    return event ? segmentEvidenceId(event) : id;
  });
}
export type EvidenceStatus =
  /** The cited revision is the current transcript. */
  | "current"
  /** The source was corrected after the cited revision. */
  | "stale"
  /** A legacy reference with no revision to a segment that was later corrected; the current text is shown, unverified. */
  | "unversioned"
  /** The record has no such segment or revision. */
  | "missing";
export interface EvidenceResolution {
  status: EvidenceStatus;
  /** The revision that was cited (absent for unversioned and missing references). */
  cited?: SpeechEvent;
  /** The current source revision of the same segment. */
  current?: SpeechEvent;
}
export function resolveSegmentEvidence(
  segments: SpeechEvent[],
  id: string,
): EvidenceResolution {
  const ref = parseSegmentEvidence(id);
  if (!ref) return { status: "missing" };
  const source = assembleTranscripts(segments).source;
  const own = segments.filter((e) => e.segmentId === ref.segmentId);
  // A cited translation stands for the source revision it translates.
  const sourceId = own.find((e) => e.kind === "translation")?.sourceSegmentId;
  const current = source.find((e) => e.segmentId === (sourceId ?? ref.segmentId));
  if (ref.revision === undefined) {
    if (!current) return { status: "missing" };
    // Revisions only ever append, so a never-corrected segment can only have meant this text.
    const revisions = new Set(
      segments
        .filter((e) => e.kind === "final" && e.segmentId === current.segmentId)
        .map((e) => e.revision),
    );
    return revisions.size > 1
      ? { status: "unversioned", current }
      : { status: "current", cited: current, current };
  }
  const cited = own.find(
    (e) => e.revision === ref.revision && e.kind !== "partial",
  );
  if (!cited || !current) return { status: "missing" };
  const stale = current.revision > cited.revision;
  const shown =
    cited.kind === "translation"
      ? (segments.find(
          (e) =>
            e.segmentId === cited.sourceSegmentId &&
            e.revision === cited.revision &&
            e.kind === "final",
        ) ?? cited)
      : cited;
  return { status: stale ? "stale" : "current", cited: shown, current };
}
