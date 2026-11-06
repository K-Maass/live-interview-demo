import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildCheckpointBasis,
  validateCase,
  type GuidanceCase,
} from "../src/evaluation/guidanceCases";
import {
  calibrationAgreement,
  calibrationProblems,
  calibrationValid,
  compareRuns,
  judgePrompt,
  parseVerdict,
  scoreCheckpoint,
  summarizeRun,
  type JudgeVerdict,
  type RunMeta,
  type SampleOutcome,
} from "../src/evaluation/guidanceScoring";
import { CostCapReached, CostMeter, costOf } from "../src/evaluation/costCap";
import { effectiveContext } from "../src/snapshots";
import { createGuidanceJob, guidancePrompt } from "../src/guidance/engine";

const fixture = (): GuidanceCase => ({
  id: "unit-case",
  title: "Unit case",
  profile: "discovery",
  language: "de",
  purpose: "Understand the rollout constraint",
  objectives: ["Who signs off the rollout?"],
  attendees: [{ id: "p1", name: "Jana Beispiel" }],
  edgeCases: ["staleSource", "mistranslation"],
  sources: [
    {
      sourceId: "plan",
      title: "Rollout plan",
      kind: "markdown",
      text: "Pilot in March.",
      revision: 1,
    },
  ],
  turns: [
    {
      seq: 1,
      lane: "remote",
      text: "Wir starten vielleicht im März.",
      translation: "We start in March.",
    },
    { seq: 2, lane: "me", text: "Who signs off?", language: "en" },
    {
      seq: 3,
      sourceUpdate: {
        sourceId: "plan",
        title: "Rollout plan",
        kind: "markdown",
        text: "Pilot moved to May.",
        revision: 2,
      },
    },
    { seq: 4, lane: "remote", text: "Das entscheidet der Betriebsrat." },
    {
      seq: 5,
      sourceUpdate: {
        sourceId: "plan",
        title: "Rollout plan",
        kind: "markdown",
        text: "Pilot moved to June.",
        revision: 3,
      },
    },
  ],
  checkpoints: [
    {
      id: "cp1",
      intent: "digDeeper",
      at: 5,
      snapshotAt: 3,
      mustInclude: ["asks about works council timing"],
      mustNotInclude: ["claims March is confirmed"],
      ideal: "Ask when the works council meets relative to the May pilot.",
    },
  ],
});
const verdict = (overrides: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
  items: [
    { id: "must:0", pass: true, reason: "ok" },
    { id: "mustNot:0", pass: true, reason: "ok" },
  ],
  scores: {
    usefulness: 5,
    specificity: 4,
    nonObviousValue: 4,
    answerQuality: 4,
    grounding: 5,
    repetition: 5,
    brevity: 4,
  },
  unflaggedUnsupportedClaim: false,
  repeatsEstablished: false,
  falseCoverage: false,
  fidelity: { pass: true, reason: "hedge kept" },
  summary: "good",
  ...overrides,
});
const card = { say: "When does the works council meet?", why: "w", evidence: [], uncertain: false };
const sample = (n: number, v?: JudgeVerdict, extra: Partial<SampleOutcome> = {}): SampleOutcome => ({
  caseId: "unit-case",
  checkpointId: "cp1",
  intent: "digDeeper",
  sample: n,
  card,
  verdict: v,
  latency: { path: "cold", firstCardMs: 1000 + n * 100 },
  provider: { provider: "managedFast", model: "luna-x" },
  ...extra,
});
const meta: RunMeta = {
  date: "2026-10-12",
  commit: "abc1234",
  caseSetRevision: "rev",
  judgeModel: "claude-opus-5-5",
  rubricHash: "hash",
  samplesPerCheckpoint: 2,
  complete: true,
  costUsd: { generator: 0.5, judge: 1.25 },
};
const calibration = {
  judgeModel: "claude-opus-5-5",
  rubricHash: "hash",
  date: "2026-10-12",
  ratings: 20,
  agreement: 0.85,
};

