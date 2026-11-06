import type { AssistanceIntent, GuidanceCard, HotkeyContext } from "../contracts";
import { effectiveContext } from "../snapshots";
import { percentile, summarizeStages, type StageTimings } from "../guidance/latency";
import type { Checkpoint, GuidanceCase } from "./guidanceCases";

/**
 * External judge for the offline guidance evaluation. Card self-scores are
 * never used here; the judge's scores count toward the launch gate only after
 * calibration against a human rater's blind ratings (see `calibrationValid`).
 */
export const judgeDimensions = [
  "usefulness",
  "specificity",
  "nonObviousValue",
  "answerQuality",
  "grounding",
  "repetition",
  "brevity",
] as const;
export type JudgeDimension = (typeof judgeDimensions)[number];
export type JudgeScores = Record<JudgeDimension, number>;
export interface JudgeVerdict {
  items: { id: string; pass: boolean; reason: string }[];
  scores: JudgeScores;
  unflaggedUnsupportedClaim: boolean;
  repeatsEstablished: boolean;
  falseCoverage: boolean;
  fidelity: { pass: boolean; reason: string } | null;
  summary: string;
}
const score = { type: "integer", minimum: 1, maximum: 5 };
export const judgeSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          pass: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["id", "pass", "reason"],
        additionalProperties: false,
      },
    },
    scores: {
      type: "object",
      properties: Object.fromEntries(judgeDimensions.map((d) => [d, score])),
      required: [...judgeDimensions],
      additionalProperties: false,
    },
    unflaggedUnsupportedClaim: { type: "boolean" },
    repeatsEstablished: { type: "boolean" },
    falseCoverage: { type: "boolean" },
    fidelity: {
      anyOf: [
        {
          type: "object",
          properties: {
            pass: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["pass", "reason"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    summary: { type: "string" },
  },
  required: [
    "items",
    "scores",
    "unflaggedUnsupportedClaim",
    "repeatsEstablished",
    "falseCoverage",
    "fidelity",
    "summary",
  ],
  additionalProperties: false,
};
/**
 * Version of everything that decides a verdict and turns it into a pass: the
 * judge prompt, verdict parsing, sample and checkpoint pass rules and the gate.
 * It is part of the rubric hash, so bumping it invalidates the stored judge
 * calibration on purpose. Bump it whenever that logic changes; the hash no
 * longer reads function source, which varies with the transpiler.
 * 2: checkpoints need the requested number of samples (`missingSamples`).
 */
export const RUBRIC_VERSION = 2;
/** Changing this text or the schema changes the rubric hash and requires recalibration. */
export const judgeInstructions = `You are a strict evaluator of live meeting guidance for the user, a professional who reads one short card during a live call.
The card has: say (what the user could say now), why (support, at most 80 words), evidence (cited segment:IDs or source IDs) and uncertain (true when the card rests on inference or general knowledge).
Judge only the card against the meeting evidence shown. The transcript lanes are fixed: "me" is the user's microphone, "remote" is everyone else. Translation segments are machine translations of the source-language segment they reference; the source-language text is authoritative.

Rules:
- Grounding: every claim must trace to cited evidence, or be general knowledge with uncertain=true that is not presented as meeting evidence. Set unflaggedUnsupportedClaim=true for any specific (figure, name, date, commitment, quote or attribution) that is unsupported and not flagged uncertain, even if it might be true.
- Repetition: set repeatsEstablished=true if say re-asks a question already asked or answered in the transcript, or restates something already established as if it were new.
- Review intents (checkConversation, checkObjectives): set falseCoverage=true if the card treats an objective as covered or answered when it was only mentioned. Otherwise false.
- respond: if the evidence does not contain the answer, the best general answer marked uncertain is correct; a fabricated specific presented as fact is a failure.
- digDeeper and contribute: generic or obvious questions any participant would think of score low on nonObviousValue.
- Meaning fidelity (only when asked): fail if the card relies on a mistranslation, loses a hedge or condition from the source-language speech, or changes register in a way that would mislead. Otherwise set fidelity=null.

Score 1-5 (5 best) on: usefulness (would help the user right now), specificity (concrete to this meeting), nonObviousValue (adds information beyond what participants would think of; rate even for other intents), answerQuality (accuracy and directness of the answer; rate even for non-respond intents as the quality of the stated content), grounding (5 = fully supported or properly flagged), repetition (5 = entirely new; 1 = pure repetition), brevity (5 = leads with the point and readable at a glance).
For each rubric item return its id with pass=true only if the card clearly satisfies it (must items) or clearly avoids it (mustNot items), with a one-line reason.
Return only the structured result.`;
const conversationView = (basis: HotkeyContext) =>
  effectiveContext(basis).conversation.map((e) => ({
    id: `segment:${e.segmentId}`,
    lane: e.lane,
    language: e.language,
    kind: e.kind,
    ...(e.sourceSegmentId ? { translationOf: `segment:${e.sourceSegmentId}` } : {}),
    text: e.text,
  }));
export function rubricItems(checkpoint: Checkpoint) {
  return [
    ...checkpoint.mustInclude.map((text, i) => ({
      id: `must:${i}`,
      kind: "must" as const,
      text,
    })),
    ...checkpoint.mustNotInclude.map((text, i) => ({
      id: `mustNot:${i}`,
      kind: "mustNot" as const,
      text,
    })),
  ];
}
export const needsFidelity = (c: GuidanceCase) => c.language === "de";
export function judgePrompt(
  c: GuidanceCase,
  checkpoint: Checkpoint,
  basis: HotkeyContext,
  card: Pick<GuidanceCard, "say" | "why" | "evidence" | "uncertain"> & {
    headline?: string;
  },
): string {
  const context = effectiveContext(basis);
  return JSON.stringify({
    task: {
      intent: checkpoint.intent,
      profile: c.profile,
      meetingLanguage: c.language,
      meaningFidelityRequired: needsFidelity(c),
    },
    meeting: {
      purpose: context.purpose,
      objectives: context.objectives,
      coveredObjectives: context.coveredObjectives ?? [],
      brief: context.brief?.text ?? null,
      sources: context.sources.map((s) => ({
        id: s.sourceId,
        title: s.title,
        revision: s.revision,
        text: s.text,
      })),
      transcript: conversationView(basis),
    },
    rubric: rubricItems(checkpoint).map(({ id, kind, text }) => ({
      id,
      kind,
      text,
    })),
    referenceNotes: `An ideal card would roughly: ${checkpoint.ideal} Other wording or angles can be equally good.`,
    card: {
      headline: card.headline ?? null,
      say: card.say,
      why: card.why,
      evidence: card.evidence,
      uncertain: card.uncertain,
    },
  });
}
const int = (v: unknown) =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
export function parseVerdict(
  output: unknown,
  checkpoint: Checkpoint,
  fidelityRequired: boolean,
): JudgeVerdict | undefined {
  const o = output as JudgeVerdict;
  if (!o || typeof o !== "object") return;
  const expected = rubricItems(checkpoint).map((i) => i.id);
  if (
    !Array.isArray(o.items) ||
    o.items.length !== expected.length ||
    !expected.every((id) =>
      o.items.some((i) => i?.id === id && typeof i.pass === "boolean"),
    ) ||
    !o.scores ||
    !judgeDimensions.every((d) => int(o.scores[d])) ||
    typeof o.unflaggedUnsupportedClaim !== "boolean" ||
    typeof o.repeatsEstablished !== "boolean" ||
    typeof o.falseCoverage !== "boolean" ||
    (fidelityRequired &&
      (!o.fidelity || typeof o.fidelity.pass !== "boolean")) ||
    typeof o.summary !== "string"
  )
    return;
  return o;
}

/**
 * One managed-service call made for a sample, counts and tokens only. `input`
 * and `output` are the tokens the service reported; they are absent for a
 * failed call and after a deep-to-fast fallback, which reports none.
 * `cachedInput` is the part of `input` the provider served from its prompt
 * cache; it is absent when the provider did not report it.
 */
export interface CallRecord {
  purpose: "hotkey" | "preparation";
  lane: "fast" | "deep";
  outcome: "complete" | "failure" | "cancelled";
  input?: number;
  output?: number;
  cachedInput?: number;
}
export interface SampleOutcome {
  caseId: string;
  checkpointId: string;
  intent: AssistanceIntent;
  sample: number;
  /** Absent when no validated model card was produced (fallback, failure or timeout). */
  card?: Pick<GuidanceCard, "say" | "why" | "evidence" | "uncertain"> & {
    headline?: string;
    /**
     * The model's own 0-1 self-scores for the card, kept so they can later be
     * checked against the judge's verdict. Local detail only: never sent to the
     * judge and never part of a run summary.
     */
    scores?: Pick<GuidanceCard, "usefulness" | "relevance" | "novelty" | "answerQuality">;
  };
  failure?: string;
  verdict?: JudgeVerdict;
  latency: {
    path: "cold" | "review";
    firstCardMs?: number;
    /** Per-stage breakdown of the cold or review request. `render` is app-only and absent here. */
    stages?: StageTimings;
    /**
     * Background preparation at the checkpoint basis; the prepared card itself is not judged.
     * `lookupMs` is the in-memory hotkey lookup of the prepared card.
     */
    prepared?: { ready: boolean; preparationMs?: number; lookupMs?: number };
  };
  provider?: { provider: string; model: string };
  /**
   * Every managed-service call this sample made (hotkey card, brevity repairs
   * and the mirrored preparation job). Absent in outcomes recorded before
   * token accounting existed.
   */
  calls?: CallRecord[];
}
/**
 * Thresholds mirror the human pilot rule (usefulness and specificity >= 4,
 * nonObviousValue >= 4 for contribute/digDeeper, answerQuality >= 4 for
 * respond) for the dimensions a judge can assess; timeliness (>= 3) and
 * distraction (<= 2) stay with human pilot ratings in real calls.
 * Brevity >= 3 is an assumed default.
 */
export function samplePasses(
  sample: SampleOutcome,
  fidelityRequired: boolean,
): { pass: boolean; reasons: string[] } {
  if (!sample.card) return { pass: false, reasons: [sample.failure ?? "noCard"] };
  const v = sample.verdict;
  if (!v) return { pass: false, reasons: [sample.failure ?? "notJudged"] };
  const reasons = [
    ...v.items.filter((i) => !i.pass).map((i) => i.id),
    v.unflaggedUnsupportedClaim && "unflaggedUnsupportedClaim",
    v.repeatsEstablished && "repeatsEstablished",
    v.falseCoverage && "falseCoverage",
    fidelityRequired && !v.fidelity?.pass && "fidelity",
    v.scores.usefulness < 4 && "usefulness",
    v.scores.specificity < 4 && "specificity",
    v.scores.brevity < 3 && "brevity",
    ["contribute", "digDeeper"].includes(sample.intent) &&
      v.scores.nonObviousValue < 4 &&
      "nonObviousValue",
    sample.intent === "respond" &&
      v.scores.answerQuality < 4 &&
      "answerQuality",
  ].filter((r): r is string => !!r);
  return { pass: reasons.length === 0, reasons };
}
export interface CheckpointResult {
  caseId: string;
  checkpointId: string;
  intent: AssistanceIntent;
  profile: GuidanceCase["profile"];
  language: GuidanceCase["language"];
  /** Worst sample: passes only when every sample passes. */
  pass: boolean;
  anyPass: boolean;
  reasons: string[];
  hardFails: { grounding: boolean; repetition: boolean };
}
/**
 * A checkpoint with fewer samples than the run asked for (a lost or skipped
 * sample) fails with `missingSamples`: worst-sample scoring is only as strong
 * as the samples it saw.
 */
export function scoreCheckpoint(
  c: GuidanceCase,
  checkpoint: Checkpoint,
  samples: SampleOutcome[],
  samplesPerCheckpoint: number,
): CheckpointResult {
  const outcomes = samples.map((s) => samplePasses(s, needsFidelity(c)));
  const complete = samples.length > 0 && samples.length >= samplesPerCheckpoint;
  return {
    caseId: c.id,
    checkpointId: checkpoint.id,
    intent: checkpoint.intent,
    profile: c.profile,
    language: c.language,
    pass: complete && outcomes.every((o) => o.pass),
    anyPass: outcomes.some((o) => o.pass),
    reasons: [
      ...new Set([
        ...outcomes.flatMap((o) => o.reasons),
        ...(complete ? [] : ["missingSamples"]),
      ]),
    ],
    hardFails: {
      grounding: samples.some((s) => s.verdict?.unflaggedUnsupportedClaim),
      repetition: samples.some((s) => s.verdict?.repeatsEstablished),
    },
  };
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
};
const round = (n: number | null, digits = 3) =>
  n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const rate = (results: CheckpointResult[]) =>
  results.length ? round(results.filter((r) => r.pass).length / results.length) : null;
function groupRates<K extends keyof CheckpointResult>(
  results: CheckpointResult[],
  key: K,
) {
  const groups: Record<string, CheckpointResult[]> = {};
  for (const r of results) (groups[String(r[key])] ??= []).push(r);
  return Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rs]) => [k, { checkpoints: rs.length, passRate: rate(rs) }]),
  );
}
export interface Calibration {
  judgeModel: string;
  rubricHash: string;
  date: string;
  ratings: number;
  agreement: number;
}
export interface RunMeta {
  date: string;
  commit: string;
  caseSetRevision: string;
  judgeModel: string;
  rubricHash: string;
  samplesPerCheckpoint: number;
  complete: boolean;
  costUsd: { generator: number; judge: number };
}
export const CALIBRATION_MIN_RATINGS = 20;
export const CALIBRATION_MIN_AGREEMENT = 0.8;
/**
 * Why the stored calibration does not let the judge count toward the gate, in
 * words a person can act on; empty when it does. Only a new blind rating
 * session (`--calibrate`, then `--calibration-check`) clears these.
 */
