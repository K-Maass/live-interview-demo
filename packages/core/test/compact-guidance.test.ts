import { expect, test } from "vitest";
import { createMeetingState, SnapshotStore } from "../src/snapshots";
import {
  createGuidanceJob,
  parseCard,
  runWithBrevityRepair,
  selectCandidate,
  makeClarification,
} from "../src/guidance/engine";
import { PreparedGuidanceCache } from "../src/guidance/prepared";
import type { ModelJob, ModelResult } from "../src/contracts";

const state = createMeetingState({
  id: "mock",
  workspaceId: "w",
  purpose: "Coding-agent pilot",
  objectives: ["Understand delivery outcomes"],
  attendees: [],
  profileId: "interview",
  profileRevision: 0,
});
const snapshots = new SnapshotStore();
snapshots.initialise(state);
const basis = snapshots.read(state);
const payload = (say = "Where does saved coding effort go?", score = 0.9) => ({
  headline: "Follow the saved effort",
  say,
  why: "Distinguishes individual task gains from delivery outcomes.",
  evidence: [],
  usefulness: score,
  relevance: score,
  novelty: score,
  answerQuality: score,
  uncertain: true,
});
const result = (job: ModelJob, output: unknown): ModelResult => ({
  jobId: job.id,
  provider: "ibmLuna",
  model: "luna",
  basis: job.basis,
  outcome: "complete",
  output,
});

test("oversized live wording is rejected intact rather than silently truncated", () => {
  const job = createGuidanceJob("respond", basis, "requested");
  const long = payload("important qualification ".repeat(30));
  expect(parseCard(long, job)).toBeUndefined();
  expect(long.say).toBe("important qualification ".repeat(30));
});
test("headlines cannot carry unbounded extra live text", () => {
  const job = createGuidanceJob("respond", basis, "requested");
  expect(
    parseCard(
      { ...payload(), headline: "Here is a very long additional explanation" },
      job,
    ),
  ).toBeUndefined();
});
test("respond keeps the best answer even when a weaker alternative is fresh", () => {
  const job = createGuidanceJob("respond", basis, "requested");
  const best = parseCard(
    payload("The delivery outcome remains unproven.", 0.99),
    job,
  )!;
  const weak = parseCard(
    payload("The sponsor should consider other options.", 0.5),
    job,
  )!;
  expect(
    selectCandidate([best, weak], basis, "requested", [best.say])?.id,
  ).toBe(best.id);
});
test("a probing hotkey never prefers a weak new angle just to avoid repeating a strong question", () => {
  const job = createGuidanceJob("digDeeper", basis, "requested");
  const best = parseCard(
    payload("Where does saved coding effort go?", 0.95),
    job,
  )!;
  const weak = parseCard(
    payload("What other technologies might be interesting?", 0.2),
    job,
  )!;
  expect(
    selectCandidate([best, weak], basis, "requested", [best.say])?.id,
  ).toBe(best.id);
});
test("a prepared group keeps distinct probing angles available for repeated requested hotkeys", () => {
  const job = createGuidanceJob("digDeeper", basis, "automatic", {
    preparation: true,
  });
  const cache = new PreparedGuidanceCache(1000, 1);
  const questions = [
    payload("Where does saved coding effort go?", 0.95),
    payload("What would distinguish tool effects from task selection?", 0.9),
    payload("Who benefits if the measured outcome changes?", 0.85),
  ];
  expect(cache.store(job, result(job, { candidates: questions }), 0, 100)).toBe(
    true,
  );
  const first = cache.select("digDeeper", basis, "requested", [], 200);
  expect(first?.say).toBe("Where does saved coding effort go?");
  const second = cache.select(
    "digDeeper",
    basis,
    "requested",
    [first!.say],
    201,
  );
  expect(second?.say).toBe(
    "What would distinguish tool effects from task selection?",
  );
  expect(second?.basis).toEqual(basis);
  expect(
    cache.select(
      "digDeeper",
      basis,
      "requested",
      questions.map((x) => x.say),
      202,
    ),
  ).toBeDefined();
});
test("a broken candidate cannot contaminate a valid prepared question", () => {
  const job = createGuidanceJob("digDeeper", basis, "automatic", {
    preparation: true,
  });
  const cache = new PreparedGuidanceCache();
  expect(
    cache.store(
      job,
      result(job, {
        candidates: [
          { ...payload("Invented claim"), evidence: ["foreign"] },
          payload(),
        ],
      }),
      0,
      100,
    ),
  ).toBe(true);
  expect(cache.select("digDeeper", basis, "requested", [], 200)?.say).toBe(
    "Where does saved coding effort go?",
  );
});
test("brevity repair is one correlated attempt on the original evidence basis", async () => {
  const job = createGuidanceJob("respond", basis, "requested");
  const jobs: ModelJob[] = [];
  const repaired = await runWithBrevityRepair(job, async (attempt) => {
    jobs.push(attempt);
    return result(
      attempt,
      payload(
        jobs.length === 1
          ? "qualification ".repeat(50)
          : "The outcome remains unproven.",
      ),
    );
  });
  expect(jobs).toHaveLength(2);
  expect(jobs[1].id).not.toBe(job.id);
  expect(jobs[1].basis).toEqual(job.basis);
  expect(repaired.jobId).toBe(job.id);
  expect(parseCard(repaired.output, job)?.say).toBe(
    "The outcome remains unproven.",
  );
});
test("a stale shortening retry is rejected rather than rebound to current evidence", async () => {
  const job = createGuidanceJob("respond", basis, "requested");
  let n = 0;
  const answer = await runWithBrevityRepair(job, async (attempt) => {
    if (++n === 1) return result(attempt, payload("qualification ".repeat(50)));
    return {
      ...result(attempt, payload()),
      basis: { ...attempt.basis, observationSequence: 99 },
    };
  });
  expect(parseCard(answer.output, job)).toBeUndefined();
});
test("cancelled preparation cannot start a shortening retry", async () => {
  const job = createGuidanceJob("respond", basis, "requested");
  let n = 0;
  await runWithBrevityRepair(
    job,
    async (attempt) => {
      n++;
      return result(attempt, payload("qualification ".repeat(50)));
    },
    () => false,
  );
  expect(n).toBe(1);
});
test("qualified fallback remains readable even when the meeting objective is very long", () => {
  const captured = structuredClone(basis);
  captured.snapshot.context.objectives = ["long objective ".repeat(100)];
  const card = makeClarification("checkObjectives", captured);
  expect(card.say.trim().split(/\s+/).length).toBeLessThanOrEqual(25);
  expect(card.origin).toBe("clarification");
});