describe("committed cases", () => {
  const dir = join(__dirname, "../../../eval/guidance/cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const cases = files.map(
    (f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GuidanceCase,
  );
  test("every case validates and is named after its id", () => {
    for (const [i, c] of cases.entries()) {
      expect(validateCase(c), files[i]).toEqual([]);
      expect(files[i]).toBe(`${c.id}.json`);
      expect(c.private).toBeUndefined();
    }
  });
  test("the set covers every profile, language, brief mode, intent and required edge case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    for (const profile of ["interview", "discovery", "workClient", "presentationAnswering"])
      for (const language of ["en", "de"])
        for (const brief of [true, false])
          expect(
            cases.some(
              (c) => c.profile === profile && c.language === language && !!c.brief === brief,
            ),
            `${profile}/${language}/${brief ? "brief" : "no brief"}`,
          ).toBe(true);
    const intents = new Set(cases.flatMap((c) => c.checkpoints.map((cp) => cp.intent)));
    expect([...intents].sort()).toEqual(
      ["checkConversation", "checkObjectives", "contribute", "digDeeper", "respond"],
    );
    const edges = new Set(cases.flatMap((c) => c.edgeCases));
    for (const edge of [
      "conflictingClaims",
      "asrNoise",
      "codeSwitching",
      "mistranslation",
      "topicShift",
      "staleSource",
      "answerNotInEvidence",
      "mentionedNotCovered",
    ])
      expect(edges.has(edge as never), edge).toBe(true);
  });
  test("every checkpoint builds a basis whose prompt fits the live deadline and keeps every turn", () => {
    for (const c of cases)
      for (const cp of c.checkpoints) {
        const basis = buildCheckpointBasis(c, cp);
        const spoken = c.turns.filter((t) => "lane" in t && t.seq <= cp.at).length;
        const finals = effectiveContext(basis).conversation.filter((e) => e.kind === "final");
        expect(finals.length, `${c.id}/${cp.id}`).toBe(spoken);
        expect(guidancePrompt(createGuidanceJob(cp.intent, basis, "requested")).length).toBeLessThan(60000);
      }
  });
});

describe("checkpoint basis", () => {
  test("contains only turns through the checkpoint, with later turns as deltas", () => {
    const c = fixture();
    const basis = buildCheckpointBasis(c, { ...c.checkpoints[0], at: 2, snapshotAt: 1 });
    const context = effectiveContext(basis);
    expect(context.conversation.map((e) => e.segmentId)).toEqual(["t1", "t1-en", "t2"]);
    expect(basis.snapshot.context.conversation.map((e) => e.segmentId)).toEqual(["t1", "t1-en"]);
    expect(basis.transcriptDeltas.map((e) => e.segmentId)).toEqual(["t2"]);
    const translation = context.conversation.find((e) => e.kind === "translation")!;
    expect(translation).toMatchObject({ language: "en", sourceSegmentId: "t1", lane: "remote" });
  });
  test("a revision published before the snapshot is visible; a later one invalidates the stale source", () => {
    const c = fixture();
    const before = effectiveContext(buildCheckpointBasis(c, { ...c.checkpoints[0], at: 4, snapshotAt: 3 }));
    expect(before.sources.map((s) => [s.sourceId, s.revision, s.text])).toEqual([
      ["plan", 2, "Pilot moved to May."],
    ]);
    const after = buildCheckpointBasis(c, c.checkpoints[0]);
    expect(after.invalidatedSourceIds).toEqual(["plan"]);
    expect(effectiveContext(after).sources).toEqual([]);
  });
  test("validation reports structural problems", () => {
    const c = fixture();
    c.checkpoints[0].at = 99;
    c.turns.push({ seq: 2, lane: "me", text: "dup" });
    expect(validateCase(c)).toEqual(
      expect.arrayContaining([
        "checkpoints[0]: at must name a turn",
        "turns[5]: seq must increase",
      ]),
    );
  });
});

