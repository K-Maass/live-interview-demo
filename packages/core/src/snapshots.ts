import type {
  ContextBundle,
  HotkeyContext,
  MeetingEvent,
  MeetingOptions,
  MeetingState,
  ReadyContextSnapshot,
  SourceHit,
  SpeechEvent,
} from "./contracts";
const immutable = <T>(input: T): T => {
  const v = structuredClone(input);
  const freeze = (x: unknown): void => {
    if (x && typeof x === "object") {
      Object.values(x).forEach(freeze);
      Object.freeze(x);
    }
  };
  freeze(v);
  return v;
};
export function createMeetingState(options: MeetingOptions): MeetingState {
  return {
    ...structuredClone(options),
    status: "active",
    segments: [],
    observationSequence: 0,
    revision: 0,
    indexRevision: 0,
    invalidatedSourceIds: [],
    attributions: [],
    coveredObjectives: [],
    pins: [],
  };
}
export function reduceMeetingEvent(
  state: MeetingState,
  event: MeetingEvent,
): MeetingState {
  const next = structuredClone(state);
  switch (event.kind) {
    case "speech":
      if (event.event.meetingId !== state.id) return state;
      {
        const old = next.segments.find(
          (e) => e.segmentId === event.event.segmentId,
        );
        if (
          old &&
          (old.revision > event.event.revision ||
            (old.revision === event.event.revision &&
              (old.kind === event.event.kind ||
                (old.kind === "final" && event.event.kind === "partial"))))
        )
          return state;
        if (
          next.historySummary?.evidence.some(
            (ref) =>
              ref.segmentId === event.event.segmentId &&
              ref.revision !== event.event.revision,
          )
        ) {
          next.historySummary = undefined;
          next.coveredObjectives = [];
          next.invalidatedSourceIds = [
            ...new Set([...next.invalidatedSourceIds, `summary:${next.id}`]),
          ];
        }
        next.segments = next.segments.filter(
          (e) => e.segmentId !== event.event.segmentId,
        );
        next.segments.push(event.event);
        next.observationSequence = Math.max(
          next.observationSequence,
          event.event.journalSequence,
        );
      }
      break;
    case "source":
      next.invalidatedSourceIds = [
        ...new Set([...next.invalidatedSourceIds, event.sourceId]),
      ];
      next.indexRevision++;
      break;
    case "profile":
      next.profileId = event.profileId;
      next.profileRevision++;
      break;
    case "brief":
      next.brief = event.brief;
      break;
    case "coverage":
      next.coveredObjectives = event.objectives;
      break;
    case "lifecycle":
      next.status = event.status;
      break;
    case "direction":
      next.purpose = event.purpose;
      break;
  }
  next.revision++;
  return next;
}
/**
 * The context holds the newest 32 to 39 transcript events. Its start moves 8 events at a time rather
 * than with every event, so the transcript in consecutive prompts starts at the same event and only
 * grows at the end (provider prompt caching); older turns are covered by the history summary.
 */
export const TRANSCRIPT_WINDOW = 32;
export const TRANSCRIPT_WINDOW_STRIDE = 8;
export function transcriptWindowStart(length: number): number {
  return Math.max(
    0,
    Math.floor((length - TRANSCRIPT_WINDOW) / TRANSCRIPT_WINDOW_STRIDE) *
      TRANSCRIPT_WINDOW_STRIDE,
  );
}
/**
 * Longest source ID a context may carry: the managed service rejects a longer one and the
 * evidence-ID pattern (`evidenceIdPattern`) could not cite it. research.rs caps new web IDs at the
 * same length; this also drops an over-long ID that is already cached.
 */
