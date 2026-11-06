import { expect, test } from "vitest";
import { CopilotRuntime } from "../../src/lib/copilot/runtime";
import type { ModelJob, SpeechEvent } from "@live-interview/core";
test("explicit shortcut dispatches full basis before stalled workspace/background completion", async () => {
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    {
      id: "m",
      workspaceId: "w",
      purpose: "Interview",
      objectives: ["Decision owner"],
      attendees: [],
      profileId: "interview",
      profileRevision: 0,
    },
    () => {},
    () => {},
    {
      run: async (job) => {
        jobs.push(job);
        return {
          jobId: job.id,
          provider: "ibmLuna",
          model: "luna",
          basis: job.basis,
          outcome: "failure",
          output: null,
        };
      },
      retrieve: () => new Promise(() => {}),
      refresh: () => new Promise(() => {}),
      decide: () => new Promise(() => {}),
    },
  );
  runtime.start();
  const event: SpeechEvent = {
    meetingId: "m",
    segmentId: "s",
    revision: 1,
    journalSequence: 21,
    lane: "remote",
    startMs: 0,
    endMs: 1,
    language: "en",
    text: "Business units decide",
    kind: "final",
  };
  runtime.ingest(event);
  const pending = runtime.request("respond");
  expect(jobs).toHaveLength(1);
  expect(jobs[0].trigger).toBe("requested");
  expect(jobs[0].basis.transcriptDeltas).toEqual([event]);
  runtime.setProfile("presentationAnswering");
  expect(jobs[0].basis.profileId).toBe("interview");
  await pending;
  runtime.stop();
});
test("an invalid answer is never shown, and help written before a new turn is marked as of its basis", async () => {
  let resolve!: (r: any) => void;
  const emitted: any[] = [];
  const runtime = new CopilotRuntime(
    {
      id: "m",
      workspaceId: "w",
      purpose: "Interview",
      objectives: ["Decision owner"],
      attendees: [],
      profileId: "interview",
      profileRevision: 0,
    },
    (e) => emitted.push(e),
    () => {},
    {
      run: (job) =>
        new Promise((r) => {
          resolve = (output) =>
            r({
              jobId: job.id,
              provider: "ibmLuna",
              model: "luna",
              basis: job.basis,
              outcome: "complete",
              output,
            });
        }),
      retrieve: async () => [],
      refresh: async () => [],
      decide: () => new Promise(() => {}),
    },
  );
  const pending = runtime.request("respond");
  runtime.ingest({
    meetingId: "m",
    segmentId: "latest",
    revision: 1,
    journalSequence: 21,
    lane: "remote",
    startMs: 0,
    endMs: 1,
    language: "en",
    text: "A new question?",
    kind: "final",
  });
  resolve({
    say: "Old answer",
    why: "Old",
    evidence: [],
    usefulness: 1,
    relevance: 1,
    novelty: 0,
    answerQuality: 1,
    uncertain: true,
  });
  await pending;
  expect(
    emitted.some((e) => e.kind === "card" && e.card.say === "Old answer"),
  ).toBe(false);
  // The new turn only appends to what the help was written from, so it is shown, labelled with its time.
  const help = emitted.find((e) => e.kind === "card");
  expect(help.card.origin).toBe("clarification");
  expect(typeof help.card.asOfMs).toBe("number");
  runtime.stop();
});