describe("judge prompt and verdict", () => {
  test("prompt carries rubric ids, fidelity flag and the card but no self-scores", () => {
    const c = fixture();
    const basis = buildCheckpointBasis(c, c.checkpoints[0]);
    const prompt = JSON.parse(
      judgePrompt(c, c.checkpoints[0], basis, { ...card, usefulness: 0.99 } as never),
    );
    expect(prompt.rubric.map((r: { id: string }) => r.id)).toEqual(["must:0", "mustNot:0"]);
    expect(prompt.task.meaningFidelityRequired).toBe(true);
    expect(prompt.card).not.toHaveProperty("usefulness");
    expect(prompt.meeting.transcript[1]).toMatchObject({ translationOf: "segment:t1" });
  });
  test("verdicts with missing items, out-of-range scores or missing fidelity are rejected", () => {
    const cp = fixture().checkpoints[0];
    expect(parseVerdict(verdict(), cp, true)).toBeDefined();
    expect(parseVerdict(verdict({ items: verdict().items.slice(1) }), cp, true)).toBeUndefined();
    expect(
      parseVerdict(verdict({ scores: { ...verdict().scores, brevity: 6 } }), cp, true),
    ).toBeUndefined();
    expect(parseVerdict(verdict({ fidelity: null }), cp, true)).toBeUndefined();
    expect(parseVerdict(verdict({ fidelity: null }), cp, false)).toBeDefined();
  });
});

describe("checkpoint pass rule", () => {
  const c = fixture();
  const cp = c.checkpoints[0];
  test("passes only when both samples pass", () => {
    expect(scoreCheckpoint(c, cp, [sample(1, verdict()), sample(2, verdict())], 2).pass).toBe(true);
    const mixed = scoreCheckpoint(c, cp, [
      sample(1, verdict()),
      sample(2, verdict({ scores: { ...verdict().scores, nonObviousValue: 3 } })),
    ], 2);
    expect(mixed).toMatchObject({ pass: false, anyPass: true, reasons: ["nonObviousValue"] });
  });
  test("an unflagged unsupported claim is a grounding hard fail", () => {
    const r = scoreCheckpoint(c, cp, [
      sample(1, verdict({ unflaggedUnsupportedClaim: true })),
      sample(2, verdict()),
    ], 2);
    expect(r).toMatchObject({ pass: false, hardFails: { grounding: true, repetition: false } });
  });
  test("respond needs answerQuality 4; review intents fail on false coverage", () => {
    const respond = { ...cp, intent: "respond" as const };
    const low = verdict({ scores: { ...verdict().scores, answerQuality: 3, nonObviousValue: 1 } });
    expect(
      scoreCheckpoint(c, respond, [
        sample(1, low, { intent: "respond" }),
        sample(2, low, { intent: "respond" }),
      ], 2).reasons,
    ).toEqual(["answerQuality"]);
    const review = { ...cp, intent: "checkObjectives" as const };
    expect(
      scoreCheckpoint(c, review, [
        sample(1, verdict({ falseCoverage: true }), { intent: "checkObjectives" }),
      ], 1).reasons,
    ).toEqual(["falseCoverage"]);
  });
  test("a missing card, a lost hedge in German, or no samples fail", () => {
    expect(scoreCheckpoint(c, cp, [sample(1, undefined, { card: undefined, failure: "clarificationFallback" })], 1).reasons).toEqual(["clarificationFallback"]);
    expect(
      scoreCheckpoint(c, cp, [sample(1, verdict({ fidelity: { pass: false, reason: "hedge lost" } }))], 1).reasons,
    ).toEqual(["fidelity"]);
    expect(scoreCheckpoint(c, cp, [], 2).pass).toBe(false);
  });
  test("fewer samples than the run asked for fail, even when every sample passed", () => {
    const short = scoreCheckpoint(c, cp, [sample(1, verdict())], 2);
    expect(short).toMatchObject({ pass: false, anyPass: true, reasons: ["missingSamples"] });
    expect(scoreCheckpoint(c, cp, [sample(1, verdict())], 1).pass).toBe(true);
  });
});

