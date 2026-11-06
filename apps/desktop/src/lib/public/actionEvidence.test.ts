import { expect, test } from "vitest";
import { groundNextSteps, type ContextBundle, type NextStep, type SpeechEvent } from "@live-interview/core";
import { describeActionEvidence, groundSavedSteps, staleEvidenceCount, stepsOutdated } from "./actionEvidence";
const event = (over: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  startMs: 0,
  endMs: 1,
  language: "de",
  text: "Wir senden morgen.",
  kind: "final",
  ...over,
});
const corrected = event({ revision: 2, journalSequence: 2, text: "Wir senden nicht." });

test("current revision-qualified evidence shows its text with no warning", () => {
  const view = describeActionEvidence([event({})], "segment:s@1");
  expect(view).toMatchObject({ status: "current", text: "Wir senden morgen." });
  expect(view.note).toBeUndefined();
});

test("evidence cited before a correction is marked stale and shows both texts", () => {
  const view = describeActionEvidence([event({}), corrected], "segment:s@1");
  expect(view.status).toBe("stale");
  expect(view.text).toBe("Wir senden morgen.");
  expect(view.currentText).toBe("Wir senden nicht.");
  expect(view.note).toContain("corrected");
  expect(staleEvidenceCount([view])).toBe(1);
});

test("legacy actions render without rewriting: unambiguous ones are plain, corrected ones are flagged", () => {
  expect(describeActionEvidence([event({})], "segment:s")).toMatchObject({
    status: "current",
    text: "Wir senden morgen.",
  });
  const flagged = describeActionEvidence([event({}), corrected], "segment:s");
  expect(flagged.status).toBe("unversioned");
  expect(flagged.text).toBe("Wir senden nicht.");
  expect(flagged.note).toContain("revisions were recorded");
  expect(staleEvidenceCount([flagged])).toBe(1);
});

test("unknown references and non-transcript sources never claim a revision", () => {
  const missing = describeActionEvidence([event({})], "segment:gone@1");
  expect(missing.status).toBe("missing");
  expect(staleEvidenceCount([missing])).toBe(1);
  expect(describeActionEvidence([event({})], "source:notes").status).toBe("source");
});

const step = (...evidence: string[]) => ({ evidence });
const other = event({ segmentId: "t", journalSequence: 3, text: "Danke." });
const lateTranslation = event({
  segmentId: "s",
  kind: "translation",
  sourceSegmentId: "s",
  language: "en",
  journalSequence: 4,
  text: "We send tomorrow.",
});

test("steps are outdated when a cited segment has a newer revision", () => {
  expect(stepsOutdated([event({}), corrected], [step("segment:s@1")], 1, 2)).toBe(true);
});

test("an unrelated record revision does not outdate steps", () => {
  const segments = [event({}), other, event({ segmentId: "t", revision: 2, journalSequence: 5, text: "Vielen Dank." })];
  expect(stepsOutdated(segments, [step("segment:s@1", "source:notes")], 1, 2)).toBe(false);
  expect(stepsOutdated([event({}), lateTranslation], [step("segment:s@1")], 1, 2)).toBe(false);
});

test("a versioned citation whose segment is no longer in the record outdates the steps, like a changed one", () => {
  expect(stepsOutdated([other], [step("segment:s@1")], 1, 2)).toBe(true);
  expect(stepsOutdated([event({}), other], [step("segment:s@9")], 1, 2)).toBe(true);
  // Nothing about the record changed, so a bad citation alone is not an "earlier version".
  expect(stepsOutdated([other], [step("segment:s@1")], 2, 2)).toBe(false);
});

test("legacy bare citations keep the old rule: any later record revision outdates them", () => {
  expect(stepsOutdated([event({}), other], [step("segment:s")], 1, 2)).toBe(true);
  expect(stepsOutdated([event({}), other], [step("segment:s")], 2, 2)).toBe(false);
});

test("steps with no transcript citations are never outdated", () => {
  expect(stepsOutdated([event({}), corrected], [step("source:notes")], 1, 2)).toBe(false);
});

test("saved steps citing a vanished segment survive grounding and are flagged, not silently dropped", () => {
  const segments = [event({ segmentId: "t", text: "Wir senden morgen." })];
  const context = { conversation: segments, sources: [] } as unknown as ContextBundle;
  const saved = [
    { task: "Send the file", inferred: false, owner: null, due: null, evidence: ["segment:t@1", "segment:gone@1"] },
    { task: "Plain step", inferred: true, owner: null, due: null, evidence: ["segment:t@1"] },
    { task: "Invented", inferred: true, owner: null, due: null, evidence: ["segment:nope"] },
  ];
  // Plain grounding drops the first step: this is what the load path used to do.
  expect(groundNextSteps(saved, context).map((s) => s.task)).toEqual(["Plain step"]);
  const steps = groundSavedSteps<NextStep>(saved, segments, (s) => groundNextSteps(s, context));
  expect(steps.map((s) => s.task)).toEqual(["Send the file", "Plain step"]);
  expect(steps[0].evidence).toEqual(["segment:t@1", "segment:gone@1"]);
  expect(describeActionEvidence(segments, "segment:gone@1").status).toBe("missing");
  expect(stepsOutdated(segments, saved.slice(0, 2), 1, 2)).toBe(true);
});
