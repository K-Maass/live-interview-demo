// Pure calendar geometry for the Today, Week and Month views (#123). No React, no DOM.
//
// API for the view layer
//   dayBounds(day)                       local [start, end) of a day; 23, 24 or 25 h long on DST days
//   wallMinutes(ms, day)                 minutes on the wall clock since 00:00 of `day` (0..1440)
//   segmentForDay(item, day)             the part of a timed item inside `day`, or null
//   layoutDay(items, day, options)       lanes for one timed day column: events plus "+N" overflow items
//   allDayLanes(items, days, options)    spanning all-day bars with lanes, and a per-column "+N" count
//   monthCell(items, day, max)           up to `max` entries for a month cell, and how many are left over
//   defaultScrollMinutes(days, items, now)  where the 24 h grid should start scrolled to
//   periodRange(mode, anchor)            the range to load for Today, Week or Month
//   shiftAnchor(mode, anchor, dir)       previous/next period, safe at the end of a month
//   weekdayNames(locale, style)          Monday-first weekday names from Intl
//   gapLabel(minutes)                    "1 h 45 free" for gaps of 30 minutes or more
//   dayKey(date), parseDayKey(key), addDays(date, n)   local-day helpers (yyyy-MM-dd)
//
// Positions are wall-clock minutes from local midnight so the 24-row hour grid stays regular on a 23 h or 25 h day.
// Day boundaries always come from calendar arithmetic (`new Date(y, m, d + 1)`), never from adding 86,400,000 ms.
import { visibleCalendarRange } from "../../lib/public/state";

export type PeriodMode = "today" | "week" | "month";

/** What layout needs from a calendar item. `allDay` items are ignored by the timed functions. */
export interface TimedLike {
  id: string;
  startMs: number;
  endMs: number;
  allDay?: { startDay: string; endDay: string };
}

export const MINUTES_PER_DAY = 1440;
/** 1.5 rem at 48 px/h is about 27 minutes; pass another value when the hour height or font size differs. */
export const DEFAULT_MIN_HEIGHT_MINUTES = 27;

const pad = (n: number) => String(n).padStart(2, "0");

/** yyyy-MM-dd of the local day. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** Local midnight of a yyyy-MM-dd key. */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** `date` moved by whole calendar days, keeping the time of day; DST safe. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Local midnight to the next local midnight. `(endMs - startMs) / 3_600_000` is 23, 24 or 25. */
export function dayBounds(day: Date): { startMs: number; endMs: number } {
  const y = day.getFullYear(), m = day.getMonth(), d = day.getDate();
  return { startMs: new Date(y, m, d).getTime(), endMs: new Date(y, m, d + 1).getTime() };
}

/**
 * Wall-clock minutes since 00:00 of `day`, clamped to 0..1440. On the 25 h day the repeated hour maps to the same
 * wall minutes twice, which is what a printed clock shows.
 */
export function wallMinutes(ms: number, day: Date): number {
  const { startMs, endMs } = dayBounds(day);
  if (ms <= startMs) return 0;
  if (ms >= endMs) return MINUTES_PER_DAY;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
}

