// The meeting page's day panel, wired to real data (pure; the page component is copilot/PlanDayPanel.tsx).
//
//   dayPanelMeetings(input)        every meeting on the shown day: loaded calendar events and in-app plans, each once
//   eventMovability(event, opts)   how a calendar event may move (dayEdit `movability` fed from `eventMoveInfo`)
//   planMovability(plan, loaded)   how a plan without a loaded event may move
//   routeProposal(id, range, ctx)  what a drop means: save this plan, save another plan, review a calendar move, or refuse
//   dayLoadRange(day, loaded)      the range to load so the shown day is covered without dropping what is loaded
//   movedText(name, revert)        "Moved in Work calendar", "Moved back in Work calendar"
//
// Nothing here saves or writes to a calendar: a calendar move goes through `calendarMove` (the reviewed path of the
// app-owned action executor); a plan-only meeting is saved as a plan edit.
import type { PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import { eventMoveInfo } from "./calendarSave";
import { movability, type DayPanelMeeting, type Movability, type TimeRange } from "./dayEdit";

const UNTITLED = "Untitled meeting";
export const planRowId = (planId: string) => "plan:" + planId;
const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const nextDay = (dayMs: number) => { const d = new Date(dayMs); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const onDay = (r: { startMs: number; endMs: number }, dayMs: number, endMs: number) => r.endMs > r.startMs ? r.startMs < endMs && r.endMs > dayMs : r.startMs >= dayMs && r.startMs < endMs;

export const NOT_LOADED_REASON = "Its calendar isn't loaded for this day. Retry, or change it in Calendar.";

/**
 * A calendar event's movability. Google and Microsoft connections are read-only; macOS events move after review when
 * their calendar allows changes and they are neither repeating nor all-day. An invitation can move, with the warning.
 * `invitation` (from the native proposal) overrides the list's first guess once a move is being reviewed.
 */
export function eventMovability(event: PublicCalendarEvent, options: { appCreated?: boolean; calendarName?: string; invitation?: boolean } = {}): Movability {
  const info = eventMoveInfo(event);
  return movability({
    appOnly: false,
    appCreated: options.appCreated,
    provider: event.provider,
    calendarName: options.calendarName,
    // eventMoveInfo decides whether the calendar takes changes (a macOS event is writable only when the list says so).
    readOnly: !info.movable && (info.code === "readOnly" || info.code === "cancelled"),
    recurring: !!event.recurring,
    allDay: !!event.isAllDay,
    invitation: options.invitation ?? (info.movable && info.invitation),
  });
}

/**
 * A plan whose calendar event is not in the loaded list. Only in this app: saved directly. Added by this app to a
 * calendar (it has a sync record): its times are the plan's to change, and the calendar row offers "Update calendar
 * event" afterwards, reviewed. Opened from someone's calendar event that is not loaded: not movable here.
 */
export function planMovability(plan: Pick<PublicMeetingPlan, "eventId" | "calendarSync">): Movability {
  if (!plan.eventId || plan.calendarSync) return { kind: "direct" };
  return { kind: "readOnly", reason: NOT_LOADED_REASON };
}

export interface DayPanelMeetingsInput {
  /** Any time on the shown day. */
  day: number;
  events: PublicCalendarEvent[];
  /** Saved plans (the open one may be newer in `current`). */
  plans: PublicMeetingPlan[];
  /** The plan open on the page: its meeting is `isThis`. */
  current?: PublicMeetingPlan;
  /** A calendar name for a calendar id (the writable calendars on this Mac), for "Move in Work calendar?". */
  calendarName?: (calendarId: string) => string | undefined;
  /** The move under review, whose native read is more exact about the calendar name and invitation. */
  pendingMove?: { eventId: string; calendarName: string; invitation: boolean };
}

/**
 * Every meeting on the shown day, this one marked `isThis`. A plan linked to a loaded event appears once, as the event
 * (with its `planId`); a plan without a loaded event appears as itself. Cancelled plans and undated plans are left out
 * (the undated open plan is drawn on the timeline instead, see `untimedMeetingId`).
 */
export function dayPanelMeetings({ day, events, plans, current, calendarName, pendingMove }: DayPanelMeetingsInput): DayPanelMeeting[] {
  const dayMs = startOfDay(day), endMs = nextDay(dayMs);
  const allPlans = current ? [current, ...plans.filter((p) => p.id !== current.id)] : plans;
  const loaded = new Set(events.map((e) => e.id));
  const planOfEvent = new Map<string, PublicMeetingPlan>();
  for (const plan of allPlans) if (plan.eventId && loaded.has(plan.eventId) && !planOfEvent.has(plan.eventId)) planOfEvent.set(plan.eventId, plan);
  const out: DayPanelMeeting[] = [];
  for (const event of events) {
    if (event.cancelled || !onDay(event, dayMs, endMs)) continue;
    const plan = planOfEvent.get(event.id);
    const pending = pendingMove?.eventId === event.id ? pendingMove : undefined;
    out.push({
      id: event.id,
      title: event.title || UNTITLED,
      startMs: event.startMs,
      endMs: event.endMs,
      allDay: !!event.isAllDay || undefined,
      isThis: !!current && (plan?.id === current.id || current.eventId === event.id),
      movability: eventMovability(event, { appCreated: !!plan?.calendarSync, calendarName: pending?.calendarName ?? calendarName?.(event.calendarId), invitation: pending?.invitation }),
      eventId: event.id,
      planId: plan?.id,
    });
  }
  for (const plan of allPlans) {
    if (plan.status === "cancelled" || plan.startMs === undefined || plan.endMs === undefined) continue;
    if (plan.eventId && loaded.has(plan.eventId)) continue;
    if (!onDay({ startMs: plan.startMs, endMs: plan.endMs }, dayMs, endMs)) continue;
    out.push({ id: planRowId(plan.id), title: plan.title || UNTITLED, startMs: plan.startMs, endMs: plan.endMs, isThis: plan.id === current?.id, movability: planMovability(plan), planId: plan.id, eventId: plan.eventId });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export type Proposal =
  /** The open plan, only in this app (or newly given a time): `c.setup.setSchedule(range)`. `before` is for Undo. */
  | { kind: "thisPlan"; range: TimeRange; before?: TimeRange; title: string }
  /** Another plan only in this app: save its times. */
  | { kind: "otherPlan"; planId: string; range: TimeRange; before: TimeRange; title: string }
  /** A calendar event: prepare the move for review. */
  | { kind: "calendar"; event: PublicCalendarEvent; range: TimeRange }
  | { kind: "refused"; reason: string };

/**
 * What a drop, key press or drawn time means. `untimedMeetingId` is the open plan's id on the timeline while it has no
 * time yet (drawing gives it one). A read-only meeting never reaches here; if it does, it is refused with its reason.
 */
export function routeProposal(meetingId: string, range: TimeRange, ctx: { meetings: DayPanelMeeting[]; events: PublicCalendarEvent[]; current?: PublicMeetingPlan; untimedMeetingId?: string }): Proposal {
  const { meetings, events, current } = ctx;
  if (current && meetingId === ctx.untimedMeetingId) return { kind: "thisPlan", range, title: current.title || UNTITLED };
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) return { kind: "refused", reason: "This meeting is no longer on this day. Nothing was changed." };
  if (meeting.movability.kind === "readOnly") return { kind: "refused", reason: meeting.movability.reason };
  const before = { startMs: meeting.startMs, endMs: meeting.endMs };
  if (meeting.movability.kind === "direct") {
    if (meeting.planId && meeting.planId === current?.id) return { kind: "thisPlan", range, before, title: meeting.title };
    if (meeting.planId) return { kind: "otherPlan", planId: meeting.planId, range, before, title: meeting.title };
    return { kind: "refused", reason: "This meeting can't be moved from here. Nothing was changed." };
  }
  const event = events.find((e) => e.id === (meeting.eventId ?? meeting.id));
  if (!event) return { kind: "refused", reason: "Calendar not loaded for this day. Nothing was changed." };
  return { kind: "calendar", event, range };
}

/** The panel's `pending` for a move under review: the event's row is its event id. */
export const pendingForPanel = (move: { eventId: string; after: TimeRange } | undefined) => move ? { meetingId: move.eventId, startMs: move.after.startMs, endMs: move.after.endMs } : undefined;

/** "Moved in Work calendar"; a name already ending in "calendar" is not doubled. */
export function movedText(calendarName: string, revert = false): string {
  const name = calendarName.trim() || "your calendar";
  return `${revert ? "Moved back in" : "Moved in"} ${name}${/calendar$/i.test(name) ? "" : " calendar"}`;
}

const MAX_UNION_MS = 62 * 86_400_000;
/**
 * The range to load so `day` is covered: undefined when the loaded range already covers it. Otherwise the loaded range
 * widened to the day's week, so the Calendar keeps what it showed; a day far away loads just its week.
 */
export function dayLoadRange(day: number, loaded?: { startMs: number; endMs: number }): { startMs: number; endMs: number } | undefined {
  const dayMs = startOfDay(day), endMs = nextDay(dayMs);
  if (loaded && loaded.startMs <= dayMs && loaded.endMs >= endMs) return undefined;
  const d = new Date(dayMs);
  const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  const weekEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 7).getTime();
  if (!loaded) return { startMs: weekStart, endMs: weekEnd };
  const union = { startMs: Math.min(loaded.startMs, weekStart), endMs: Math.max(loaded.endMs, weekEnd) };
  return union.endMs - union.startMs <= MAX_UNION_MS ? union : { startMs: weekStart, endMs: weekEnd };
}
