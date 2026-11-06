import { invoke } from "@tauri-apps/api/core";
import {
  SnapshotStore,
  createMeetingState,
  reduceMeetingEvent,
  buildContext,
  basisCompatibility,
  materialAppend,
  guidanceLane,
  requestGuidance,
  StageRecorder,
  PreparationCounter,
  summarizeStages,
  timedTransport,
  runWithBrevityRepair,
  meetingProfiles,
  effectiveContext,
  applyHistorySummary,
  historySchema,
  safePublicQuery,
  publicResearchQueries,
  makeClarification,
  PreparedGuidanceCache,
  createGuidanceJob,
  guidanceBasisKey,
  DraftAccumulator,
  type MeetingState,
  type MeetingOptions,
  type SpeechEvent,
  type ProfileId,
  type AssistanceIntent,
  type GuidanceEvent,
  type GuidanceCard,
  type SourceHit,
  type HotkeyContext,
  type ModelJob,
  type ModelResult,
  type PreparationCounts,
  type StageTimings,
  type TimingTrace,
} from "@live-interview/core";

import { invokeReasoning, type DraftUpdate } from "./reasoningInvoke";
import type { StatusEvent } from "./status";
export type { DraftUpdate };

/** Timings only; never card text. `render` arrives after the trace is first reported. */
export interface GuidanceLatencyTrace {
  path: "prepared" | "model" | "automatic";
  intent: AssistanceIntent;
  cardId: string;
  timings: StageTimings;
}
const TRACE_LIMIT = 200;
/** Minimum time between automatic (paid) guidance decisions. Hotkeys are not affected. */
export const DECISION_INTERVAL_MS = 15_000;
/**
 * Speculative preparation (paid calls, never on the hotkey path). It runs when a remote turn settles:
 * the remote lane has had a final and then this much quiet.
 */
export const REMOTE_SETTLE_MS = 1500;
/** Continuous remote speech with no such pause still prepares once it has gone on this long. */
export const REMOTE_MAX_WAIT_MS = 20_000;
/**
 * The user's own finished turns prepare instead only while the remote lane has been silent this long
 * (or never spoke): a meeting captured without system audio still gets prepared cards.
 */
export const REMOTE_ABSENT_MS = 60_000;
/** At most one turn's preparation starts per interval; a turn that settles meanwhile is prepared when it ends. */
export const PREPARATION_TURN_INTERVAL_MS = 30_000;
/**
 * Provider calls speculative preparation may make in one meeting (a brevity repair counts). After it,
 * hotkeys use the cold path. See docs/public/pricing-model.md, section 5.1.
 */
export const MEETING_PREPARATION_BUDGET = 150;
/**
 * The turn interval widens as the budget is spent, so a long meeting keeps some preparation for its
 * later part: the base interval for the first half, twice it up to 80%, four times it after. At two
 * calls per turn in continuous talk the budget lasts about 70 minutes (about 37 at the base pace).
 */
