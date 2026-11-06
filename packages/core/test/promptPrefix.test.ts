import { expect, test } from "vitest";
import {
  buildContext,
  createMeetingState,
  reduceMeetingEvent,
  SnapshotStore,
} from "../src/snapshots";
import { createGuidanceJob, guidancePrompt } from "../src/guidance/engine";
import type { AssistanceIntent, MeetingState, SourceHit } from "../src/contracts";

// Consecutive guidance prompts in one meeting must share the longest possible prefix, so a provider's
// prompt cache can serve it: everything up to the newest turn, whatever the intent.
const sources: SourceHit[] = ["pricing", "approvals", "contract"].map((id, n) => ({
  sourceId: id,
  workspaceId: "w",
  kind: "markdown",
  title: `${id}.md`,
  text: `Section ${n}: the ${id} terms say the pilot needs written approval before 1 March.`,
  locator: `${id}.md`,
  revision: 1,
  derived: false,
}));
function say(state: MeetingState, n: number): MeetingState {
  return reduceMeetingEvent(state, {
    kind: "speech",
    event: {
      meetingId: state.id,
      segmentId: `s${n}`,
      revision: 1,
      journalSequence: n,
      lane: n % 2 ? "remote" : "me",
      startMs: n * 4000,
      endMs: n * 4000 + 3000,
      language: "en",
      text: `Turn ${n}: we still need the approval owner and the evidence for the launch.`,
      kind: "final",
    },
  });
}
const shared = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};
/** Where the earlier prompt's transcript array closes: all before it can be shared, nothing after. */
const transcriptClose = (prompt: string) =>
  prompt.indexOf("]\n<<<END UNTRUSTED TRANSCRIPT>>>");

test("consecutive prompts share everything up to the newest turn, across intents and snapshot refreshes", () => {
  let state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Pilot approval",
    objectives: ["Who approves the pilot?"],
    attendees: [],
    profileId: "discovery",
    profileRevision: 0,
  });
  const store = new SnapshotStore();
  for (let n = 1; n <= 41; n++) state = say(state, n);
  // Retrieval returned the sources in a different rank order than the next refresh will.
  const publish = (hits: SourceHit[]) =>
    store.publish(
      {
        snapshotId: crypto.randomUUID(),
        meetingId: state.id,
        context: buildContext(state, hits),
        candidates: [],
        createdAtMs: Date.now(),
        transcriptThroughSequence: state.observationSequence,
      },
      state.segments,
    );
  publish(sources);
  const intents: AssistanceIntent[] = ["respond", "digDeeper", "contribute", "checkObjectives"];
  let previous = guidancePrompt(
    createGuidanceJob("respond", store.read(state), "requested", { recentSuggestions: [] }),
  );
  for (let n = 42; n <= 46; n++) {
    state = say(state, n);
    if (n === 44) publish([...sources].reverse());
    const prompt = guidancePrompt(
      createGuidanceJob(intents[n % intents.length], store.read(state), "requested", {
        recentSuggestions: [`Suggestion ${n}`],
      }),
    );
    // The new turn is appended, so the shared prefix ends exactly where the earlier transcript closed.
    expect(shared(previous, prompt), `turn ${n}`).toBe(transcriptClose(previous));
    expect(transcriptClose(previous) / prompt.length, `turn ${n}`).toBeGreaterThan(0.7);
    previous = prompt;
  }
});

test("the transcript window moves in steps, so most turns do not shift its start", () => {
  let state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Pilot approval",
    objectives: [],
    attendees: [],
    profileId: "interview",
    profileRevision: 0,
  });
  const starts: string[] = [];
  for (let n = 1; n <= 80; n++) {
    state = say(state, n);
    const conversation = buildContext(state, []).conversation;
    expect(conversation.length).toBeGreaterThanOrEqual(Math.min(n, 32));
    expect(conversation.length).toBeLessThan(40);
    starts.push(conversation[0].segmentId);
  }
  // 80 turns, a window of 32 that moves 8 at a time: the first turn shown changes 6 times, not 48.
  expect(new Set(starts).size).toBe(7);
});
