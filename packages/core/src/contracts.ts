export type CaptureLane = "me" | "remote";
export type SpeakerClusterId = string & { readonly __cluster: unique symbol };
export type PersonId = string & { readonly __person: unique symbol };
export type AssistanceIntent =
  | "digDeeper"
  | "respond"
  | "contribute"
  | "checkConversation"
  | "checkObjectives";
export type ProfileId =
  "interview" | "discovery" | "workClient" | "presentationAnswering";
export interface SpeechEvent {
  meetingId: string;
  segmentId: string;
  revision: number;
  journalSequence: number;
  lane: CaptureLane;
  startMs: number;
  endMs: number;
  language: string;
  text: string;
  kind: "partial" | "final" | "translation";
  sourceSegmentId?: string;
  speakerClusterId?: SpeakerClusterId;
  confidence?: number;
}
export interface SpeakerAttribution {
  clusterId: SpeakerClusterId;
  personId?: PersonId;
  status: "unattributed" | "suggested" | "established" | "confirmed";
  evidence: string[];
  confirmedByUser?: boolean;
}
export interface ImportedSegment {
  id: string;
  text: string;
  language: string;
  provenance: "unknown" | "source-reported";
  sourceId: string;
  speakerLabel?: string;
}
export interface Brief {
  revision: number;
  text: string;
  objectives: string[];
  evidence: string[];
}
export interface MeetingOptions {
  sourceIds?: string[];
  sharedLibraryIds?: string[];
  publicResearchTopics?: string[];
  id: string;
  workspaceId: string;
  purpose: string;
  objectives: string[];
  brief?: Brief;
  attendees: { id: PersonId; name: string }[];
  /** Display name of the signed-in user, bound to the `me` (microphone) lane. Neutral "You" when absent. */
  selfName?: string;
  scheduledEndMs?: number;
  profileId: ProfileId;
  profileRevision: number;
}
export interface LocalMeetingOptions extends MeetingOptions {
  retainAudio: boolean;
}
export interface MeetingRecord extends MeetingOptions {
  date: string;
  revision: number;
  segments: SpeechEvent[];
  importedSegments: ImportedSegment[];
  attributions: SpeakerAttribution[];
  /** "unavailable": nothing is left to process, but some source passages could not be translated. */
  translationStatus: "pending" | "complete" | "unavailable";
  pendingSegments?: number;
  canonicalEnglishPath?: string;
  fixtureMode?: boolean;
  audioReference?: string;
  /**
   * Set on `list_meeting_records` entries: a summary without the transcript (`segments` is empty). Open the meeting
   * with `load_meeting_record` before reading its segments.
   */
  summary?: boolean;
  /** The app closed during this meeting and launch recovery processed (or is processing) what it saved. */
  recovery?: { state: "recovering" | "recovered" | "interrupted" };
}
export interface TranslationReadiness {
  /** Language translations are written in; English until the app has a per-user target. */
  target: string;
  /** Apple on-device translation needs macOS 26; older Macs keep the source and mark translation pending. */
  appleAvailable: boolean;
  /** Source languages Apple has installed for `target`. */
  installedSources: string[];
  /** Whisper medium translation is experimental (#29) and off unless the user turns it on. */
  experimentalMedium: boolean;
  mediumAssetsReady: boolean;
}
export interface SpeechReadiness {
  recognitionReady: boolean;
  translationReady: boolean;
  translation?: TranslationReadiness;
  code?: string;
}
export interface SourceHit {
  sourceId: string;
  workspaceId: string;
  kind: string;
  title: string;
  text: string;
  locator: string;
  revision: number;
  derived: boolean;
}
export interface ContextBundle {
  publicResearchTopics?: string[];
  coveredObjectives?: string[];
  pinnedTopics?: string[];
  participants?: { id: PersonId; name: string }[];
  /** Name the `me` lane is bound to; taken from the app, never inferred. Neutral "You" when absent. */
  selfName?: string;
  attributions?: SpeakerAttribution[];
  purpose: string;
  objectives: string[];
  brief?: Brief;
  conversation: SpeechEvent[];
  sources: SourceHit[];
  stateRevision: number;
  indexRevision: number;
  briefRevision: number;
  sourceRevisions: Record<string, number>;
}
export interface ReadyContextSnapshot {
  snapshotId: string;
  meetingId: string;
  context: ContextBundle;
  candidates: GuidanceCard[];
  createdAtMs: number;
  transcriptThroughSequence: number;
}
export interface HotkeyContext {
  snapshot: ReadyContextSnapshot;
  transcriptDeltas: SpeechEvent[];
  invalidatedSourceIds: string[];
  observationSequence: number;
  stateRevision: number;
  profileId: ProfileId;
  profileRevision: number;
}
export interface MeetingProfile {
  id: ProfileId;
  label: string;
  automaticIntents: AssistanceIntent[];
  /** Intents prepared speculatively when a remote turn settles, most useful first. */
  preparedIntents: AssistanceIntent[];
  threshold: number;
  steering: "active" | "selective" | "responses";
}
/** Answered: the person says the topic was addressed. Outdated: no longer relevant. */
export type PinOutcome = "answered" | "outdated";
export interface GuidanceCard {
  trigger?: "requested" | "automatic";
  provisional?: boolean;
  id: string;
  origin?: "model" | "clarification" | "cache";
  preparedFrom?: {
    jobId: string;
    provider: string;
    model: string;
    startedAtMs: number;
    preparedAtMs: number;
    snapshotId: string;
    snapshotCreatedAtMs: number;
    observationSequence: number;
    stateRevision: number;
    profileId: ProfileId;
    profileRevision: number;
    indexRevision: number;
    briefRevision: number;
    sourceRevisions: Record<string, number>;
  };
  intent: AssistanceIntent;
  headline?: string;
  say: string;
  why: string;
  evidence: string[];
  createdAtMs: number;
  basis: HotkeyContext;
  /**
   * Set when newer turns arrived after the basis was read and the card was still shown (they do not
   * touch what it cites): the wall-clock time of that basis, shown as "as of hh:mm:ss".
   */
  asOfMs?: number;
  pinned: boolean;
  /** A person's decision on a pinned topic. Only the person sets it; the app never infers it. */
  pinOutcome?: PinOutcome;
  /** The app's inference that a pinned topic may be outdated: a source it cites changed. Never a decision. */
  outdatedSuggested?: boolean;
  stale: boolean;
  usefulness: number;
  relevance: number;
  novelty: number;
  answerQuality: number;
  uncertain: boolean;
}
export interface ModelJob {
  usageFeature?: "live" | "preparation" | "automaticPreparation" | "synthesis";
  id: string;
  meetingId: string;
  lane: "fast" | "deep" | "decision";
  intent: AssistanceIntent;
  trigger: "requested" | "automatic";
  recentSuggestions?: string[];
  brevityRetry?: boolean;
  basis: HotkeyContext;
  outputSchema: object;
  deadlineMs: number;
  toolBudget: number;
  refinesJobId?: string;
  refinesCardId?: string;
  preparation?: boolean;
}
export interface ModelResult {
  jobId: string;
  provider: string;
  model: string;
  output: unknown;
  basis: HotkeyContext;
  outcome: "complete" | "failure" | "cancelled";
  code?: string;
  /** `cachedInput`, when the provider reports it, is the part of `input` served from its prompt cache; it never changes billing. */
  usage?: { input: number; output: number; cachedInput?: number };
}
export interface MeetingState extends MeetingOptions {
  historySummary?: {
    text: string;
    evidence: { segmentId: string; revision: number }[];
    throughSequence: number;
    revision: number;
  };
  status: "active" | "paused" | "stopped";
  segments: SpeechEvent[];
  observationSequence: number;
  revision: number;
  indexRevision: number;
  invalidatedSourceIds: string[];
  attributions: SpeakerAttribution[];
  coveredObjectives: string[];
  pins: GuidanceCard[];
}
export type MeetingEvent =
  | { kind: "speech"; event: SpeechEvent }
  | { kind: "source"; sourceId: string }
  | { kind: "profile"; profileId: ProfileId }
  | { kind: "coverage"; objectives: string[] }
  | { kind: "brief"; brief: Brief }
  | { kind: "lifecycle"; status: MeetingState["status"] }
  | { kind: "direction"; purpose: string };
