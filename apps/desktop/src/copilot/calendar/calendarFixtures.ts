// Fictional calendar rows for the markup tests (#123). Example names and addresses only.
import type { PublicMeetingPlan } from "@live-interview/core";
import type { UpcomingMeeting } from "../presentation/types";
import { toCalendarItems, type CalendarItem } from "./model";

/** Monday 12 October 2026. */
export const WEEK_DAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 12 + i));
/** The 42 dates of the October 2026 month grid (Monday 28 September to Sunday 8 November). */
export const MONTH_DAYS = Array.from({ length: 42 }, (_, i) => new Date(2026, 8, 28 + i));
/** Friday 16 October 2026, 10:30. */
export const NOW = new Date(2026, 9, 16, 10, 30).getTime();
export const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const dayOf = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;

export const timed = (id: string, title: string, day: number, from: number, to: number, extra: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({ id, title, startMs: at(day, from), endMs: at(day, to), ...extra });
export const allDayRow = (id: string, title: string, firstDay: number, lastDay: number): UpcomingMeeting => ({ id, title, startMs: at(firstDay, 0), endMs: at(lastDay + 1, 0), isAllDay: true, startDay: dayOf(firstDay), endDay: dayOf(lastDay + 1) });
export const planFor = (eventId: string, status: "draft" | "prepared" = "prepared") => ({ id: "p-" + eventId, eventId, status, automaticPreparation: false }) as PublicMeetingPlan;

export function itemsOf(rows: UpcomingMeeting[], plans: PublicMeetingPlan[] = []): CalendarItem[] {
  return toCalendarItems({ upcoming: rows, plans, accounts: [{ id: "a1", email: "me@example.test" }], enabled: true });
}

export const everyDay = () => "loaded" as const;
