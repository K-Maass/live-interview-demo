import { expect, test } from "vitest";
import {
  StageRecorder,
  PreparationCounter,
  percentile,
  summarizeStages,
  timedTransport,
} from "../src/guidance/latency";
import {
  createGuidanceJob,
  requestGuidance,
  runWithBrevityRepair,
} from "../src/guidance/engine";
import { createMeetingState, SnapshotStore } from "../src/snapshots";
import type { ModelJob, ModelResult } from "../src/contracts";

const state = createMeetingState({
  id: "m",
  workspaceId: "w",
  purpose: "approval interview",
  objectives: ["Who approves?"],
  attendees: [],
  profileId: "interview",
  profileRevision: 0,
});
const store = new SnapshotStore();
const basis = store.read(state);
const card = (say: string) => ({
  headline: "Probe the approver",
  say,
  why: "Authority is unclear.",
  evidence: [],
  usefulness: 0.8,
  relevance: 0.8,
  novelty: 0.8,
  answerQuality: 0.8,
  uncertain: true,
});
const answer = (job: ModelJob, say: string): ModelResult => ({
  jobId: job.id,
  provider: "stand-in",
  model: "stand-in",
  output: card(say),
  basis: job.basis,
  outcome: "complete",
});

test("percentile uses nearest rank and is null without samples", () => {
  expect(percentile([], 50)).toBeNull();
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
});

test("the recorder sums provider attempts and reports first token only for the last one", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  recorder.add("snapshotRead", 2);
  await recorder.provider(async () => {
    t += 400;
  });
  await recorder.provider(async (trace) => {
    t += 100;
    trace.firstToken();
    t += 300;
    trace.firstToken();
  });
  expect(recorder.elapsed()).toBe(800);
  expect(recorder.snapshot()).toEqual({
    snapshotRead: 2,
    providerAttempts: 2,
    providerTotal: 800,
    providerFirstToken: 500,
  });
});

test("a transport that learns of the first token afterwards can pass its offset from the call start", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  await recorder.provider(async (trace) => {
    t += 900;
    trace.firstToken(310);
    trace.firstToken(5);
  });
  expect(recorder.snapshot()).toMatchObject({
    providerTotal: 900,
    providerFirstToken: 310,
  });
});

test("a provider that never reports a first token leaves that stage empty", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  await recorder.provider(async () => {
    t += 250;
  });
  expect(recorder.snapshot().providerTotal).toBe(250);
  expect(recorder.snapshot()).not.toHaveProperty("providerFirstToken");
});

test("a failed provider call is still timed", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  await expect(
    recorder.provider(async () => {
      t += 90;
      throw new Error("down");
    }),
  ).rejects.toThrow("down");
  expect(recorder.snapshot()).toMatchObject({
    providerTotal: 90,
    providerAttempts: 1,
  });
});

test("every stage of a hotkey request is measured through the real engine with a stand-in provider", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  recorder.time("snapshotRead", () => {
    t += 3;
    return store.read(state);
  });
  const transport = timedTransport(recorder, async (job, prompt, trace) => {
    expect(prompt).toContain("approval interview");
    t += 120;
    trace.firstToken();
    t += 380;
    return answer(job, "Who signs off on the budget?");
  });
  const events = [];
  for await (const event of requestGuidance(
    "digDeeper",
    basis,
    "requested",
    transport,
    [],
    undefined,
    undefined,
    recorder,
  ))
    events.push(event);
  expect(events.map((e) => e.kind)).toEqual(["card"]);
  expect(recorder.snapshot()).toMatchObject({
    snapshotRead: 3,
    providerAttempts: 1,
    providerTotal: 500,
    providerFirstToken: 120,
  });
  // Real clocks are not frozen, so prompt build is small but measured.
  expect(recorder.snapshot().promptBuild).toBeGreaterThanOrEqual(0);
  expect(recorder.snapshot()).not.toHaveProperty("render");
});

test("a brevity repair adds a second prompt build and provider attempt", async () => {
  let t = 0;
  const recorder = new StageRecorder(() => t);
  const long = Array.from({ length: 60 }, () => "word").join(" ");
  const transport = timedTransport(recorder, async (job) => {
    t += 200;
    return answer(job, job.brevityRetry ? "Who signs off?" : long);
  });
  const job = createGuidanceJob("digDeeper", basis, "requested");
  const result = await runWithBrevityRepair(job, (attempt) =>
    transport.run(attempt),
  );
  expect(result.outcome).toBe("complete");
  expect(recorder.snapshot()).toMatchObject({
    providerAttempts: 2,
    providerTotal: 400,
  });
});

test("summaries keep gaps visible instead of treating them as zero", () => {
  const summary = summarizeStages([
    { snapshotRead: 1, providerTotal: 500, total: 520 },
    { snapshotRead: 3, providerTotal: 900, total: 940, providerFirstToken: 200 },
  ]);
  expect(summary.snapshotRead).toEqual({ count: 2, p50Ms: 1, p95Ms: 3 });
  expect(summary.providerTotal).toEqual({ count: 2, p50Ms: 500, p95Ms: 900 });
  expect(summary.providerFirstToken).toEqual({ count: 1, p50Ms: 200, p95Ms: 200 });
  expect(summary.render).toEqual({ count: 0, p50Ms: null, p95Ms: null });
  expect(summarizeStages([]).total.p95Ms).toBeNull();
});

test("preparation counts split started jobs by how they ended and hold no content", () => {
  const counter = new PreparationCounter();
  expect(counter.snapshot()).toEqual({
    started: 0,
    completed: 0,
    superseded: 0,
    failed: 0,
    providerCalls: 0,
    inFlight: 0,
  });
  counter.start();
  counter.start();
  counter.start();
  counter.start();
  counter.end("completed", 1);
  counter.end("superseded", 2);
  counter.end("failed");
  expect(counter.snapshot()).toEqual({
    started: 4,
    completed: 1,
    superseded: 1,
    failed: 1,
    providerCalls: 3,
    inFlight: 1,
  });
  // Counts only: every value is a number.
  expect(Object.values(counter.snapshot()).every((v) => typeof v === "number")).toBe(true);
});