export function calibrationProblems(
  calibration: Calibration | undefined,
  judgeModel: string,
  rubricHash: string,
): string[] {
  if (!calibration) return ["no calibration.json: the judge has never been calibrated"];
  return [
    calibration.rubricHash !== rubricHash &&
      `rubric changed since calibration on ${calibration.date} (calibrated ${calibration.rubricHash}, current ${rubricHash})`,
    calibration.judgeModel !== judgeModel &&
      `judge model changed (calibrated ${calibration.judgeModel}, current ${judgeModel})`,
    calibration.ratings < CALIBRATION_MIN_RATINGS &&
      `only ${calibration.ratings} fully rated cards (needs ${CALIBRATION_MIN_RATINGS})`,
    calibration.agreement < CALIBRATION_MIN_AGREEMENT &&
      `agreement ${(calibration.agreement * 100).toFixed(1)}% is below ${CALIBRATION_MIN_AGREEMENT * 100}%`,
  ].filter((r): r is string => !!r);
}
export function calibrationValid(
  calibration: Calibration | undefined,
  judgeModel: string,
  rubricHash: string,
): boolean {
  return calibrationProblems(calibration, judgeModel, rubricHash).length === 0;
}
/** The hard-fail flags are calibrated alongside the scores, since they decide the gate. */
export const calibrationFlags = ["unflaggedUnsupportedClaim", "repeatsEstablished"] as const;
export type CalibrationRating = JudgeScores &
  Record<(typeof calibrationFlags)[number], boolean>;