describe("stage latency in the run summary", () => {
  test("reports p50/p95 per stage and marks unmeasured stages as empty", () => {
    const staged = (n: number, providerTotal: number) =>
      sample(n, verdict(), {
        latency: {
          path: "cold",
          firstCardMs: providerTotal + 10,
          stages: { snapshotRead: n, promptBuild: 1, providerTotal, total: providerTotal + 10 },
          prepared: { ready: true, preparationMs: 900 + n, lookupMs: 0.2 },
        },
      });
    const s = summarizeRun(meta, [fixture()], [staged(1, 800), staged(2, 1600)], calibration);
    expect(s.latency.cold.stages.providerTotal).toEqual({ count: 2, p50Ms: 800, p95Ms: 1600 });
    expect(s.latency.cold.stages.snapshotRead).toEqual({ count: 2, p50Ms: 1, p95Ms: 2 });
    expect(s.latency.cold.stages.providerFirstToken.count).toBe(0);
    expect(s.latency.cold.stages.render).toEqual({ count: 0, p50Ms: null, p95Ms: null });
    expect(s.latency.review.stages.total.count).toBe(0);
    expect(s.latency.prepared).toMatchObject({ preparationP95Ms: 902, lookupP50Ms: 0.2, lookupP95Ms: 0.2 });
  });
});

