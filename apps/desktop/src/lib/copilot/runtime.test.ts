import { afterEach, expect, test, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
import {
  CopilotRuntime,
  MEETING_PREPARATION_BUDGET,
  PREPARATION_TURN_INTERVAL_MS,
  REMOTE_MAX_WAIT_MS,
  preparationIntervalMs,
  nativeReasoningHost,
  type DraftUpdate,
  type GuidanceLatencyTrace,
} from "./runtime";
import { describeStatus, type StatusEvent } from "./status";
import {
  applyGuidanceEvent,
  dismissCard,
  pinTopic,
  type LiveViewState,
} from "@live-interview/core";
import type {
  HotkeyContext,
  ModelJob,
  SpeechEvent,
  GuidanceEvent,
  ModelResult,
} from "@live-interview/core";
afterEach(() => vi.useRealTimers());
test("workspace revocation clears ready context immediately and rejects in-flight retrieval", async () => {
  const source = {
    sourceId: "revoked-source",
    workspaceId: "w",
    kind: "workspace" as const,
    title: "Selected note",
    text: "Private former context",
    locator: "note.txt",
    revision: 1,
    derived: false,
  };
  let settle: (hits: any[]) => void = () => {};
  let calls = 0;
  const runtime = new CopilotRuntime(
    { ...options, sharedLibraryIds: ["library"] },
    () => {},
    () => {},
    {
      run: async () => {
        throw Error("no provider expected");
      },
      decide: async () => ({ intent: "digDeeper", intervene: false }),
      refresh: async () => [],
      retrieve: async () => {
        calls++;
        return calls === 1
          ? [source]
          : new Promise<any[]>((resolve) => {
              settle = resolve;
            });
      },
    },
  );
  await (runtime as any).refreshContext();
  expect(
    runtime.snapshots
      .read(runtime.state)
      .snapshot.context.sources.map((s) => s.sourceId),
  ).toContain("revoked-source");
  runtime.invalidateWorkspace("other");
  expect(
    runtime.snapshots.read(runtime.state).snapshot.context.sources,
  ).toHaveLength(1);
  runtime.invalidateWorkspace("library");
  expect(
    runtime.snapshots.read(runtime.state).snapshot.context.sources,
  ).toHaveLength(0);
  const pending = (runtime as any).refreshContext();
  await Promise.resolve();
  await Promise.resolve();
  runtime.invalidateWorkspace("w");
  settle([source]);
  await pending;
  expect(
    runtime.snapshots.read(runtime.state).snapshot.context.sources,
  ).toHaveLength(0);
  runtime.stop();
});
test("late history output cannot restore revoked workspace text", async () => {
  let settle: (result: any) => void = () => {};
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: (job) => {
        jobs.push(job);
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    },
  );
  runtime.state.segments = [speech("m", 1)];
  runtime.state.observationSequence = 1;
  const pending = (runtime as any).summarise();
  runtime.invalidateWorkspace("w");
  settle({
    jobId: jobs[0].id,
    basis: jobs[0].basis,
    outcome: "complete",
    output: {
      summary: "Revoked private source detail",
      evidence: ["segment:s1"],
      coveredObjectives: [],
    },
  });
  await pending;
  expect(runtime.state.historySummary).toBeUndefined();
  expect(JSON.stringify(runtime.snapshots.read(runtime.state))).not.toContain(
    "Revoked private source detail",
  );
  runtime.stop();
});
test("workspace revocation discards derived summaries and late public research", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  let settle: (hits: any[]) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "search_public_text"
      ? new Promise<any[]>((resolve) => {
          settle = resolve;
        })
      : undefined,
  );
  const runtime = new CopilotRuntime(
    { ...options, publicResearchTopics: ["approval workflow"] },
    () => {},
    () => {},
    {
      ...quietHost,
      run: async () => {
        throw Error("no model");
      },
    },
  );
  runtime.state.historySummary = {
    text: "Previously derived private text",
    evidence: [{ segmentId: "s1", revision: 1 }],
    throughSequence: 1,
    revision: 1,
  };
  const pending = runtime.researchPublic(
    "approval workflow official documentation",
  );
  runtime.invalidateWorkspace("w");
  expect(runtime.state.historySummary).toBeUndefined();
  settle([
    {
      sourceId: "late-web",
      workspaceId: "w",
      kind: "web",
      title: "Old query",
      text: "Late source",
      locator: "https://example.test",
      revision: 1,
      derived: false,
    },
  ]);
  await pending;
  expect((runtime as any).publicSources).toEqual([]);
  runtime.stop();
  vi.mocked(invoke).mockImplementation(async () => undefined);
});
const options = {
  id: "m",
  workspaceId: "w",
  purpose: "Deployment decision",
  objectives: ["Who approves?"],
  attendees: [],
  profileId: "interview" as const,
  profileRevision: 0,
};
const speech = (id: string, n: number): SpeechEvent => ({
  meetingId: id,
  segmentId: "s" + n,
  revision: 1,
  journalSequence: n,
  lane: "remote",
  startMs: n,
  endMs: n + 1,
  language: "en",
  text: "Compliance owns evidence, the business owns launch.",
  kind: "final",
});
test("foreign meeting events never trigger decisions or change live observations", async () => {
  const decide = vi.fn(async () => ({
    intent: "digDeeper" as const,
    intervene: false,
  }));
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      run: async () => {
        throw Error();
      },
      retrieve: async () => [],
      refresh: async () => [],
      decide,
    },
  );
  runtime.ingest(speech("other", 1));
  runtime.ingest(speech("other", 2));
  await Promise.resolve();
  expect(decide).not.toHaveBeenCalled();
  expect(runtime.state.observationSequence).toBe(0);
  runtime.stop();
});
test("all dispatched background jobs are canceled on stop and never publish a late summary", async () => {
  const jobs: ModelJob[] = [];
  let settle: (v: any) => void = () => {};
  const host = {
    run: (job: ModelJob) => {
      jobs.push(job);
      return new Promise<any>((resolve) => (settle = resolve));
    },
    retrieve: async () => [],
    refresh: async () => [],
    decide: async (_b: HotkeyContext) => ({
      intent: "digDeeper" as const,
      intervene: false,
    }),
  };
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    host,
  );
  for (let n = 1; n <= 20; n++) runtime.ingest(speech("m", n));
  expect(jobs.length).toBe(1);
  runtime.stop();
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).toHaveBeenCalledWith("reasoning_cancel", {
    jobId: jobs[0].id,
  });
  settle({
    outcome: "complete",
    output: {
      summary: "Late result",
      evidence: ["segment:s1"],
      coveredObjectives: [],
    },
    basis: jobs[0].basis,
    jobId: jobs[0].id,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(runtime.state.historySummary).toBeUndefined();
});

