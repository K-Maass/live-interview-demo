import { expect, test } from "vitest";
import { createMeetingState, SnapshotStore } from "../src/snapshots";
import { createGuidanceJob } from "../src/guidance/engine";
import { PreparedGuidanceCache } from "../src/guidance/prepared";
import type { HotkeyContext, ModelJob, ModelResult } from "../src/contracts";

const initial = (): HotkeyContext => {
  const state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Deployment decision",
    objectives: ["Who approves?"],
    attendees: [],
    profileId: "interview",
    profileRevision: 0,
  });
  const store = new SnapshotStore();
  store.initialise(state);
  const basis = structuredClone(store.read(state));
  basis.snapshot.context.conversation = [
    {
      meetingId: "m",
      segmentId: "s1",
      revision: 1,
      journalSequence: 1,
      lane: "remote",
      startMs: 0,
      endMs: 1000,
      language: "en",
      kind: "final",
      text: "Compliance owns evidence; the business owns launch.",
    },
  ];
  basis.snapshot.context.sources = [
    {
      sourceId: "policy",
      workspaceId: "w",
      kind: "markdown",
      title: "Policy",
      text: "Approval requires evidence.",
      locator: "policy.md",
      revision: 1,
      derived: false,
    },
  ];
  basis.snapshot.context.sourceRevisions = { policy: 1 };
  basis.observationSequence = 1;
  return basis;
};
const result = (job: ModelJob, overrides: object = {}): ModelResult => ({
  jobId: job.id,
  provider: "ibmLuna",
  model: "luna",
  basis: job.basis,
  outcome: "complete",
  output: {
    headline: "Decision and evidence",
    say: "Separate evidence ownership from the decision to launch.",
    why: "They need different owners.",
    evidence: ["segment:s1", "policy"],
    usefulness: 0.5,
    relevance: 0.5,
    novelty: 0.8,
    answerQuality: 0.8,
    uncertain: true,
    ...overrides,
  },
});

test("a prepared answer is found from a later hotkey snapshot and keeps the basis it was written against", () => {
  const basis = initial();
  const cache = new PreparedGuidanceCache(1000);
  const job = createGuidanceJob("respond", basis, "automatic", {
    lane: "fast",
  });
  expect(cache.store(job, result(job), 20, 100)).toBe(true);
  const current = structuredClone(basis);
  current.snapshot.snapshotId = "new-ready-snapshot";
  current.snapshot.createdAtMs = 110;
  current.transcriptDeltas = current.snapshot.context.conversation;
  current.snapshot.context.conversation = [];
  const selected = cache.select("respond", current, "requested", [], 200);
  expect(selected?.say).toBe(
    "Separate evidence ownership from the decision to launch.",
  );
  // Its evidence must resolve against what it was written from, not against the newer read.
  expect(selected?.basis).toEqual(job.basis);
  // Nothing new arrived, so it is not marked as written against an earlier basis.
  expect(selected?.asOfMs).toBeUndefined();
  expect(selected?.origin).toBe("cache");
  expect(selected?.trigger).toBe("requested");
  expect(selected?.preparedFrom).toMatchObject({
    jobId: job.id,
    preparedAtMs: 100,
    startedAtMs: 20,
    snapshotId: basis.snapshot.snapshotId,
  });
  expect(JSON.stringify(selected)).not.toContain('"candidates":[{');
});

