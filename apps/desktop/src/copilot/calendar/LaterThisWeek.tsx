// "Later this week" under the Today timeline (#123): what is coming on the next days, at most six rows.
//
//   <LaterThisWeek rows note? busy selectedId? onOpen onPick onShowWeek />
//   laterRows(items, today, max?)   the rows to show: the items that start after today and within the next seven days
//
// Each row is one button: day ("Tomorrow", "Wed 21 Oct"; shown on the first row of a day only), time ("All day" for
// all-day events), title and readiness as coloured text. A click selects the meeting for the details panel (`onPick`,
// which opens it when no panel is shown); Enter and double-click open the plan (`onOpen`), exactly as a Today card.
// After the rows comes the text link "Open Week" (`onShowWeek` switches the layout to Week). `note` says when some of the
// later days are not loaded, so an empty list never reads as an empty week.
import { Repeat } from "lucide-react";
import { timeText } from "../ui";
import { calendarEventLabel } from "../presentation/accessibility";
import { addDays, dayKey, parseDayKey } from "./layout";
import { itemDays, type CalendarItem } from "./model";

export const LATER_MAX_ROWS = 6;
/** Today plus this many days are loaded (periodRange('today') is eight days). */
export const LATER_DAYS = 7;

export interface LaterRow { item: CalendarItem; dayKey: string; dayLabel: string; firstOfDay: boolean }

/** "Tomorrow" for the next calendar day, else "Wed 21 Oct". */
export function laterDayLabel(key: string, today: Date): string {
  if (key === dayKey(addDays(today, 1))) return "Tomorrow";
  return parseDayKey(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Items whose first day is after today and no later than today + 7 days, in start order, each listed once (on its first day). */
export function laterRows(items: CalendarItem[], today: Date, max = LATER_MAX_ROWS): LaterRow[] {
  const todayKey = dayKey(today);
  const lastKey = dayKey(addDays(today, LATER_DAYS));
  const rows = items
    .map((item) => ({ item, first: itemDays(item)[0] }))
    .filter((r) => r.first && r.first > todayKey && r.first <= lastKey)
    .sort((a, b) => a.item.startMs - b.item.startMs || a.item.endMs - b.item.endMs || a.item.id.localeCompare(b.item.id))
    .slice(0, Math.max(0, max));
  return rows.map(({ item, first }, i) => ({ item, dayKey: first, dayLabel: laterDayLabel(first, today), firstOfDay: i === 0 || rows[i - 1].first !== first }));
}

export interface LaterThisWeekProps {
  rows: LaterRow[];
  /** Said under the rows, e.g. "Some days are not loaded." Empty when everything is loaded. */
  note?: string;
  /** True while the calendar is still loading and no row is known yet: nothing is said about an empty week. */
  loading?: boolean;
  busy: boolean;
  selectedId?: string;
  onOpen(item: CalendarItem): void;
  onPick(item: CalendarItem): void;
  onShowWeek(): void;
}

export function LaterThisWeek({ rows, note, loading, busy, selectedId, onOpen, onPick, onShowWeek }: LaterThisWeekProps) {
  return <section className="today-later" aria-labelledby="today-later-title">
    <h2 id="today-later-title">Later this week</h2>
    {rows.length > 0 && <ul className="today-later-list">
      {rows.map(({ item, dayLabel, firstOfDay }) => {
        const time = item.allDay ? "All day" : timeText(item.startMs);
        const label = dayLabel + " " + calendarEventLabel(item, item.allDay ? "title" : "range", { readiness: item.readinessText, recurring: item.recurring, people: item.people, allDay: item.allDay ?? false });
        const classes = ["today-later-row", "tone-" + item.readiness];
        if (item.isPlan) classes.push("dashed");
        if (selectedId === item.id) classes.push("is-selected");
        if (busy) classes.push("is-busy");
        return <li key={item.id}>
          <button type="button" className={classes.join(" ")} aria-label={label} aria-disabled={busy ? true : undefined} aria-current={selectedId === item.id ? true : undefined}
            onClick={() => { if (!busy) onPick(item); }}
            onDoubleClick={() => { if (!busy) onOpen(item); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!busy) onOpen(item); } }}>
            <span className={"today-later-day" + (firstOfDay ? "" : " is-repeat")}>{dayLabel}</span>
            <span className="today-later-time">{time}</span>
            <span className="today-later-title">{item.title}{item.recurring && <Repeat className="today-card-repeat" size={12} aria-hidden />}</span>
            <span className={"today-card-ready tone-" + item.readiness}>{item.readinessText}</span>
          </button>
        </li>;
      })}
    </ul>}
    {!rows.length && !loading && !note && <p className="muted today-later-empty">Nothing else on your calendar this week.</p>}
    {note && <p className="muted today-later-empty">{note}</p>}
    <button type="button" className="link-button today-open-week" onClick={onShowWeek}>Open Week</button>
  </section>;
}