const answer = (
  job: ModelJob,
  say = "Separate evidence collection from launch approval.",
): ModelResult => ({
  jobId: job.id,
  provider: "ibmLuna",
  model: "luna",
  basis: job.basis,
  outcome: "complete",
  output: {
    headline: "Decision and evidence",
    say,
    why: "The conversation gives them different owners.",
    evidence: ["segment:s1"],
    usefulness: 0.9,
    relevance: 0.9,
    novelty: 0.8,
    answerQuality: 0.9,
    uncertain: true,
  },
});
const quietHost = {
  retrieve: async () => [],
  refresh: async () => [],
  decide: async () => ({ intent: "digDeeper" as const, intervene: false }),
};
test("pausing assistance cancels the active shortening retry while recording state remains active", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: async (job) => {
        jobs.push(job);
        if (jobs.length > 1) return new Promise<ModelResult>(() => {});
        const first = answer(job);
        first.output = {
          ...(first.output as object),
          headline: "Qualify the answer",
          say: "qualification ".repeat(50),
        };
        return first;
      },
    },
  );
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs).toHaveLength(2);
  runtime.setAssistancePaused(true);
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).toHaveBeenCalledWith("reasoning_cancel", {
    jobId: jobs[1].id,
  });
  expect(runtime.state.status).toBe("active");
  runtime.stop();
});

test("hotkey emits a prepared card synchronously while retrieval is stalled, and skips the cold call when it is current", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      retrieve: () => new Promise(() => {}),
      run: async (job) => {
        jobs.push(job);
        if (job.trigger === "automatic") return answer(job);
        return new Promise(() => {});
      },
    },
  );
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(events).toEqual([]);
  const prepared = jobs.find(
    (job) => job.preparation && job.intent === "respond",
  );
  expect(prepared).toBeDefined();
  const snapshot = structuredClone(
    runtime.snapshots.read(runtime.state).snapshot,
  );
  snapshot.snapshotId = "published-after-preparation";
  snapshot.createdAtMs = Date.now();
  runtime.snapshots.publish(snapshot);
  const request = runtime.request("respond");
  expect(events).toMatchObject([
    {
      kind: "card",
      card: {
        origin: "cache",
        trigger: "requested",
        say: "Separate evidence collection from launch approval.",
        // The basis it was written against, so its evidence resolves; nothing new arrived since.
        basis: prepared!.basis,
        preparedFrom: { jobId: prepared?.id },
      },
    },
  ]);
  expect(events[0].kind === "card" && events[0].card.asOfMs).toBeFalsy();
  await request;
  // A prepared card on the hotkey's own lane with no newer turns needs no cold call.
  expect(jobs.filter((job) => job.trigger === "requested")).toHaveLength(0);
  runtime.stop();
});

test("a prepared card written before newer finished turns is shown as of its basis time and refined once", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(options, (e) => events.push(e), () => {}, {
    ...quietHost,
    run: async (job) => {
      jobs.push(job);
      return answer(job, job.preparation ? undefined : "A refined answer that has seen the new turn.");
    },
  });
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  const preparedAt = jobs.find((job) => job.preparation && job.intent === "respond")!;
  runtime.ingest({ ...speech("m", 2), lane: "me", text: "Who signs off the launch evidence then?" });
  await vi.advanceTimersByTimeAsync(100);
  await runtime.request("respond");
  const shown = events.filter((e) => e.kind === "card" || e.kind === "refinement");
  expect(shown[0]).toMatchObject({ kind: "card", card: { origin: "cache" } });
  expect(shown[0].kind === "card" && shown[0].card.asOfMs).toBeLessThanOrEqual(Date.now());
  expect(shown[0].kind === "card" && shown[0].card.basis.observationSequence).toBe(preparedAt.basis.observationSequence);
  expect(shown[1]).toMatchObject({ kind: "refinement", card: { origin: "model", say: "A refined answer that has seen the new turn." } });
  expect(jobs.filter((job) => job.trigger === "requested")).toHaveLength(1);
  runtime.stop();
});

test("a settled remote turn prepares the profile's intents quietly on Luna's fast lane", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const events: GuidanceEvent[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: async (job) => {
        jobs.push(job);
        return answer(job);
      },
    },
  );
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(7000);
  const preparations = jobs.filter((job) => job.preparation);
  // The interview profile's order; the deep reviews are not prepared.
  expect(preparations.map((job) => job.intent)).toEqual(["digDeeper", "respond"]);
  expect(
    preparations.every((job) => job.lane === "fast" && job.toolBudget === 0),
  ).toBe(true);
  expect(events).toEqual([]);
  const request = runtime.request("respond");
  expect(events[0]).toMatchObject({
    kind: "card",
    card: { origin: "cache", intent: "respond" },
  });
  await request;
  runtime.stop();
});

test("obsolete preparation is canceled and cannot publish; the next basis waits for that slot", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const events: GuidanceEvent[] = [];
  const pending: ((result: ModelResult) => void)[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: (job) => {
        jobs.push(job);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  );
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs).toHaveLength(1);
  runtime.ingest({
    ...speech("m", 1),
    revision: 2,
    text: "The evidence owner also approves launch.",
  });
  await vi.advanceTimersByTimeAsync(2000);
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).toHaveBeenCalledWith("reasoning_cancel", {
    jobId: jobs[0].id,
  });
  expect(jobs).toHaveLength(1);
  pending[0](answer(jobs[0], "Obsolete advice"));
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs).toHaveLength(2);
  expect(jobs[1].basis.transcriptDeltas[0].text).toBe(
    "The evidence owner also approves launch.",
  );
  expect(events).toEqual([]);
  const requested = runtime.request("respond");
  expect(events).toEqual([]);
  const fresh = jobs.find((job) => job.trigger === "requested")!;
  pending[jobs.indexOf(fresh)]({
    ...answer(fresh),
    outcome: "failure",
    output: null,
  });
  await requested;
  expect(events).not.toContainEqual(
    expect.objectContaining({
      card: expect.objectContaining({ say: "Obsolete advice" }),
    }),
  );
  runtime.stop();
});

test.each(["assistance", "meeting", "stop"])(
  "%s pause cancels preparation and suppresses late results/new jobs",
  async (mode) => {
    vi.useFakeTimers();
    const jobs: ModelJob[] = [];
    let settle: (result: ModelResult) => void = () => {};
    const runtime = new CopilotRuntime(
      options,
      () => {},
      () => {},
      {
        ...quietHost,
        run: (job) => {
          jobs.push(job);
          return new Promise((resolve) => {
            settle = resolve;
          });
        },
      },
    );
    runtime.ingest(speech("m", 1));
    await vi.advanceTimersByTimeAsync(1500);
    expect(jobs).toHaveLength(1);
    if (mode === "assistance") runtime.setAssistancePaused(true);
    else if (mode === "meeting") runtime.setPaused(true);
    else runtime.stop();
    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("reasoning_cancel", {
      jobId: jobs[0].id,
    });
    settle(answer(jobs[0]));
    runtime.ingest(speech("m", 2));
    await vi.advanceTimersByTimeAsync(35000);
    expect(jobs).toHaveLength(1);
    if (mode === "assistance")
      expect(runtime.state.observationSequence).toBe(2);
    runtime.stop();
  },
);

test("failed preparations cool down across changing context instead of hammering the provider", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: async (job) => {
        jobs.push(job);
        return { ...answer(job), outcome: "failure", output: null };
      },
    },
  );
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs).toHaveLength(1);
  runtime.ingest(speech("m", 2));
  await vi.advanceTimersByTimeAsync(20000);
  expect(jobs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(jobs).toHaveLength(2);
  runtime.stop();
});

