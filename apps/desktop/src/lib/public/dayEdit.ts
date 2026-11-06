// The meeting page's day panel: which meetings can move, and the drag → pending → confirmed/cancelled steps. Pure.
//
//   movability(input)                    how a meeting may move: saved directly, reviewed first, or not at all (and why)
//   placeRange(mode, original, at, floor)  where a drag or key press puts a range, in wall minutes of the day
//   nudge(range, key, modifiers, floor)  the arrow-key shortcuts: a new range, or a day step for Option+←/→
//   pastFloor(dayMs, now)                the earliest minute a change may land on that day (no drops into the past)
//   reduceEdit(state, event)             the drag → pending → confirmed/cancelled state machine
//   overlapNote(active, others)          "Overlaps “Team review”" in plain words
//
// The panel only reports proposed ranges; the page decides whether to save directly or open a calendar review, and the
// app-owned action executor does any calendar write. Nothing here writes anything.
import { DAY_MINUTES, SNAP, snap } from "./calendarSave";

export type Movability = { kind: "direct" } | { kind: "review"; calendarName: string; invitation?: boolean } | { kind: "readOnly"; reason: string };
export interface DayPanelMeeting { id: string; title: string; startMs: number; endMs: number; allDay?: boolean; isThis: boolean; movability: Movability; planId?: string; eventId?: string }
export interface TimeRange { startMs: number; endMs: number }
/** Wall minutes from local midnight; end may be 1440 (midnight that ends the day). */
export interface MinuteRange { start: number; end: number }

// ---- Movability ----

export interface MovabilityInput {
  /** A plan that lives only in this app (no calendar event). */
  appOnly: boolean;
  /** The calendar event was added by this app to a Mac calendar. */
  appCreated?: boolean;
  /** Where the event comes from. Only macOS (EventKit) events can move; Outlook/Exchange added to macOS count as macOS. */
  provider?: "apple" | "google" | "microsoft";
  /** The calendar's name, for "Move in Work calendar?". */
  calendarName?: string;
  /** The event or its calendar does not allow changes. */
  readOnly?: boolean;
  /** Part of a series. */
  recurring?: boolean;
  allDay?: boolean;
  /** Someone else organised it: moving it changes only the person's own calendar. */
  invitation?: boolean;
}

export const READ_ONLY_REASONS = {
  google: "From Google Calendar, connected read-only. Change it in Google Calendar.",
  microsoft: "From Microsoft 365, connected read-only. Change it in Outlook.",
  calendar: "This calendar doesn't allow changes.",
  recurring: "Repeating meeting. Change it in Calendar.",
  allDay: "All-day event. Change it in Calendar.",
} as const;

/** The default warning for moving an invitation (product decision 2); the page may pass more exact copy. */
export const INVITATION_WARNING = "You're not the organiser. This moves it in your calendar only; the organiser and other guests keep their time.";
/** What the review card says for a meeting the person organised or the app created. */
export const ORGANISER_NOTE = "People invited may get an update from your calendar.";

/**
 * How a meeting may move. App-only plans save directly. Calendar events are reviewed on each drop, but only macOS
 * events that are single (not repeating), timed and in a calendar that allows changes. The first rule that blocks a
 * move gives the reason: the connection, then the calendar, then repeating, then all-day.
 */
export function movability(input: MovabilityInput): Movability {
  if (input.appOnly) return { kind: "direct" };
  if (input.provider === "google") return { kind: "readOnly", reason: READ_ONLY_REASONS.google };
  if (input.provider === "microsoft") return { kind: "readOnly", reason: READ_ONLY_REASONS.microsoft };
  if (input.readOnly) return { kind: "readOnly", reason: READ_ONLY_REASONS.calendar };
  if (input.recurring) return { kind: "readOnly", reason: READ_ONLY_REASONS.recurring };
  if (input.allDay) return { kind: "readOnly", reason: READ_ONLY_REASONS.allDay };
  const calendarName = input.calendarName?.trim() || "your calendar";
  // An event the app created is the person's own, whatever the attendee list says.
  return input.invitation && !input.appCreated ? { kind: "review", calendarName, invitation: true } : { kind: "review", calendarName };
}

export const canMove = (m: Movability) => m.kind !== "readOnly";

