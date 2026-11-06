import { expect, test } from "vitest";
import type { SpeechEvent } from "@live-interview/core";
import { conversationLines } from "./conversation";

const base = { meetingId: "m", revision: 1, endMs: 0 };
const events = [
  { ...base, segmentId: "me-1", journalSequence: 1, lane: "me", startMs: 0, language: "en", text: "How does a pilot move into everyday use?", kind: "final" },
  { ...base, segmentId: "de-1", journalSequence: 2, lane: "remote", startMs: 1000, language: "de", text: "Das Projektteam entscheidet.", kind: "final" },
  { ...base, segmentId: "de-1-en", sourceSegmentId: "de-1", journalSequence: 3, lane: "remote", startMs: 1000, language: "en", text: "The project team decides.", kind: "translation" },
  { ...base, segmentId: "de-2", journalSequence: 4, lane: "remote", startMs: 2000, language: "de", text: "Noch nicht übersetzt.", kind: "final" },
] as SpeechEvent[];

test("non-English lines keep the source text with the English translation beside it, newest first", () => {
  expect(conversationLines(events)).toEqual([
    { segmentId: "de-2", lane: "remote", language: "de", text: "Noch nicht übersetzt." },
    { segmentId: "de-1", lane: "remote", language: "de", text: "Das Projektteam entscheidet.", english: "The project team decides." },
    { segmentId: "me-1", lane: "me", language: "en", text: "How does a pilot move into everyday use?" },
  ]);
});

test("keeps only the newest lines", () => {
  expect(conversationLines(events, 1).map((l) => l.segmentId)).toEqual(["de-2"]);
});