test("recording-paused meetings still answer explicit requests from their retained context", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const events: GuidanceEvent[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: async (job) => {
        jobs.push(job);
        return answer(job);
      },
    },
  );
  runtime.ingest(speech("m", 1));
  runtime.setPaused(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(jobs).toEqual([]);
  await runtime.request("respond");
  expect(events).toMatchObject([
    {
      kind: "card",
      card: {
        origin: "model",
        say: "Separate evidence collection from launch approval.",
      },
    },
  ]);
  expect(jobs[0].basis.transcriptDeltas.map((e) => e.segmentId)).toEqual([
    "s1",
  ]);
  runtime.stop();
  await runtime.request("respond");
  expect(jobs).toHaveLength(1);
});

test.each(["dismiss", "pin"])(
  "late refinement of prepared guidance respects %s",
  async (action) => {
    vi.useFakeTimers();
    let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
    let fresh: ModelJob | undefined;
    let settle: (result: ModelResult) => void = () => {};
    const runtime = new CopilotRuntime(
      options,
      (e) => {
        view = applyGuidanceEvent(view, e);
      },
      () => {},
      {
        ...quietHost,
        run: async (job) => {
          if (job.preparation) return answer(job);
          fresh = job;
          return new Promise((resolve) => {
            settle = resolve;
          });
        },
      },
    );
    runtime.ingest(speech("m", 1));
    await vi.advanceTimersByTimeAsync(1500);
    // digDeeper's hotkey runs on the deep lane, so its fast prepared card is refined.
    const request = runtime.request("digDeeper");
    const initial = view.cards[0];
    expect(initial?.origin).toBe("cache");
    view =
      action === "dismiss"
        ? dismissCard(view, initial.id)
        : pinTopic(view, initial.id);
    settle(answer(fresh!, "A fresh refinement"));
    await request;
    if (action === "dismiss") expect(view.cards).toEqual([]);
    else {
      expect(view.cards[0].say).toBe(
        "Separate evidence collection from launch approval.",
      );
      expect(view.cards[0].pinned).toBe(true);
      expect(view.queued).toBe(1);
    }
    runtime.stop();
  },
);

test("a new retrieval hit does not invalidate a prepared answer: only changed or invalidated sources do", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: async (job) => answer(job),
    },
  );
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  const snapshot = structuredClone(
    runtime.snapshots.read(runtime.state).snapshot,
  );
  snapshot.context.sources = [
    {
      sourceId: "new-policy",
      workspaceId: "w",
      kind: "markdown",
      title: "Policy",
      text: "The evidence owner also approves launch.",
      locator: "policy.md",
      revision: 1,
      derived: false,
    },
  ];
  runtime.snapshots.publish(snapshot);
  await runtime.request("respond");
  expect(events[0]).toMatchObject({ kind: "card", card: { origin: "cache" } });
  runtime.stop();
});

test.each(["speech", "source", "profile", "pins"])(
  "%s immediately marks displayed prepared wording historical, including after rejected refinement",
  async (change) => {
    vi.useFakeTimers();
    let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
    let sourceChanged = false;
    let fresh: ModelJob | undefined;
    let settle: (result: ModelResult) => void = () => {};
    const runtime = new CopilotRuntime(
      options,
      (event) => {
        view = applyGuidanceEvent(view, event);
      },
      () => {},
      {
        ...quietHost,
        refresh: async () => (sourceChanged ? ["policy"] : []),
        // The source is in the context the card was written from, so its change makes the card obsolete.
        retrieve: async () => [
          { sourceId: "policy", workspaceId: "w", kind: "markdown" as const, title: "Policy", text: "Approval needs evidence.", locator: "policy.md", revision: sourceChanged ? 2 : 1, derived: false },
        ],
        run: async (job) => {
          if (job.preparation) return answer(job);
          if (fresh)
            return { ...answer(job), outcome: "failure", output: null };
          fresh = job;
          return new Promise((resolve) => {
            settle = resolve;
          });
        },
      },
    );
    runtime.start();
    runtime.ingest(speech("m", 1));
    await vi.advanceTimersByTimeAsync(1500);
    const request = runtime.request("digDeeper");
    const original = structuredClone(view.cards[0]);
    expect(original.origin).toBe("cache");
    if (change === "speech")
      runtime.ingest({
        ...speech("m", 1),
        revision: 2,
        text: "The evidence owner now also approves launch.",
      });
    else if (change === "source") {
      sourceChanged = true;
      await vi.advanceTimersByTimeAsync(1000);
    } else if (change === "profile") runtime.setProfile("workClient");
    else {
      view = pinTopic(view, original.id);
      runtime.setPins(view.savedPins);
    }
    expect(view.cards[0]).toMatchObject({
      id: original.id,
      say: original.say,
      stale: true,
    });
    settle(answer(fresh!, "An obsolete refinement"));
    await request;
    expect(view.cards[0]).toMatchObject({
      id: original.id,
      say: original.say,
      stale: true,
    });
    runtime.stop();
  },
);

test.each(["assistance", "recording"])(
  "%s pause retains still-valid cached help when fresh reasoning fails",
  async (mode) => {
    vi.useFakeTimers();
    let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
    const jobs: ModelJob[] = [];
    const runtime = new CopilotRuntime(
      options,
      (event) => {
        view = applyGuidanceEvent(view, event);
      },
      () => {},
      {
        ...quietHost,
        run: async (job) => {
          jobs.push(job);
          return job.preparation
            ? answer(job)
            : { ...answer(job), outcome: "failure", output: null };
        },
      },
    );
    runtime.ingest(speech("m", 1));
    await vi.advanceTimersByTimeAsync(1500);
    if (mode === "assistance") runtime.setAssistancePaused(true);
    else runtime.setPaused(true);
    const request = runtime.request("respond");
    expect(view.cards[0]).toMatchObject({
      origin: "cache",
      stale: false,
      say: "Separate evidence collection from launch approval.",
    });
    await request;
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]).toMatchObject({ origin: "cache", stale: false });
    const preparedCount = jobs.filter((job) => job.preparation).length;
    // Past the prepared cache's 120 s lifetime, with no preparation while paused.
    await vi.advanceTimersByTimeAsync(125_000);
    expect(jobs.filter((job) => job.preparation)).toHaveLength(preparedCount);
    const expired = runtime.request("respond");
    await expired;
    expect(view.cards.at(-1)?.origin).toBe("clarification");
    runtime.stop();
  },
);

test("an unchanged conversation is prepared once per turn, and a new remote turn prepares again", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: async (job) => {
        jobs.push(job);
        return answer(job);
      },
    },
  );
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(65000);
  expect(jobs.filter((job) => job.preparation)).toHaveLength(2);
  runtime.ingest(speech("m", 2));
  await vi.advanceTimersByTimeAsync(7000);
  expect(jobs.filter((job) => job.preparation)).toHaveLength(4);
  runtime.stop();
});