export function preparationIntervalMs(callsUsed: number): number {
  const share = callsUsed / MEETING_PREPARATION_BUDGET;
  return PREPARATION_TURN_INTERVAL_MS * (share < 0.5 ? 1 : share < 0.8 ? 2 : 4);
}
export class CopilotRuntime {
  state: MeetingState;
  readonly snapshots = new SnapshotStore();
  private stopped = false;
  private summaryBusy = false;
  private summaryThrough = 0;
  private publicSources: SourceHit[] = [];
  private researchAbort = new AbortController();
  private lastResearch = 0;
  private researchBusy = false;
  private researchQueries = new Map<string, number>();
  private assistancePaused = false;
  private refreshBusy = false;
  private retrievalKey = "";
  private workspaceHits: SourceHit[] = [];
  private workspaceEpoch = 0;
  private pinMinimumIndex = 0;
  private decisionBusy = false;
  /** Paid decisions run at most once per DECISION_INTERVAL_MS however much is said; see automatic(). */
  private nextDecisionAtMs = 0;
  private decisionTimer?: ReturnType<typeof setTimeout>;
  private recent: string[] = [];
  private tasks = new Set<string>();
  private draftShown?: AssistanceIntent;
  private retryChildren = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private observationsSinceCandidate = 0;
  private prepared = new PreparedGuidanceCache();
  private preparationTimer?: ReturnType<typeof setTimeout>;
  private preparation?: {
    jobId: string;
    basis: HotkeyContext;
    cancelled: boolean;
    timedOut: boolean;
  };
  /** Intents still to prepare for the latest settled remote turn, in the profile's order. */
  private preparationQueue: AssistanceIntent[] = [];
  private settleTimer?: ReturnType<typeof setTimeout>;
  private turnTimer?: ReturnType<typeof setTimeout>;
  private nextTurnAtMs = 0;
  private preparationCalls = 0;
  private budgetReported = false;
  /** When the current stretch of remote speech began (reset when a turn is prepared). */
  private remoteSpeechSinceMs?: number;
  private lastRemoteAtMs = Number.NEGATIVE_INFINITY;
  /** Counts only; see PreparationCounts. Starts empty for every meeting. */
  private preparationCounts = new PreparationCounter();
  private nextPreparationAtMs = 0;
  private contextKey: string;
  private hasPublishedGuidance = false;
  private traces: GuidanceLatencyTrace[] = [];
  private latestRequested?: {
    requestId: string;
    createdAtMs: number;
    jobId?: string;
    intent: AssistanceIntent;
    cardId?: string;
    sequence: number;
    usefulCard?: boolean;
    /** Set once a source change has re-run this request; later changes leave it as it is. */
    refreshed?: boolean;
    /** Set once newer turns have re-run this request; it is refined at most once for them. */
    caughtUp?: boolean;
  };
  constructor(
    options: MeetingOptions,
    private emit: (event: GuidanceEvent) => void,
    /** A status code and severity (see status.ts); the words a person sees are chosen there, not here. */
    private status: (event: StatusEvent) => void,
    private host: {
      run: (
        job: ModelJob,
        prompt: string,
        trace?: TimingTrace,
        onDraft?: (update: DraftUpdate) => void,
      ) => Promise<ModelResult>;
      retrieve: (
        workspaceId: string,
        query: string,
        scope?: { sourceIds?: string[]; sharedLibraryIds?: string[] },
      ) => Promise<SourceHit[]>;
      refresh: (
        workspaceId: string,
        sharedLibraryIds?: string[],
      ) => Promise<string[]>;
      persistProfile?: (
        id: string,
        profile: ProfileId,
        revision: number,
      ) => Promise<void>;
      decide: (basis: HotkeyContext) => Promise<{
        intent: AssistanceIntent;
        intervene: boolean;
        researchQuery?: string;
        researchNeeded?: boolean;
      }>;
      /** The account's plan when known (public edition): Standard asks for fast digDeeper directly. */
      plan?: () => "none" | "standard" | "premium" | undefined;
    },
    private onLatency?: (trace: GuidanceLatencyTrace) => void,
    /** Called once at stop with the meeting's preparation counts. */
    private onPreparationCounts?: (counts: PreparationCounts) => void,
  ) {
    this.state = createMeetingState(options);
    this.snapshots.initialise(this.state);
    this.contextKey = guidanceBasisKey(this.snapshots.read(this.state));
  }
  start() {
    this.timer = setInterval(() => {
      void this.refreshContext();
    }, 2500);
    void this.refreshContext();
  }
  invalidateWorkspace(workspaceId: string) {
    if (
      this.stopped ||
      (workspaceId !== this.state.workspaceId &&
        !this.state.sharedLibraryIds?.includes(workspaceId))
    )
      return;
    this.workspaceEpoch++;
    const ids = new Set([
      ...this.snapshots
        .read(this.state)
        .snapshot.context.sources.map((s) => s.sourceId),
      ...this.workspaceHits.map((s) => s.sourceId),
      ...this.publicSources.map((s) => s.sourceId),
      `workspace:${workspaceId}`,
    ]);
    for (const sourceId of ids)
      this.state = reduceMeetingEvent(this.state, { kind: "source", sourceId });
    this.pinMinimumIndex = this.state.indexRevision;
    this.state.historySummary = undefined;
    this.state.coveredObjectives = [];
    this.state.brief = undefined;
    this.state.pins = [];
    this.recent = [];
    this.latestRequested = undefined;
    this.prepared = new PreparedGuidanceCache();
    this.preparationQueue = [];
    this.workspaceHits = [];
    this.publicSources = [];
    this.retrievalKey = "";
    this.researchAbort.abort();
    this.researchAbort = new AbortController();
    this.suspendPreparation();
    for (const jobId of this.tasks)
      void invoke("reasoning_cancel", { jobId }).catch(() => {});
    this.snapshots.initialise(this.state);
    this.reconcileContext();
    this.status({ code: "workspaceRefreshing" });
  }
  ingest(event: SpeechEvent) {
    if (this.stopped || event.meetingId !== this.state.id) return;
    const before = this.state;
    this.state = reduceMeetingEvent(this.state, { kind: "speech", event });
    if (this.state === before) return;
    this.reconcilePreparation();
    this.armTurnSettle(event);
    if (!this.state.historySummary) this.summaryThrough = 0;
    this.observationsSinceCandidate++;
    if (
      this.state.segments.filter(
        (e) => e.kind === "final" && e.journalSequence > this.summaryThrough,
      ).length >= 20 &&
      !this.summaryBusy &&
      this.canPrepare()
    )
      void this.summarise();
    if (this.observationsSinceCandidate >= 2 && !this.decisionBusy)
      void this.automatic();
  }
  private publishStateChange() {
    const previous = this.snapshots.read(this.state).snapshot;
    const hits = previous.context.sources.filter(
      (s) =>
        !this.state.invalidatedSourceIds.includes(s.sourceId) &&
        s.sourceId !== `summary:${this.state.id}`,
    );
    this.snapshots.publish(
      {
        snapshotId: crypto.randomUUID(),
        meetingId: this.state.id,
        context: buildContext(this.state, hits),
        candidates: [],
        createdAtMs: Date.now(),
        transcriptThroughSequence: this.state.observationSequence,
      },
      this.state.segments,
    );
    this.reconcilePreparation();
  }
  setPins(pins: GuidanceCard[]) {
    this.state = {
      ...this.state,
      pins: structuredClone(
        pins.filter(
          (p) => p.basis.snapshot.context.indexRevision >= this.pinMinimumIndex,
        ),
      ),
      revision: this.state.revision + 1,
    };
    this.publishStateChange();
  }
  setAssistancePaused(paused: boolean) {
    this.assistancePaused = paused;
    if (paused) this.suspendPreparation();
    else this.reconcilePreparation();
  }
  setProfile(profileId: ProfileId) {
    this.state = reduceMeetingEvent(this.state, { kind: "profile", profileId });
    this.publishStateChange();
    this.observationsSinceCandidate = 2;
    void this.host
      .persistProfile?.(this.state.id, profileId, this.state.profileRevision)
      .catch(() => this.status({ code: "profilePending" }));
  }
  setPaused(paused: boolean) {
    this.state = reduceMeetingEvent(this.state, {
      kind: "lifecycle",
      status: paused ? "paused" : "active",
    });
    if (paused) this.suspendPreparation();
    else this.reconcilePreparation();
  }
  private canPrepare() {
    return (
      !this.stopped && !this.assistancePaused && this.state.status === "active"
    );
  }
  private cancelPreparation() {
    if (!this.preparation || this.preparation.cancelled) return;
    this.preparation.cancelled = true;
    void this.cancelTrackedGroup(this.preparation.jobId).catch(() => {});
  }
  private suspendPreparation() {
    for (const timer of [this.preparationTimer, this.settleTimer, this.turnTimer])
      if (timer) clearTimeout(timer);
    this.preparationTimer = this.settleTimer = this.turnTimer = undefined;
    this.preparationQueue = [];
    this.cancelPreparation();
  }
  private emitGuidance(
    event: GuidanceEvent,
    measured?: { path: GuidanceLatencyTrace["path"]; recorder: StageRecorder },
  ) {
    if (event.kind === "card" || event.kind === "refinement")
      this.hasPublishedGuidance = true;
    const trace =
      measured &&
      (event.kind === "card" || event.kind === "refinement") &&
      event.card.origin !== "clarification"
        ? this.recordTrace({
            path: measured.path,
            intent: event.card.intent,
            cardId: event.card.id,
            timings: {
              ...measured.recorder.snapshot(),
              total: measured.recorder.elapsed(),
            },
          })
        : undefined;
    const emittedAt = performance.now();
    this.emit(event);
    if (trace) this.reportTrace(trace);
    // Render: the view update was queued by `emit`; it is on screen after the next frame.
    if (trace && typeof requestAnimationFrame === "function")
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          trace.timings.render =
            Math.round((performance.now() - emittedAt) * 10) / 10;
          this.reportTrace(trace);
        }),
      );
  }
  private recordTrace(trace: GuidanceLatencyTrace) {
    this.traces = [...this.traces, trace].slice(-TRACE_LIMIT);
    return trace;
  }
  /** Diagnostics must never block or break guidance delivery. */
  private reportTrace(trace: GuidanceLatencyTrace) {
    try {
      this.onLatency?.(trace);
    } catch {}
  }
  /** p50/p95 per stage over the most recent requests, by path. */
  latencyReport() {
    const of = (path: GuidanceLatencyTrace["path"]) =>
      summarizeStages(
        this.traces.filter((t) => t.path === path).map((t) => t.timings),
      );
    return {
      prepared: of("prepared"),
      model: of("model"),
      automatic: of("automatic"),
      /** Speculative preparation jobs this meeting: counts only. */
      preparation: this.preparationCounts.snapshot(),
    };
  }
  private reconcileContext(basis = this.snapshots.read(this.state)) {
    if (this.stopped) return this.contextKey;
    const key = guidanceBasisKey(basis);
    if (key !== this.contextKey) {
      this.contextKey = key;
      if (this.hasPublishedGuidance)
        this.emit({ kind: "contextChanged", basis });
    }
    return key;
  }
  /**
   * A preparation stays worth finishing while the meeting only appends to its basis. It does not know
   * yet what its card will cite, so every finished turn in its basis counts as cited: a corrected one
   * makes it obsolete. A partial is not counted, so it becoming final does not cancel the job.
   */
  private preparationCurrent(basis: HotkeyContext) {
    return basisCompatibility(
      basis,
      this.snapshots.read(this.state),
      effectiveContext(basis)
        .conversation.filter((e) => e.kind !== "partial")
        .map((e) => `segment:${e.segmentId}`),
      this.state.segments,
    ).compatible;
  }
  /** Keeps a running preparation only while its basis is still current (see preparationCurrent). */
  private reconcilePreparation() {
    this.reconcileContext();
    if (!this.preparation || this.preparation.cancelled) return;
    if (!this.canPrepare() || !this.preparationCurrent(this.preparation.basis))
      this.cancelPreparation();
  }
  /**
   * A remote final followed by REMOTE_SETTLE_MS of quiet on the remote lane ends the turn. Remote speech
   * that never pauses that long still prepares after REMOTE_MAX_WAIT_MS. The user's own turns count
   * only while the remote lane is absent (REMOTE_ABSENT_MS).
   */
  private armTurnSettle(event: SpeechEvent) {
    const now = Date.now();
    if (event.lane === "remote") {
      this.lastRemoteAtMs = now;
      this.remoteSpeechSinceMs ??= now;
    } else if (now - this.lastRemoteAtMs < REMOTE_ABSENT_MS) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (!this.canPrepare()) return;
    if (
      event.lane === "remote" &&
      now - (this.remoteSpeechSinceMs ?? now) >= REMOTE_MAX_WAIT_MS
    ) {
      this.remoteTurnSettled();
      return;
    }
    if (event.kind === "partial") return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.remoteTurnSettled();
    }, REMOTE_SETTLE_MS);
  }
  private remoteTurnSettled() {
    if (!this.canPrepare()) return;
    const wait =
      Math.max(this.nextTurnAtMs, this.nextPreparationAtMs) - Date.now();
    if (wait > 0) {
      // Trailing: the newest turn is prepared once the interval (or a failure back-off) ends.
      if (!this.turnTimer)
        this.turnTimer = setTimeout(() => {
          this.turnTimer = undefined;
          this.remoteTurnSettled();
        }, wait);
      return;
    }
    if (this.preparationCalls >= MEETING_PREPARATION_BUDGET) {
      this.reportBudgetSpent();
      return;
    }
    this.remoteSpeechSinceMs = undefined;
    this.nextTurnAtMs = Date.now() + preparationIntervalMs(this.preparationCalls);
    this.preparationQueue = [
      ...meetingProfiles[this.state.profileId].preparedIntents,
    ];
    this.pumpPreparation();
  }
  private pumpPreparation() {
    if (this.preparationTimer) clearTimeout(this.preparationTimer);
    this.preparationTimer = undefined;
    // Keep the slot until its transport settles, even after cancellation. A stuck
    // provider cannot cause overlapping speculative jobs; hotkeys stay independent.
    if (!this.canPrepare() || this.preparation || !this.preparationQueue.length)
      return;
    if (this.preparationCalls >= MEETING_PREPARATION_BUDGET) {
      this.preparationQueue = [];
      this.reportBudgetSpent();
      return;
    }
    const wait = this.nextPreparationAtMs - Date.now();
    if (wait <= 0) {
      void this.prepareNext();
      return;
    }
    this.preparationTimer = setTimeout(() => {
      this.preparationTimer = undefined;
      void this.prepareNext();
    }, wait);
  }
  /** Once per meeting, for Settings › Diagnostics only: nothing changes on the live page. */
  private reportBudgetSpent() {
    if (this.budgetReported) return;
    this.budgetReported = true;
    this.status({
      code: "preparationBudgetSpent",
      detail: `background preparation used its ${MEETING_PREPARATION_BUDGET} calls; help requests use the direct path`,
    });
  }
  private async prepareNext() {
    if (!this.canPrepare() || this.preparation) return;
    const intent = this.preparationQueue.shift();
    if (!intent) return;
    const basis = this.snapshots.read(this.state);
    const context = effectiveContext(basis);
    if (!context.conversation.length) return;
    const startedAtMs = Date.now();
    const job = createGuidanceJob(intent, basis, "automatic", {
      lane: "fast",
      preparation: true,
      recentSuggestions: this.recent.slice(-12),
      deadlineMs: startedAtMs + 15000,
    });
    const pending = {
      jobId: job.id,
      basis,
      cancelled: false,
      timedOut: false,
    };
    this.preparation = pending;
    this.preparationCalls++;
    this.preparationCounts.start();
    const recorder = new StageRecorder();
    let outcome: "completed" | "superseded" | "failed" = "failed";
    const backOff = () => {
      this.nextPreparationAtMs = Date.now() + 30000;
      this.preparationQueue = [];
    };
    const timeout = setTimeout(() => {
      pending.timedOut = true;
      this.cancelPreparation();
      backOff();
    }, 15000);
    try {
      const result = await this.runTracked(job, recorder);
      if (
        pending.cancelled ||
        !this.canPrepare() ||
        !this.preparationCurrent(basis)
      ) {
        outcome = pending.timedOut ? "failed" : "superseded";
        // Its basis went out of date: prepare the same intent again, on the current basis, first.
        if (outcome === "superseded" && this.canPrepare())
          this.preparationQueue = [intent, ...this.preparationQueue.filter((i) => i !== intent)];
        return;
      }
      if (this.prepared.store(job, result, startedAtMs)) outcome = "completed";
      else backOff();
    } catch {
      if (!pending.cancelled) backOff();
      else if (!pending.timedOut) {
        outcome = "superseded";
        if (this.canPrepare())
          this.preparationQueue = [intent, ...this.preparationQueue.filter((i) => i !== intent)];
      }
    } finally {
      clearTimeout(timeout);
      this.preparationCounts.end(
        outcome,
        recorder.snapshot().providerAttempts ?? 0,
      );
      this.preparation = undefined;
      this.pumpPreparation();
    }
  }
  private async refreshContext() {
    if (this.stopped || this.refreshBusy) return;
    this.refreshBusy = true;
    const epoch = this.workspaceEpoch;
    try {
      const changed = await this.host.refresh(
        this.state.workspaceId,
        this.state.sharedLibraryIds,
      );
      if (this.stopped || epoch !== this.workspaceEpoch) return;
      for (const sourceId of changed)
        this.state = reduceMeetingEvent(this.state, {
          kind: "source",
          sourceId,
        });
      this.reconcilePreparation();
      const captured = structuredClone(this.state);
      const query = [
        captured.purpose,
        ...captured.objectives,
        ...captured.segments
          .filter((e) => e.kind === "final")
          .slice(-3)
          .map((e) => e.text),
      ].join(" ");
      const key = JSON.stringify([
        captured.workspaceId,
        captured.sourceIds,
        captured.sharedLibraryIds,
        captured.indexRevision,
        query,
      ]);
      const hits =
        key === this.retrievalKey
          ? this.workspaceHits
          : await this.host.retrieve(captured.workspaceId, query, {
              sourceIds: captured.sourceIds,
              sharedLibraryIds: captured.sharedLibraryIds,
            });
      if (this.stopped || epoch !== this.workspaceEpoch) return;
      if (key !== this.retrievalKey) {
        this.retrievalKey = key;
        this.workspaceHits = hits;
      }
      if (this.stopped) return;
      const published = this.snapshots.publish(
        {
          snapshotId: crypto.randomUUID(),
          meetingId: captured.id,
          context: buildContext(captured, [
            ...hits.filter(
              (hit) =>
                !this.publicSources.some(
                  (publicHit) =>
                    publicHit.sourceId === hit.sourceId &&
                    publicHit.revision >= hit.revision,
                ),
            ),
            ...this.publicSources.filter(
              (publicHit) =>
                !hits.some(
                  (hit) =>
                    hit.sourceId === publicHit.sourceId &&
                    hit.revision > publicHit.revision,
                ),
            ),
          ]),
          candidates: [],
          createdAtMs: Date.now(),
          transcriptThroughSequence: captured.observationSequence,
        },
        captured.segments,
      );
      // Clears only what this snapshot covered, as a new state: a source or summary invalidated meanwhile stays invalid.
      if (published && this.state.indexRevision === captured.indexRevision)
        this.state = {
          ...this.state,
          invalidatedSourceIds: this.state.invalidatedSourceIds.filter(
            (id) => !captured.invalidatedSourceIds.includes(id),
          ),
        };
      this.reconcilePreparation();
      if (
        this.latestRequested &&
        !this.latestRequested.refreshed &&
        this.state.status === "active" &&
        changed.length &&
        Date.now() - this.latestRequested.createdAtMs < 30000
      ) {
        // One regeneration per hotkey: a folder that keeps changing must not keep paying for the same answer.
        const latest = this.latestRequested;
        latest.refreshed = true;
        void this.generate(latest.intent, "requested", latest.cardId);
      }
    } catch {
      this.status({ code: "contextPending" });
    } finally {
      this.refreshBusy = false;
    }
  }
  /** Synchronous context read happens before the first await, regardless of worker state. */
  request(intent: AssistanceIntent) {
    if (this.stopped) return Promise.resolve();
    const start = performance.now();
    const recorder = new StageRecorder();
    const basis = recorder.time("snapshotRead", () =>
      this.snapshots.read(this.state),
    );
    this.reconcileContext(basis);
    // The previous request's draft is not this request's answer.
    if (this.draftShown) this.emitDraft(this.draftShown);
    this.latestRequested = {
      intent,
      sequence: basis.observationSequence,
      requestId: crypto.randomUUID(),
      createdAtMs: Date.now(),
    };
    const prepared = this.prepared.select(
      intent,
      basis,
      "requested",
      this.recent,
      Date.now(),
      this.state.segments,
    );
    if (prepared) {
      this.latestRequested.cardId = prepared.id;
      this.latestRequested.jobId = prepared.preparedFrom?.jobId;
      this.latestRequested.usefulCard = true;
      this.recent = [...this.recent, prepared.say].slice(-12);
      this.emitGuidance(
        { kind: "card", card: prepared },
        { path: "prepared", recorder },
      );
      this.status({ code: "guidanceReady", detail: `prepared · ${(performance.now() - start).toFixed(0)} ms` });
      // A prepared card on its own lane needs no cold call, unless finished turns have arrived since it
      // was written (one bounded refinement). A deep-lane intent still gets its deep card.
      const appended = basisCompatibility(prepared.basis, basis, prepared.evidence, this.state.segments).appended;
      const material = materialAppend(appended);
      if (this.prepared.laneOf(intent) === this.laneFor(intent, "requested") && !material)
        return Promise.resolve();
      if (material) this.latestRequested.caughtUp = true;
    }
    return this.generate(intent, "requested", prepared?.id, basis, recorder);
  }
  /** The lane to ask for; the service enforces the plan's lane either way. */
  private laneFor(intent: AssistanceIntent, trigger: "requested" | "automatic") {
    return guidanceLane(intent, trigger, this.host.plan?.());
  }
  private async generate(
    intent: AssistanceIntent,
    trigger: "requested" | "automatic",
    refinesCardId?: string,
    input?: HotkeyContext,
    recorder = new StageRecorder(),
  ) {
    if (
      this.stopped ||
      (trigger === "automatic" && this.state.status !== "active")
    )
      return;
    const basis = input ?? this.snapshots.read(this.state);
    const basisAtMs = Date.now();
    const epoch = this.workspaceEpoch;
    const requestId = this.latestRequested?.requestId;
    const preserveExisting =
      !!refinesCardId && !!this.latestRequested?.usefulCard;
    const refinesJobId = this.latestRequested?.jobId;
    const start = performance.now();
    for await (const event of requestGuidance(
      intent,
      basis,
      trigger,
      {
        run: async (job) => {
          if (
            trigger === "requested" &&
            this.latestRequested &&
            this.latestRequested.requestId === requestId
          )
            this.latestRequested.jobId = job.id;
          // With a useful card already on screen, a draft of its refinement would only compete with it.
          return this.runTracked(
            job,
            recorder,
            requestId && trigger === "requested" && !preserveExisting
              ? { requestId, intent }
              : undefined,
          );
        },
        cancel: (jobId) => this.cancelTrackedGroup(jobId),
      },
      this.recent,
      undefined,
      refinesCardId
        ? { refinesCardId, refinesJobId, preserveExisting }
        : undefined,
      recorder,
      this.laneFor(intent, trigger),
    )) {
      if (this.stopped) return;
      this.reconcileContext();
      if (
        trigger === "requested" &&
        this.latestRequested?.requestId !== requestId
      )
        return;
      if (event.kind === "card" || event.kind === "refinement") {
        // Shown while the meeting has only moved on (see basisCompatibility); withheld when a source,
        // the profile, or a turn it cites changed, or the workspace was revoked meanwhile.
        const fit =
          epoch === this.workspaceEpoch
            ? basisCompatibility(
                event.card.basis,
                this.snapshots.read(this.state),
                event.card.evidence,
                this.state.segments,
              )
            : undefined;
        if (!fit?.compatible) {
          this.status({ code: "staleWithheld" });
          if (trigger === "requested" && !preserveExisting)
            this.emitGuidance({
              kind: "card",
              card: makeClarification(intent, this.snapshots.read(this.state)),
            });
          continue;
        }
        if (
          trigger === "automatic" &&
          (this.assistancePaused || this.state.status !== "active")
        )
          continue;
        const card: GuidanceCard = fit.appended.length
          ? { ...event.card, asOfMs: basisAtMs }
          : event.card;
        this.recent.push(card.say);
        this.recent = this.recent.slice(-12);
        this.emitGuidance(
          refinesCardId
            ? { kind: "refinement", card, refinesCardId }
            : { ...event, card },
          {
            path: trigger === "requested" ? "model" : "automatic",
            recorder,
          },
        );
        if (
          trigger === "requested" &&
          this.latestRequested &&
          this.latestRequested.requestId === requestId
        ) {
          this.latestRequested.cardId = event.card.id;
          this.latestRequested.usefulCard =
            event.card.origin !== "clarification";
          // Finished turns arrived while it was written: refine once in the background, keeping this card.
          if (
            event.card.origin !== "clarification" &&
            !this.latestRequested.caughtUp &&
            materialAppend(fit.appended)
          ) {
            this.latestRequested.caughtUp = true;
            void this.generate(intent, "requested", event.card.id);
          }
        }
        this.status(
          event.card.origin === "clarification"
            ? { code: event.card.provisional ? "clarificationProvisional" : "clarificationOnly" }
            : { code: "guidanceReady", detail: `model · ${(performance.now() - start).toFixed(0)} ms` },
        );
      } else if (event.kind === "failure")
        this.status(
          preserveExisting
            ? { code: event.code === "refinementPending" ? "refinementPending" : "refinementUnavailable" }
            : { code: "reasoningUnavailable", detail: event.code },
        );
    }
  }
  /**
   * Shows the first line of a requested answer while the model is still
   * writing it. The text is unvalidated and goes nowhere but the draft view
   * state: it is not a card, so it is never pinned, noted, cited or recorded.
   * It is withheld once the request or the evidence it was written against
   * is no longer current.
   */
  private draftSink(attempt: ModelJob, draft: { requestId: string; intent: AssistanceIntent }) {
    const text = new DraftAccumulator();
    const current = () =>
      !this.stopped &&
      this.latestRequested?.requestId === draft.requestId &&
      basisCompatibility(attempt.basis, this.snapshots.read(this.state), [])
        .compatible;
    return (update: DraftUpdate) => {
      const next = "reset" in update ? text.reset() : text.push(update.delta);
      if (next.changed && current()) this.emitDraft(draft.intent, next.text);
    };
  }
  private emitDraft(intent: AssistanceIntent, text?: string) {
    this.draftShown = text ? intent : undefined;
    this.emit({ kind: "draft", intent, text });
  }
  private async runTracked(
    job: ModelJob,
    recorder = new StageRecorder(),
    draft?: { requestId: string; intent: AssistanceIntent },
  ) {
    let attempts = 0;
    const timed = timedTransport(recorder, (attempt, prompt, trace) =>
      this.host.run(
        attempt,
        prompt,
        trace,
        draft && this.draftSink(attempt, draft),
      ),
    );
    const execute = async (attempt: ModelJob) => {
      // A repair attempt replaces the text the first attempt was rejected for.
      if (draft && attempts++) this.emitDraft(draft.intent);
      this.tasks.add(attempt.id);
      try {
        return await timed.run(attempt);
      } finally {
        this.tasks.delete(attempt.id);
      }
    };
    try {
      return await runWithBrevityRepair(job, execute, (retry) => {
        if (
          this.stopped ||
          !basisCompatibility(job.basis, this.snapshots.read(this.state), [])
            .compatible
        )
          return false;
        if (job.trigger === "automatic" && !this.canPrepare()) return false;
        if (
          job.preparation &&
          (!this.preparation ||
            this.preparation.cancelled ||
            this.preparation.jobId !== job.id ||
            this.preparationCalls >= MEETING_PREPARATION_BUDGET)
        )
          return false;
        if (job.preparation) this.preparationCalls++;
        if (
          job.trigger === "requested" &&
          this.latestRequested?.jobId !== job.id
        )
          return false;
        this.retryChildren.set(job.id, retry.id);
        if (this.preparation?.jobId === job.id)
          this.preparation.jobId = retry.id;
        if (this.latestRequested?.jobId === job.id)
          this.latestRequested.jobId = retry.id;
        return true;
      });
    } finally {
      this.retryChildren.delete(job.id);
    }
  }
  private async cancelTrackedGroup(jobId: string) {
    const ids = new Set(
      [jobId, this.retryChildren.get(jobId)].filter((id): id is string => !!id),
    );
    await Promise.allSettled(
      [...ids].map((id) => invoke<void>("reasoning_cancel", { jobId: id })),
    );
  }
  private async summarise() {
    this.summaryBusy = true;
    const epoch = this.workspaceEpoch;
    const captured = structuredClone(this.state);
    const basis = this.snapshots.read(captured);
    const job: ModelJob = {
      id: crypto.randomUUID(),
      meetingId: captured.id,
      lane: "fast",
      intent: "checkConversation",
      trigger: "automatic",
      basis,
      outputSchema: historySchema,
      deadlineMs: Date.now() + 30000,
      toolBudget: 0,
    };
    try {
      const result = await this.runTracked(job);
      if (
        this.stopped ||
        epoch !== this.workspaceEpoch ||
        captured.indexRevision !== this.state.indexRevision ||
        result.outcome !== "complete"
      )
        return;
      const output = result.output as {
        summary: string;
        evidence: string[];
        coveredObjectives: string[];
      };
      const evidence = (output.evidence || [])
        .map((id) =>
          captured.segments.find((e) => `segment:${e.segmentId}` === id),
        )
        .map((e) =>
          e?.kind === "translation"
            ? captured.segments.find(
                (s) =>
                  s.segmentId === e.sourceSegmentId &&
                  s.revision === e.revision,
              )
            : e,
        )
        .filter((e): e is SpeechEvent => !!e)
        .map((e) => ({ segmentId: e.segmentId, revision: e.revision }));
      if (
        output.evidence.includes(`summary:${captured.id}`) &&
        captured.historySummary
      )
        evidence.push(...captured.historySummary.evidence);
      if (!evidence.length) return;
      const summarised = applyHistorySummary(this.state, {
        text: output.summary,
        evidence,
        throughSequence: captured.observationSequence,
        revision: (captured.historySummary?.revision ?? 0) + 1,
      });
      this.state = {
        ...summarised,
        coveredObjectives: (output.coveredObjectives || []).filter((o) =>
          summarised.objectives.includes(o),
        ),
      };
      this.summaryThrough = captured.observationSequence;
      void this.refreshContext();
    } catch {
      this.status({ code: "summaryPending" });
    } finally {
      this.summaryBusy = false;
    }
  }
  private async planPublicResearch(basis: HotkeyContext) {
    if (this.researchBusy || this.stopped) return;
    const queries = publicResearchQueries(
      JSON.stringify(effectiveContext(basis)),
      basis.snapshot.context.publicResearchTopics,
    );
    if (!queries.length) return;
    this.researchBusy = true;
    const epoch = this.workspaceEpoch;
    const job: ModelJob = {
      id: crypto.randomUUID(),
      meetingId: this.state.id,
      lane: "fast",
      intent: "checkConversation",
      trigger: "automatic",
      basis,
      deadlineMs: Date.now() + 15000,
      toolBudget: 0,
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string", enum: queries },
          publicSubject: { type: "boolean" },
          needed: { type: "boolean" },
        },
        required: ["query", "publicSubject", "needed"],
        additionalProperties: false,
      },
    };
    try {
      const result = await this.runTracked(job);
      if (
        this.stopped ||
        epoch !== this.workspaceEpoch ||
        result.outcome !== "complete"
      )
        return;
      const output = result.output as {
        query?: string;
        publicSubject?: boolean;
        needed?: boolean;
      };
      const query =
        typeof output.query === "string" && queries.includes(output.query)
          ? output.query
          : undefined;
      if (output.needed && output.publicSubject && query)
        await this.researchPublic(query);
    } finally {
      this.researchBusy = false;
    }
  }
  async researchPublic(query: string) {
    if (this.stopped || this.researchAbort.signal.aborted) return;
    const signal = this.researchAbort.signal;
    const epoch = this.workspaceEpoch;
    const allowed = publicResearchQueries(
      JSON.stringify(effectiveContext(this.snapshots.read(this.state))),
      this.state.publicResearchTopics,
    );
    const safe = allowed.includes(query)
      ? safePublicQuery(query, [])
      : undefined;
    if (
      !safe ||
      Date.now() - (this.researchQueries.get(safe.toLowerCase()) ?? 0) < 1200000
    )
      return;
    this.researchQueries.set(safe.toLowerCase(), Date.now());
    query = safe;
    try {
      const hits = await invoke<SourceHit[]>("search_public_text", {
        query,
        workspaceId: this.state.workspaceId,
      });
      if (this.stopped || signal.aborted || epoch !== this.workspaceEpoch)
        return;
      this.publicSources = hits;
      for (const hit of hits)
        this.state = reduceMeetingEvent(this.state, {
          kind: "source",
          sourceId: hit.sourceId,
        });
      this.status({ code: "publicEvidence" });
      void this.refreshContext();
    } catch {
      this.status({ code: "publicResearchUnavailable" });
    }
  }
  private async automatic() {
    if (
      this.stopped ||
      this.assistancePaused ||
      this.state.status !== "active" ||
      this.decisionBusy
    )
      return;
    // A rate floor: speech arrives every second in a lively meeting, and each decision is a paid call. Within the
    // interval the decision is deferred (once), so the latest speech is still considered when the meeting goes quiet.
    const wait = this.nextDecisionAtMs - Date.now();
    if (wait > 0) {
      if (!this.decisionTimer)
        this.decisionTimer = setTimeout(() => {
          this.decisionTimer = undefined;
          if (this.observationsSinceCandidate >= 2) void this.automatic();
        }, wait);
      return;
    }
    this.nextDecisionAtMs = Date.now() + DECISION_INTERVAL_MS;
    this.decisionBusy = true;
    this.observationsSinceCandidate = 0;
    const basis = this.snapshots.read(this.state);
    try {
      const decision = await this.host.decide(basis);
      // The decision stays valid while the meeting has only moved on; generate() checks the card again.
      if (
        !this.canPrepare() ||
        !basisCompatibility(basis, this.snapshots.read(this.state), [])
          .compatible
      )
        return;
      if (
        (decision.researchQuery || decision.researchNeeded) &&
        Date.now() - this.lastResearch > 300000
      ) {
        this.lastResearch = Date.now();
        if (decision.researchQuery)
          void this.researchPublic(decision.researchQuery);
        else
          void this.planPublicResearch(basis).catch(() =>
            this.status({ code: "publicResearchUnavailable", detail: "planning" }),
          );
      }
      if (
        !decision.intervene ||
        !meetingProfiles[basis.profileId].automaticIntents.includes(
          decision.intent,
        )
      )
        return;
      await this.generate(decision.intent, "automatic", undefined, basis);
    } catch {
      this.status({ code: "decisionsUnavailable" });
    } finally {
      this.decisionBusy = false;
    }
  }
  stop() {
    if (!this.stopped) {
      const counts = this.preparationCounts.snapshot();
      if (counts.started)
        try {
          this.onPreparationCounts?.(counts);
        } catch {}
    }
    this.stopped = true;
    this.suspendPreparation();
    this.prepared.clear();
    this.researchAbort.abort();
    this.state = reduceMeetingEvent(this.state, {
      kind: "lifecycle",
      status: "stopped",
    });
    if (this.timer) clearInterval(this.timer);
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    // A failed cancel only means the job runs to its end; its result is ignored once the meeting has stopped.
    for (const jobId of this.tasks)
      void invoke("reasoning_cancel", { jobId }).catch((error: unknown) => console.warn("reasoning_cancel failed", error));
    this.tasks.clear();
  }
}
export function nativeReasoningHost(
  plan?: () => "none" | "standard" | "premium" | undefined,
) {
  return {
    plan: () => plan?.(),
    persistProfile: (
      id: string,
      profileId: ProfileId,
      profileRevision: number,
    ) =>
      invoke<void>("set_meeting_profile", { id, profileId, profileRevision }),
    run: async (
      job: ModelJob,
      prompt: string,
      trace?: TimingTrace,
      onDraft?: (update: DraftUpdate) => void,
    ) => {
      // Native streams provisional fragments over a channel the helper opens.
      const { timing, ...result } = await invokeReasoning<
        ModelResult & { timing?: { firstTokenMs?: number } }
      >(job, prompt, onDraft);
      // Native reports when the first streamed token arrived; absent on the single-body fallback.
      if (typeof timing?.firstTokenMs === "number")
        trace?.firstToken(timing.firstTokenMs);
      return result as ModelResult;
    },
    retrieve: (
      workspaceId: string,
      query: string,
      scope?: { sourceIds?: string[]; sharedLibraryIds?: string[] },
    ) =>
      invoke<SourceHit[]>("retrieve_context", { workspaceId, query, ...scope }),
    refresh: async (id: string, sharedLibraryIds?: string[]) => {
      const result = await invoke<{ changedSourceIds: string[] }>(
        "refresh_workspace",
        { id, sharedLibraryIds },
      );
      return result.changedSourceIds;
    },
    decide: async (basis: HotkeyContext) => {
      const profile = meetingProfiles[basis.profileId];
      const criteria = Object.fromEntries(
        profile.automaticIntents.map((intent) => [intent, intent]),
      );
      const result = await invoke<{
        answers: {
          intent: { choice: AssistanceIntent };
          intervene: { noul: number };
          research: { noul: number };
        };
      }>("jev_decide", {
        basis,
        effectiveContext: effectiveContext(basis),
        questions: {
          research: {
            type: "noul",
            instructions:
              "Would verifying a public tool, regulation, standard or company fact materially improve this conversation now? Private participant or internal-project research is excluded; do not research merely to repeat known context.",
          },
          intent: {
            type: "choice",
            instructions:
              "Which available intervention would most advance this meeting?",
            criteria,
          },
          intervene: {
            type: "noul",
            instructions:
              "Is there a specific worthwhile opportunity to intervene now, beyond repeating already-covered material? Be selective in ordinary work meetings and emphasize unanswered objectives in interviews/discovery.",
          },
        },
      });
      return {
        intent: result.answers.intent.choice,
        intervene: result.answers.intervene.noul >= profile.threshold,
        researchNeeded: result.answers.research.noul >= 0.9,
      };
    },
  };
}