// ---- Geometry: where a drag or key press lands ----

export type DragMode = "move" | "start" | "end" | "new";

/**
 * The earliest wall minute a change may land on `dayMs`: 0 on a later day, the next 15-minute mark today, and past the
 * end of the day for an earlier day (nothing can be dropped there).
 */
export function pastFloor(dayMs: number, now: number): number {
  const day = new Date(dayMs), today = new Date(now);
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (d > t) return 0;
  if (d < t) return DAY_MINUTES + SNAP;
  const minutes = today.getHours() * 60 + today.getMinutes() + today.getSeconds() / 60;
  return Math.ceil(minutes / SNAP) * SNAP;
}

// A value may not land before `floor`. A value that was already in the past (an ongoing meeting's start) stays where it
// was until the new value passes the floor, so dragging a started meeting never makes it jump forward on its own.
const notPast = (value: number, was: number, floor: number) => was < floor ? (value < floor ? was : value) : Math.max(value, floor);

/**
 * The range a drag gives. `at` is the pointer's minute (for "move", the block's wanted start: pointer minus where it was
 * grabbed). 15-minute snap, at least 15 minutes long, never across midnight, never into the past. A change that cannot
 * be made returns `original` unchanged.
 */
export function placeRange(mode: DragMode, original: MinuteRange, at: number, floor: number, anchor = original.start): MinuteRange {
  const length = original.end - original.start;
  if (mode === "move") {
    const max = DAY_MINUTES - length;
    if (floor > max) return original;
    const start = Math.min(max, Math.max(0, notPast(snap(at), original.start, floor)));
    return start < floor && start !== original.start ? original : { start, end: start + length };
  }
  if (mode === "start") {
    const start = Math.min(original.end - SNAP, Math.max(0, notPast(snap(at), original.start, floor)));
    return start < floor && start !== original.start ? original : { start, end: original.end };
  }
  if (mode === "end") {
    const end = Math.min(DAY_MINUTES, Math.max(original.start + SNAP, notPast(snap(at), original.end, floor)));
    return end < floor && end !== original.end ? original : { start: original.start, end };
  }
  // "new": from where the drag began to where it is now.
  if (floor > DAY_MINUTES - SNAP) return original;
  const a = Math.max(snap(anchor), floor), b = Math.max(snap(at), floor);
  const start = Math.min(a, b), end = Math.max(a, b);
  if (end - start >= SNAP) return { start, end };
  const s = Math.min(start, DAY_MINUTES - SNAP);
  return { start: s, end: s + SNAP };
}

export interface KeyModifiers { shiftKey?: boolean; altKey?: boolean }
export type NudgeResult = { range: MinuteRange; mode: DragMode } | { day: -1 | 1 } | undefined;

/**
 * The keyboard shortcuts on a focused meeting: ↑/↓ move it 15 minutes, Shift+↑/↓ change the end, Option+↑/↓ change the
 * start, Option+←/→ step to the previous or next day (the page decides what that means). Other keys: undefined.
 */
export function nudge(range: MinuteRange, key: string, modifiers: KeyModifiers, floor: number): NudgeResult {
  if (modifiers.altKey && (key === "ArrowLeft" || key === "ArrowRight")) return { day: key === "ArrowLeft" ? -1 : 1 };
  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  const delta = key === "ArrowUp" ? -SNAP : SNAP;
  if (modifiers.shiftKey) return { mode: "end", range: placeRange("end", range, range.end + delta, floor) };
  if (modifiers.altKey) return { mode: "start", range: placeRange("start", range, range.start + delta, floor) };
  return { mode: "move", range: placeRange("move", range, range.start + delta, floor) };
}

// ---- The state machine ----

export type EditState =
  | { phase: "idle" }
  | { phase: "dragging"; meetingId: string; mode: DragMode; original: TimeRange; range: TimeRange; review: boolean }
  /** Waiting for the person to confirm a calendar change on the review card. */
  | { phase: "pending"; meetingId: string; original: TimeRange; range: TimeRange }
  /** Reported to the page; shown at the new time until the page's data catches up (`settle`). */
  | { phase: "confirmed"; meetingId: string; original: TimeRange; range: TimeRange }
  /** Put back; the block slides back to `original` and then `settle`s. */
  | { phase: "cancelled"; meetingId: string; original: TimeRange; range: TimeRange };