test("a context worker finishing after stop cannot invalidate visible guidance or publish events", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  let waitForRefresh = false;
  let finishRefresh: (ids: string[]) => void = () => {};
  const runtime = new CopilotRuntime(
    options,
    (event) => {
      events.push(event);
    },
    () => {},
    {
      ...quietHost,
      refresh: async () =>
        waitForRefresh
          ? new Promise((resolve) => {
              finishRefresh = resolve;
            })
          : [],
      run: async (job) =>
        job.preparation
          ? answer(job)
          : { ...answer(job), outcome: "failure", output: null },
    },
  );
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  await runtime.request("respond");
  waitForRefresh = true;
  await vi.advanceTimersByTimeAsync(1000);
  runtime.stop();
  const afterStop = events.length;
  finishRefresh(["new-policy"]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(events).toHaveLength(afterStop);
  expect(runtime.state.invalidatedSourceIds).toEqual([]);
});

test("live retrieval carries the selected source and explicitly shared workspace scope", async () => {
  const retrieve = vi.fn(async () => []);
  const runtime = new CopilotRuntime(
    { ...options, sourceIds: [], sharedLibraryIds: ["shared-library"] },
    () => {},
    () => {},
    {
      run: async () => {
        throw Error("unused");
      },
      retrieve,
      refresh: async () => [],
      decide: async () => ({ intent: "digDeeper", intervene: false }),
    },
  );
  runtime.start();
  await vi.waitFor(() => expect(retrieve).toHaveBeenCalled());
  expect(retrieve.mock.calls[0]).toEqual([
    "w",
    expect.any(String),
    { sourceIds: [], sharedLibraryIds: ["shared-library"] },
  ]);
  runtime.stop();
});

// Polls instead of sleeping a fixed time, so a loaded machine only makes the test slower, never wrong.
async function waitUntil(done: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("a hotkey request reports every guidance stage as timings only, including render", async () => {
  // Counts the animation frames still to run, so the test can wait for exactly those.
  let frames = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames++;
    return setTimeout(() => {
      frames--;
      callback();
    }, 5);
  });
  const prompts: string[] = [];
  const traces: GuidanceLatencyTrace[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: async (job, prompt) => {
        prompts.push(prompt);
        await new Promise((r) => setTimeout(r, 20));
        return answer(job);
      },
    },
    (trace) => traces.push(structuredClone(trace)),
  );
  runtime.ingest(speech("m", 1));
  await runtime.request("respond");
  await waitUntil(() => traces.at(-1)?.timings.render !== undefined, "the render stage to be reported");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Intent: respond");
  const final = traces.at(-1)!;
  expect(final).toMatchObject({ path: "model", intent: "respond" });
  const { timings } = final;
  for (const stage of ["snapshotRead", "promptBuild", "providerTotal", "render", "total"] as const)
    expect(timings[stage], stage).toBeGreaterThanOrEqual(0);
  expect(timings.providerTotal).toBeGreaterThanOrEqual(10);
  expect(timings.total!).toBeGreaterThanOrEqual(timings.providerTotal!);
  expect(timings.providerAttempts).toBe(1);
  // This stand-in host reports no first token, so that stage stays empty.
  expect(timings).not.toHaveProperty("providerFirstToken");
  expect(JSON.stringify(traces)).not.toContain("Separate evidence");
  expect(runtime.latencyReport().model.providerTotal.count).toBe(1);
  // A throwing diagnostics callback must not stop card delivery.
  const cards: GuidanceEvent[] = [];
  const noisy = new CopilotRuntime(
    options,
    (e) => cards.push(e),
    () => {},
    { ...quietHost, run: async (job) => answer(job) },
    () => {
      throw new Error("diagnostics failed");
    },
  );
  noisy.ingest(speech("m", 1));
  await noisy.request("respond");
  expect(cards).toMatchObject([{ kind: "card", card: { origin: "model" } }]);
  noisy.stop();
  expect(runtime.latencyReport().prepared.total.count).toBe(0);
  runtime.stop();
  // Let the stubbed animation frames of both runtimes finish before the stub goes away.
  await waitUntil(() => frames === 0, "the stubbed animation frames to finish");
  vi.unstubAllGlobals();
});

test("a host that reports a first token fills the first-token stage; one that cannot leaves it empty", async () => {
  const traces: GuidanceLatencyTrace[] = [];
  let streamed = true;
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: async (job, _prompt, trace) => {
        await new Promise((r) => setTimeout(r, 20));
        if (streamed) trace?.firstToken(12);
        return answer(job);
      },
    },
    (trace) => traces.push(structuredClone(trace)),
  );
  runtime.ingest(speech("m", 1));
  await runtime.request("respond");
  expect(traces.at(-1)!.timings.providerFirstToken).toBe(12);
  expect(runtime.latencyReport().model.providerFirstToken).toMatchObject({
    count: 1,
    p50Ms: 12,
  });
  streamed = false;
  runtime.ingest(speech("m", 2));
  await runtime.request("digDeeper");
  expect(traces.at(-1)!.timings).not.toHaveProperty("providerFirstToken");
  expect(runtime.latencyReport().model.providerFirstToken.count).toBe(1);
  runtime.stop();
});

test("the native host passes the streamed first-token offset to the trace and strips it from the result", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const job = { id: "job-a" } as ModelJob;
  const result = { jobId: "job-a", outcome: "complete", output: {} };
  const trace = { firstToken: vi.fn() };
  vi.mocked(invoke).mockResolvedValueOnce({
    ...result,
    timing: { firstTokenMs: 310 },
  });
  const run = nativeReasoningHost().run;
  expect(await run(job, "prompt", trace)).toEqual(result);
  expect(trace.firstToken).toHaveBeenCalledWith(310);
  expect(invoke).toHaveBeenCalledWith("reasoning_run", {
    job,
    prompt: "prompt",
    onDraft: expect.anything(),
  });
  // Single-body fallback: no timing, so no first token is invented.
  vi.mocked(invoke).mockResolvedValueOnce(result);
  trace.firstToken.mockClear();
  expect(await run(job, "prompt", trace)).toEqual(result);
  expect(trace.firstToken).not.toHaveBeenCalled();
  vi.mocked(invoke).mockImplementation(async () => undefined);
});

const draftsOf = (events: GuidanceEvent[]) =>
  events.flatMap((e) => (e.kind === "draft" ? [e.text] : []));

