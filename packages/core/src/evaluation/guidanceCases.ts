import type {
  AssistanceIntent,
  CaptureLane,
  HotkeyContext,
  MeetingState,
  PersonId,
  ProfileId,
  SourceHit,
} from "../contracts";
import {
  buildContext,
  createMeetingState,
  reduceMeetingEvent,
  SnapshotStore,
} from "../snapshots";

/** Offline guidance evaluation case. Synthetic cases are committed; private ones stay local. */
export const edgeCases = [
  "conflictingClaims",
  "asrNoise",
  "codeSwitching",
  "mistranslation",
  "topicShift",
  "staleSource",
  "answerNotInEvidence",
  "mentionedNotCovered",
] as const;
export type EdgeCase = (typeof edgeCases)[number];
export interface CaseSource {
  sourceId: string;
  title: string;
  kind: string;
  text: string;
  revision: number;
}
export type CaseTurn =
  | {
      seq: number;
      lane: CaptureLane;
      text: string;
      language?: string;
      /** English translation event for non-English speech, as the local pipeline emits it. */
      translation?: string;
    }
  | { seq: number; sourceUpdate: CaseSource }
  | { seq: number; coverage: string[] };
export interface Checkpoint {
  id: string;
  intent: AssistanceIntent;
  /** Hotkey moment: transcript through this sequence is known. */
  at: number;
  /** Latest ready snapshot; later turns arrive as transcript deltas. */
  snapshotAt: number;
  mustInclude: string[];
  mustNotInclude: string[];
  ideal: string;
}
export interface GuidanceCase {
  id: string;
  title: string;
  profile: ProfileId;
  language: "en" | "de";
  purpose: string;
  objectives: string[];
  brief?: { text: string; objectives: string[] };
  attendees: { id: string; name: string }[];
  edgeCases: EdgeCase[];
  sources: CaseSource[];
  turns: CaseTurn[];
  checkpoints: Checkpoint[];
  /** Private cases never appear in committed summaries. */
  private?: boolean;
}
const profiles: ProfileId[] = [
  "interview",
  "discovery",
  "workClient",
  "presentationAnswering",
];
const intents: AssistanceIntent[] = [
  "digDeeper",
  "respond",
  "contribute",
  "checkConversation",
  "checkObjectives",
];
const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const texts = (v: unknown) => Array.isArray(v) && v.every(text);
const seq = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
function sourceErrors(s: CaseSource, where: string): string[] {
  return [
    !text(s?.sourceId) && `${where}: sourceId`,
    !text(s?.title) && `${where}: title`,
    !text(s?.kind) && `${where}: kind`,
    !text(s?.text) && `${where}: text`,
    !seq(s?.revision) && `${where}: revision`,
  ].filter((e): e is string => !!e);
}
/** Returns every structural problem; an empty list means the case is usable. */
export function validateCase(c: GuidanceCase): string[] {
  const errors: string[] = [];
  const need = (ok: unknown, message: string) => {
    if (!ok) errors.push(message);
  };
  need(/^[a-z0-9-]{3,80}$/.test(c?.id ?? ""), "id must be kebab-case");
  need(text(c?.title), "title");
  need(profiles.includes(c?.profile), "profile");
  need(["en", "de"].includes(c?.language), "language");
  need(text(c?.purpose), "purpose");
  need(texts(c?.objectives) && c.objectives.length > 0, "objectives");
  need(
    c?.brief === undefined ||
      (text(c.brief.text) && texts(c.brief.objectives)),
    "brief",
  );
  need(
    Array.isArray(c?.attendees) &&
      c.attendees.every((a) => text(a.id) && text(a.name)),
    "attendees",
  );
  need(
    Array.isArray(c?.edgeCases) &&
      c.edgeCases.every((e) => edgeCases.includes(e)),
    "edgeCases",
  );
  if (!Array.isArray(c?.sources) || !Array.isArray(c?.turns)) {
    errors.push("sources and turns must be arrays");
    return errors;
  }
  c.sources.forEach((s, i) => errors.push(...sourceErrors(s, `sources[${i}]`)));
  need(
    new Set(c.sources.map((s) => s.sourceId)).size === c.sources.length,
    "duplicate sourceId",
  );
  let last = 0;
  for (const [i, t] of c.turns.entries()) {
    need(seq(t.seq) && t.seq > last, `turns[${i}]: seq must increase`);
    last = Math.max(last, t.seq);
    if ("lane" in t) {
      need(["me", "remote"].includes(t.lane), `turns[${i}]: lane`);
      need(text(t.text), `turns[${i}]: text`);
      need(
        t.translation === undefined || text(t.translation),
        `turns[${i}]: translation`,
      );
    } else if ("sourceUpdate" in t) {
      errors.push(...sourceErrors(t.sourceUpdate, `turns[${i}].sourceUpdate`));
      need(
        c.sources.some((s) => s.sourceId === t.sourceUpdate.sourceId),
        `turns[${i}]: update of unknown source`,
      );
    } else if ("coverage" in t) need(texts(t.coverage), `turns[${i}]: coverage`);
    else errors.push(`turns[${i}]: unknown turn`);
  }
  need(
    Array.isArray(c.checkpoints) &&
      c.checkpoints.length >= 1 &&
      c.checkpoints.length <= 3,
    "1-3 checkpoints",
  );
  for (const [i, cp] of (c.checkpoints ?? []).entries()) {
    need(text(cp.id), `checkpoints[${i}]: id`);
    need(intents.includes(cp.intent), `checkpoints[${i}]: intent`);
    need(
      seq(cp.at) && c.turns.some((t) => t.seq === cp.at),
      `checkpoints[${i}]: at must name a turn`,
    );
    need(
      Number.isSafeInteger(cp.snapshotAt) &&
        cp.snapshotAt >= 0 &&
        cp.snapshotAt <= cp.at,
      `checkpoints[${i}]: snapshotAt`,
    );
    need(
      texts(cp.mustInclude) && cp.mustInclude.length > 0,
      `checkpoints[${i}]: mustInclude`,
    );
    need(texts(cp.mustNotInclude), `checkpoints[${i}]: mustNotInclude`);
    need(text(cp.ideal), `checkpoints[${i}]: ideal`);
  }
  need(
    new Set((c.checkpoints ?? []).map((cp) => cp.id)).size ===
      (c.checkpoints ?? []).length,
    "duplicate checkpoint id",
  );
  return errors;
}
const hit = (c: GuidanceCase, s: CaseSource): SourceHit => ({
  sourceId: s.sourceId,
  workspaceId: "eval",
  kind: s.kind,
  title: s.title,
  text: s.text,
  locator: `eval:${c.id}/${s.sourceId}`,
  revision: s.revision,
  derived: false,
});
/**
 * Replays a case up to a checkpoint exactly as the live runtime would see it:
 * a ready snapshot published at `snapshotAt` (after which pending source
 * invalidations are cleared, as a successful retrieval publish does), then the
 * remaining turns as transcript deltas and source invalidations.
 */
