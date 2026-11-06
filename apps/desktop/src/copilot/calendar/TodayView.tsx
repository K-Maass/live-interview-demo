// The Today view of the Calendar (#123): Up next, all-day bars, the day spine and "Later this week".
//
//   <TodayView c={controller} upcoming={visible} busy={busy} query={query} selectedId={selected?.id}
//              onOpen={open} onPick={pick} onStart={startEvent} onShowWeek={() => setPeriod("week")}
//              onManageCalendars={calendarSettings} onRangeChange={setShownRange} />
//
// Props
//   c                 the controller; only publicProduct (plans, accounts, coverage, loadRange) and calendarRange are read
//   upcoming          calendar events plus app-only plan rows ("plan:" ids), exactly what MeetingsPage shows
//   now               optional clock override; default is the minute-aligned useNow()
//   busy              a live meeting is running: cards, Join and Up next stay readable but inert
//   query             the search box; filters the timeline and Later this week ("3 of 12 match “review”" in the status line)
//   selectedId        the meeting shown in the details panel beside Today (highlighted)
//   onOpen            open the plan, called with the ORIGINAL UpcomingMeeting (item.source); Enter and double-click
//   onPick            select for the details panel, or open when no panel is shown (MeetingsPage `pick`); click
//   onStart           start recording (the controller's startEvent); only the Up next strip offers it
//   onShowWeek        "Open Week" under Later this week
//   onManageCalendars "Manage calendars" in the unloaded panel
//   onRangeChange     called with the range being loaded (the footer Refresh in MeetingsPage uses it)
//   onPendingChange   called with true while that range loads and false once it has finished
//
// How Up next is chosen: nextUpMeeting() over ALL loaded rows (search does not hide it): the first calendar event that has
// not ended, in start order, so a meeting in progress beats a later one. Plan rows and all-day events are never Up next.
//
// Today loads periodRange('today', today) = [start of today, +8 days). It has no previous/next arrows: it is always today.
// Coverage decides what an empty day means: an unloaded today is a hatched panel ("Today’s calendar isn’t loaded.") and
// never "Nothing on your calendar today."; that line is only for a day whose calendar is fully loaded. The panel is only
// for chosen calendars that did not load: with no calendar to read (none connected, macOS access off, none chosen) the
// page shows one CalendarSetupNotice above the views instead, and a failed load is the status line with its reason.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Repeat } from "lucide-react";
import type { CopilotController } from "../useCopilotController";
import type { UpcomingMeeting } from "../presentation/types";
import { calendarEventLabel } from "../presentation/accessibility";
import { DayDrawer } from "./DayDrawer";
import { DaySpine } from "./DaySpine";
import { LaterThisWeek, laterRows } from "./LaterThisWeek";
import { UpNextStrip, nextUpMeeting } from "./UpNextStrip";
import { calendarConnection, nothingToRead } from "./connection";
import { dayCoverage, errorReason, rangeStatus } from "./coverage";
import { addDays, dayKey, parseDayKey, segmentForDay } from "./layout";
import { toCalendarItems, type CalendarItem } from "./model";
import { useCalendarRange } from "./useCalendarRange";
import { useNow } from "./useNow";

export interface TodayViewProps {
  c: CopilotController;
  upcoming: UpcomingMeeting[];
  now?: number;
  busy: boolean;
  query: string;
  selectedId?: string;
  onOpen(event: UpcomingMeeting): void;
  onPick(event: UpcomingMeeting): void;
  onStart(event: UpcomingMeeting): void;
  onShowWeek(): void;
  onManageCalendars(): void;
  onRangeChange?(range: { startMs: number; endMs: number }): void;
  /** True while the range is loading; MeetingsPage holds back "No calendar covers these dates yet" until it is false. */
  onPendingChange?(pending: boolean): void;
}

const ALL_DAY_MAX = 3;