test("a requested answer shows its first line as a draft that the validated card replaces", async () => {
  const events: GuidanceEvent[] = [];
  let sink: ((update: DraftUpdate) => void) | undefined;
  let finish: ((result: ModelResult) => void) | undefined;
  let job: ModelJob | undefined;
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: (j, _prompt, _trace, onDraft) => {
        job = j;
        sink = onDraft;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  runtime.ingest(speech("m", 1));
  const request = runtime.request("respond");
  expect(sink).toBeDefined();
  sink!({ delta: '{"say":"Who' });
  sink!({ delta: " signs off?" });
  sink!({ delta: '","why":"not shown' });
  // The route switched: the first route's text is void, the second one's is not.
  sink!({ reset: true });
  sink!({ delta: '{"say":"Fast' });
  expect(draftsOf(events)).toEqual([
    "Who",
    "Who signs off?",
    undefined,
    "Fast",
  ]);
  finish!(answer(job!, "Separate the evidence from launch approval."));
  await request;
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  for (const event of events) view = applyGuidanceEvent(view, event);
  expect(view.draft).toBeUndefined();
  const shown = [...view.cards, view.requestedCard].filter(Boolean);
  expect(shown.map((c) => c!.say)).toEqual([
    "Separate the evidence from launch approval.",
  ]);
  // Only the draft view ever carries the provisional text.
  expect(
    events
      .filter((e) => e.kind !== "draft")
      .map((e) => JSON.stringify(e))
      .join(""),
  ).not.toMatch(/Fast|Who signs/);
  runtime.stop();
});

test("a superseded request and a stopped runtime show no further draft", async () => {
  const events: GuidanceEvent[] = [];
  const sinks: ((update: DraftUpdate) => void)[] = [];
  const finish: ((result: ModelResult) => void)[] = [];
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: (_job, _prompt, _trace, onDraft) => {
        sinks.push(onDraft!);
        return new Promise((resolve) => finish.push(resolve));
      },
    },
  );
  runtime.ingest(speech("m", 1));
  const first = runtime.request("respond");
  const second = runtime.request("contribute");
  sinks[0]({ delta: '{"say":"Old request' });
  expect(draftsOf(events)).toEqual([]);
  sinks[1]({ delta: '{"say":"Current request' });
  expect(draftsOf(events)).toEqual(["Current request"]);
  // A newer request ends the draft of the one it replaced, even before it has text of its own.
  const third = runtime.request("digDeeper");
  expect(draftsOf(events)).toEqual(["Current request", undefined]);
  sinks[1]({ delta: " late" });
  expect(draftsOf(events)).toEqual(["Current request", undefined]);
  sinks[2]({ delta: '{"say":"Third' });
  expect(draftsOf(events)).toEqual(["Current request", undefined, "Third"]);
  runtime.stop();
  sinks[2]({ delta: " grows" });
  expect(draftsOf(events)).toEqual(["Current request", undefined, "Third"]);
  finish.forEach((resolve, i) =>
    resolve({ jobId: "x" + i, outcome: "failure" } as ModelResult),
  );
  await Promise.all([first, second, third]);
});

test("a shortening retry clears the draft of the attempt it replaces", async () => {
  const events: GuidanceEvent[] = [];
  let calls = 0;
  const runtime = new CopilotRuntime(
    options,
    (e) => events.push(e),
    () => {},
    {
      ...quietHost,
      run: async (job, _prompt, _trace, onDraft) => {
        calls++;
        if (calls === 1) {
          onDraft!({ delta: '{"say":"qualification qualification' });
          const long = answer(job);
          long.output = {
            ...(long.output as object),
            say: "qualification ".repeat(50),
          };
          return long;
        }
        onDraft!({ delta: '{"say":"Short' });
        return answer(job);
      },
    },
  );
  runtime.ingest(speech("m", 1));
  await runtime.request("respond");
  expect(calls).toBe(2);
  expect(draftsOf(events)).toEqual([
    "qualification qualification",
    undefined,
    "Short",
  ]);
  runtime.stop();
});

test("the native host streams provisional fragments over a channel and ignores late ones", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const job = { id: "job-a" } as ModelJob;
  const result = { jobId: "job-a", outcome: "complete", output: {} };
  const seen: DraftUpdate[] = [];
  let channel: { onmessage: (message: unknown) => void } | undefined;
  vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
    channel = (args as { onDraft: typeof channel }).onDraft;
    channel!.onmessage({ delta: "{" });
    channel!.onmessage({ reset: true });
    return result;
  });
  const run = nativeReasoningHost().run;
  expect(await run(job, "prompt", undefined, (u) => seen.push(u))).toEqual(
    result,
  );
  channel!.onmessage({ delta: "late" });
  expect(seen).toEqual([{ delta: "{" }, { reset: true }]);
  // Calls without a draft consumer still open a channel; Tauri requires one.
  vi.mocked(invoke).mockResolvedValueOnce(result);
  await run(job, "prompt");
  const args = vi.mocked(invoke).mock.lastCall![1] as { onDraft?: unknown };
  expect(args.onDraft).toBeDefined();
  vi.mocked(invoke).mockImplementation(async () => undefined);
});

test("preparation counts classify jobs as completed, superseded or failed and keep no content", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const pending: ((result: ModelResult) => void)[] = [];
  const stopped: unknown[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: (job) => {
        jobs.push(job);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
    undefined,
    (counts) => stopped.push(counts),
  );
  expect(runtime.latencyReport().preparation).toEqual({
    started: 0,
    completed: 0,
    superseded: 0,
    failed: 0,
    providerCalls: 0,
    inFlight: 0,
  });
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(runtime.latencyReport().preparation).toMatchObject({ started: 1, inFlight: 1 });
  // A turn in its basis is corrected while the first job runs: its late result is superseded.
  runtime.ingest({ ...speech("m", 1), revision: 2, journalSequence: 2, text: "Compliance owns launch too." });
  pending[0](answer(jobs[0], "Obsolete advice"));
  await vi.advanceTimersByTimeAsync(1500);
  expect(runtime.latencyReport().preparation).toMatchObject({
    started: 2,
    superseded: 1,
    completed: 0,
    providerCalls: 1,
    inFlight: 1,
  });
  // The second job still matches the current basis and is stored.
  pending[1](answer(jobs[1]));
  await vi.advanceTimersByTimeAsync(1500);
  expect(runtime.latencyReport().preparation).toMatchObject({ completed: 1, superseded: 1 });
  // The superseded intent ran again first (above); the turn's other intent follows and is stored too.
  pending[2](answer(jobs[2]));
  await vi.advanceTimersByTimeAsync(100);
  expect(jobs.map((j) => j.intent)).toEqual(["digDeeper", "digDeeper", "respond"]);
  // The next remote turn, after the turn interval, prepares again; a provider failure is a failed job.
  await vi.advanceTimersByTimeAsync(30_000);
  runtime.ingest(speech("m", 3));
  await vi.advanceTimersByTimeAsync(1500);
  pending[3]({ ...answer(jobs[3]), outcome: "failure", output: null });
  await vi.advanceTimersByTimeAsync(100);
  const counts = runtime.latencyReport().preparation;
  expect(counts.failed).toBe(1);
  expect(counts.started).toBe(counts.completed + counts.superseded + counts.failed + counts.inFlight);
  expect(counts.providerCalls).toBeGreaterThanOrEqual(4);
  // Counts only: nothing of the card text or the transcript is in the report.
  const report = JSON.stringify(runtime.latencyReport().preparation);
  expect(report).not.toContain("Obsolete advice");
  expect(report).not.toContain("Compliance");
  runtime.stop();
  runtime.stop();
  // The stop callback fires once, with the counts at that moment.
  expect(stopped).toHaveLength(1);
  expect(stopped[0]).toMatchObject({ started: counts.started });
});

test("a preparation job that outlives its 15 s timeout counts as failed, not superseded", async () => {
  vi.useFakeTimers();
  let settle: (result: ModelResult) => void = () => {};
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(
    options,
    () => {},
    () => {},
    {
      ...quietHost,
      run: (job) => {
        jobs.push(job);
        return new Promise<ModelResult>((resolve) => {
          settle = resolve;
        });
      },
    },
  );
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  await vi.advanceTimersByTimeAsync(15000);
  // The slot is held until the transport settles, even after the timeout cancelled the job.
  expect(runtime.latencyReport().preparation).toMatchObject({ started: 1, failed: 0, inFlight: 1 });
  settle(answer(jobs[0]));
  await vi.advanceTimersByTimeAsync(10);
  expect(runtime.latencyReport().preparation).toMatchObject({ started: 1, failed: 1, superseded: 0, inFlight: 0 });
  runtime.stop();
});