export const maxSourceIdLength = 2048;
export function buildContext(
  state: MeetingState,
  allHits: SourceHit[],
): ContextBundle {
  const hits = allHits.filter((h) => h.sourceId.length <= maxSourceIdLength);
  const sources: SourceHit[] = state.historySummary
    ? [
        ...hits,
        {
          sourceId: `summary:${state.id}`,
          workspaceId: state.workspaceId,
          kind: "conversation-summary",
          title: "Earlier conversation (derived)",
          text: state.historySummary.text,
          locator: `meeting:${state.id}#through:${state.historySummary.throughSequence}`,
          revision: state.historySummary.revision,
          derived: true,
        },
      ]
    : hits;
  return {
    purpose: state.purpose,
    publicResearchTopics: state.publicResearchTopics,
    coveredObjectives: state.coveredObjectives,
    // An answered or outdated pin no longer steers guidance.
    pinnedTopics: state.pins.filter((p) => !p.pinOutcome).map((p) => p.say),
    participants: state.attendees,
    selfName: state.selfName,
    attributions: state.attributions,
    objectives: state.objectives,
    brief: state.brief,
    conversation: state.segments.slice(transcriptWindowStart(state.segments.length)),
    sources,
    stateRevision: state.revision,
    indexRevision: state.indexRevision,
    briefRevision: state.brief?.revision ?? 0,
    sourceRevisions: Object.fromEntries(
      sources.map((h) => [h.sourceId, h.revision]),
    ),
  };
}
export class SnapshotStore {
  private ready = new Map<string, ReadyContextSnapshot>();
  private versions = new Map<
    string,
    {
      complete: boolean;
      events: Map<string, { revision: number; kind: SpeechEvent["kind"] }>;
    }
  >();
  initialise(state: MeetingState) {
    this.publish(
      {
        snapshotId: crypto.randomUUID(),
        meetingId: state.id,
        context: buildContext(state, []),
        candidates: [],
        createdAtMs: Date.now(),
        transcriptThroughSequence: state.observationSequence,
      },
      state.segments,
    );
  }
  publish(snapshot: ReadyContextSnapshot, segments?: SpeechEvent[]) {
    const current = this.ready.get(snapshot.meetingId);
    if (
      current &&
      snapshot.context.stateRevision < current.context.stateRevision
    )
      return false;
    this.ready.set(snapshot.meetingId, immutable(snapshot));
    this.versions.set(snapshot.meetingId, {
      complete: segments !== undefined,
      events: new Map(
        (segments ?? snapshot.context.conversation).map((e) => [
          e.segmentId,
          { revision: e.revision, kind: e.kind },
        ]),
      ),
    });
    return true;
  }
  read(state: MeetingState): HotkeyContext {
    if (!this.ready.has(state.id)) this.initialise(state);
    return immutable({
      snapshot: this.ready.get(state.id)!,
      transcriptDeltas: state.segments
        .filter(
          (e) =>
            e.journalSequence >
              this.ready.get(state.id)!.transcriptThroughSequence ||
            (this.versions.get(state.id)?.events.has(e.segmentId) &&
              (this.versions.get(state.id)!.events.get(e.segmentId)!
                .revision !== e.revision ||
                this.versions.get(state.id)!.events.get(e.segmentId)!.kind !==
                  e.kind)) ||
            (!!this.versions.get(state.id)?.complete &&
              !this.versions.get(state.id)!.events.has(e.segmentId)),
        )
        .slice(-256),
      invalidatedSourceIds: [...state.invalidatedSourceIds],
      observationSequence: state.observationSequence,
      stateRevision: state.revision,
      profileId: state.profileId,
      profileRevision: state.profileRevision,
    });
  }
  clear(id: string) {
    this.ready.delete(id);
    this.versions.delete(id);
  }
}
export function acceptResultBasis(
  state: MeetingState,
  basis: HotkeyContext,
): boolean {
  return (
    state.status !== "stopped" &&
    basis.snapshot.meetingId === state.id &&
    basis.stateRevision === state.revision &&
    basis.observationSequence === state.observationSequence &&
    basis.profileRevision === state.profileRevision &&
    !state.invalidatedSourceIds.some(
      (id) =>
        basis.snapshot.context.sources.some((s) => s.sourceId === id) &&
        !basis.invalidatedSourceIds.includes(id),
    )
  );
}
export function effectiveContext(basis: HotkeyContext): ContextBundle {
  const context = structuredClone(basis.snapshot.context);
  context.sources = context.sources.filter(
    (s) => !basis.invalidatedSourceIds.includes(s.sourceId),
  );
  const events = new Map(context.conversation.map((e) => [e.segmentId, e]));
  for (const e of basis.transcriptDeltas) {
    const old = events.get(e.segmentId);
    if (!old || e.revision >= old.revision) events.set(e.segmentId, e);
  }
  context.conversation = [...events.values()].sort(
    (a, b) => a.startMs - b.startMs,
  );
  context.stateRevision = basis.stateRevision;
  return context;
}
/**
 * Whether a result written against `earlier` may still be shown at `current` (two reads of the same
 * meeting, the second one now). It may when the meeting only moved on: same meeting and profile, no
 * source the result could rest on was invalidated or revised, the brief is the same, and every
 * segment the result cites is still there at the same revision and kind (a cited translation also
 * needs its source turn unchanged). Newer turns, and revisions of turns it does not cite, are allowed
 * and returned as `appended`, so the caller can label the card with its basis time and decide
 * whether to refine it. Uncited sources count too: a source that shaped the reasoning without being
 * cited may still have changed its conclusion. Only an uncited derived summary may be re-summarised.
 */
