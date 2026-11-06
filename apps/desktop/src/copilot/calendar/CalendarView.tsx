// The Calendar's Week and Month views: toolbar, grid, status line, day drawer and keyboard (#123).
//
//   <CalendarView c={controller} mode="week" upcoming={visible} busy={busy} query={query}
//                 onOpen={open} onRangeChange={setRange} onModeChange={setPeriod} />
//
// Props
//   c              the controller; used for publicProduct (plans, accounts, coverage, loadRange) and calendarRange
//   mode           'week' | 'month', chosen by the segmented control in MeetingsPage (the Today view adds 'today' later)
//   upcoming       calendar events plus app-only plan rows ("plan:" ids), exactly what MeetingsPage shows
//   now            optional clock override; default is the minute-aligned useNow()
//   busy           a live meeting is running: blocks and Join stay readable but inert
//   query          the search box; filters by title and the status line says "3 of 12 meetings match"
//   onOpen         called with the ORIGINAL UpcomingMeeting (item.source) when a block or drawer row is pressed
//   onPick         reserved for Today, where a card selects the meeting for the details panel instead of opening it
//   onRangeChange  called with the range being loaded; MeetingsPage keeps it for the footer Refresh
//   onModeChange   lets the drawer's "Show week" switch from Month to Week
// State owned here: the anchor date (prev/next/Today), the open day drawer and the roving keyboard focus.
// Reusable by the Today view: useCalendarRange, useCalendarKeyboard, CalendarToolbar, DayDrawer, EventBlock, JoinButton,
// AvatarStack, coverage.ts and viewProps.ts (GridViewProps).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CopilotController } from "../useCopilotController";
import type { UpcomingMeeting } from "../presentation/types";
import { CalendarToolbar, periodLabel, type CalendarStatus } from "./CalendarToolbar";
import { DayDrawer } from "./DayDrawer";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";
import { calendarConnection, nothingToRead } from "./connection";
import { dayCoverage, errorReason, rangeStatus } from "./coverage";
import { addDays, dayKey, followToday, shiftAnchor } from "./layout";
import { toCalendarItems, type CalendarItem } from "./model";
import { useCalendarKeyboard } from "./useCalendarKeyboard";
import { useCalendarRange } from "./useCalendarRange";
import { useNow } from "./useNow";

export interface CalendarViewProps {
  c: CopilotController;
  mode: "week" | "month";
  upcoming: UpcomingMeeting[];
  now?: number;
  busy: boolean;
  query: string;
  onOpen(event: UpcomingMeeting): void;
  onPick?(event: UpcomingMeeting): void;
  onRangeChange?(range: { startMs: number; endMs: number }): void;
  /** True while the range is loading (MeetingsPage holds back its "no calendar covers these dates" notice). */
  onPendingChange?(pending: boolean): void;
  onModeChange?(mode: "week" | "month"): void;
}

