import type { PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import type { AppliedCalendarChange } from "./client";
import { FILE_APPLY_DECLINED, fileApplyFailure } from "./applyFlow";

/** A calendar on this Mac that accepts new events, as `calendar_capabilities` reports it. */
export interface WritableCalendar { id: string; name: string; account: string }
export interface CalendarCapabilityRow { id: string; name: string; account: string; add?: boolean }

export function writableCalendars(rows: CalendarCapabilityRow[] | undefined): WritableCalendar[] {
  return (rows ?? []).filter((row) => row.add === true).map(({ id, name, account }) => ({ id, name, account }));
}
export const calendarLabel = (calendar: Pick<WritableCalendar, "name" | "account">) => calendar.account ? `${calendar.name} · ${calendar.account}` : calendar.name;

const HALF_HOUR = 30 * 60_000;
/** The next half hour, 30 minutes long: a sensible start for a meeting made by hand. */
export function defaultMeetingTimes(now = Date.now()): { startMs: number; endMs: number } {
  const startMs = Math.ceil((now + 1) / HALF_HOUR) * HALF_HOUR;
  return { startMs, endMs: startMs + HALF_HOUR };
}

/**
 * Where a plan stands with the calendar:
 * - `undated`: no date yet, so nothing to add.
 * - `fromCalendar`: opened from an event the app did not create; its time belongs to that calendar.
 * - `notSaved`: dated but only in the app.
 * - `saved`: the calendar has what the plan says.
 * - `changed`: the plan's title or time moved after it was saved.
 */
export type CalendarSaveState = "undated" | "fromCalendar" | "notSaved" | "saved" | "changed";
export function calendarSaveState(plan: Pick<PublicMeetingPlan, "eventId" | "title" | "startMs" | "endMs" | "calendarSync">): CalendarSaveState {
  const sync = plan.calendarSync;
  if (!sync && plan.eventId) return "fromCalendar";
  if (plan.startMs === undefined || plan.endMs === undefined) return "undated";
  if (!sync) return "notSaved";
  return sync.syncedTitle === plan.title && sync.syncedStartMs === plan.startMs && sync.syncedEndMs === plan.endMs ? "saved" : "changed";
}

export interface CalendarChange { title: string; startMs: number; endMs: number }
const dayText = (ms: number, locale?: string) => new Date(ms).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
const timeText = (ms: number, locale?: string) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
function when(c: CalendarChange, locale?: string) {
  const sameDay = new Date(c.startMs).toDateString() === new Date(c.endMs).toDateString();
  return sameDay
    ? `${dayText(c.startMs, locale)}, ${timeText(c.startMs, locale)}–${timeText(c.endMs, locale)}`
    : `${dayText(c.startMs, locale)}, ${timeText(c.startMs, locale)} – ${dayText(c.endMs, locale)}, ${timeText(c.endMs, locale)}`;
}
/** The exact change in plain words, for the confirmation sheet. `before` is set when an existing event is updated. */
export function calendarChangeSummary(input: { after: CalendarChange; before?: CalendarChange; calendar: string; timeZone: string; locale?: string }): { heading: string; lines: string[] } {
  const { after, before, calendar, timeZone, locale } = input;
  if (!before) return { heading: "Add to calendar", lines: [`Add “${after.title}” to ${calendar}`, `${when(after, locale)} (${timeZone})`] };
  const lines = [`Update “${before.title}” in ${calendar}`];
  if (before.title !== after.title) lines.push(`Title: ${before.title} → ${after.title}`);
  const from = when(before, locale), to = when(after, locale);
  lines.push(from === to ? `${to} (${timeZone})` : `Time: ${from} → ${to} (${timeZone})`);
  return { heading: "Update calendar event", lines };
}

const SAVE_ERRORS: Record<string, string> = {
  calendarRequired: "Choose a calendar first.",
  // The native file picker behind a calendar-file save.
  pickFailed: "Could not open the file picker. Nothing was changed.",
  invalidPickedTarget: "Could not open the file picker. Nothing was changed.",
  calendarUnavailable: "Calendar access is off. Connect it in Settings → Calendars.",
  eventUnavailable: "The event is no longer in your calendar. Nothing was changed.",
  invalidDate: "Check the date and times. Nothing was changed.",
  approvalRequired: "This change needs your confirmation again. Nothing was changed.",
  approvalFailed: "This change can no longer be saved. Nothing was changed; prepare it again.",
  calendarApplyFailedOrTargetChanged: "The event changed in your calendar. Review the update again.",
  calendarApplyFailed: "The calendar did not accept the change. Nothing was changed.",
  // Moving an existing event.
  eventChanged: "The event changed in your calendar. Nothing was changed.",
  recurringUnsupported: "Repeating meeting. Change it in Calendar. Nothing was changed.",
  allDayUnsupported: "All-day event. Change it in Calendar. Nothing was changed.",
  calendarReadOnly: "This calendar doesn't allow changes. Nothing was changed.",
  eventNotModifiable: "Your calendar didn't allow this event to be moved. Nothing was changed.",
  moveReverted: "Your calendar kept the original time. Nothing was changed.",
  moveNotVerified: "Your calendar didn't confirm the move. Check the event in Calendar. The meeting plan was not changed.",
  calendarMoveUnavailable: "This meeting can't be moved from here. Nothing was changed.",
};
export function calendarSaveErrorMessage(error: unknown): string {
  return SAVE_ERRORS[typeof error === "string" ? error : ""] ?? "The calendar could not be updated. Nothing was changed.";
}

export const ICS_SAVE_RETRY = "The calendar file could not be saved. Nothing was written; save it again.";
/** A failed calendar-file save: "save it again" only when the writer reopened the proposal, otherwise why it ended. */
export function icsSaveFailure(error: unknown): { retry: boolean; message: string } {
  const failure = fileApplyFailure(error, calendarSaveErrorMessage);
  // A cancelled "Replace this file?" sheet keeps its own calm message.
  if (failure.message === FILE_APPLY_DECLINED) return failure;
  return failure.retry ? { retry: true, message: ICS_SAVE_RETRY } : failure;
}

/** Shown when the event was written to the calendar but the plan could not record it; adding again would duplicate it. */
export const PLAN_SYNC_NOT_SAVED = (calendar: string) =>
  `Saved to ${calendar}, but the meeting plan could not record it. Reload the plan; don't add it again.`;
export type CalendarSaveOutcome =
  | { status: "saved"; patch: Partial<PublicMeetingPlan> }
  /** An earlier click already saved this change or is saving it: nothing to do. */
  | { status: "earlier" }
  /** The calendar refused or failed: nothing was written. */
  | { status: "notApplied"; error: string }
  /** The event is in the calendar; only the plan's record of it failed. */
  | { status: "planNotSaved"; error: string; patch: Partial<PublicMeetingPlan> };
/**
 * Applies a reviewed "Add to calendar" and records the event on the plan. The two steps fail differently: a failed apply
 * changed nothing, while a failed plan save leaves the event in the calendar, so its message must not say otherwise.
 */
export async function applyCalendarSave(
  pending: { proposalId: string; calendar: WritableCalendar },
  deps: { apply: (proposalId: string) => Promise<AppliedCalendarChange | undefined>; recordOnPlan: (patch: Partial<PublicMeetingPlan>) => Promise<void> },
): Promise<CalendarSaveOutcome> {
  let result: AppliedCalendarChange | undefined;
  try {
    result = await deps.apply(pending.proposalId);
  } catch (error) {
    return { status: "notApplied", error: calendarSaveErrorMessage(error) };
  }
  if (!result) return { status: "earlier" };
  const linked = result.publicEvent;
  const patch: Partial<PublicMeetingPlan> = {
    eventId: linked?.id,
    calendarAccountId: linked?.accountId,
    calendarId: pending.calendar.id,
    calendarSync: {
      nativeEventId: result.event.id,
      calendarId: pending.calendar.id,
      calendarName: calendarLabel(pending.calendar),
      version: result.event.version,
      syncedTitle: result.event.title,
      syncedStartMs: result.event.startMs,
      syncedEndMs: result.event.endMs,
    },
  };
  try {
    await deps.recordOnPlan(patch);
    return { status: "saved", patch };
  } catch {
    return { status: "planNotSaved", error: PLAN_SYNC_NOT_SAVED(calendarLabel(pending.calendar)), patch };
  }
}

// ---- Moving a calendar event ----
/**
 * Shown before moving an event someone else organises. What happens, as far as Apple documents it: Calendar itself lets
 * an invitee change only their status, calendar, alerts and availability, not the time; CalDAV servers may refuse an
 * attendee's time change (RFC 6638 allowed-attendee-scheduling-object-change); Exchange keeps a separate copy per
 * attendee that the organiser's next update overwrites. So the move is local to this person's calendar at best.
 */
export const INVITATION_MOVE_WARNING =
  "You're not the organiser. This moves it in your calendar only; the organiser and other guests keep the original time. Your calendar account may refuse the change or move it back when it syncs.";
/** Shown before moving an event this person organises that has guests. */
export const ORGANISER_MOVE_NOTE = "People invited may get an update from your calendar.";
export type MoveBlockCode = "notMacCalendar" | "recurring" | "allDay" | "readOnly" | "cancelled";
/**
 * Whether an event from the calendar list can be moved through the reviewed path, and the plain reason when not.
 * Only macOS (EventKit) events in calendars that accept changes, not repeating and not all-day, can move;
 * invitations can, with `INVITATION_MOVE_WARNING`.
 */
export type EventMoveInfo =
  | { movable: true; invitation: boolean; note?: string }
  | { movable: false; code: MoveBlockCode; reason: string };
export function eventMoveInfo(event: Pick<PublicCalendarEvent, "provider" | "readOnly" | "recurring" | "isAllDay" | "cancelled" | "calendarWritable" | "invitation" | "attendees">): EventMoveInfo {
  if (event.provider === "google") return { movable: false, code: "notMacCalendar", reason: "From Google Calendar, read-only here. Change it in Google Calendar." };
  if (event.provider === "microsoft") return { movable: false, code: "notMacCalendar", reason: "From Microsoft 365, read-only here. Change it in Outlook." };
  if (event.cancelled) return { movable: false, code: "cancelled", reason: "Cancelled meeting." };
  if (event.recurring) return { movable: false, code: "recurring", reason: "Repeating meeting. Change it in Calendar." };
  if (event.isAllDay) return { movable: false, code: "allDay", reason: "All-day event. Change it in Calendar." };
  if (event.readOnly !== false || event.calendarWritable === false) return { movable: false, code: "readOnly", reason: "This calendar doesn't allow changes. Change it in Calendar." };
  if (event.invitation) return { movable: true, invitation: true, note: INVITATION_MOVE_WARNING };
  return (event.attendees?.length ?? 0) > 0 ? { movable: true, invitation: false, note: ORGANISER_MOVE_NOTE } : { movable: true, invitation: false };
}

/**
 * Dated plans that no loaded calendar event stands for (only in the app, or not yet read back), as agenda rows, so a
 * meeting made by hand shows on the calendar right away. Ids are prefixed so they never collide with event ids.
 */
export function appOnlyPlanRows(plans: PublicMeetingPlan[], eventIds: Set<string>, now = Date.now()): { id: string; planId: string; title: string; startMs: number; endMs: number }[] {
  return plans
    .filter((p) => p.status !== "cancelled" && p.startMs !== undefined && p.endMs !== undefined && p.endMs >= now && !(p.eventId && eventIds.has(p.eventId)))
    .map((p) => ({ id: "plan:" + p.id, planId: p.id, title: p.title || "Untitled meeting", startMs: p.startMs!, endMs: p.endMs! }));
}
export const isPlanRow = (id: string) => id.startsWith("plan:");

// ---- Visual picker: a month grid to choose the day, a day timeline to draw the time. ----
export const DAY_MINUTES = 24 * 60;
export const SNAP = 15;
export const snap = (minutes: number, step = SNAP) => Math.min(DAY_MINUTES, Math.max(0, Math.round(minutes / step) * step));
const midnight = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const minutesOfDay = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
/** A time on a given day; built from calendar fields so daylight-saving days land on the wall-clock time. */
export function atMinutes(dayMs: number, minutes: number): number {
  const d = new Date(midnight(dayMs));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
}
/** Six Monday-first weeks covering the month of `month` (any date in it), as local midnights. */
export function monthGrid(month: Date): number[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i).getTime());
}
/** A range from where a drag started to where it is now, at least one snap long, inside the day. */
export function dragRange(anchor: number, current: number): { start: number; end: number } {
  const a = snap(anchor), b = snap(current);
  const start = Math.min(a, b), end = Math.max(a, b);
  return end - start >= SNAP ? { start, end } : { start: Math.min(start, DAY_MINUTES - SNAP), end: Math.min(start, DAY_MINUTES - SNAP) + SNAP };
}
/** Moves a range by `delta` minutes, keeping its length and keeping it inside the day. */
export function moveRange(start: number, end: number, delta: number): { start: number; end: number } {
  const length = end - start;
  const next = Math.min(DAY_MINUTES - length, Math.max(0, snap(start + delta)));
  return { start: next, end: next + length };
}
/** Sets the end, at least one snap after the start and no later than midnight. */
export const resizeRange = (start: number, end: number) => ({ start, end: Math.min(DAY_MINUTES, Math.max(start + SNAP, snap(end))) });
/**
 * Choosing a day keeps the meeting's time of day and length. A first date for an undated plan starts at the next half
 * hour today, or at 09:00 on another day.
 */
export function onDay(dayMs: number, current: { startMs?: number; endMs?: number }, now = Date.now()): { startMs: number; endMs: number } {
  if (current.startMs !== undefined && current.endMs !== undefined) {
    const start = minutesOfDay(current.startMs), length = Math.max(SNAP, Math.round((current.endMs - current.startMs) / 60_000));
    const s = Math.min(start, DAY_MINUTES - length);
    return { startMs: atMinutes(dayMs, s), endMs: atMinutes(dayMs, s) + length * 60_000 };
  }
  if (midnight(dayMs) === midnight(now)) return defaultMeetingTimes(now);
  return { startMs: atMinutes(dayMs, 9 * 60), endMs: atMinutes(dayMs, 9 * 60 + 30) };
}
export function withLength(current: { startMs: number }, minutes: number): { startMs: number; endMs: number } {
  return { startMs: current.startMs, endMs: current.startMs + minutes * 60_000 };
}
/** "30 min", "1 h", "1 h 15 min". */
export function lengthText(startMs: number, endMs: number): string {
  const m = Math.round((endMs - startMs) / 60_000), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}