export interface DaySegment {
  /** Wall minutes from local midnight. */
  top: number;
  bottom: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The part of a timed item that falls inside `day`, or null. An item ending exactly at midnight is not on the next day. */
export function segmentForDay(item: { startMs: number; endMs: number }, day: Date): DaySegment | null {
  const { startMs, endMs } = dayBounds(day);
  const zeroLength = item.endMs <= item.startMs;
  if (zeroLength ? !(item.startMs >= startMs && item.startMs < endMs) : !(item.startMs < endMs && item.endMs > startMs)) return null;
  const top = wallMinutes(item.startMs, day);
  let bottom = zeroLength ? top : wallMinutes(item.endMs, day);
  // The repeated hour on the 25 h day can make the end's wall time earlier than the start's; never draw a negative height.
  if (bottom < top) bottom = top;
  return { top, bottom, continuesBefore: item.startMs < startMs, continuesAfter: item.endMs > endMs };
}

export interface PositionedEvent<T extends TimedLike = TimedLike> extends DaySegment {
  kind: "event";
  id: string;
  item: T;
  /** top + at least the minimum height; what packing and the drawn block use. */
  visualBottom: number;
  /** 0-based column inside its overlap cluster. */
  lane: number;
  /** Columns shown in the cluster (never more than maxColumns). */
  lanes: number;
  /** Fractions of the day column's width. */
  left: number;
  width: number;
}
/** Hidden events of one overlap cluster, drawn in the last column as "+N". Opens the day drawer. */
export interface OverflowItem {
  kind: "more";
  id: string;
  count: number;
  /** Union span of the hidden events, wall minutes. */
  top: number;
  bottom: number;
  visualBottom: number;
  startMs: number;
  endMs: number;
  lane: number;
  lanes: number;
  left: number;
  width: number;
  hiddenIds: string[];
  continuesBefore: false;
  continuesAfter: false;
}
export type DayEntry<T extends TimedLike = TimedLike> = PositionedEvent<T> | OverflowItem;

export interface LayoutOptions {
  /** Columns allowed side by side: 3 on a wide Week, 2 on a narrow Week and on Today. Default 3. */
  maxColumns?: number;
  /** Shortest height a block is drawn at, in minutes of the grid. Default 27 (1.5 rem at 48 px/h). */
  minHeightMinutes?: number;
}

/**
 * Packs the timed items of one day into columns.
 *
 * Items that overlap (using visualEnd = max(end, start + minHeightMinutes), so two 10-minute meetings 15 minutes apart
 * still do not cover each other) form a cluster; back-to-back items (one ends exactly when the next starts) do not.
 * Each cluster is packed greedily into lanes. When a cluster needs more than `maxColumns` lanes, lanes 0..maxColumns-2
 * stay as columns and every event in the remaining lanes is replaced by one "+N" item in the last column whose span is
 * the union of the hidden events (one overflow control per cluster).
 * Result is sorted by top, then lane. All-day items and items outside the day are skipped.
 */
export function layoutDay<T extends TimedLike>(items: T[], day: Date, options: LayoutOptions = {}): DayEntry<T>[] {
  const maxColumns = Math.max(1, Math.floor(options.maxColumns ?? 3));
  const minHeight = options.minHeightMinutes ?? DEFAULT_MIN_HEIGHT_MINUTES;
  type Placed = { item: T; seg: DaySegment; visualBottom: number; lane: number };
  const placed: Placed[] = [];
  for (const item of items) {
    if (item.allDay) continue;
    const seg = segmentForDay(item, day);
    if (seg) placed.push({ item, seg, visualBottom: Math.max(seg.bottom, seg.top + minHeight), lane: 0 });
  }
  placed.sort((a, b) => a.seg.top - b.seg.top || b.visualBottom - a.visualBottom || a.item.id.localeCompare(b.item.id));

  const clusters: Placed[][] = [];
  let clusterEnd = -Infinity;
  for (const p of placed) {
    if (clusters.length && p.seg.top < clusterEnd) { clusters[clusters.length - 1].push(p); clusterEnd = Math.max(clusterEnd, p.visualBottom); }
    else { clusters.push([p]); clusterEnd = p.visualBottom; }
  }

  const out: DayEntry<T>[] = [];
  for (const cluster of clusters) {
    const laneEnds: number[] = [];
    for (const p of cluster) {
      let lane = laneEnds.findIndex((end) => end <= p.seg.top);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = p.visualBottom;
      p.lane = lane;
    }
    const laneCount = laneEnds.length;
    const overflow = laneCount > maxColumns;
    const columns = Math.min(laneCount, maxColumns);
    const shown = overflow ? maxColumns - 1 : laneCount;
    for (const p of cluster) {
      if (p.lane >= shown) continue;
      out.push({ kind: "event", id: p.item.id, item: p.item, ...p.seg, visualBottom: p.visualBottom, lane: p.lane, lanes: columns, left: p.lane / columns, width: 1 / columns });
    }
    if (!overflow) continue;
    // One "+N" per cluster over the union of its hidden events, so a cluster never shows two overflow controls.
    const group = cluster.filter((c) => c.lane >= shown);
    const top = Math.min(...group.map((p) => p.seg.top));
    const visualBottom = Math.max(...group.map((p) => p.visualBottom));
    out.push({
      kind: "more", id: "more:" + group[0].item.id, count: group.length, top, bottom: visualBottom, visualBottom,
      startMs: Math.min(...group.map((p) => p.item.startMs)), endMs: Math.max(...group.map((p) => p.item.endMs)),
      lane: shown, lanes: columns, left: shown / columns, width: 1 / columns, hiddenIds: group.map((p) => p.item.id),
      continuesBefore: false, continuesAfter: false,
    });
  }
  return out.sort((a, b) => a.top - b.top || a.lane - b.lane);
}

export interface AllDayBar<T extends TimedLike = TimedLike> {
  id: string;
  item: T;
  /** 0-based column index in `days`, inclusive on both ends. */
  colStart: number;
  colEnd: number;
  lane: number;
  /** The event starts before the first visible day / ends after the last one. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}
export interface AllDayMore { col: number; count: number; hiddenIds: string[] }
export interface AllDayLayout<T extends TimedLike = TimedLike> {
  bars: AllDayBar<T>[];
  /** One entry per column that has hidden bars. */
  more: AllDayMore[];
  /** Lanes drawn (at most maxLanes). Add one row when `more` is not empty. */
  laneCount: number;
}

/**
 * Spanning all-day bars for the visible days (end day exclusive, columns clamped to the visible range). Greedy lanes;
 * bars beyond `maxLanes` (default 2) are dropped from `bars` and counted per column in `more`.
 */
export function allDayLanes<T extends TimedLike>(items: T[], days: Date[], options: { maxLanes?: number } = {}): AllDayLayout<T> {
  const maxLanes = Math.max(1, Math.floor(options.maxLanes ?? 2));
  const keys = days.map(dayKey);
  const afterLast = keys.length ? addKey(keys[keys.length - 1]) : "";
  const bars: AllDayBar<T>[] = [];
  for (const item of items) {
    if (!item.allDay) continue;
    const { startDay, endDay } = item.allDay;
    const colStart = keys.findIndex((k) => k >= startDay && k < endDay);
    if (colStart < 0) continue;
    let colEnd = colStart;
    while (colEnd + 1 < keys.length && keys[colEnd + 1] < endDay) colEnd++;
    bars.push({ id: item.id, item, colStart, colEnd, lane: 0, continuesBefore: startDay < keys[0], continuesAfter: endDay > afterLast });
  }
  bars.sort((a, b) => a.colStart - b.colStart || (b.colEnd - b.colStart) - (a.colEnd - a.colStart) || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end < bar.colStart);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.colEnd;
    bar.lane = lane;
  }
  const visible = bars.filter((b) => b.lane < maxLanes);
  const hidden = bars.filter((b) => b.lane >= maxLanes);
  const more: AllDayMore[] = [];
  for (let col = 0; col < keys.length; col++) {
    const inCol = hidden.filter((b) => b.colStart <= col && col <= b.colEnd);
    if (inCol.length) more.push({ col, count: inCol.length, hiddenIds: inCol.map((b) => b.id) });
  }
  return { bars: visible, more, laneCount: Math.min(laneEnds.length, maxLanes) };
}
const addKey = (key: string) => dayKey(addDays(parseDayKey(key), 1));