export function TodayView({ c, upcoming, now: nowOverride, busy, query, selectedId, onOpen, onPick, onStart, onShowWeek, onManageCalendars, onRangeChange, onPendingChange }: TodayViewProps) {
  const clock = useNow();
  const now = nowOverride ?? clock;
  const pp = c.publicProduct;
  const todayKey = dayKey(new Date(now));
  // Follows the clock past midnight, so the loaded range and the timeline move to the new day.
  const day = useMemo(() => parseDayKey(todayKey), [todayKey]);
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const r = useCalendarRange({ enabled: pp.enabled, mode: "today", anchor: day, loadRange: pp.loadRange });
  const { range } = r;
  const rangeCallback = useRef(onRangeChange);
  rangeCallback.current = onRangeChange;
  useEffect(() => { rangeCallback.current?.(range); }, [range]);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  useEffect(() => { pendingCallback.current?.(r.pending); }, [r.pending]);

  const searching = query.trim().length > 0;
  const all = useMemo(() => toCalendarItems({ upcoming, plans: pp.plans, accounts: pp.accounts, enabled: pp.enabled }), [upcoming, pp.plans, pp.accounts, pp.enabled]);
  const items = useMemo(() => searching ? toCalendarItems({ upcoming, plans: pp.plans, accounts: pp.accounts, enabled: pp.enabled, query }) : all, [searching, all, upcoming, pp.plans, pp.accounts, pp.enabled, query]);
  const inRange = (item: CalendarItem) => item.startMs < range.endMs && item.endMs > range.startMs;
  const matches = searching ? { shown: items.filter(inRange).length, total: all.filter(inRange).length } : undefined;

  const connection = calendarConnection({ enabled: pp.enabled, accountsLoaded: pp.accountsLoaded, accounts: pp.accounts, rangeError: pp.rangeError, calendarRange: c.calendarRange });
  const quiet = nothingToRead(connection);
  const coverage = (d: Date) => dayCoverage(d, { enabled: pp.enabled, coverage: pp.coverage, calendarRange: c.calendarRange, loading: r.pending || connection.kind === "checking", nothingToRead: quiet });
  const accountName = (id: string) => pp.accounts.find((a) => a.id === id)?.name || id;
  const rs = pp.enabled && !r.pending ? rangeStatus(pp.coverage, accountName) : ({ kind: "ok" } as const);
  const state = coverage(day);
  const laterStates = Array.from({ length: 7 }, (_, i) => coverage(addDays(day, i + 1)));

  const allDay = items.filter((item) => item.allDay && item.allDay.startDay <= todayKey && todayKey < item.allDay.endDay);
  const timed = items.filter((item) => !item.allDay && segmentForDay(item, day) !== null);
  const next = nextUpMeeting(all, now);
  const later = laterRows(items, day);

  const open = (item: CalendarItem) => onOpen(item.source);
  const pick = (item: CalendarItem) => onPick(item.source);
  const showDrawer = (el: HTMLElement) => { opener.current = el; setDrawer(true); };
  const closeDrawer = useCallback(() => {
    const el = opener.current;
    opener.current = null;
    setDrawer(false);
    if (el?.isConnected) el.focus();
  }, []);

  const warn = rs.kind === "partial" ? rs.accounts : state === "partial" ? [] : undefined;
  const failed = connection.kind === "failed" || rs.kind === "error" || (r.failed && !pp.coverage.length);
  const reason = connection.kind === "failed" ? connection.reason : errorReason(pp.coverage);
  const laterNote = failed ? undefined : laterStates.includes("missing") ? "Some of these days are not loaded." : laterStates.includes("partial") ? "Some of these days are only partly loaded." : undefined;

  return <div className="cal today-view" ref={rootRef} onKeyDown={(event) => { if (event.key === "Escape" && drawer) { event.stopPropagation(); closeDrawer(); } }}>
    <p className="today-status" role="status">
      {failed ? <><span className="today-status-error">Couldn’t load {rs.kind === "error" ? rs.accounts.join(", ") || "the calendar" : "the calendar"}.</span>{reason && <span className="today-status-reason">{reason}</span>} <button type="button" className="link-button" onClick={r.refresh} disabled={r.pending}>Retry</button></>
        : warn ? <span className="today-status-warn">Partly loaded{warn.length > 0 ? ": " + warn.join(", ") : ""}</span>
        : r.slow ? <span>Loading calendar…</span> : null}
      {busy && <span className="today-status-busy">Unavailable during a live meeting</span>}
      {matches && <span className="today-status-matches">{matches.shown} of {matches.total} match “{query.trim()}”</span>}
    </p>
    {next && <UpNextStrip item={next} now={now} busy={busy} onOpen={open} onStart={(item) => onStart(item.source)} />}
    {state === "missing" && !failed && <div className="today-unloaded" role="group" aria-label="Today’s calendar is not loaded">
      <p>Today’s calendar isn’t loaded.</p>
      <div className="today-unloaded-actions">
        <button type="button" onClick={r.refresh} disabled={r.pending}>Refresh</button>
        <button type="button" onClick={onManageCalendars}>Manage calendars</button>
      </div>
    </div>}
    {allDay.length > 0 && <ul className="today-allday" aria-label="All day">
      {allDay.slice(0, ALL_DAY_MAX).map((item) => <li key={item.id}>
        <button type="button" className={"today-allday-bar tone-" + item.readiness + (item.isPlan ? " dashed" : "") + (busy ? " is-busy" : "")} aria-disabled={busy ? true : undefined}
          aria-label={calendarEventLabel(item, "title", { readiness: item.readinessText, recurring: item.recurring, people: item.people, allDay: item.allDay ?? false })}
          onClick={() => { if (!busy) pick(item); }} onDoubleClick={() => { if (!busy) open(item); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!busy) open(item); } }}>
          <span className="today-allday-label">All day</span><span className="today-allday-title">{item.title}</span>{item.recurring && <Repeat className="today-card-repeat" size={12} aria-hidden />}
        </button>
      </li>)}
      {allDay.length > ALL_DAY_MAX && <li><button type="button" className="link-button today-allday-more" aria-haspopup="dialog" onClick={(event) => showDrawer(event.currentTarget)}>+{allDay.length - ALL_DAY_MAX} all-day</button></li>}
    </ul>}
    <DaySpine day={day} items={timed} now={now} busy={busy} selectedId={selectedId} onOpen={open} onPick={pick} onMore={showDrawer} />
    {!timed.length && !allDay.length && <>
      {state === "loaded" && !searching && <p className="today-empty">Nothing on your calendar today.</p>}
      {state === "partial" && !searching && <p className="today-empty">No meetings found in the calendars that loaded.</p>}
      {searching && <p className="today-empty">No meeting today matches “{query.trim()}”.</p>}
    </>}
    <LaterThisWeek rows={later} note={laterNote} loading={laterStates.includes("loading") || quiet || failed} busy={busy} selectedId={selectedId} onOpen={open} onPick={pick} onShowWeek={onShowWeek} />
    {drawer && <DayDrawer key={todayKey} day={day} items={items} coverage={state} partialAccounts={rs.kind === "partial" ? rs.accounts : undefined} now={now} busy={busy} onOpen={open} onClose={closeDrawer} />}
  </div>;
}
