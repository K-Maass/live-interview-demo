import { expect, test, vi } from "vitest";
import type { MeetingRecord, SpeechEvent } from "@live-interview/core";
const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: boundary.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
import { generateSynthesis } from "./reasoning";
import { synthesisTranscript, synthesisEvidence } from "./transcript";
const segment = (patch: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "record",
  segmentId: "de",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  language: "de",
  text: "obsolete source",
  kind: "final",
  startMs: 0,
  endMs: 1000,
  ...patch,
});
const record: MeetingRecord = {
  id: "record",
  workspaceId: "default",
  purpose: "Approval",
  objectives: [],
  attendees: [],
  profileId: "workClient",
  profileRevision: 0,
  date: "2026-10-11",
  revision: 7,
  segments: [
    segment({}),
    segment({
      revision: 2,
      journalSequence: 3,
      text: "Wir starten noch nicht.",
    }),
    segment({
      segmentId: "en-old",
      sourceSegmentId: "de",
      language: "en",
      kind: "translation",
      text: "obsolete translation",
    }),
    segment({
      segmentId: "en-current",
      sourceSegmentId: "de",
      revision: 2,
      journalSequence: 4,
      language: "en",
      kind: "translation",
      text: "We are not launching yet.",
    }),
  ],
  importedSegments: [],
  attributions: [],
  translationStatus: "complete",
};
test("synthesis uses one current source turn and its matching English translation with versioned linkage", async () => {
  boundary.invoke.mockImplementation(async (command, args) => {
    if (command !== "reasoning_run") throw Error(command);
    // Tauri rejects reasoning_run without its required onDraft channel.
    if (!args.onDraft) throw Error("missing required key onDraft");
    return {
      outcome: "complete",
      jobId: args.job.id,
      basis: args.job.basis,
      output: {
        items: [
          {
            kind: "discussed",
            text: "The launch remains unapproved.",
            evidence: ["segment:de@2"],
          },
          {
            kind: "recommendation",
            text: "Confirm who approves the launch.",
            evidence: [],
          },
        ],
      },
    };
  });
  const generated = await generateSynthesis(record);
  expect(generated.evidence).toEqual(["segment:de@2"]);
  expect(generated.items.map((item) => item.kind)).toEqual([
    "discussed",
    "recommendation",
  ]);
  expect(generated.text).toContain("The launch remains unapproved.");
  const args = boundary.invoke.mock.calls[0][1];
  expect(Object.keys(args.job.outputSchema.properties)).toEqual(["items"]);
  expect(JSON.stringify(args)).not.toContain("obsolete");
  expect(args.prompt).toContain("Wir starten noch nicht.");
  expect(args.prompt).toContain("We are not launching yet.");
  const turns = synthesisTranscript(record);
  expect(turns).toHaveLength(1);
  expect(turns[0].id).toBe("segment:de@2");
  expect(turns[0].english?.sourceEvidenceId).toBe("segment:de@2");
  expect(synthesisEvidence(record, "segment:de@1")).toBeUndefined();
  expect(synthesisEvidence(record, "segment:de@2")?.text).toBe(
    "Wir starten noch nicht.",
  );
});