export interface MonthCell<T extends TimedLike = TimedLike> {
  entries: T[];
  /** Entries that did not fit: shown as "+N more". */
  more: number;
  hiddenIds: string[];
}

/** Items on `day` (all-day first, then by start time), the first `max` of them, and the count left over. */
export function monthCell<T extends TimedLike>(items: T[], day: Date, max = 3): MonthCell<T> {
  const key = dayKey(day);
  const onDay = items.filter((item) => item.allDay ? item.allDay.startDay <= key && key < item.allDay.endDay : segmentForDay(item, day) !== null);
  onDay.sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || a.startMs - b.startMs || a.id.localeCompare(b.id));
  const limit = Math.max(0, max);
  return { entries: onDay.slice(0, limit), more: Math.max(0, onDay.length - limit), hiddenIds: onDay.slice(limit).map((i) => i.id) };
}

/**
 * Minutes from midnight the scrolling grid should start at: 90 minutes before now when today is visible, otherwise
 * 08:00 (earlier if a visible meeting starts before 08:30, so it is not hidden above the fold).
 */
export function defaultScrollMinutes(days: Date[], items: TimedLike[], now: number): number {
  const nowDay = new Date(now);
  if (days.some((d) => dayKey(d) === dayKey(nowDay))) return Math.floor(Math.max(0, Math.min(MINUTES_PER_DAY, wallMinutes(now, startOfDay(nowDay)) - 90)));
  let earliest = Infinity;
  for (const day of days) for (const item of items) {
    if (item.allDay) continue;
    const seg = segmentForDay(item, day);
    if (seg && !seg.continuesBefore) earliest = Math.min(earliest, seg.top);
  }
  return Math.floor(Math.min(480, Math.max(0, earliest - 30)));
}

