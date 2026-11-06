import {
  assembleTranscripts,
  type MeetingRecord,
  type SpeechEvent,
} from "@live-interview/core";
export const revisionEvidenceId = (segment: SpeechEvent) =>
  `segment:${segment.segmentId}@${segment.revision}`;
export function synthesisTranscript(record: MeetingRecord) {
  const canonical = assembleTranscripts(record.segments);
  return canonical.source.map((source) => {
    const id = revisionEvidenceId(source);
    const english = canonical.english.find(
      (t) =>
        t.kind === "translation" &&
        t.sourceSegmentId === source.segmentId &&
        t.revision === source.revision,
    );
    return {
      id,
      segmentId: source.segmentId,
      revision: source.revision,
      lane: source.lane,
      language: source.language,
      text: source.text,
      startMs: source.startMs,
      endMs: source.endMs,
      ...(english
        ? {
            english: {
              id: revisionEvidenceId(english),
              text: english.text,
              language: english.language,
              sourceEvidenceId: id,
            },
          }
        : {}),
    };
  });
}
export function synthesisEvidence(record: MeetingRecord, evidenceId: string) {
  return synthesisTranscript(record).find((turn) => turn.id === evidenceId);
}
export function synthesisSegments(record: MeetingRecord) {
  const canonical = assembleTranscripts(record.segments);
  return [
    ...canonical.source,
    ...canonical.english.filter((turn) => turn.kind === "translation"),
  ].sort((a, b) => a.journalSequence - b.journalSequence);
}
