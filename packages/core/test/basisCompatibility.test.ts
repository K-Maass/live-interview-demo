import { expect, test } from "vitest";
import {
  basisCompatibility,
  createMeetingState,
  materialAppend,
  reduceMeetingEvent,
  SnapshotStore,
} from "../src/snapshots";
import type { MeetingState, SourceHit, SpeechEvent } from "../src/contracts";

const turn = (n: number, extra: Partial<SpeechEvent> = {}): SpeechEvent => ({
  meetingId: "m",
  segmentId: `s${n}`,
  revision: 1,
  journalSequence: n,
  lane: "remote",
  startMs: n * 1000,
  endMs: n * 1000 + 900,
  language: "de",
  text: `Wir brauchen die Freigabe ${n} vor dem Start.`,
  kind: "final",
  ...extra,
});
const policy: SourceHit = {
  sourceId: "policy",
  workspaceId: "w",
  kind: "markdown",
  title: "Policy",
  text: "Approval requires evidence.",
  locator: "policy.md",
  revision: 1,
  derived: false,
};
function meeting() {
  let state: MeetingState = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Approval",
    objectives: ["Who approves?"],
    attendees: [],
    profileId: "interview",
    profileRevision: 0,
  });
  const store = new SnapshotStore();
  const say = (e: SpeechEvent) => (state = reduceMeetingEvent(state, { kind: "speech", event: e }));
  say(turn(1));
  say({ ...turn(2), segmentId: "s1:en", kind: "translation", sourceSegmentId: "s1", language: "en", text: "We need approval 1 before launch." });
  store.publish(
    {
      snapshotId: "a",
      meetingId: "m",
      context: { ...store.read(state).snapshot.context, sources: [policy], conversation: state.segments, sourceRevisions: { policy: 1 } },
      candidates: [],
      createdAtMs: 0,
      transcriptThroughSequence: state.observationSequence,
    },
    state.segments,
  );
  return { store, say, get state() { return state; } };
}

test("appended turns are compatible and reported; a short or partial turn is not material", () => {
  const m = meeting();
  const earlier = m.store.read(m.state);
  m.say(turn(3, { lane: "me", text: "Okay." }));
  const fit = basisCompatibility(earlier, m.store.read(m.state), ["segment:s1:en", "policy"]);
  expect(fit.compatible).toBe(true);
  expect(fit.appended.map((e) => e.segmentId)).toEqual(["s3"]);
  expect(materialAppend(fit.appended)).toBe(false);
  m.say(turn(4, { kind: "partial" }));
  expect(materialAppend(basisCompatibility(earlier, m.store.read(m.state), []).appended)).toBe(false);
  m.say(turn(4));
  expect(materialAppend(basisCompatibility(earlier, m.store.read(m.state), []).appended)).toBe(true);
});

test("a corrected source turn makes a cited translation of it stale; an uncited correction does not", () => {
  const m = meeting();
  const earlier = m.store.read(m.state);
  m.say(turn(1, { revision: 2, journalSequence: 3, text: "Wir brauchen keine Freigabe." }));
  const now = m.store.read(m.state);
  expect(basisCompatibility(earlier, now, ["segment:s1:en"])).toMatchObject({ compatible: false, reason: "citedSegment" });
  expect(basisCompatibility(earlier, now, ["segment:s1"])).toMatchObject({ compatible: false, reason: "citedSegment" });
  expect(basisCompatibility(earlier, now, ["policy"]).compatible).toBe(true);
});

test("an invalidated or revised source withholds, cited or not; a profile or objective change withholds", () => {
  const m = meeting();
  const earlier = m.store.read(m.state);
  const invalidated = structuredClone(m.store.read(m.state));
  invalidated.invalidatedSourceIds = ["policy"];
  expect(basisCompatibility(earlier, invalidated, [])).toMatchObject({ compatible: false, reason: "source" });
  const revised = structuredClone(earlier);
  revised.snapshot.context.sources = [{ ...policy, revision: 2 }];
  expect(basisCompatibility(earlier, revised, [])).toMatchObject({ compatible: false, reason: "source" });
  const profile = structuredClone(earlier);
  profile.profileRevision++;
  expect(basisCompatibility(earlier, profile, [])).toMatchObject({ compatible: false, reason: "profile" });
  const direction = structuredClone(earlier);
  direction.snapshot.context.objectives = ["Who pays?"];
  expect(basisCompatibility(earlier, direction, [])).toMatchObject({ compatible: false, reason: "direction" });
  // A new retrieval hit, or a re-written derived summary that is not cited, is only the meeting moving on.
  const added = structuredClone(earlier);
  added.snapshot.context.sources.push({ ...policy, sourceId: "faq" });
  expect(basisCompatibility(earlier, added, ["policy"]).compatible).toBe(true);
  const summary = { ...policy, sourceId: "summary:m", derived: true, kind: "conversation-summary" as const };
  const withSummary = structuredClone(earlier);
  withSummary.snapshot.context.sources.push(summary);
  const resummarised = structuredClone(withSummary);
  resummarised.snapshot.context.sources[1] = { ...summary, revision: 2 };
  expect(basisCompatibility(withSummary, resummarised, ["policy"]).compatible).toBe(true);
  expect(basisCompatibility(withSummary, resummarised, ["summary:m"]).compatible).toBe(false);
});

test("a cited turn revised and then pushed out of the transcript window still withholds", () => {
  const m = meeting();
  const earlier = m.store.read(m.state);
  m.say(turn(1, { revision: 2, journalSequence: 3, text: "Wir brauchen keine Freigabe." }));
  for (let n = 4; n < 40; n++) m.say(turn(n));
  m.store.publish(
    {
      snapshotId: "b",
      meetingId: "m",
      context: { ...m.store.read(m.state).snapshot.context, conversation: m.state.segments.slice(-32), sources: [policy] },
      candidates: [],
      createdAtMs: 1,
      transcriptThroughSequence: m.state.observationSequence,
    },
    m.state.segments,
  );
  const now = m.store.read(m.state);
  // The revised turn is no longer in the current read at all.
  expect([...now.snapshot.context.conversation, ...now.transcriptDeltas].some((e) => e.segmentId === "s1")).toBe(false);
  expect(basisCompatibility(earlier, now, ["segment:s1"], m.state.segments)).toMatchObject({ compatible: false, reason: "citedSegment" });
  expect(basisCompatibility(earlier, now, ["segment:s1:en"], m.state.segments).compatible).toBe(false);
  // Without the full transcript a cited turn that cannot be found is not assumed unchanged.
  expect(basisCompatibility(earlier, now, ["segment:s1"]).compatible).toBe(false);
  // An unrevised cited turn outside the window is fine when the full transcript says so.
  const unrevised = meeting();
  const before = unrevised.store.read(unrevised.state);
  for (let n = 4; n < 40; n++) unrevised.say(turn(n));
  expect(basisCompatibility(before, unrevised.store.read(unrevised.state), ["segment:s1"], unrevised.state.segments).compatible).toBe(true);
});
