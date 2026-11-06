import { expect, test } from "vitest";
import { applyHistorySummary } from "../src/historyState";
import {
  createMeetingState,
  reduceMeetingEvent,
  buildContext,
} from "../src/snapshots";
import type { SpeechEvent } from "../src/contracts";
const event = (n: number): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s" + n,
  revision: 1,
  journalSequence: n,
  lane: "remote",
  startMs: n,
  endMs: n + 1,
  language: "en",
  text: "Relevant evidence " + n,
  kind: "final",
});
test("summary retains explicit source revision evidence while recent context is bounded", () => {
  let state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Interview",
    objectives: [],
    attendees: [],
    profileId: "interview",
    profileRevision: 0,
  });
  for (let n = 1; n <= 150; n++)
    state = reduceMeetingEvent(state, { kind: "speech", event: event(n) });
  state = applyHistorySummary(state, {
    text: "Early decision ownership remains unresolved.",
    evidence: [{ segmentId: "s1", revision: 1 }],
    throughSequence: 120,
    revision: 1,
  });
  const context = buildContext(state, []);
  expect(context.conversation.length).toBeLessThanOrEqual(128);
  expect(
    context.sources.some((s) => s.derived && s.text.includes("ownership")),
  ).toBe(true);
  expect(() =>
    applyHistorySummary(state, {
      text: "Invented",
      evidence: [{ segmentId: "missing", revision: 1 }],
      throughSequence: 120,
      revision: 2,
    }),
  ).toThrow();
});
test("correcting old evidence invalidates its derived summary and snapshot source", () => {
  let state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Interview",
    objectives: [],
    attendees: [],
    profileId: "interview",
    profileRevision: 0,
  });
  state = reduceMeetingEvent(state, { kind: "speech", event: event(1) });
  state = applyHistorySummary(state, {
    text: "Prior conclusion",
    evidence: [{ segmentId: "s1", revision: 1 }],
    throughSequence: 1,
    revision: 1,
  });
  expect(buildContext(state, []).sourceRevisions["summary:m"]).toBe(1);
  state = reduceMeetingEvent(state, {
    kind: "speech",
    event: {
      ...event(1),
      revision: 2,
      journalSequence: 2,
      text: "Corrected conclusion",
    },
  });
  expect(state.historySummary).toBeUndefined();
  expect(state.invalidatedSourceIds).toContain("summary:m");
});
