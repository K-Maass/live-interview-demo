import type { SpeechEvent } from "./contracts";
/** Live ordering only; canonical records and linked translation timing are unchanged. */
export function liveTranscriptEntries(events: SpeechEvent[], english: boolean) {
  const transcript = assembleTranscripts(events);
  return [...(english ? transcript.english : transcript.source)].reverse();
}
export function assembleTranscripts(events: SpeechEvent[]) {
  const sources = new Map<string, SpeechEvent>(),
    translations = new Map<string, SpeechEvent>();
  for (const event of events) {
    const map = event.kind === "translation" ? translations : sources;
    const old = map.get(event.segmentId);
    if (
      !old ||
      event.revision > old.revision ||
      (event.revision === old.revision &&
        event.journalSequence >= old.journalSequence)
    )
      map.set(event.segmentId, event);
  }
  const source = [...sources.values()]
    .filter((e) => e.kind === "final")
    .sort((a, b) => a.startMs - b.startMs);
  // Translations indexed by the line they translate, each list kept in the map's insertion order, so the first match
  // is the same one a scan of every translation would find; one pass instead of a scan per source line (#U4).
  const bySource = new Map<string, SpeechEvent[]>();
  for (const t of translations.values()) {
    if (t.sourceSegmentId === undefined) continue;
    const list = bySource.get(t.sourceSegmentId);
    if (list) list.push(t);
    else bySource.set(t.sourceSegmentId, [t]);
  }
  const english = source.flatMap((e) => {
    if (e.language === "en") return [e];
    const t = bySource
      .get(e.segmentId)
      ?.find(
        (t) =>
          t.revision === e.revision &&
          t.lane === e.lane &&
          t.language === "en",
      );
    return t ? [t] : [];
  });
  return {
    source,
    english,
    status:
      english.length === source.length
        ? ("complete" as const)
        : ("pending" as const),
  };
}