export const completeRating = (r: Partial<CalibrationRating> | undefined): r is CalibrationRating =>
  !!r &&
  judgeDimensions.every((d) => int(r[d])) &&
  calibrationFlags.every((f) => typeof r[f] === "boolean");
/**
 * Share of agreeing ratings over fully rated cards: scores within one point,
 * hard-fail flags identical. Partially rated cards are not counted.
 */
export function calibrationAgreement(
  pairs: { human: Partial<CalibrationRating>; judge: CalibrationRating }[],
): { agreement: number; compared: number; cards: number } {
  let compared = 0,
    agreed = 0,
    cards = 0;
  for (const { human, judge } of pairs) {
    if (!completeRating(human)) continue;
    cards++;
    for (const d of judgeDimensions) {
      compared++;
      if (Math.abs(human[d] - judge[d]) <= 1) agreed++;
    }
    for (const f of calibrationFlags) {
      compared++;
      if (human[f] === judge[f]) agreed++;
    }
  }
  return { agreement: compared ? round(agreed / compared)! : 0, compared, cards };
}
const perMeeting = (values: number[]) =>
  values.length
    ? { mean: round(values.reduce((a, v) => a + v, 0) / values.length, 2), max: Math.max(...values) }
    : null;
/**
 * Tokens and call counts of the managed-service calls in a run, by purpose,
 * intent and lane, plus calls per replayed meeting (one case replayed once
 * per sample). Counts and tokens only, so it is safe to record.
 *
 * Preparation here mirrors the runtime's job once per non-review checkpoint,
 * so `preparationCallsPerMeeting` counts what the replay asked for, not how
 * many jobs the app's trigger rules start in a live meeting (the app's own
 * preparation counts do that).
 */
