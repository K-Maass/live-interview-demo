import { expect, test } from "vitest";
import {
  SnapshotStore,
  createMeetingState,
  reduceMeetingEvent,
  acceptResultBasis,
} from "../src/snapshots";
import type { MeetingOptions, SpeechEvent } from "../src/contracts";
const options: MeetingOptions = {
  id: "m",
  workspaceId: "w",
  purpose: "interview",
  objectives: ["Who approves?"],
  attendees: [],
  profileId: "interview",
  profileRevision: 0,
};
const event = (sequence: number): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s" + sequence,
  revision: 1,
  journalSequence: sequence,
  lane: "remote",
  startMs: 0,
  endMs: 1,
  text: "Business units approve; compliance checks evidence.",
  language: "en",
  kind: "final",
});
test("hotkey reads snapshot, new delta and invalidation synchronously while background work stalls", () => {
  const store = new SnapshotStore();
  let state = createMeetingState(options);
  state = reduceMeetingEvent(state, { kind: "speech", event: event(20) });
  store.initialise(state);
  const snapshot = store.read(state);
  state = reduceMeetingEvent(state, { kind: "speech", event: event(21) });
  state = reduceMeetingEvent(state, { kind: "source", sourceId: "old" });
  const basis = store.read(state);
  expect(basis.snapshot).toEqual(snapshot.snapshot);
  expect(basis.transcriptDeltas.map((e) => e.journalSequence)).toEqual([21]);
  expect(basis.invalidatedSourceIds).toEqual(["old"]);
  expect(basis.observationSequence).toBe(21);
  expect(basis.stateRevision).toBe(state.revision);
  expect(acceptResultBasis(state, snapshot)).toBe(false);
  expect(acceptResultBasis(state, basis)).toBe(true);
});
test("no brief or ready worker required; captured basis is immutable after profile change", () => {
  const state = createMeetingState(options),
    store = new SnapshotStore();
  store.initialise(state);
  const basis = store.read(state);
  expect(basis.snapshot.context.brief).toBeUndefined();
  const newer = reduceMeetingEvent(state, {
    kind: "profile",
    profileId: "workClient",
  });
  expect(basis.profileId).toBe("interview");
  expect(acceptResultBasis(newer, basis)).toBe(false);
});
test("an older partial cannot displace a newer final, and late higher revisions remain explicit deltas", () => {
  let state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Meeting",
    objectives: [],
    attendees: [],
    profileId: "workClient",
    profileRevision: 0,
  });
  const event = {
    meetingId: "m",
    segmentId: "s",
    revision: 2,
    journalSequence: 20,
    lane: "remote" as const,
    startMs: 0,
    endMs: 1,
    language: "en",
    text: "Latest final",
    kind: "final" as const,
  };
  state = reduceMeetingEvent(state, { kind: "speech", event });
  const store = new SnapshotStore();
  store.initialise(state);
  const unchanged = reduceMeetingEvent(state, {
    kind: "speech",
    event: {
      ...event,
      revision: 1,
      journalSequence: 10,
      kind: "partial",
      text: "Old partial",
    },
  });
  expect(unchanged).toBe(state);
  state = reduceMeetingEvent(state, {
    kind: "speech",
    event: {
      ...event,
      revision: 3,
      journalSequence: 19,
      text: "Late correction",
    },
  });
  expect(store.read(state).transcriptDeltas.map((e) => e.text)).toContain(
    "Late correction",
  );
});
