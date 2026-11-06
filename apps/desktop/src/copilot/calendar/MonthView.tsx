// The Month grid (#123): seven columns of fixed-height cells (8.5 rem).
//
//   <MonthView {...GridViewProps} month={anchor.getMonth()} />
//
// - `days` is the 42 dates of the visible weeks. Dates outside `month` are muted; today has a 2 px accent outline and a
//   filled date circle. Weekend cells are not shaded or hatched: hatching means one thing, "calendar not loaded".
// - The date number is a button that opens the day drawer. A cell shows monthCell(...,3): all-day bars first, then timed
//   entries ("09:00 AM · Title"), then a "+N more" text link that opens the drawer too.
// - Unloaded dates are hatched and say "Not loaded" (partial: "Partly loaded").
// Tab order: one stop on the active date; the entries of the active cell follow it. Arrow keys move between dates
// (useCalendarKeyboard).
import { useMemo } from "react";
import { calendarDayLabel } from "../presentation/accessibility";
import { EventBlock } from "./EventBlock";
import { dayKey, monthCell, weekdayNames } from "./layout";
import { coverageText } from "./coverage";
import type { GridViewProps } from "./viewProps";

export const MONTH_ENTRIES = 3;

export function MonthView({ days, items, now, coverage, busy, onOpen, onDay, activeId, focusDay, month }: GridViewProps & { month: number }) {
  const names = weekdayNames();
  const todayKey = dayKey(new Date(now));
  const cells = useMemo(() => days.map((day, col) => ({ day, col, key: dayKey(day), ...monthCell(items, day, MONTH_ENTRIES), total: monthCell(items, day, Number.MAX_SAFE_INTEGER).entries.length })), [days, items]);
  const keys = cells.map((c) => c.key);
  const defaultKey = (focusDay && keys.includes(dayKey(focusDay)) ? dayKey(focusDay) : keys.includes(todayKey) ? todayKey : keys[0]) ?? "";
  const current = activeId ?? "d:" + defaultKey;
  const activeDay = current.split(":")[1];
  return <div className="cal-month-scroll"><div className="cal-month">
    {names.map((name) => <div key={name} className="cal-month-weekday">{name}</div>)}
    {cells.map(({ day, col, key, entries, more, total }) => {
      const state = coverage(day);
      const note = coverageText(state);
      const classes = ["cal-month-cell", "cov-" + state];
      if (key === todayKey) classes.push("is-today");
      if (day.getMonth() !== month) classes.push("is-outside");
      const entryTab = key === activeDay ? 0 : -1;
      const longDate = day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
      return <div key={key} className={classes.join(" ")}>
        <div className="cal-month-top">
          <button type="button" className="cal-month-date" tabIndex={"d:" + key === current ? 0 : -1} data-nav={"d:" + key} data-col={col} data-order={-1} data-kind="head" aria-haspopup="dialog"
            aria-label={`${day.getDate()}, ${calendarDayLabel(day, { coverage: state, meetings: total })}`} onClick={(event) => onDay(day, event.currentTarget)}><span className="cal-date-num">{day.getDate()}</span></button>
          {note && <span className={"cal-cov cov-" + state} aria-hidden="true">{note}</span>}
        </div>
        {entries.map((item, i) => <EventBlock key={item.id} item={item} variant="month" busy={busy} now={now} onOpen={onOpen}
          nav={{ id: "e:" + key + ":" + item.id, col, order: i }} tabIndex={entryTab} />)}
        {more > 0 && <button type="button" className="cal-month-more" tabIndex={entryTab} data-nav={"m:" + key} data-col={col} data-order={MONTH_ENTRIES + 1} aria-haspopup="dialog"
          aria-label={`+${more} more ${more === 1 ? "meeting" : "meetings"}, ${longDate}`} onClick={(event) => onDay(day, event.currentTarget)}>+{more} more</button>}
      </div>;
    })}
  </div></div>;
}
