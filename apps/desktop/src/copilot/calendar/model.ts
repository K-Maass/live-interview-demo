// The data every calendar view draws, built once from what the controller already has (#123). Pure.
//
//   toCalendarItems({ upcoming, plans, accounts, enabled, query? }) -> CalendarItem[]   sorted by start time
//   itemDays(item) -> string[]                local days (yyyy-MM-dd) an item touches
//   CalendarItem                              one meeting or app-only plan row, ready to lay out and render
//   Readiness                                 'ready' | 'draft' | 'none' | 'unsynced' (see readiness.ts)
//
// `upcoming` is calendar events plus app-only plan rows ("plan:" ids, see appOnlyPlanRows). `source` keeps the original
// row so the view can still call openEvent/startEvent with it. Nothing here is invented: an event without attendees has
// `people: []`, and accepted/declined status and location do not exist in the data.
import type { CalendarAccount, PublicMeetingPlan } from "@live-interview/core";
import type { UpcomingMeeting } from "../presentation/types";
import { isPlanRow } from "../../lib/public/calendarSave";
import { legacyAllDay } from "../../lib/public/legacyAllDay";
import { readinessFor, type Readiness } from "./readiness";
import { addDays, dayKey, parseDayKey } from "./layout";

export type { Readiness } from "./readiness";

export interface CalendarItem {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Local calendar days, end exclusive. Present for all-day events (startMs/endMs are then local midnights). */
  allDay?: { startDay: string; endDay: string };
  recurring: boolean;
  /** Attendee names, without the user's own address. */
  people: string[];
  joinUrl?: string;
  readiness: Readiness;
  readinessText: string;
  /** An app-only plan row, not a calendar event. */
  isPlan: boolean;
  source: UpcomingMeeting;
}

export function allDayOf(event: UpcomingMeeting): CalendarItem["allDay"] {
  if (event.isAllDay === false) return undefined;
  if (event.isAllDay === true) {
    // The flag without the days: read them from the local midnights, and make the span at least one day.
    const startDay = event.startDay ?? dayKey(new Date(event.startMs));
    let endDay = event.endDay ?? dayKey(new Date(event.endMs));
    if (endDay <= startDay) endDay = dayKey(addDays(parseDayKey(startDay), 1));
    return { startDay, endDay };
  }
  return legacyAllDay(event);
}

export function toCalendarItems(input: { upcoming: UpcomingMeeting[]; plans: PublicMeetingPlan[]; accounts: Pick<CalendarAccount, "id" | "email">[]; enabled: boolean; query?: string }): CalendarItem[] {
  const query = input.query?.trim().toLowerCase();
  const items: CalendarItem[] = [];
  for (const event of input.upcoming) {
    if (query && !event.title.toLowerCase().includes(query)) continue;
    const plan = isPlanRow(event.id);
    const own = input.accounts.find((a) => a.id === event.accountId)?.email?.trim().toLowerCase();
    const people: string[] = [];
    for (const a of event.attendees ?? []) {
      if (own && a.email?.trim().toLowerCase() === own) continue;
      const name = a.name?.trim() || a.email?.trim();
      if (name && !people.includes(name)) people.push(name);
    }
    const readiness = readinessFor(event.id, input.plans, input.enabled);
    items.push({
      id: event.id, title: event.title, startMs: event.startMs, endMs: event.endMs,
      allDay: plan ? undefined : allDayOf(event), recurring: event.recurring === true, people, joinUrl: event.joinUrl || undefined,
      readiness: readiness.tone, readinessText: readiness.text, isPlan: plan, source: event,
    });
  }
  return items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

/** Local days (yyyy-MM-dd) the item touches: all-day events from startDay to the day before endDay, timed ones every day they overlap. */
export function itemDays(item: Pick<CalendarItem, "startMs" | "endMs" | "allDay">): string[] {
  const days: string[] = [];
  if (item.allDay) {
    for (let d = parseDayKey(item.allDay.startDay), i = 0; dayKey(d) < item.allDay.endDay && i < 400; d = addDays(d, 1), i++) days.push(dayKey(d));
    return days;
  }
  const last = dayKey(new Date(Math.max(item.startMs, item.endMs - 1)));
  for (let d = new Date(new Date(item.startMs).getFullYear(), new Date(item.startMs).getMonth(), new Date(item.startMs).getDate()), i = 0; dayKey(d) <= last && i < 400; d = addDays(d, 1), i++) days.push(dayKey(d));
  return days;
}
