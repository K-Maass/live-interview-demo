import type { InferenceTransport } from "./engine";
import { guidancePrompt } from "./engine";
import type { ModelJob, ModelResult } from "../contracts";

/**
 * Per-stage guidance latency. A hotkey request passes through these stages in
 * order; each is a duration in milliseconds, summed over provider attempts
 * (a brevity repair adds a second prompt build and provider call).
 */
export const guidanceStages = [
  "snapshotRead",
  "promptBuild",
  "providerFirstToken",
  "providerTotal",
  "render",
] as const;
export type GuidanceStage = (typeof guidanceStages)[number];

export interface StageTimings {
  snapshotRead?: number;
  promptBuild?: number;
  /**
   * Only set when the provider route streams and the transport reports the
   * first token. Absent when the service lacks the streaming route and the
   * client fell back to the single-body route.
   */
  providerFirstToken?: number;
  /** Provider call as the app sees it: IPC, service and provider time. */
  providerTotal?: number;
  /** Card emitted until the next frame after the view update. */
  render?: number;
  /** Hotkey (recorder creation) until the first card was emitted. */
  total?: number;
  providerAttempts?: number;
}

export interface TimingTrace {
  firstToken(sinceCallStartMs?: number): void;
}

const clock = () => performance.now();
const round = (ms: number) => Math.round(ms * 10) / 10;

export class StageRecorder {
  private readonly startedAt: number;
  private readonly timings: StageTimings = {};
  private attempts: { totalMs: number; firstTokenMs?: number }[] = [];
  private attemptStartedAt?: number;
  private attemptFirstTokenMs?: number;
  constructor(private now: () => number = clock) {
    this.startedAt = now();
  }
  add(stage: "snapshotRead" | "promptBuild" | "render", ms: number) {
    this.timings[stage] = (this.timings[stage] ?? 0) + ms;
  }
  time<T>(stage: "snapshotRead" | "promptBuild", work: () => T): T {
    const start = this.now();
    try {
      return work();
    } finally {
      this.add(stage, this.now() - start);
    }
  }
  /**
   * A transport that streams calls this when the first token arrives. A
   * transport that only learns of it afterwards (the native host reports it
   * with the finished result) passes the offset from the call start.
   */
  firstToken(sinceCallStartMs?: number) {
    if (this.attemptStartedAt !== undefined)
      this.attemptFirstTokenMs ??=
        sinceCallStartMs ?? this.now() - this.attemptStartedAt;
  }
  async provider<T>(work: (trace: TimingTrace) => Promise<T>): Promise<T> {
    this.attemptStartedAt = this.now();
    this.attemptFirstTokenMs = undefined;
    try {
      return await work(this);
    } finally {
      this.attempts.push({
        totalMs: this.now() - this.attemptStartedAt,
        firstTokenMs: this.attemptFirstTokenMs,
      });
      this.attemptStartedAt = undefined;
    }
  }
  /** Milliseconds since the recorder was created (the hotkey, in the app). */
  elapsed() {
    return round(this.now() - this.startedAt);
  }
  snapshot(): StageTimings {
    const out: StageTimings = { ...this.timings };
    if (this.attempts.length) {
      out.providerAttempts = this.attempts.length;
      out.providerTotal = this.attempts.reduce((sum, a) => sum + a.totalMs, 0);
      const last = this.attempts.at(-1)!;
      // Earlier attempts finished before the last one began.
      if (last.firstTokenMs !== undefined)
        out.providerFirstToken =
          out.providerTotal - last.totalMs + last.firstTokenMs;
    }
    for (const key of Object.keys(out) as (keyof StageTimings)[])
      if (key !== "providerAttempts") out[key] = round(out[key]!);
    return out;
  }
}

/**
 * Wraps a provider call so prompt build and provider time are recorded. Both
 * the app and the evaluation harness build prompts here, so they measure the
 * same thing.
 */
export function timedTransport(
  recorder: StageRecorder,
  send: (
    job: ModelJob,
    prompt: string,
    trace: TimingTrace,
  ) => Promise<ModelResult>,
): InferenceTransport {
  return {
    async run(job) {
      const prompt = recorder.time("promptBuild", () => guidancePrompt(job));
      return recorder.provider((trace) => send(job, prompt, trace));
    },
  };
}

/** Nearest-rank percentile; null without samples. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

export interface StageSummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}
export type LatencySummary = Record<
  GuidanceStage | "total",
  StageSummary
>;

/** `count` is how many requests measured that stage, so gaps stay visible. */
export function summarizeStages(traces: StageTimings[]): LatencySummary {
  const summary = {} as LatencySummary;
  for (const stage of [...guidanceStages, "total"] as const) {
    const values = traces
      .map((t) => t[stage])
      .filter((n): n is number => typeof n === "number");
    summary[stage] = {
      count: values.length,
      p50Ms: percentile(values, 50),
      p95Ms: percentile(values, 95),
    };
  }
  return summary;
}

/**
 * Counts of speculative preparation jobs in one meeting. Counts only: no
 * intent, no text, no ids. `started` splits into the three ways a job ends
 * plus the jobs still in flight.
 */
export interface PreparationCounts {
  /** Preparation jobs begun (each may make several provider calls). */
  started: number;
  /** Result validated and stored in the prepared cache. */
  completed: number;
  /** Result discarded because the basis moved on, or the job was cancelled, paused or stopped. */
  superseded: number;
  /** Provider failure, empty or invalid output, or the job's own timeout. */
  failed: number;
  /** Provider calls made by these jobs, brevity repairs included. */
  providerCalls: number;
  /** Started but not yet ended. */
  inFlight: number;
}

export class PreparationCounter {
  private counts = { started: 0, completed: 0, superseded: 0, failed: 0, providerCalls: 0 };
  start() {
    this.counts.started++;
  }
  /** Ends one started job. `providerCalls` is how many calls it made. */
  end(outcome: "completed" | "superseded" | "failed", providerCalls = 0) {
    this.counts[outcome]++;
    this.counts.providerCalls += providerCalls;
  }
  snapshot(): PreparationCounts {
    const { started, completed, superseded, failed } = this.counts;
    return {
      ...this.counts,
      inFlight: started - completed - superseded - failed,
    };
  }
}