export function summarizeUsage(samples: SampleOutcome[]) {
  const groups = new Map<string, {
    purpose: CallRecord["purpose"];
    intent: AssistanceIntent;
    lane: CallRecord["lane"];
    calls: number;
    callsWithUsage: number;
    inputTokens: number;
    outputTokens: number;
    callsWithCachedInput: number;
    cachedInputTokens: number;
    /** Input tokens of the calls that reported a cached count: the denominator of the cached share. */
    inputTokensWithCachedReport: number;
  }>();
  const meetings = new Map<string, { hotkey: number; preparation: number }>();
  for (const sample of samples) {
    if (!sample.calls) continue;
    const meeting = meetings.get(`${sample.caseId}#${sample.sample}`) ?? { hotkey: 0, preparation: 0 };
    meetings.set(`${sample.caseId}#${sample.sample}`, meeting);
    for (const call of sample.calls) {
      meeting[call.purpose]++;
      const key = `${call.purpose}/${sample.intent}/${call.lane}`;
      const group = groups.get(key) ?? {
        purpose: call.purpose,
        intent: sample.intent,
        lane: call.lane,
        calls: 0,
        callsWithUsage: 0,
        inputTokens: 0,
        outputTokens: 0,
        callsWithCachedInput: 0,
        cachedInputTokens: 0,
        inputTokensWithCachedReport: 0,
      };
      groups.set(key, group);
      group.calls++;
      if (typeof call.input === "number" && typeof call.output === "number") {
        group.callsWithUsage++;
        group.inputTokens += call.input;
        group.outputTokens += call.output;
        if (typeof call.cachedInput === "number") {
          group.callsWithCachedInput++;
          group.cachedInputTokens += call.cachedInput;
          group.inputTokensWithCachedReport += call.input;
        }
      }
    }
  }
  return {
    byIntentLane: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, { inputTokensWithCachedReport, ...g }]) => ({
        ...g,
        meanInputTokens: g.callsWithUsage ? round(g.inputTokens / g.callsWithUsage, 1) : null,
        meanOutputTokens: g.callsWithUsage ? round(g.outputTokens / g.callsWithUsage, 1) : null,
        // Null when no call reported a cached count (older runs, providers that do not report it).
        meanCachedInputTokens: g.callsWithCachedInput
          ? round(g.cachedInputTokens / g.callsWithCachedInput, 1)
          : null,
        cachedInputShare: inputTokensWithCachedReport
          ? round(g.cachedInputTokens / inputTokensWithCachedReport)
          : null,
      })),
    replayedMeetings: meetings.size,
    hotkeyCallsPerMeeting: perMeeting([...meetings.values()].map((m) => m.hotkey)),
    preparationCallsPerMeeting: perMeeting([...meetings.values()].map((m) => m.preparation)),
  };
}
export const GATE_MIN_PASS_RATE = 0.9;
export function summarizeRun(
  meta: RunMeta,
  cases: GuidanceCase[],
  samples: SampleOutcome[],
  calibration: Calibration | undefined,
) {
  if (cases.some((c) => c.private))
    throw new Error("Private cases never enter a run summary");
  const results = cases.flatMap((c) =>
    c.checkpoints.map((cp) =>
      scoreCheckpoint(
        c,
        cp,
        samples.filter((s) => s.caseId === c.id && s.checkpointId === cp.id),
        meta.samplesPerCheckpoint,
      ),
    ),
  );
  const judged = samples.filter((s) => s.verdict);
  const scores = Object.fromEntries(
    judgeDimensions.map((d) => {
      const perCheckpoint = results.map((r) =>
        judged
          .filter((s) => s.caseId === r.caseId && s.checkpointId === r.checkpointId)
          .map((s) => s.verdict!.scores[d]),
      ).filter((v) => v.length);
      return [
        d,
        {
          worstMean: round(
            perCheckpoint.reduce((a, v) => a + Math.min(...v), 0) /
              Math.max(1, perCheckpoint.length),
            2,
          ),
          medianMean: round(
            perCheckpoint.reduce((a, v) => a + median(v)!, 0) /
              Math.max(1, perCheckpoint.length),
            2,
          ),
        },
      ];
    }),
  );
  const latency = (path: "cold" | "review") => {
    const ofPath = samples.filter((s) => s.latency.path === path);
    const ms = ofPath
      .map((s) => s.latency.firstCardMs)
      .filter((n): n is number => typeof n === "number");
    return {
      requests: ofPath.length,
      cards: ms.length,
      p50Ms: percentile(ms, 50),
      p90Ms: percentile(ms, 90),
      p95Ms: percentile(ms, 95),
      stages: summarizeStages(
        ofPath.map((s) => s.latency.stages).filter((t): t is StageTimings => !!t),
      ),
    };
  };
  const prepared = samples
    .map((s) => s.latency.prepared)
    .filter((p): p is NonNullable<SampleOutcome["latency"]["prepared"]> => !!p);
  const lookupMs = prepared
    .map((p) => p.lookupMs)
    .filter((n): n is number => typeof n === "number");
  const unjudgedSamples = samples.filter((s) => s.card && !s.verdict).length;
  const preparedMs = prepared
    .map((p) => p.preparationMs)
    .filter((n): n is number => typeof n === "number");
  const calibrated = calibrationValid(calibration, meta.judgeModel, meta.rubricHash);
  const summary = {
    version: 1,
    ...meta,
    costUsd: {
      generator: round(meta.costUsd.generator, 4),
      judge: round(meta.costUsd.judge, 4),
      total: round(meta.costUsd.generator + meta.costUsd.judge, 4),
    },
    generator: [
      ...new Set(
        samples
          .filter((s) => s.provider)
          .map((s) => `${s.provider!.provider}/${s.provider!.model}`),
      ),
    ].sort(),
    calibration: calibration
      ? { valid: calibrated, date: calibration.date, agreement: calibration.agreement }
      : { valid: false },
    checkpoints: results.length,
    passRate: {
      worst: rate(results),
      best: results.length
        ? round(results.filter((r) => r.anyPass).length / results.length)
        : null,
    },
    byIntent: groupRates(results, "intent"),
    byProfile: groupRates(results, "profile"),
    byLanguage: groupRates(results, "language"),
    hardFails: {
      grounding: results.filter((r) => r.hardFails.grounding).length,
      repetition: results.filter((r) => r.hardFails.repetition).length,
    },
    unjudgedSamples,
    scores,
    usage: summarizeUsage(samples),
    latency: {
      cold: latency("cold"),
      review: latency("review"),
      prepared: {
        attempts: prepared.length,
        readyRate: prepared.length
          ? round(prepared.filter((p) => p.ready).length / prepared.length)
          : null,
        preparationP50Ms: percentile(preparedMs, 50),
        preparationP90Ms: percentile(preparedMs, 90),
        preparationP95Ms: percentile(preparedMs, 95),
        lookupP50Ms: percentile(lookupMs, 50),
        lookupP95Ms: percentile(lookupMs, 95),
      },
    },
    failed: results
      .filter((r) => !r.pass)
      .map((r) => ({ case: r.caseId, checkpoint: r.checkpointId, reasons: r.reasons })),
  };
  return { ...summary, gate: guidanceEvalGate(summary) };
}
export type RunSummary = ReturnType<typeof summarizeRun>;
/**
 * The judge may settle grounding, repetition, brevity/format and
 * usefulness/novelty. Timeliness, distraction and live latency stay with
 * human ratings in real calls.
 */
