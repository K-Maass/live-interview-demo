import { expect, test } from "vitest";
import type { ContextBundle, SpeechEvent } from "../src/contracts";
import {
  citedEvents,
  parseSegmentEvidence,
  qualifyEvidence,
  resolveSegmentEvidence,
} from "../src/evidence";
import { groundNextSteps } from "../src/nextSteps";
const event = (over: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  startMs: 0,
  endMs: 1,
  language: "en",
  text: "We will send the evidence tomorrow.",
  kind: "final",
  ...over,
});
const original = event({});
const corrected = event({
  revision: 2,
  journalSequence: 3,
  text: "We will not send the evidence.",
});
const german = event({
  segmentId: "de",
  language: "de",
  text: "Wir senden es morgen.",
  journalSequence: 2,
});
const translation = event({
  segmentId: "de-en",
  sourceSegmentId: "de",
  kind: "translation",
  text: "We send it tomorrow.",
  journalSequence: 4,
});
const context = (conversation: SpeechEvent[]): ContextBundle => ({
  purpose: "Meeting",
  objectives: [],
  conversation,
  sources: [],
  stateRevision: 0,
  indexRevision: 0,
  briefRevision: 0,
  sourceRevisions: {},
  participants: [],
  attributions: [],
});
const step = (evidence: string[]) => ({
  task: "Send the evidence pack.",
  inferred: true,
  owner: null,
  due: null,
  evidence,
});

test("parses revision-qualified and legacy segment references", () => {
  expect(parseSegmentEvidence("segment:s@2")).toEqual({
    segmentId: "s",
    revision: 2,
  });
  expect(parseSegmentEvidence("segment:s")).toEqual({ segmentId: "s" });
  expect(parseSegmentEvidence("segment:a-b@x")).toEqual({ segmentId: "a-b@x" });
  expect(parseSegmentEvidence("source:doc")).toBeNull();
});

test("new evidence resolves as current and keeps the exact revision", () => {
  const segments = [original, german, translation];
  expect(resolveSegmentEvidence(segments, "segment:s@1")).toMatchObject({
    status: "current",
    cited: { revision: 1 },
  });
  // A cited English translation stands for its source-language turn.
  expect(resolveSegmentEvidence(segments, "segment:de-en@1")).toMatchObject({
    status: "current",
    cited: { segmentId: "de", language: "de" },
  });
});

test("a corrected source marks earlier revisions stale and still shows what they said", () => {
  const segments = [original, corrected];
  const stale = resolveSegmentEvidence(segments, "segment:s@1");
  expect(stale.status).toBe("stale");
  expect(stale.cited?.text).toBe("We will send the evidence tomorrow.");
  expect(stale.current?.text).toBe("We will not send the evidence.");
  expect(resolveSegmentEvidence(segments, "segment:s@2").status).toBe("current");
  expect(resolveSegmentEvidence(segments, "segment:s@9").status).toBe("missing");
  expect(resolveSegmentEvidence(segments, "segment:nope@1").status).toBe("missing");
});

test("a legacy bare reference to a never-corrected segment resolves as current", () => {
  expect(resolveSegmentEvidence([original], "segment:s")).toMatchObject({
    status: "current",
    cited: { revision: 1 },
  });
});

test("a legacy bare reference to a corrected segment stays readable but is never presented as current", () => {
  const resolved = resolveSegmentEvidence([original, corrected], "segment:s");
  expect(resolved.status).toBe("unversioned");
  expect(resolved.current?.revision).toBe(2);
  expect(resolved.cited).toBeUndefined();
});

test("a legacy bare citation of a translation follows the corrected source", () => {
  const segments = [
    german,
    event({ segmentId: "de", revision: 2, journalSequence: 5, language: "de", text: "Wir senden nicht." }),
    translation,
  ];
  expect(resolveSegmentEvidence(segments, "segment:de-en").status).toBe("unversioned");
  expect(resolveSegmentEvidence([german, translation], "segment:de-en").status).toBe("current");
});

test("new steps may cite only the current revision, qualified", () => {
  const ctx = context([original, corrected]);
  expect(
    groundNextSteps([step(["segment:s@2"])], ctx, { currentOnly: true }),
  ).toHaveLength(1);
  expect(
    groundNextSteps([step(["segment:s@1"])], ctx, { currentOnly: true }),
  ).toHaveLength(0);
  expect(
    groundNextSteps([step(["segment:s"])], ctx, { currentOnly: true }),
  ).toHaveLength(0);
  expect(
    qualifyEvidence(["segment:s", "segment:s@1", "source:x"], ctx.conversation),
  ).toEqual(["segment:s@2", "segment:s@1", "source:x"]);
  expect(
    groundNextSteps(
      [step(qualifyEvidence(["segment:s"], ctx.conversation))],
      ctx,
      { currentOnly: true },
    )[0].evidence,
  ).toEqual(["segment:s@2"]);
});

test("saved steps keep their cited revision and legacy references re-ground unchanged", () => {
  const ctx = context([original, corrected]);
  const saved = groundNextSteps(
    [step(["segment:s@1"]), step(["segment:s"])],
    ctx,
  );
  expect(saved.map((s) => s.evidence)).toEqual([["segment:s@1"], ["segment:s"]]);
  expect(groundNextSteps([step(["segment:s@7"])], ctx)).toHaveLength(0);
});

test("a revision-qualified citation attributes only to that revision", () => {
  const segments = [
    event({ lane: "me" }),
    event({ revision: 2, journalSequence: 2, lane: "remote" }),
  ];
  expect(citedEvents(segments, ["segment:s@1"]).map((e) => e.lane)).toEqual([
    "me",
  ]);
  expect(citedEvents(segments, ["segment:s"])).toHaveLength(2);
  const ctx = { ...context(segments), selfName: "Priya Nair" };
  const owned = { ...step(["segment:s@1"]), owner: "Priya Nair" };
  expect(groundNextSteps([owned], ctx)[0].owner).toBe("Priya Nair");
  expect(
    groundNextSteps([{ ...owned, evidence: ["segment:s@2"] }], ctx)[0].owner,
  ).toBeNull();
});