/**
 * The range to load. Today: from the start of today for eight days (Today plus "Later this week"). Week and Month are
 * exactly `visibleCalendarRange` so the existing loading and coverage keep working.
 */
export function periodRange(mode: PeriodMode, anchor: Date): { startMs: number; endMs: number } {
  if (mode === "today") {
    const start = startOfDay(anchor);
    return { startMs: start.getTime(), endMs: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 8).getTime() };
  }
  return visibleCalendarRange(anchor, mode);
}

/**
 * The anchor after the clock moved from `previousNow` to `now`. Across midnight, a view that showed the period holding
 * the old today follows to the new today (a window left open overnight shows this week, not last week); a period the
 * person navigated to stays. Returns the same anchor when nothing changes, so it can be used as a state update.
 */
export function followToday(mode: PeriodMode, anchor: Date, previousNow: number, now: number): Date {
  if (dayKey(new Date(previousNow)) === dayKey(new Date(now))) return anchor;
  const shown = periodRange(mode, anchor);
  return previousNow >= shown.startMs && previousNow < shown.endMs ? new Date(now) : anchor;
}

/** Previous (-1) or next (+1) period. Today moves one day, Week seven, Month one month; 31 Jan + 1 month is 28 Feb. */
export function shiftAnchor(mode: PeriodMode, anchor: Date, direction: -1 | 1): Date {
  if (mode !== "month") return addDays(anchor, direction * (mode === "week" ? 7 : 1));
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(anchor.getDate(), lastDay), anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds());
}

/** Seven weekday names starting on Monday, in the given locale (default: the app's). */
export function weekdayNames(locale?: string | string[], style: "short" | "long" | "narrow" = "short"): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: style });
  // 12 October 2026 is a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2026, 9, 12 + i, 12)));
}

/** "1 h 45 free", "2 h free", "30 min free"; undefined below 30 minutes (a gap that short is not worth a label). */
export function gapLabel(minutes: number): string | undefined {
  const total = Math.round(minutes);
  if (!(total >= 30)) return undefined;
  const h = Math.floor(total / 60), m = total % 60;
  if (h === 0) return `${m} min free`;
  return m === 0 ? `${h} h free` : `${h} h ${m} free`;
}