export type EditEvent =
  | { type: "begin"; meetingId: string; mode: DragMode; original: TimeRange; movability: Movability }
  | { type: "drag"; range: TimeRange }
  | { type: "drop" }
  /** A whole change at once (a key press, or a change the page proposes, such as Undo's reverse). */
  | { type: "propose"; meetingId: string; original: TimeRange; range: TimeRange; movability: Movability }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "settle" };

export const IDLE: EditState = { phase: "idle" };
export const sameRange = (a: TimeRange, b: TimeRange) => a.startMs === b.startMs && a.endMs === b.endMs;

/**
 * idle → dragging (begin) → pending (drop, reviewed) or confirmed (drop, direct) or cancelled (dropped where it was);
 * pending → confirmed (confirm) or cancelled (cancel); dragging → cancelled (cancel); confirmed/cancelled → idle (settle).
 * A read-only meeting never starts. While one meeting has a pending change, another cannot start one; the same meeting
 * may be dragged again and keeps its first original time, so the review card always shows where it really is.
 */
export function reduceEdit(state: EditState, event: EditEvent): EditState {
  switch (event.type) {
    case "begin":
    case "propose": {
      if (!canMove(event.movability)) return state;
      if (state.phase === "dragging") return state;
      if (state.phase === "pending" && state.meetingId !== event.meetingId) return state;
      const original = state.phase === "pending" ? state.original : event.original;
      if (event.type === "begin") return { phase: "dragging", meetingId: event.meetingId, mode: event.mode, original, range: state.phase === "pending" ? state.range : event.original, review: event.movability.kind === "review" };
      if (sameRange(event.range, original)) return state.phase === "pending" ? { ...state, phase: "cancelled", range: original } : state;
      return { phase: event.movability.kind === "review" ? "pending" : "confirmed", meetingId: event.meetingId, original, range: event.range };
    }
    case "drag":
      return state.phase === "dragging" ? { ...state, range: event.range } : state;
    case "drop": {
      if (state.phase !== "dragging") return state;
      const { meetingId, original, range } = state;
      if (sameRange(range, original)) return { phase: "cancelled", meetingId, original, range: original };
      return { phase: state.review ? "pending" : "confirmed", meetingId, original, range };
    }
    case "confirm":
      return state.phase === "pending" ? { ...state, phase: "confirmed" } : state;
    case "cancel":
      return state.phase === "dragging" || state.phase === "pending" ? { phase: "cancelled", meetingId: state.meetingId, original: state.original, range: state.original } : state;
    case "settle":
      return state.phase === "confirmed" || state.phase === "cancelled" ? IDLE : state;
  }
}

/** The range the timeline shows for a meeting while a change is in progress, or undefined to use its own times. */
export function shownRange(state: EditState, meetingId: string): TimeRange | undefined {
  return state.phase !== "idle" && state.meetingId === meetingId ? state.range : undefined;
}

// ---- Words ----

/** "Overlaps “Team review”", "Overlaps “A” and “B”", "Overlaps “A” and 2 others"; undefined when nothing overlaps. */
export function overlapNote(active: TimeRange & { id: string }, others: { id: string; title: string; startMs: number; endMs: number; allDay?: boolean }[]): string | undefined {
  const hits = others.filter((o) => o.id !== active.id && !o.allDay && o.startMs < active.endMs && o.endMs > active.startMs);
  if (!hits.length) return undefined;
  const q = (t: string) => `“${t}”`;
  if (hits.length === 1) return `Overlaps ${q(hits[0].title)}`;
  if (hits.length === 2) return `Overlaps ${q(hits[0].title)} and ${q(hits[1].title)}`;
  return `Overlaps ${q(hits[0].title)} and ${hits.length - 1} others`;
}

/** "2:00 – 3:00 PM" or "14:00–15:00", as the Mac formats a range of times. */
export function rangeText(range: TimeRange, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).formatRange(range.startMs, range.endMs);
}
/** "Move in Work calendar?"; a calendar already called "… Calendar" is not doubled. */
export const reviewHeading = (calendarName: string) => `Move in ${calendarName}${/calendar$/i.test(calendarName) ? "" : " calendar"}?`;