export interface BasisCompatibility {
  compatible: boolean;
  /** Events the result has not seen: newer than its basis, in journal order. */
  appended: SpeechEvent[];
  reason?: "meeting" | "profile" | "order" | "direction" | "source" | "brief" | "citedSegment";
}
export function basisCompatibility(
  earlier: HotkeyContext,
  current: HotkeyContext,
  evidence: readonly string[],
  /** The meeting's full transcript (MeetingState.segments): finds a cited turn outside the window. */
  segments?: readonly SpeechEvent[],
): BasisCompatibility {
  const no = (reason: BasisCompatibility["reason"]): BasisCompatibility => ({
    compatible: false,
    appended: [],
    reason,
  });
  if (earlier.snapshot.meetingId !== current.snapshot.meetingId) return no("meeting");
  if (
    earlier.profileId !== current.profileId ||
    earlier.profileRevision !== current.profileRevision
  )
    return no("profile");
  if (current.observationSequence < earlier.observationSequence) return no("order");
  const before = effectiveContext(earlier);
  const now = effectiveContext(current);
  if (before.briefRevision !== now.briefRevision) return no("brief");
  // The person changed what the meeting is for; pins, coverage and speaker attributions may move on.
  if (
    before.purpose !== now.purpose ||
    JSON.stringify(before.objectives) !== JSON.stringify(now.objectives)
  )
    return no("direction");
  const cited = new Set(evidence);
  const nowSources = new Map(now.sources.map((s) => [s.sourceId, s]));
  for (const source of before.sources) {
    if (current.invalidatedSourceIds.includes(source.sourceId)) return no("source");
    const later = nowSources.get(source.sourceId);
    if (
      later &&
      (later.revision !== source.revision || later.text !== source.text) &&
      !(source.derived && !cited.has(source.sourceId))
    )
      return no("source");
  }
  // A cited turn is looked up in the full transcript when given: the current read holds only a window,
  // and a revised turn can be pushed out of it by newer ones. A cited turn found nowhere is not assumed
  // unchanged.
  const nowEvents = new Map(now.conversation.map((e) => [e.segmentId, e]));
  const fullEvents = segments && new Map(segments.map((e) => [e.segmentId, e]));
  const beforeEvents = new Map(before.conversation.map((e) => [e.segmentId, e]));
  const unchanged = (earlierEvent: SpeechEvent | undefined, kindToo: boolean) => {
    if (!earlierEvent) return true;
    const later =
      fullEvents?.get(earlierEvent.segmentId) ?? nowEvents.get(earlierEvent.segmentId);
    return (
      !!later &&
      later.revision === earlierEvent.revision &&
      (!kindToo || (later.kind === earlierEvent.kind && later.text === earlierEvent.text))
    );
  };
  for (const id of cited) {
    if (!id.startsWith("segment:")) continue;
    const event = beforeEvents.get(id.slice("segment:".length));
    if (!event || !unchanged(event, true)) return no("citedSegment");
    // A translation is keyed to its source turn's revision: a corrected source makes it stale.
    const source =
      event.kind === "translation" && event.sourceSegmentId
        ? beforeEvents.get(event.sourceSegmentId)
        : undefined;
    if (source && !unchanged({ ...source, revision: event.revision }, false))
      return no("citedSegment");
  }
  return {
    compatible: true,
    appended: now.conversation
      .filter((e) => e.journalSequence > earlier.observationSequence)
      .sort((a, b) => a.journalSequence - b.journalSequence),
  };
}
/** A finished new turn of at least four words: worth refining a card that has not seen it. */
export function materialAppend(appended: readonly SpeechEvent[]): boolean {
  return appended.some(
    (e) => e.kind === "final" && e.text.trim().split(/\s+/u).filter(Boolean).length >= 4,
  );
}