test.each([
  [
    "transcript correction without a revision bump",
    (b: HotkeyContext) => {
      b.snapshot.context.conversation[0].text =
        "Evidence owner also decides launch.";
    },
  ],
  [
    "transcript revision",
    (b: HotkeyContext) => {
      b.snapshot.context.conversation[0].revision++;
    },
  ],
  [
    "source text",
    (b: HotkeyContext) => {
      b.snapshot.context.sources[0].text = "New policy";
    },
  ],
  [
    "source revision",
    (b: HotkeyContext) => {
      b.snapshot.context.sources[0].revision++;
    },
  ],
  [
    "invalidation",
    (b: HotkeyContext) => {
      b.invalidatedSourceIds = ["policy"];
    },
  ],
  [
    "profile",
    (b: HotkeyContext) => {
      b.profileId = "workClient";
    },
  ],
  [
    "profile revision",
    (b: HotkeyContext) => {
      b.profileRevision++;
    },
  ],
  [
    "objectives",
    (b: HotkeyContext) => {
      b.snapshot.context.objectives = ["Who collects evidence?"];
    },
  ],
  [
    "context",
    (b: HotkeyContext) => {
      b.snapshot.context.purpose = "Sales pitch";
    },
  ],
  [
    "meeting",
    (b: HotkeyContext) => {
      b.snapshot.meetingId = "another";
    },
  ],
] as const)("prepared guidance rejects changed %s", (_name, mutate) => {
  const basis = initial();
  const cache = new PreparedGuidanceCache(1000);
  const job = createGuidanceJob("respond", basis, "automatic");
  cache.store(job, result(job), 0, 100);
  const changed = structuredClone(basis);
  mutate(changed);
  expect(
    cache.select("respond", changed, "requested", [], 200),
  ).toBeUndefined();
});

test("a prepared card stays usable when the meeting only moved on, labelled with its basis time", () => {
  const basis = initial();
  const cache = new PreparedGuidanceCache(1000);
  const job = createGuidanceJob("respond", basis, "automatic");
  cache.store(job, result(job), 40, 100);
  const later = structuredClone(basis);
  later.observationSequence = 2;
  later.transcriptDeltas = [
    {
      ...basis.snapshot.context.conversation[0],
      segmentId: "s2",
      journalSequence: 2,
      startMs: 2000,
      endMs: 3000,
      lane: "me",
      text: "And who signs off the launch?",
    },
  ];
  // Pins, coverage and speaker attributions move during a meeting without touching the evidence.
  later.snapshot.context.pinnedTopics = ["Owner"];
  later.snapshot.context.attributions = [
    { clusterId: "remote1" as never, status: "suggested", evidence: [] },
  ];
  const selected = cache.select("respond", later, "requested", [], 200);
  expect(selected?.say).toContain("evidence ownership");
  expect(selected?.asOfMs).toBe(40);
  // A cited turn revised after the preparation withholds it.
  const revised = structuredClone(later);
  revised.transcriptDeltas.push({
    ...basis.snapshot.context.conversation[0],
    revision: 2,
    journalSequence: 3,
    text: "Compliance owns evidence and launch.",
  });
  revised.observationSequence = 3;
  expect(cache.select("respond", revised, "requested", [], 200)).toBeUndefined();
});

test("expired, malformed and foreign results never become prepared guidance", () => {
  const basis = initial();
  const job = createGuidanceJob("respond", basis, "automatic");
  const cache = new PreparedGuidanceCache(1000);
  expect(cache.store(job, { ...result(job), jobId: "different" }, 0, 100)).toBe(
    false,
  );
  // An invented citation is dropped; what remains is stored as an inference, never as verified.
  expect(
    cache.store(job, result(job, { evidence: ["invented"], uncertain: false }), 0, 100),
  ).toBe(true);
  expect(cache.select("respond", basis, "requested", [], 200)).toMatchObject({ evidence: [], uncertain: true });
  cache.store(job, result(job), 0, 100);
  expect(cache.select("respond", basis, "requested", [], 1100)).toBeUndefined();
});

test("prepared requested cards bypass automatic thresholds while automatic reuse keeps profile and redundancy gates", () => {
  const basis = initial();
  const job = createGuidanceJob("digDeeper", basis, "automatic");
  const cache = new PreparedGuidanceCache();
  cache.store(job, result(job), 0, 100);
  expect(cache.select("digDeeper", basis, "requested", [], 200)?.say).toContain(
    "evidence ownership",
  );
  expect(
    cache.select("digDeeper", basis, "automatic", [], 200),
  ).toBeUndefined();
  const useful = result(job, { usefulness: 0.99, relevance: 0.99 });
  cache.store(job, useful, 0, 100);
  expect(
    cache.select(
      "digDeeper",
      basis,
      "automatic",
      ["Separate evidence ownership from the decision to launch."],
      200,
    ),
  ).toBeUndefined();
});
