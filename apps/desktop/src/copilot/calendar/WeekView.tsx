// The Week grid (#123): sticky day header, sticky all-day row, 24 hours at --hour-h (3.43 rem), side-by-side lanes.
//
//   <WeekView {...GridViewProps} maxColumns? scrollKey? />
//
// - Header: weekday + date per day (today = filled accent circle). The header is a button that opens the day drawer.
//   Days whose calendar is not loaded say "Not loaded" (partial: "Partly loaded") and their column is hatched.
// - All-day row: spanning bars from allDayLanes (2 lanes, then "+N all-day"). Absent when the week has none.
// - Grid: layoutDay lanes. Up to `maxColumns` meetings sit side by side (3 when a day column is at least 9.5 rem wide,
//   else 2; measured with a ResizeObserver, `maxColumns` overrides it); the rest become one "+N" button that opens the drawer.
// - The dotted now line crosses today's column only; its time sits in the hour gutter.
// - The grid scrolls (instantly) to defaultScrollMinutes once whenever `scrollKey` changes.
// Every focusable element carries data-nav / data-col / data-order for useCalendarKeyboard.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { calendarDayLabel, calendarOverflowLabel } from "../presentation/accessibility";
import { EventBlock } from "./EventBlock";
import { HOUR_REM, MIN_BLOCK_MINUTES, weekTier } from "./geometry";
import { coverageText } from "./coverage";
import { allDayLanes, dayKey, defaultScrollMinutes, layoutDay, monthCell, wallMinutes, weekdayNames } from "./layout";
import type { GridViewProps } from "./viewProps";

// 240 px and 96 px at the app's 14 px root size, in rem so a larger text size keeps the same proportions.
const WIDE_DAY_REM = 17.15;
const GUTTER_REM = 3.75;
/** An hour label this close to the now time is hidden so the two do not overprint. */
export const NEAR_NOW_MINUTES = 14;
const pad = (n: number) => String(n).padStart(2, "0");
const hourTop = (minutes: number): CSSProperties => ({ top: `calc(var(--hour-h) * ${minutes / 60})` });