export type GuidanceEvent =
  | { kind: "card" | "refinement"; card: GuidanceCard; refinesCardId?: string }
  | { kind: "contextChanged"; basis: HotkeyContext }
  | { kind: "no-help"; trigger: "automatic"; reason: string }
  | { kind: "failure"; code: string }
  /** Unvalidated first line of a requested answer; no `text` clears the draft. */
  | { kind: "draft"; intent: AssistanceIntent; text?: string };
/**
 * Provisional, unvalidated text shown while the model is still answering. It is
 * display only: never a card, so it can't be pinned, noted, cited or recorded.
 */
export interface GuidanceDraft {
  intent: AssistanceIntent;
  text: string;
}
export interface LiveViewState {
  cards: GuidanceCard[];
  savedPins: GuidanceCard[];
  draft?: GuidanceDraft;
  requestedCard?: GuidanceCard;
  detailCardId?: string;
  queued: number;
}
export interface AppOwnedNoteTarget {
  id: string;
  path: string;
  expectedRevision: number;
}
export interface ActionProposal {
  id: string;
  targetId: string;
  targetPath: string;
  targetVersion: string;
  operation: "append" | "rewrite" | "move" | "calendarAdd" | "calendarEdit";
  before: string;
  after: string;
  evidence: string[];
  inferred: boolean;
  status: "proposed" | "approved" | "applied" | "declined";
  owner?: string;
  due?: string;
}
export interface ImportReport {
  imported: number;
  skipped: number;
  conflicts: number;
  unresolved: string[];
  errors: string[];
}
export interface ShareSelection {
  workspaceIds: string[];
  meetingIds: string[];
}
export interface WorkspaceBundle {
  version: 1;
  records: MeetingRecord[];
  sources: SourceHit[];
}