// Characterisation of today's trigger rules, not a requirement: the simulated provider takes
// `latencyMs`, utterances arrive every `gapMs`. Counts come from the real runtime scheduler.
// `readiness` is the share of seconds at which a hotkey for that intent would find a prepared
// card for the current basis (the in-memory lookup that never waits for retrieval).
// With `hotkeyEveryMs`, a hotkey is pressed on that cadence (intents in turn, at a moment when the
// remote speaker is mid-turn) and `hotkeys` reports how its cards ended: shown from the prepared
// cache, shown from a model call, or withheld as stale, plus the hotkey provider calls.
async function simulateMeeting(opts: { minutes: number; gapMs: number; latencyMs: number; partials?: boolean; hotkeyEveryMs?: number }) {
  vi.useFakeTimers();
  const statuses: StatusEvent[] = [];
  const events: GuidanceEvent[] = [];
  let hotkeyCalls = 0;
  const presses: { events: number; statuses: number }[] = [];
  const runtime = new CopilotRuntime(
    options,
    (event) => events.push(event),
    (event) => statuses.push(event),
    {
      ...quietHost,
      run: (job) =>
        (!job.preparation && job.trigger === "requested" && hotkeyCalls++, new Promise<ModelResult>((resolve) =>
          setTimeout(() => {
            // Cite a segment that is in this job's context, like a real provider would.
            const events = [
              ...job.basis.snapshot.context.conversation,
              ...job.basis.transcriptDeltas,
            ];
            const result = answer(job);
            (result.output as { evidence: string[] }).evidence = events.length
              ? [`segment:${events.at(-1)!.segmentId}`]
              : [];
            resolve(result);
          }, opts.latencyMs),
        )),
    },
  );
  runtime.start();
  const intents = [
    "respond",
    "digDeeper",
    "checkObjectives",
    "checkConversation",
    "contribute",
  ] as const;
  const hits = Object.fromEntries(intents.map((i) => [i, 0]));
  let sequence = 0;
  let segment = 0;
  const seconds = opts.minutes * 60;
  for (let t = 0; t < seconds; t++) {
    if (t % (opts.gapMs / 1000) === 0) {
      segment++;
      sequence++;
      runtime.ingest({
        ...speech("m", sequence),
        segmentId: `s${segment}`,
        lane: segment % 2 ? "remote" : "me",
        text: `Utterance ${segment} about approvals and launch evidence.`,
      });
    } else if (opts.partials) {
      sequence++;
      runtime.ingest({
        ...speech("m", sequence),
        segmentId: `s${segment + 1}`,
        kind: "partial",
        lane: segment % 2 ? "me" : "remote",
        text: `Utterance ${segment + 1} in progress ${sequence}`,
      });
    }
    await vi.advanceTimersByTimeAsync(500);
    // Mid-second, so a provider call that spans the next utterance sees it arrive.
    if (opts.hotkeyEveryMs && t > 0 && t % (opts.hotkeyEveryMs / 1000) === 0) {
      presses.push({ events: events.length, statuses: statuses.length });
      void runtime.request(intents[(t / (opts.hotkeyEveryMs / 1000)) % intents.length]);
    }
    await vi.advanceTimersByTimeAsync(500);
    const basis = runtime.snapshots.read(runtime.state);
    for (const intent of intents)
      if ((runtime as any).prepared.select(intent, basis, "requested")) hits[intent]++;
  }
  await vi.advanceTimersByTimeAsync(10_000);
  const counts = runtime.latencyReport().preparation;
  runtime.stop();
  const readiness = Object.fromEntries(
    intents.map((i) => [i, Math.round((hits[i] / seconds) * 100) / 100]),
  );
  // Per press: did a prepared or model card reach the screen, and was a model card withheld as stale?
  const outcomes = presses.map((press, n) => {
    const own = events.slice(press.events, presses[n + 1]?.events ?? events.length);
    const shown = own.flatMap((e) => (e.kind === "card" || e.kind === "refinement") && e.card.trigger === "requested" && e.card.origin !== "clarification" ? [e] : []);
    return {
      prepared: shown.some((e) => e.card.origin === "cache"),
      model: shown.some((e) => e.card.origin === "model"),
      withheld: statuses.slice(press.statuses, presses[n + 1]?.statuses ?? statuses.length).some((s) => s.code === "staleWithheld"),
    };
  });
  const share = (n: number) => (presses.length ? Math.round((n / presses.length) * 100) / 100 : 0);
  const hotkeys = {
    pressed: presses.length,
    prepared: outcomes.filter((o) => o.prepared).length,
    model: outcomes.filter((o) => o.model).length,
    withheld: outcomes.filter((o) => o.withheld).length,
    withheldRate: share(outcomes.filter((o) => o.withheld).length),
    noCardRate: share(outcomes.filter((o) => !o.prepared && !o.model).length),
    providerCalls: hotkeyCalls,
  };
  return { counts, readiness, hotkeys };
}

test("characterisation: preparation volume and hotkey outcomes of a 30-minute meeting", async () => {
  // Utterances every 6 s (alternating lanes) and every 30 s; a 2 s provider call.
  const dense = await simulateMeeting({ minutes: 30, gapMs: 6000, latencyMs: 2000 });
  const sparse = await simulateMeeting({ minutes: 30, gapMs: 30_000, latencyMs: 2000 });
  console.info("preparation volume (30 min, 2 s provider)", JSON.stringify({ dense, sparse }));
  // A hotkey every 20 s, intents in turn, pressed while the conversation goes on.
  const hotkeyDense = await simulateMeeting({ minutes: 30, gapMs: 6000, latencyMs: 2000, hotkeyEveryMs: 20_000 });
  const hotkeySparse = await simulateMeeting({ minutes: 30, gapMs: 30_000, latencyMs: 2000, hotkeyEveryMs: 20_000 });
  const hotkeyPartials = await simulateMeeting({ minutes: 30, gapMs: 6000, latencyMs: 2000, partials: true, hotkeyEveryMs: 20_000 });
  console.info("hotkeys (30 min, every 20 s, 2 s provider)", JSON.stringify({ hotkeyDense, hotkeySparse, hotkeyPartials }));
  for (const { counts } of [dense, sparse]) {
    expect(counts.started).toBe(counts.completed + counts.superseded + counts.failed + counts.inFlight);
    expect(counts.failed).toBe(0);
  }
  // Before: 723 dense / 328 sparse jobs (one per intent on every basis change, unbounded). Now a
  // settled remote turn prepares the profile's two intents, at most one turn per 30 s (widening as the
  // per-meeting budget is spent).
  expect(dense.counts.started).toBeLessThanOrEqual(2 * (30 * 60_000) / PREPARATION_TURN_INTERVAL_MS + 2);
  expect(dense.counts.started).toBeLessThanOrEqual(MEETING_PREPARATION_BUDGET);
  expect(sparse.counts.started).toBeLessThanOrEqual(2 * 30 + 2);
  // A prepared card stays usable while the meeting only appends (before: respond 47%, digDeeper 7%).
  expect(dense.readiness.respond).toBeGreaterThan(0.9);
  expect(dense.readiness.digDeeper).toBeGreaterThan(0.9);
  // Before, 63% of these hotkeys had their model card withheld as stale (any new event during the
  // call, or a background snapshot refresh once the meeting passed 32 events). Now only a change to
  // what the card cites withholds it.
  expect(hotkeyDense.hotkeys.withheldRate).toBe(0);
  expect(hotkeyDense.hotkeys.noCardRate).toBe(0);
  // The stand-in cites the newest event; with partials that is a turn still being revised, so those
  // cards are rightly withheld (before: 66%).
  expect(hotkeyPartials.hotkeys.withheldRate).toBeLessThan(0.5);
  // A long dense meeting: the widening interval spreads the budget over about 70 minutes.
  const long = await simulateMeeting({ minutes: 75, gapMs: 6000, latencyMs: 2000 });
  console.info("preparation volume (75 min dense)", JSON.stringify(long.counts));
  expect(long.counts.started).toBeLessThanOrEqual(MEETING_PREPARATION_BUDGET);
  expect(long.counts.started).toBeGreaterThan(MEETING_PREPARATION_BUDGET - 10);
  // In a quiet meeting a current prepared card on its own lane needs no cold call.
  expect(hotkeySparse.hotkeys.providerCalls).toBeLessThan(hotkeySparse.hotkeys.pressed);
}, 180_000);

