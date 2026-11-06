import type { SpeechEvent } from "@live-interview/core";
import { transcriptOf } from "../liveStore";

export interface ConversationLine {
  segmentId: string;
  lane: SpeechEvent["lane"];
  /** Spoken language of `text`. */
  language: string;
  /** What was said, in the language it was said in (the evidence). */
  text: string;
  /** English translation of a non-English line, once it exists. Absent for English lines and while translation is pending. */
  english?: string;
}

/**
 * The live page's Conversation rail: the newest `limit` lines, newest first. Each line keeps its source-language text
 * and, for a non-English line, the English translation beside it, so the evidence is never replaced by the translation
 * and a line without a translation yet is never dropped.
 */
export function conversationLines(events: SpeechEvent[], limit = 6): ConversationLine[] {
  const transcript = transcriptOf(events);
  // Only the newest `limit` lines, without copying the whole transcript; their translations are looked up by id.
  const newest = transcript.source.slice(Math.max(0, transcript.source.length - Math.max(0, limit))).reverse();
  const wanted = new Set(newest.filter((line) => line.language !== "en").map((line) => line.segmentId));
  const translated = new Map<string, string>();
  for (const t of transcript.english) if (t.sourceSegmentId !== undefined && wanted.has(t.sourceSegmentId) && !translated.has(t.sourceSegmentId)) translated.set(t.sourceSegmentId, t.text);
  return newest.map((line) => {
    const english = line.language === "en" ? undefined : translated.get(line.segmentId);
    return { segmentId: line.segmentId, lane: line.lane, language: line.language, text: line.text, ...(english ? { english } : {}) };
  });
}