/** Width of one day column in rem, measured with a ResizeObserver. Before measuring (and in static markup) it is wide. `override` wins (tests, previews). */
function useDayWidthRem(ref: RefObject<HTMLElement | null>, override?: number): number {
  const [width, setWidth] = useState(override ?? 20);
  useEffect(() => {
    const el = ref.current;
    if (override !== undefined || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWidth((el.scrollWidth / rem - GUTTER_REM) / 7);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [override, ref]);
  return override ?? width;
}

export function WeekView({ days, items, now, coverage, busy, onOpen, onDay, activeId, focusDay, maxColumns, dayWidthRem, scrollKey }: GridViewProps & { maxColumns?: number; dayWidthRem?: number; scrollKey?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dayRem = useDayWidthRem(scrollRef, dayWidthRem);
  // Three lanes only when each day column is at least 240 px wide; otherwise two, and the rest fold into "+N".
  const columnsAllowed = maxColumns ?? (dayRem >= WIDE_DAY_REM ? 3 : 2);
  const names = weekdayNames();
  const todayKey = dayKey(new Date(now));
  const columns = useMemo(() => days.map((day, col) => ({ day, col, key: dayKey(day), entries: layoutDay(items, day, { maxColumns: columnsAllowed, minHeightMinutes: MIN_BLOCK_MINUTES }), count: monthCell(items, day, Number.MAX_SAFE_INTEGER).entries.length })), [days, items, columnsAllowed]);
  const allDay = useMemo(() => allDayLanes(items, days, { maxLanes: 2 }), [items, days]);
  const keys = columns.map((c) => c.key);
  const defaultKey = (focusDay && keys.includes(dayKey(focusDay)) ? dayKey(focusDay) : keys.includes(todayKey) ? todayKey : keys[0]) ?? "";
  const current = activeId ?? "h:" + defaultKey;
  const tab = (id: string) => (id === current ? 0 : -1);

  const latest = useRef({ days, items, now });
  latest.current = { days, items, now };
  useEffect(() => {
    const scroller = scrollRef.current, body = bodyRef.current;
    if (!scroller || !body) return;
    const { days: d, items: i, now: n } = latest.current;
    scroller.scrollTop = (defaultScrollMinutes(d, i, n) / 60) * (body.offsetHeight / 24);
  }, [scrollKey]);

  const todayCol = columns.find((c) => c.key === todayKey);
  const allDayRows = allDay.laneCount + (allDay.more.length ? 1 : 0);
  const hasAllDay = allDay.bars.length > 0 || allDay.more.length > 0;
  const nowMinutes = todayCol ? wallMinutes(now, todayCol.day) : 0;
  const nowDate = new Date(now);

  return <div className="cal-week-scroll" ref={scrollRef}>
    <div className="cal-week" style={{ "--cols": days.length, "--gutter-w": GUTTER_REM + "rem", "--hour-h": HOUR_REM + "rem" } as CSSProperties}>
      <div className="cal-week-sticky">
        <div className="cal-week-head">
          <div className="cal-gutter-cell" />
          {columns.map(({ day, col, key }) => {
            const state = coverage(day);
            const note = coverageText(state);
            return <div key={key} className={"cal-col-head cov-" + state + (key === todayKey ? " is-today" : "")}>
              <button type="button" className="cal-day-head" tabIndex={tab("h:" + key)} data-nav={"h:" + key} data-col={col} data-order={-2} data-kind="head" aria-haspopup="dialog" aria-label={`${names[col % 7]} ${day.getDate()}, day details`} onClick={(event) => onDay(day, event.currentTarget)}>
                <span className="cal-wd">{names[col % 7]}</span><span className="cal-date-num">{day.getDate()}</span>
              </button>
              {note && <span className={"cal-cov cov-" + state} aria-hidden="true">{note}</span>}
            </div>;
          })}
        </div>
        {hasAllDay && <div className="cal-allday" style={{ gridTemplateRows: `repeat(${allDayRows}, auto)` }}>
          <div className="cal-gutter-cell cal-allday-label" style={{ gridRow: `1 / span ${allDayRows}` }}>All day</div>
          {columns.map(({ day, col, key }) => <div key={key} className={"cal-allday-cell cov-" + coverage(day)} style={{ gridColumn: col + 2, gridRow: `1 / span ${allDayRows}` }} />)}
          {allDay.bars.map((bar) => <EventBlock key={bar.id} item={bar.item} variant="week" busy={busy} now={now} onOpen={onOpen} tier="line"
            style={{ gridColumn: `${bar.colStart + 2} / ${bar.colEnd + 3}`, gridRow: bar.lane + 1 }} continuesBefore={bar.continuesBefore} continuesAfter={bar.continuesAfter}
            nav={{ id: "a:" + bar.id, col: bar.colStart, order: -1 + bar.lane / 100 }} tabIndex={tab("a:" + bar.id)} />)}
          {allDay.more.map((m) => <button key={m.col} type="button" className="cal-bar-more" style={{ gridColumn: m.col + 2, gridRow: allDayRows }} tabIndex={tab("am:" + keys[m.col])} data-nav={"am:" + keys[m.col]} data-col={m.col} data-order={-0.5} aria-haspopup="dialog"
            aria-label={`${m.count} more all-day ${m.count === 1 ? "event" : "events"}, ${days[m.col].toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`} onClick={(event) => onDay(days[m.col], event.currentTarget)}>+{m.count} all-day</button>)}
        </div>}
      </div>
      <div className="cal-week-body" ref={bodyRef}>
        <div className="cal-gutter" aria-hidden="true">
          {Array.from({ length: 23 }, (_, i) => <span key={i} className={"cal-hour-label" + (todayCol && Math.abs((i + 1) * 60 - nowMinutes) <= NEAR_NOW_MINUTES ? " is-near-now" : "")} title={`${pad(i + 1)}:00`} style={hourTop((i + 1) * 60)}>{pad(i + 1)}:00</span>)}
          {todayCol && <span className="cal-now-time" style={hourTop(nowMinutes)}>{pad(nowDate.getHours())}:{pad(nowDate.getMinutes())}</span>}
        </div>
        {columns.map(({ day, col, key, entries, count }) => {
          const state = coverage(day);
          return <div key={key} className={"cal-col cov-" + state + (key === todayKey ? " is-today" : "")} role="group" aria-label={calendarDayLabel(day, { coverage: state, meetings: count })} data-day={key}>
            {entries.map((entry) => {
              const length = entry.visualBottom - entry.top;
              const style: CSSProperties = { ...hourTop(entry.top), height: `calc(var(--hour-h) * ${length / 60} - 2px)`, left: `calc(${entry.left * 100}% + 1px)`, width: `calc(${entry.width * 100}% - 2px)` };
              if (entry.kind === "more") {
                const id = "m:" + key + ":" + entry.id;
                return <button key={entry.id} type="button" className="cal-more" style={style} tabIndex={tab(id)} data-nav={id} data-col={col} data-order={entry.top + 0.001} aria-haspopup="dialog"
                  aria-label={calendarOverflowLabel(entry, day)} onClick={(event) => onDay(day, event.currentTarget)}>+{entry.count}</button>;
              }
              const id = "e:" + key + ":" + entry.id;
              return <EventBlock key={entry.id} item={entry.item} variant="week" tier={weekTier(length)} widthRem={dayRem * entry.width} busy={busy} now={now} onOpen={onOpen} style={style}
                continuesBefore={entry.continuesBefore} continuesAfter={entry.continuesAfter} nav={{ id, col, order: entry.top }} tabIndex={tab(id)} />;
            })}
            {key === todayKey && <div className="cal-now-line" style={hourTop(nowMinutes)} role="img" aria-label={`Now, ${pad(nowDate.getHours())}:${pad(nowDate.getMinutes())}`} />}
          </div>;
        })}
      </div>
    </div>
  </div>;
}