export const GATE_MIN_SAMPLES = 2;
export function guidanceEvalGate(summary: {
  complete: boolean;
  samplesPerCheckpoint: number;
  unjudgedSamples: number;
  checkpoints: number;
  passRate: { worst: number | null };
  hardFails: { grounding: number; repetition: number };
  calibration: { valid: boolean };
}): { pass: boolean; reasons: string[] } {
  const reasons = [
    !summary.complete && "runIncomplete",
    summary.samplesPerCheckpoint < GATE_MIN_SAMPLES && "samplesBelow2",
    summary.unjudgedSamples > 0 && "unjudgedSamples",
    !summary.calibration.valid && "judgeNotCalibrated",
    summary.checkpoints === 0 && "noCheckpoints",
    (summary.passRate.worst ?? 0) < GATE_MIN_PASS_RATE && "passRateBelow90",
    summary.hardFails.grounding > 0 && "groundingHardFail",
    summary.hardFails.repetition > 0 && "repetitionHardFail",
  ].filter((r): r is string => !!r);
  return { pass: reasons.length === 0, reasons };
}
/** Lists checkpoints that passed before and fail now, plus summary-level drops. */
export function compareRuns(
  // Summaries recorded before token accounting have no `usage`.
  previous: Omit<RunSummary, "usage"> & Partial<Pick<RunSummary, "usage">>,
  next: RunSummary,
): string[] {
  const failedBefore = new Set(previous.failed.map((f) => `${f.case}/${f.checkpoint}`));
  const regressions = next.failed
    .map((f) => `${f.case}/${f.checkpoint}`)
    .filter((key) => !failedBefore.has(key))
    .map((key) => `newly failing: ${key}`);
  if ((next.passRate.worst ?? 0) < (previous.passRate.worst ?? 0))
    regressions.push(
      `pass rate ${previous.passRate.worst} -> ${next.passRate.worst}`,
    );
  for (const path of ["cold", "review"] as const) {
    const before = previous.latency[path].p50Ms,
      after = next.latency[path].p50Ms;
    if (before !== null && after !== null && after > before * 1.25)
      regressions.push(`${path} p50 ${before} ms -> ${after} ms`);
  }
  return regressions;
}
