// What a screen reader is told when something changes on its own (#37). Pure: each function compares the previous
// and the next value of one piece of state and returns at most one short message. Nothing here reads audio or
// transcript text, and nothing gates recording. The design goal is "quiet during a live meeting": progress is
// announced at quarters rather than per byte, guidance announces its headline rather than its body, and draft text
// is never read out while it is still being written.
import { visibleCards, type GuidanceCard, type LiveViewState } from "@live-interview/core";
import { describeModelSetup, describeSetupFailure, type ModelSetupState } from "../public/modelSetup";
import { slowStatus, warmStatus } from "../public/speechWarmup";
import type { AssistanceStatus } from "./status";

export type Politeness = "polite" | "assertive";
export interface Announcement {
  text: string;
  politeness: Politeness;
  /**
   * The report this announcement comes from, when it has one (an assistance status id, a product message id). A new
   * report is spoken even with the same words as the last one; the same report is never spoken twice.
   */
  eventId?: string;
}
const polite = (text: string): Announcement => ({ text, politeness: "polite" });
const assertive = (text: string): Announcement => ({ text, politeness: "assertive" });

/** "Preparing local speech (one-time, a few minutes) · recording continues" -> two short sentences. */
function sentences(status: string): string {
  return status
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + part.slice(1))
    .join(". ") + ".";
}

/** Background speech-model load (#83): announce that it started, that it finished, and that it is pending. */
export function speechStatusAnnouncement(previous: string | undefined, next: string): Announcement | undefined {
  if (next === previous) return undefined;
  if (next.startsWith("Preparing local speech")) return polite(sentences(next));
  if (next === warmStatus && (previous?.startsWith("Preparing local speech") || previous === slowStatus)) return polite("Local speech is ready.");
  if (next === slowStatus) return polite(sentences(next));
  if (next.startsWith("Warm-up pending")) return polite(sentences(next));
  return undefined;
}

const QUARTERS = [25, 50, 75] as const;
const quarter = (state: ModelSetupState): number => {
  if (state.phase !== "running" || state.stage !== "downloading" || state.totalBytes <= 0) return 0;
  // 100 percent is not a milestone: finishing is announced when the download ends.
  return Math.min(QUARTERS.length, Math.floor((Math.min(1, state.completedBytes / state.totalBytes) * 100) / 25));
};

/** First-run model download: start, quarter milestones, retry, cancel, finish and failure. Never per byte. */
export function modelSetupAnnouncement(previous: ModelSetupState, next: ModelSetupState): Announcement | undefined {
  if (previous.phase === "running" && next.phase === "failed") {
    const failure = next.failure ? describeSetupFailure(next.failure) : undefined;
    const text = failure ? `${failure.message} ${failure.recovery}` : "Model setup stopped before it finished.";
    // A cancel the person asked for is not an error.
    return next.failure?.code === "cancelled" ? polite(text) : assertive(text);
  }
  if (previous.phase === "running" && next.phase === "idle") return polite("Speech models are downloaded and ready.");
  if (previous.phase !== "running" && next.phase === "running") return polite("Speech model download started. Recording is not affected.");
  if (next.phase !== "running") return undefined;
  if (!previous.cancelling && next.cancelling) return polite("Cancelling the download.");
  if (previous.stage !== "retrying" && next.stage === "retrying") return polite(describeModelSetup(next).headline);
  const before = previous.asset === next.asset ? quarter(previous) : 0;
  const after = quarter(next);
  if (after > before && after >= 1) return polite(`${describeModelSetup(next).headline}: ${QUARTERS[after - 1]} percent.`);
  return undefined;
}

/**
 * Guidance: a draft starting, and cards arriving. Only the headline is announced, never the card text: it keeps the
 * speech from competing with the meeting, and a screen reader speaks through the Mac's output, which in a call may be
 * audio the remote lane captures. Replacing a card in place (a refinement) says "updated" rather than "new". The first
 * call after a meeting starts has no previous view and says nothing.
 */
