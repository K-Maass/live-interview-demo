import type { SpeechEvent } from "@live-interview/core";
export function routeSpeech(
  event: SpeechEvent,
  active: { ingest: (e: SpeechEvent) => void } | undefined,
  displayedId: string | undefined,
  show: (event: SpeechEvent) => void,
) {
  active?.ingest(event);
  if (!displayedId || displayedId === event.meetingId) show(event);
}
export function finalizationTargets(
  eventId: string,
  activeId: string | undefined,
  viewedId: string | undefined,
) {
  return {
    refreshRecordId: eventId,
    replaceRuntime: false,
    refreshVisibleTranscript: eventId === viewedId && eventId !== activeId,
  };
}
