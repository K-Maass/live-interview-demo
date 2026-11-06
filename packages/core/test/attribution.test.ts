import { expect, test } from "vitest";
import { createMeetingState } from "../src/snapshots";
import type { PersonId, SpeakerClusterId } from "../src/contracts";
const person = "Lisa-1" as PersonId,
  cluster = "remoteSpeaker2" as SpeakerClusterId;
const state = createMeetingState({
  id: "m",
  workspaceId: "w",
  purpose: "Interview",
  objectives: [],
  attendees: [{ id: person, name: "Lisa" }],
  profileId: "interview",
  profileRevision: 0,
});
import { buildContext, SnapshotStore } from "../src/snapshots";
import { parseCard, cardSchema } from "../src/guidance/engine";
import type { ModelJob } from "../src/contracts";
test("anonymous remote citations cannot support a named commitment in guidance or owners", () => {
  const anonymous = {
    ...state,
    segments: [
      {
        meetingId: "m",
        segmentId: "remote",
        revision: 1,
        journalSequence: 1,
        lane: "remote" as const,
        speakerClusterId: cluster,
        startMs: 0,
        endMs: 1,
        language: "en",
        text: "We will send the draft tomorrow",
        kind: "final" as const,
      },
    ],
  };
  const store = new SnapshotStore();
  store.initialise(anonymous);
  const job: ModelJob = {
    id: "j",
    meetingId: "m",
    lane: "fast",
    intent: "contribute",
    trigger: "requested",
    basis: store.read(anonymous),
    outputSchema: cardSchema,
    deadlineMs: 0,
    toolBudget: 0,
  };
  expect(
    parseCard(
      {
        say: "Lisa committed to sending the draft.",
        why: "Lisa said it",
        evidence: ["segment:remote"],
        usefulness: 1,
        relevance: 1,
        novelty: 1,
        answerQuality: 1,
        uncertain: false,
      },
      job,
    ),
  ).toBeUndefined();
});
import { supportedOwner, namedClaimsSupported } from "../src/claimAttribution";
test("lowercase or unfamiliar ownership claims do not bypass binding checks", () => {
  const context = {
    purpose: "Meeting",
    objectives: [],
    conversation: [],
    sources: [],
    stateRevision: 1,
    indexRevision: 0,
    briefRevision: 0,
    sourceRevisions: {},
    participants: [{ id: "p" as never, name: "Lisa" }],
    attributions: [],
  };
  expect(supportedOwner("lisa", context, [])).toBeNull();
  expect(supportedOwner("unidentified person", context, [])).toBeNull();
  expect(namedClaimsSupported("lisa promised delivery", context, [])).toBe(
    false,
  );
});