test("a model card is shown as of its basis when only new turns arrived, and withheld when a turn it cites was revised", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  const statuses: StatusEvent[] = [];
  const pending: ((result: ModelResult) => void)[] = [];
  const requested: ModelJob[] = [];
  const runtime = new CopilotRuntime(options, (e) => events.push(e), (e) => statuses.push(e), {
    ...quietHost,
    run: (job) => {
      if (job.preparation) return new Promise<ModelResult>(() => {});
      requested.push(job);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  runtime.ingest(speech("m", 1));
  // Appended: a short turn (not material, so no refinement follows).
  const appended = runtime.request("checkConversation");
  runtime.ingest({ ...speech("m", 2), lane: "me", text: "Right." });
  pending[0](answer(requested[0]));
  await appended;
  const shown = events.filter((e) => e.kind === "card");
  expect(shown).toHaveLength(1);
  expect(shown[0].kind === "card" && shown[0].card.origin).toBe("model");
  expect(shown[0].kind === "card" && typeof shown[0].card.asOfMs).toBe("number");
  expect(requested).toHaveLength(1);
  // Revised: the cited turn s1 is corrected while the card is written.
  const revised = runtime.request("checkObjectives");
  runtime.ingest({ ...speech("m", 1), revision: 2, journalSequence: 3, text: "Compliance owns launch too." });
  pending[1](answer(requested[1]));
  await revised;
  expect(statuses.some((s) => s.code === "staleWithheld")).toBe(true);
  expect(events.filter((e) => e.kind === "card").at(-1)).toMatchObject({ card: { origin: "clarification" } });
  runtime.stop();
});

test("a model card refines once in the background when finished turns arrived while it was written", async () => {
  vi.useFakeTimers();
  const events: GuidanceEvent[] = [];
  const requested: ModelJob[] = [];
  const pending: ((result: ModelResult) => void)[] = [];
  const runtime = new CopilotRuntime(options, (e) => events.push(e), () => {}, {
    ...quietHost,
    run: (job) => {
      if (job.preparation) return new Promise<ModelResult>(() => {});
      requested.push(job);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  runtime.ingest(speech("m", 1));
  const request = runtime.request("checkConversation");
  runtime.ingest({ ...speech("m", 2), text: "And the budget owner signs the final launch." });
  pending[0](answer(requested[0]));
  await request;
  await vi.advanceTimersByTimeAsync(0);
  expect(requested).toHaveLength(2);
  expect(requested[1].refinesCardId).toBe(events.find((e) => e.kind === "card" && e.card.origin === "model")!.kind === "card" ? (events.find((e) => e.kind === "card" && e.card.origin === "model") as { card: { id: string } }).card.id : undefined);
  // Newer turns again while the refinement runs: it is shown, but not refined a second time.
  runtime.ingest({ ...speech("m", 3), text: "Finance also wants the numbers by Friday." });
  pending[1](answer(requested[1], "A refinement that saw the budget owner."));
  await vi.advanceTimersByTimeAsync(100);
  expect(events.at(-1)).toMatchObject({ kind: "refinement", card: { say: "A refinement that saw the budget owner." } });
  expect(requested).toHaveLength(2);
  runtime.stop();
});

test("automatic decisions keep a minimum interval in a talkative meeting, and the last one still runs when speech stops", async () => {
  vi.useFakeTimers();
  const decide = vi.fn(async () => ({ intent: "digDeeper" as const, intervene: false }));
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    decide,
    run: async (job) => answer(job),
  });
  runtime.start();
  // A final every second for 50 s, each with a partial before it; speech stops between two decisions.
  for (let n = 1; n <= 50; n++) {
    runtime.ingest({ ...speech("m", 2 * n), kind: "partial", segmentId: "s" + n, text: "In progress " + n });
    runtime.ingest({ ...speech("m", 2 * n + 1), segmentId: "s" + n });
    await vi.advanceTimersByTimeAsync(1000);
  }
  // Without a floor the decision would run about every second.
  expect(decide.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(decide.mock.calls.length).toBeLessThanOrEqual(5);
  const afterSpeech = decide.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(decide.mock.calls.length).toBe(afterSpeech + 1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(decide.mock.calls.length).toBe(afterSpeech + 1);
  runtime.stop();
});

test("the runtime reports status codes; degraded ones are marked by the model, not the wording", async () => {
  vi.useFakeTimers();
  const statuses: StatusEvent[] = [];
  const runtime = new CopilotRuntime(options, () => {}, (event) => statuses.push(event), {
    ...quietHost,
    run: async (job) => (job.preparation ? new Promise<ModelResult>(() => {}) : { ...answer(job), outcome: "failure", output: null }),
  });
  runtime.ingest(speech("m", 1));
  await runtime.request("respond");
  // A failed answer falls back to a contextual clarification, which says suggestions are limited.
  expect(statuses.map((event) => describeStatus(event, 0)).filter((s) => s.degraded).map((s) => s.code)).toEqual(["clarificationOnly"]);
  runtime.stop();
});

test("a ready answer reports its timing as a diagnostic detail only", async () => {
  vi.useFakeTimers();
  const statuses: StatusEvent[] = [];
  const runtime = new CopilotRuntime(options, () => {}, (event) => statuses.push(event), {
    ...quietHost,
    run: async (job) => (job.preparation ? new Promise<ModelResult>(() => {}) : answer(job)),
  });
  runtime.ingest(speech("m", 1));
  await runtime.request("respond");
  const ready = statuses.map((event) => describeStatus(event, 0)).find((s) => s.code === "guidanceReady");
  expect(ready?.text).toBe("");
  expect(ready?.detail).toMatch(/^model · \d+ ms$/);
  runtime.stop();
});

test("background source changes after a hotkey regenerate the requested answer at most once", async () => {
  vi.useFakeTimers();
  const requested: ModelJob[] = [];
  let refreshes = 0;
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    // Every context refresh reports a changed source, as a busy folder would.
    refresh: async () => [`policy-${++refreshes}`],
    run: async (job) => {
      if (!job.preparation) requested.push(job);
      return answer(job);
    },
  });
  runtime.start();
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  const before = requested.length;
  // Not prepared speculatively, so the hotkey makes a model call.
  await runtime.request("checkConversation");
  expect(requested.length).toBe(before + 1);
  // Ten refreshes (2.5 s apart) inside the 30 s window.
  await vi.advanceTimersByTimeAsync(25_000);
  expect(requested.length).toBe(before + 2);
  runtime.stop();
});

test("a partial becoming final at the same revision does not cancel a running preparation", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    run: (job) => {
      jobs.push(job);
      return new Promise(() => {});
    },
  });
  runtime.ingest(speech("m", 1));
  runtime.ingest({ ...speech("m", 2), lane: "me", kind: "partial", text: "So who" });
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs).toHaveLength(1);
  runtime.ingest({ ...speech("m", 2), journalSequence: 3, lane: "me", text: "So who signs it?" });
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).not.toHaveBeenCalledWith("reasoning_cancel", { jobId: jobs[0].id });
  runtime.stop();
});