describe("run summary and gate", () => {
  const c = fixture();
  const good = [sample(1, verdict()), sample(2, verdict())];
  test("passing calibrated run opens the gate and carries no card text", () => {
    const s = summarizeRun(meta, [c], good, calibration);
    expect(s.gate).toEqual({ pass: true, reasons: [] });
    expect(s.passRate).toEqual({ worst: 1, best: 1 });
    expect(s.latency.cold).toMatchObject({ requests: 2, cards: 2, p50Ms: 1100, p90Ms: 1200, p95Ms: 1200 });
    expect(s.costUsd.total).toBe(1.75);
    expect(JSON.stringify(s)).not.toContain(card.say);
    expect(JSON.stringify(s)).not.toContain("Who signs off");
  });
  test("uncalibrated, incomplete, low pass rate or hard fails close the gate", () => {
    expect(summarizeRun(meta, [c], good, undefined).gate.reasons).toEqual(["judgeNotCalibrated"]);
    expect(
      summarizeRun(meta, [c], good, { ...calibration, rubricHash: "old" }).gate.reasons,
    ).toEqual(["judgeNotCalibrated"]);
    expect(
      summarizeRun({ ...meta, complete: false }, [c], good, calibration).gate.reasons,
    ).toEqual(["runIncomplete"]);
    const bad = summarizeRun(
      meta,
      [c],
      [sample(1, verdict({ repeatsEstablished: true })), sample(2, verdict())],
      calibration,
    );
    expect(bad.gate.reasons).toEqual(["passRateBelow90", "repetitionHardFail"]);
    expect(bad.failed).toEqual([
      { case: "unit-case", checkpoint: "cp1", reasons: ["repeatsEstablished"] },
    ]);
  });
  test("a single sample per checkpoint or an unjudged card closes the gate", () => {
    expect(
      summarizeRun({ ...meta, samplesPerCheckpoint: 1 }, [c], [sample(1, verdict())], calibration).gate.reasons,
    ).toEqual(["samplesBelow2"]);
    const unjudged = summarizeRun(
      meta,
      [{ ...c, checkpoints: [...c.checkpoints, { ...c.checkpoints[0], id: "cp2" }] }],
      [...good, sample(1, undefined, { checkpointId: "cp2", failure: "judgeInvalid" }), sample(2, verdict(), { checkpointId: "cp2" })],
      calibration,
    );
    expect(unjudged.unjudgedSamples).toBe(1);
    expect(unjudged.gate.reasons).toContain("unjudgedSamples");
  });
  test("private cases never enter a summary", () => {
    expect(() => summarizeRun(meta, [{ ...c, private: true }], good, calibration)).toThrow(
      /Private/,
    );
  });
  test("compareRuns lists newly failing checkpoints and latency regressions", () => {
    const before = summarizeRun(meta, [c], good, calibration);
    const after = summarizeRun(
      meta,
      [c],
      [
        sample(1, verdict({ falseCoverage: true }), { latency: { path: "cold", firstCardMs: 3000 } }),
        sample(2, verdict(), { latency: { path: "cold", firstCardMs: 3000 } }),
      ],
      calibration,
    );
    expect(compareRuns(before, after)).toEqual([
      "newly failing: unit-case/cp1",
      "pass rate 1 -> 0",
      "cold p50 1100 ms -> 3000 ms",
    ]);
  });
  test("calibration agreement counts pairs within one point and needs the current judge", () => {
    const judge = { ...verdict().scores, unflaggedUnsupportedClaim: false, repeatsEstablished: false };
    expect(
      calibrationAgreement([
        { human: { ...judge, usefulness: 3 }, judge },
        { human: { ...judge, unflaggedUnsupportedClaim: true }, judge },
        { human: { usefulness: 1 }, judge },
      ]),
    ).toEqual({ agreement: 0.889, compared: 18, cards: 2 });
    expect(calibrationValid(calibration, "claude-opus-5-5", "hash")).toBe(true);
    expect(calibrationValid({ ...calibration, agreement: 0.79 }, "claude-opus-5-5", "hash")).toBe(false);
    expect(calibrationValid(calibration, "other-judge", "hash")).toBe(false);
    expect(calibrationValid(calibration, "claude-opus-5-5", "other-hash")).toBe(false);
  });
  test("calibration problems name every reason the judge cannot count", () => {
    expect(calibrationProblems(calibration, "claude-opus-5-5", "hash")).toEqual([]);
    expect(calibrationProblems(undefined, "claude-opus-5-5", "hash")).toEqual([
      "no calibration.json: the judge has never been calibrated",
    ]);
    const problems = calibrationProblems({ ...calibration, ratings: 5, agreement: 0.5 }, "other-judge", "new-hash");
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^rubric changed since calibration .*calibrated hash, current new-hash/);
  });
});

describe("cost cap", () => {
  test("refuses a call that would cross the cap and aborts once spending passes it", () => {
    const meter = new CostMeter(5);
    meter.add("judge", 4.9);
    expect(() => meter.reserve(0.2)).toThrow(CostCapReached);
    expect(() => meter.add("generator", 0.2)).toThrow(/Cost cap reached/);
    expect(costOf({ inputPerMTok: 5, outputPerMTok: 25 }, { input: 1e6, output: 1e5 })).toBe(7.5);
  });
});

