import { expect, test } from "vitest";
import { assembleTranscripts, liveTranscriptEntries } from "../src/transcripts";
import type { SpeechEvent } from "../src/contracts";
const source: SpeechEvent = {
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  startMs: 0,
  endMs: 1000,
  language: "de",
  text: "Compliance prüft die Nachweise.",
  kind: "final",
};
test("preserves German evidence, remote provenance and pending translation", () => {
  const pair = assembleTranscripts([source, source]);
  expect(pair.source).toEqual([source]);
  expect(pair.status).toBe("pending");
  expect(pair.english).toEqual([]);
});
test("live entries are newest-first by spoken time while saved order and late translation placement stay chronological", () => {
  const later: SpeechEvent = {
    ...source,
    segmentId: "later",
    startMs: 2000,
    endMs: 3000,
    language: "en",
    text: "Later words",
    journalSequence: 2,
  };
  const translated: SpeechEvent = {
    ...source,
    segmentId: "s:en",
    sourceSegmentId: "s",
    language: "en",
    text: "Earlier words translated later",
    kind: "translation",
    journalSequence: 3,
  };
  const events = [later, source, translated];
  expect(liveTranscriptEntries(events, true).map((e) => e.segmentId)).toEqual([
    "later",
    "s:en",
  ]);
  expect(liveTranscriptEntries(events, false).map((e) => e.segmentId)).toEqual([
    "later",
    "s",
  ]);
  expect(assembleTranscripts(events).source.map((e) => e.segmentId)).toEqual([
    "s",
    "later",
  ]);
  expect(events.map((e) => e.segmentId)).toEqual(["later", "s", "s:en"]);
});
test("translation is linked to latest source revision; old translation cannot replace revised source", () => {
  const translated: SpeechEvent = {
    ...source,
    segmentId: "s:en",
    sourceSegmentId: "s",
    language: "en",
    text: "Compliance reviews the evidence.",
    kind: "translation",
    journalSequence: 2,
  };
  expect(assembleTranscripts([source, translated]).status).toBe("complete");
  expect(
    assembleTranscripts([
      source,
      translated,
      { ...source, revision: 2, text: "Compliance entscheidet." },
    ]).status,
  ).toBe("pending");
});
test("English passes through; orphan translations are excluded", () => {
  expect(
    assembleTranscripts([
      { ...source, language: "en" },
      {
        ...source,
        segmentId: "t",
        sourceSegmentId: "missing",
        kind: "translation",
      },
    ]).english,
  ).toHaveLength(1);
});
test("revised final wins over newer stale partial and English translations remain ordered", () => {
  const final = {
    ...source,
    revision: 2,
    kind: "final" as const,
    journalSequence: 3,
  };
  const partial = {
    ...source,
    revision: 1,
    kind: "partial" as const,
    journalSequence: 4,
  };
  expect(assembleTranscripts([final, partial]).source[0].revision).toBe(2);
});
