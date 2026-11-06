// The "when" line of a meeting in the details panel beside Today (#123). Pure.
//
//   meetingWhen(event, now?)   "Today · 10:00 AM – 11:00 AM" for timed events (unchanged),
//                              "All day · Sat 17 Oct" or "All day · Fri 16 – Sun 18 Oct" for all-day events
//
// All-day events carry local days with the end day exclusive, so the last day shown is the one before `endDay`.
import { agendaDayLabel } from "../presentation/agenda";
import type { UpcomingMeeting } from "../presentation/types";
import { timeText } from "../ui";
import { addDays, parseDayKey } from "./layout";
import { allDayOf } from "./model";

const part = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString(undefined, options);
const short = (date: Date) => `${part(date, { weekday: "short" })} ${date.getDate()} ${part(date, { month: "short" })}`;

export function meetingWhen(event: UpcomingMeeting, now = Date.now()): string {
  const allDay = event.id.startsWith("plan:") ? undefined : allDayOf(event);
  if (!allDay) return `${agendaDayLabel(event.startMs, now)} · ${timeText(event.startMs)} – ${timeText(event.endMs)}`;
  const first = parseDayKey(allDay.startDay);
  const last = addDays(parseDayKey(allDay.endDay), -1);
  if (last.getTime() <= first.getTime()) return "All day · " + short(first);
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) return `All day · ${part(first, { weekday: "short" })} ${first.getDate()} – ${short(last)}`;
  return `All day · ${short(first)} – ${short(last)}`;
}