describe("token and call accounting in the run summary", () => {
  const withCalls = (n: number, calls: NonNullable<SampleOutcome["calls"]>, extra: Partial<SampleOutcome> = {}) =>
    sample(n, verdict(), { calls, ...extra });
  test("sums tokens per purpose, intent and lane and counts calls per replayed meeting", () => {
    const samples = [
      withCalls(1, [
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 1000, output: 100 },
        // A brevity repair is a second call.
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 1200, output: 120 },
        { purpose: "preparation", lane: "fast", outcome: "complete", input: 900, output: 300 },
      ]),
      withCalls(2, [
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 1400, output: 80 },
        // A failed call reports no usage: counted as a call, not averaged into tokens.
        { purpose: "preparation", lane: "fast", outcome: "failure" },
        { purpose: "preparation", lane: "fast", outcome: "complete", input: 1100, output: 500 },
      ]),
      // Deep fallback: counted, but no usage.
      withCalls(1, [{ purpose: "hotkey", lane: "deep", outcome: "complete" }], {
        intent: "checkObjectives",
        checkpointId: "cp2",
      }),
    ];
    const usage = summarizeRun(meta, [fixture()], samples, calibration).usage;
    expect(usage.byIntentLane.find((g) => g.purpose === "hotkey" && g.lane === "fast")).toMatchObject({
      intent: "digDeeper",
      calls: 3,
      callsWithUsage: 3,
      inputTokens: 3600,
      outputTokens: 300,
      meanInputTokens: 1200,
      meanOutputTokens: 100,
    });
    expect(usage.byIntentLane.find((g) => g.purpose === "preparation")).toMatchObject({
      calls: 3,
      callsWithUsage: 2,
      meanInputTokens: 1000,
      meanOutputTokens: 400,
    });
    expect(usage.byIntentLane.find((g) => g.lane === "deep")).toMatchObject({
      intent: "checkObjectives",
      calls: 1,
      callsWithUsage: 0,
      meanInputTokens: null,
    });
    // A meeting is one case replayed once per sample number: two here.
    expect(usage.replayedMeetings).toBe(2);
    expect(usage.hotkeyCallsPerMeeting).toEqual({ mean: 2, max: 3 });
    expect(usage.preparationCallsPerMeeting).toEqual({ mean: 1.5, max: 2 });
  });
  test("cached input tokens are optional: averaged over the calls that reported them, null otherwise", () => {
    const samples = [
      withCalls(1, [
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 1000, output: 100, cachedInput: 800 },
        // Reports usage but no cached count (a provider that does not report it).
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 3000, output: 100 },
        // A reported zero is a measurement.
        { purpose: "hotkey", lane: "fast", outcome: "complete", input: 1000, output: 100, cachedInput: 0 },
        { purpose: "preparation", lane: "fast", outcome: "complete", input: 500, output: 50 },
      ]),
    ];
    const { byIntentLane } = summarizeRun(meta, [fixture()], samples, calibration).usage;
    expect(byIntentLane.find((g) => g.purpose === "hotkey")).toMatchObject({
      callsWithUsage: 3,
      callsWithCachedInput: 2,
      cachedInputTokens: 800,
      meanCachedInputTokens: 400,
      // 800 cached of the 2000 input tokens that came with a cached report; the 3000 without one are excluded.
      cachedInputShare: 0.4,
    });
    expect(byIntentLane.find((g) => g.purpose === "preparation")).toMatchObject({
      callsWithCachedInput: 0,
      cachedInputTokens: 0,
      meanCachedInputTokens: null,
      cachedInputShare: null,
    });
  });
  test("outcomes recorded before accounting existed give an empty usage section and still compare", () => {
    const old = summarizeRun(meta, [fixture()], [sample(1, verdict()), sample(2, verdict())], calibration);
    expect(old.usage).toEqual({
      byIntentLane: [],
      replayedMeetings: 0,
      hotkeyCallsPerMeeting: null,
      preparationCallsPerMeeting: null,
    });
    // A summary file written before this field existed has no `usage` at all.
    const { usage: _dropped, ...recorded } = old;
    expect(compareRuns(recorded, old)).toEqual([]);
  });
  test("carries numbers and fixed labels only", () => {
    const s = summarizeRun(
      meta,
      [fixture()],
      [withCalls(1, [{ purpose: "hotkey", lane: "fast", outcome: "complete", input: 10, output: 5 }])],
      calibration,
    );
    const allowed = new Set(["hotkey", "preparation", "fast", "deep", "digDeeper"]);
    for (const g of s.usage.byIntentLane)
      for (const v of Object.values(g)) expect(typeof v === "number" || v === null || allowed.has(v)).toBe(true);
  });
});
