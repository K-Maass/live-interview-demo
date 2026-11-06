import { test, expect } from "vitest";
import { createMeetingState, SnapshotStore, createGuidanceJob, parseCard } from "@live-interview/core";
import { previewSuggestions } from "../../src/copilot/dev/installPreview";

test("all normal preview recommendations pass the unchanged live evidence validator", () => {
  const state = createMeetingState({ id: "fixture", workspaceId: "fixture", purpose: "Discovery", objectives: [], attendees: [] });
  state.segments = [{ meetingId: "fixture", segmentId: "remote-de", revision: 1, journalSequence: 1, lane: "remote", startMs: 0, endMs: 1000, language: "en", text: "The project team decides when to launch.", kind: "final" }];
  const store = new SnapshotStore(); store.initialise(state);
  const job = createGuidanceJob("digDeeper", store.read(state), "requested");
  for (const suggestion of previewSuggestions) {
    expect(parseCard({ ...suggestion, why: "Clarify the handoff.", evidence: ["segment:remote-de"], usefulness: .99, relevance: .99, novelty: .99, answerQuality: .99, uncertain: true }, job), suggestion.headline).toBeDefined();
  }
});