test("a preparation cancelled because a final turn in it was corrected is requeued on the corrected basis", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const pending: ((result: ModelResult) => void)[] = [];
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    run: (job) => {
      jobs.push(job);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs.map((j) => j.intent)).toEqual(["digDeeper"]);
  runtime.ingest({ ...speech("m", 1), revision: 2, journalSequence: 2, lane: "me", text: "Compliance owns launch too." });
  pending[0](answer(jobs[0]));
  await vi.advanceTimersByTimeAsync(10);
  // The cancelled intent runs again, on the corrected turn, before the rest of the queue.
  expect(jobs.map((j) => j.intent)).toEqual(["digDeeper", "digDeeper"]);
  expect(jobs[1].basis.transcriptDeltas.at(-1)?.revision).toBe(2);
  runtime.stop();
});

test("a remote monologue without pauses still prepares after the maximum wait", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    run: async (job) => {
      jobs.push(job);
      return answer(job);
    },
  });
  // A final every 3 s and a partial every second in between: never 1.5 s of remote quiet.
  for (let t = 0; t < 25; t++) {
    runtime.ingest({ ...speech("m", 100 + t), segmentId: `r${Math.floor(t / 3)}`, kind: t % 3 === 2 ? "final" : "partial", text: `Part ${t} of a long answer.` });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(jobs.filter((j) => j.preparation).length).toBeGreaterThan(0);
  expect(jobs.find((j) => j.preparation)!.basis.observationSequence).toBeGreaterThanOrEqual(100 + Math.floor(REMOTE_MAX_WAIT_MS / 1000) - 1);
  runtime.stop();
});

test("without a remote lane, the user's own finished turns prepare", async () => {
  vi.useFakeTimers();
  const jobs: ModelJob[] = [];
  const runtime = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    run: async (job) => {
      jobs.push(job);
      return answer(job);
    },
  });
  runtime.ingest({ ...speech("m", 1), lane: "me" });
  await vi.advanceTimersByTimeAsync(1500);
  expect(jobs.filter((j) => j.preparation)).toHaveLength(2);
  runtime.stop();
  // Once the remote lane has spoken recently, the user's own turns do not prepare.
  const later: ModelJob[] = [];
  const both = new CopilotRuntime(options, () => {}, () => {}, {
    ...quietHost,
    run: async (job) => {
      later.push(job);
      return answer(job);
    },
  });
  both.ingest({ ...speech("m", 1), lane: "remote", kind: "partial" });
  both.ingest({ ...speech("m", 2), lane: "me" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(later.filter((j) => j.preparation)).toHaveLength(0);
  both.stop();
});

test("the preparation interval widens as the budget is spent, and exhaustion is a quiet diagnostic", async () => {
  expect(preparationIntervalMs(0)).toBe(PREPARATION_TURN_INTERVAL_MS);
  expect(preparationIntervalMs(MEETING_PREPARATION_BUDGET * 0.6)).toBe(2 * PREPARATION_TURN_INTERVAL_MS);
  expect(preparationIntervalMs(MEETING_PREPARATION_BUDGET * 0.9)).toBe(4 * PREPARATION_TURN_INTERVAL_MS);
  // Spending the budget at two calls per turn as fast as allowed lasts about 70 minutes.
  let used = 0, minutes = 0;
  while (used < MEETING_PREPARATION_BUDGET) {
    used += 2;
    minutes += preparationIntervalMs(used) / 60_000;
  }
  expect(minutes).toBeGreaterThan(60);
  vi.useFakeTimers();
  const statuses: StatusEvent[] = [];
  const runtime = new CopilotRuntime(options, () => {}, (e) => statuses.push(e), {
    ...quietHost,
    run: async (job) => answer(job),
  });
  (runtime as any).preparationCalls = MEETING_PREPARATION_BUDGET;
  runtime.ingest(speech("m", 1));
  await vi.advanceTimersByTimeAsync(1500);
  const spent = statuses.filter((s) => s.code === "preparationBudgetSpent");
  expect(spent).toHaveLength(1);
  const shown = describeStatus(spent[0], 0);
  expect(shown.severity).toBe("ok");
  expect(shown.text).toBe("");
  expect(shown.detail).toMatch(/150/);
  runtime.ingest(speech("m", 2));
  await vi.advanceTimersByTimeAsync(40_000);
  expect(statuses.filter((s) => s.code === "preparationBudgetSpent")).toHaveLength(1);
  runtime.stop();
});

test("on Standard a requested digDeeper asks for the fast lane; Premium and an unknown plan ask for deep", async () => {
  for (const [plan, lane] of [
    ["standard", "fast"],
    ["premium", "deep"],
    [undefined, "deep"],
  ] as const) {
    const jobs: ModelJob[] = [];
    const runtime = new CopilotRuntime(options, () => {}, () => {}, {
      ...quietHost,
      plan: () => plan,
      run: async (job) => {
        jobs.push(job);
        return answer(job);
      },
    });
    runtime.ingest(speech("m", 1));
    await runtime.request("digDeeper");
    expect(jobs.map((j) => j.lane), String(plan)).toEqual([lane]);
    runtime.stop();
  }
});
test("a fast answer from the service (a downgraded deep request) is shown as a normal card", async () => {
  const events: GuidanceEvent[] = [];
  const runtime = new CopilotRuntime(options, (e) => events.push(e), () => {}, {
    ...quietHost,
    // An app that did not know the plan asked for deep; the service answered on the fast route.
    run: async (job) => ({ ...answer(job), provider: "managedFast" }),
  });
  runtime.ingest(speech("m", 1));
  await runtime.request("digDeeper");
  expect(events.map((e) => e.kind)).toEqual(["card"]);
  runtime.stop();
});
test("the native host reports the plan it was given", () => {
  let plan: "standard" | "premium" | undefined = "standard";
  const host = nativeReasoningHost(() => plan);
  expect(host.plan?.()).toBe("standard");
  plan = "premium";
  expect(host.plan?.()).toBe("premium");
  expect(nativeReasoningHost().plan?.()).toBeUndefined();
});