export function guidanceAnnouncement(previous: LiveViewState | undefined, next: LiveViewState, label: (card: GuidanceCard) => string): Announcement | undefined {
  if (!previous) return undefined;
  // Mirrors the list on screen: while a draft shows, the generic "reasoning pending" placeholder is not repeated.
  const shown = (view: LiveViewState) => visibleCards(view).filter((card) => !(view.draft && card.origin === "clarification" && card.provisional));
  const before = new Set(shown(previous).map((card) => card.id));
  const after = shown(next);
  const added = after.filter((card) => !before.has(card.id));
  const gone = [...before].some((id) => !after.some((card) => card.id === id));
  if (added.length) {
    const lead = gone ? "Suggestion updated" : added.length === 1 ? "New suggestion" : `${added.length} new suggestions`;
    return polite(`${lead}: ${added.map(label).join("; ")}`);
  }
  if (next.draft?.text && !previous.draft?.text) return polite("Draft guidance is being checked.");
  return undefined;
}

/**
 * Start, pause and resume of recording. Failure is already an alert where it happens, and the "Starting audio
 * capture" step is skipped so a meeting start is one message ("Recording started."), not two.
 */
export function captureAnnouncement(previous: string | undefined, next: string | undefined): Announcement | undefined {
  if (!previous || !next || previous === next) return undefined;
  if (next === "Recording needs attention" || next === "Starting audio capture") return undefined;
  if (next === "Recording locally" && previous === "Recording paused") return polite("Recording resumed.");
  if (next === "Recording locally" && previous === "Starting audio capture") return polite("Recording started.");
  if (next === "Recording locally") return polite("Recording locally.");
  return polite(next + ".");
}

/**
 * Assistance statuses (status.ts). Degraded statuses are spoken, and so are `info` confirmations a panel reports in
 * plain words (code `message`: "Approved record link created", "Meeting notes saved to 2 destinations"), because the
 * toast that shows them has no live role and this is the only place their words are spoken. Healthy (`ok`) statuses
 * have no words and are never spoken. Coded `info` hints from the guidance runtime ("Workspace context is catching
 * up") stay quiet: the live page does not show them either, and they would talk over the meeting. Each report is
 * spoken once: its id is the announcement's event id, so the gate lets a new report with the same words through.
 */
export function assistanceAnnouncement(previousId: number | undefined, next: Pick<AssistanceStatus, "id" | "code" | "severity" | "text">): Announcement | undefined {
  if (next.id === previousId || !next.text) return undefined;
  const spoken = next.severity === "degraded" || (next.severity === "info" && next.code === "message");
  return spoken ? { ...polite(next.text), eventId: `assistance:${next.id}` } : undefined;
}
/**
 * How the operation status line is shown: `info` stays quiet, `notice` is shown as a notice, `alert` is shown and
 * announced as a problem. Set by whoever sets the text, so a copy edit cannot change what a screen reader hears.
 */
export type StatusTone = "info" | "notice" | "alert";

/** A detected Teams call that waits for the person to accept it. */
export function callOfferAnnouncement(previous: string | undefined, next: string | undefined): Announcement | undefined {
  if (!next || next === previous) return undefined;
  return polite(`Detected call: ${next}. Accept it to start recording.`);
}

/**
 * Decides whether an announcement is spoken. An announcement with an event id is a distinct report: it is spoken once,
 * however recently the same words were said, and the same event id is never spoken again. One without an event id (a
 * change of state, such as "Recording paused.") is dropped when the same words were the last thing said within
 * `windowMs`, so a state that is set again does not talk over a meeting. A change back and forth (paused, resumed,
 * paused) always goes through: the last toggle is the state the person is in.
 */
export class AnnouncementGate {
  private last?: { text: string; at: number };
  private readonly spokenEvents: string[] = [];
  constructor(private readonly windowMs = 15_000, private readonly rememberedEvents = 100) {}
  accept(announcement: Announcement, now: number): boolean {
    if (announcement.eventId !== undefined) {
      if (this.spokenEvents.includes(announcement.eventId)) return false;
      this.spokenEvents.push(announcement.eventId);
      if (this.spokenEvents.length > this.rememberedEvents) this.spokenEvents.shift();
    } else if (this.last && this.last.text === announcement.text && now - this.last.at < this.windowMs) return false;
    this.last = { text: announcement.text, at: now };
    return true;
  }
}