export function buildCheckpointBasis(
  c: GuidanceCase,
  checkpoint: Checkpoint,
): HotkeyContext {
  let state: MeetingState = createMeetingState({
    id: c.id,
    workspaceId: "eval",
    purpose: c.purpose,
    objectives: c.objectives,
    ...(c.brief
      ? {
          brief: {
            revision: 1,
            text: c.brief.text,
            objectives: c.brief.objectives,
            evidence: [],
          },
        }
      : {}),
    attendees: c.attendees.map((a) => ({ id: a.id as PersonId, name: a.name })),
    sourceIds: c.sources.map((s) => s.sourceId),
    profileId: c.profile,
    profileRevision: 0,
  });
  const sources = new Map(c.sources.map((s) => [s.sourceId, hit(c, s)]));
  const store = new SnapshotStore();
  let published = false;
  const publish = () => {
    store.publish(
      {
        snapshotId: `${c.id}@${checkpoint.snapshotAt}`,
        meetingId: c.id,
        context: buildContext(state, [...sources.values()]),
        candidates: [],
        createdAtMs: checkpoint.snapshotAt * 1000,
        transcriptThroughSequence: state.observationSequence,
      },
      state.segments,
    );
    state = { ...state, invalidatedSourceIds: [] };
    published = true;
  };
  for (const turn of c.turns) {
    if (turn.seq > checkpoint.at) break;
    if (!published && turn.seq > checkpoint.snapshotAt) publish();
    if ("lane" in turn) {
      const language = turn.language ?? c.language;
      const base = {
        meetingId: c.id,
        revision: 1,
        journalSequence: turn.seq,
        lane: turn.lane,
        startMs: turn.seq * 8000,
        endMs: turn.seq * 8000 + 7000,
      };
      state = reduceMeetingEvent(state, {
        kind: "speech",
        event: {
          ...base,
          segmentId: `t${turn.seq}`,
          language,
          text: turn.text,
          kind: "final",
        },
      });
      if (turn.translation)
        state = reduceMeetingEvent(state, {
          kind: "speech",
          event: {
            ...base,
            segmentId: `t${turn.seq}-en`,
            sourceSegmentId: `t${turn.seq}`,
            language: "en",
            text: turn.translation,
            kind: "translation",
          },
        });
    } else if ("sourceUpdate" in turn) {
      sources.set(turn.sourceUpdate.sourceId, hit(c, turn.sourceUpdate));
      state = reduceMeetingEvent(state, {
        kind: "source",
        sourceId: turn.sourceUpdate.sourceId,
      });
    } else
      state = reduceMeetingEvent(state, {
        kind: "coverage",
        objectives: turn.coverage,
      });
  }
  if (!published) publish();
  return structuredClone(store.read(state));
}