export function CalendarView({ c, mode, upcoming, now: nowOverride, busy, query, onOpen, onRangeChange, onPendingChange, onModeChange }: CalendarViewProps) {
  const clock = useNow();
  const now = nowOverride ?? clock;
  const pp = c.publicProduct;
  // Starts on the given "now" when one is passed (tests, previews), so the shown period never depends on the real clock.
  const [anchor, setAnchor] = useState(() => new Date(now));
  // Past midnight, a view that showed today's period follows to the new today; a navigated-to period stays.
  const lastNow = useRef(now);
  useEffect(() => { const previous = lastNow.current; lastNow.current = now; setAnchor((a) => followToday(mode, a, previous, now)); }, [now, mode]);
  const [drawer, setDrawer] = useState<{ day: Date }>();
  const opener = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const r = useCalendarRange({ enabled: pp.enabled, mode, anchor, loadRange: pp.loadRange });
  const { range } = r;
  const rangeCallback = useRef(onRangeChange);
  rangeCallback.current = onRangeChange;
  useEffect(() => { rangeCallback.current?.(range); }, [range]);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  useEffect(() => { pendingCallback.current?.(r.pending); }, [r.pending]);

  const days = useMemo(() => Array.from({ length: mode === "week" ? 7 : 42 }, (_, i) => addDays(new Date(range.startMs), i)), [mode, range.startMs]);
  const items = useMemo(() => toCalendarItems({ upcoming, plans: pp.plans, accounts: pp.accounts, enabled: pp.enabled, query }), [upcoming, pp.plans, pp.accounts, pp.enabled, query]);
  const matches = useMemo(() => {
    if (!query.trim()) return undefined;
    const inRange = (item: CalendarItem) => item.startMs < range.endMs && item.endMs > range.startMs;
    return { shown: items.filter(inRange).length, total: toCalendarItems({ upcoming, plans: pp.plans, accounts: pp.accounts, enabled: pp.enabled }).filter(inRange).length };
  }, [items, query, upcoming, pp.plans, pp.accounts, pp.enabled, range]);

  // With no calendar to read, MeetingsPage's CalendarSetupNotice says why once; the grid stays plain, not hatched.
  const connection = calendarConnection({ enabled: pp.enabled, accountsLoaded: pp.accountsLoaded, accounts: pp.accounts, rangeError: pp.rangeError, calendarRange: c.calendarRange });
  const quiet = nothingToRead(connection);
  const coverage = (day: Date) => dayCoverage(day, { enabled: pp.enabled, coverage: pp.coverage, calendarRange: c.calendarRange, loading: r.pending || connection.kind === "checking", nothingToRead: quiet });
  const accountName = (id: string) => pp.accounts.find((a) => a.id === id)?.name || id;
  const rs = pp.enabled && !r.pending ? rangeStatus(pp.coverage, accountName) : ({ kind: "ok" } as const);
  const status: CalendarStatus = {
    loading: r.slow,
    partial: rs.kind === "partial" ? rs.accounts : undefined,
    error: rs.kind === "error" ? rs.accounts : r.failed || connection.kind === "failed" ? [] : undefined,
    reason: connection.kind === "failed" ? connection.reason : rs.kind === "error" ? errorReason(pp.coverage) : undefined,
    matches,
    empty: undefined as string | undefined,
  };

  const inRange = (item: CalendarItem) => item.startMs < range.endMs && item.endMs > range.startMs;
  const totalInRange = matches ? matches.total : items.filter(inRange).length;
  // Only a range that is loaded for every date can be called empty; unloaded or partial dates never are.
  if (!r.pending && !r.failed && totalInRange === 0 && days.every((d) => coverage(d) === "loaded")) status.empty = mode === "week" ? "No meetings this week" : "No meetings this month";

  const periodKey = mode + ":" + range.startMs;
  const closeDrawer = useCallback((restoreFocus: boolean) => {
    const el = opener.current;
    opener.current = null;
    setDrawer(undefined);
    if (!restoreFocus) return;
    if (el?.isConnected) el.focus();
    else rootRef.current?.querySelector<HTMLElement>('[data-nav][tabindex="0"]')?.focus();
  }, []);
  useEffect(() => { closeDrawer(false); }, [periodKey, closeDrawer]);
  const keyboard = useCalendarKeyboard({
    containerRef: rootRef, layout: mode, periodKey, drawerOpen: !!drawer,
    onShift: (direction) => setAnchor((a) => shiftAnchor(mode, a, direction)),
    onToday: () => setAnchor(new Date()),
    onEscape: () => closeDrawer(true),
  });

  const open = (item: CalendarItem) => onOpen(item.source);
  const openDay = (day: Date, el: HTMLElement) => { opener.current = el; setDrawer({ day }); };
  const showWeek = () => {
    if (!drawer) return;
    keyboard.requestFocus();
    setAnchor(drawer.day);
    onModeChange?.("week");
  };
  const grid = { days, items, now, coverage, busy, onOpen: open, onDay: openDay, activeId: keyboard.activeId, focusDay: anchor };
  const drawerState = drawer ? coverage(drawer.day) : "loaded";
  const anyUnloaded = days.some((d) => { const state = coverage(d); return state === "missing" || state === "partial"; });

  return <div className="cal" ref={rootRef} {...keyboard.props}>
    <CalendarToolbar mode={mode} label={periodLabel(mode, anchor, new Date(range.startMs))} status={status} onRetry={r.refresh}
      onPrev={() => setAnchor((a) => shiftAnchor(mode, a, -1))} onNext={() => setAnchor((a) => shiftAnchor(mode, a, 1))} onToday={() => setAnchor(new Date())} />
    {mode === "week" ? <WeekView {...grid} scrollKey={periodKey} /> : <MonthView {...grid} month={anchor.getMonth()} />}
    {anyUnloaded && <p className="muted cal-legend">Hatched dates are not loaded, or only partly. Meetings may be missing there.</p>}
    {drawer && <DayDrawer key={dayKey(drawer.day)} day={drawer.day} items={items} coverage={drawerState} partialAccounts={rs.kind === "partial" ? rs.accounts : undefined} now={now} busy={busy}
      onOpen={open} onClose={() => closeDrawer(true)} onShowWeek={mode === "month" && onModeChange ? showWeek : undefined} />}
  </div>;
}
