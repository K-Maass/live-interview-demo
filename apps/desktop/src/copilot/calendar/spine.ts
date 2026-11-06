// Geometry of the Today "day spine" (#123). Pure: no React, no DOM.
//
//   gapHeightRem(minutes)          height of a free gap: clamp(0.75rem, minutes * 0.057rem, 6.8rem)
//   buildSpine(items, day, now)    ordered rows for one day: meeting blocks, the gaps between them, and where "now" sits
//   nowLabel(ms)                   "13:52", the minute-aligned time the now-marker shows
//
// A block is one meeting or one overlap cluster. Overlapping meetings are packed with layoutDay into lanes: at most two
// columns are drawn, and the meetings of every lane beyond the second are counted in `more` ("+N more"), which the view
// shows on the cluster's caption row and which opens the day drawer. A gap is drawn between two
// blocks, to scale (see gapHeightRem), and only gaps of 30 minutes or more get a label (gapLabel).
//
// The now-marker is returned as { entry, fraction }: `entry` indexes `entries`, `fraction` is how far through that
// entry's time span "now" is (0 at its start, 1 at its end). It sits
//   - inside a block when a meeting is in progress (start <= now < end),
//   - in the gap at its fraction when now falls between two blocks,
//   - in a leading gap (now until the first meeting) when nothing has started yet,
//   - on a short tail row after the last meeting when everything is over.
// Days with no timed meeting have no spine and no marker.
import { dayBounds, gapLabel, layoutDay, type PositionedEvent } from "./layout";
import type { CalendarItem, Readiness } from "./model";

export const GAP_REM_PER_MINUTE = 0.057;
export const GAP_MIN_REM = 0.75;
export const GAP_MAX_REM = 6.8;

/** clamp(0.75rem, minutes * 0.057rem, 6.8rem). A negative or invalid length reads as the minimum. */
export function gapHeightRem(minutes: number): number {
  const rem = Number.isFinite(minutes) ? minutes * GAP_REM_PER_MINUTE : 0;
  return Math.min(GAP_MAX_REM, Math.max(GAP_MIN_REM, rem));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "13:52" in 24 h form, the same text the Week gutter shows. */
export function nowLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface SpineColumn {
  events: PositionedEvent<CalendarItem>[];
}
/** Meetings of a cluster that did not fit in two columns. */
export interface SpineMore { count: number; startMs: number; endMs: number }
/** Columns drawn side by side in an overlap cluster. */
export const SPINE_COLUMNS = 2;
export interface SpineBlock {
  kind: "block";
  key: string;
  /** Clipped to the day, in ms. */
  startMs: number;
  endMs: number;
  /** Colour of the spine segment: the readiness of the cluster's first meeting. */
  tone: Readiness;
  /** 1 for a single meeting, 2 for an overlap cluster. */
  lanes: number;
  columns: SpineColumn[];
  /** Meetings beyond the second column, shown as "+N more" on the caption row. */
  more?: SpineMore;
  /** Meetings in the block, hidden ones included. */
  count: number;
}
export interface SpineGap {
  kind: "gap";
  key: string;
  startMs: number;
  endMs: number;
  minutes: number;
  heightRem: number;
  /** "1 h 45 free"; undefined for gaps under 30 minutes. */
  label?: string;
}
/** A short row after the last meeting, so a marker for "everything is over" has somewhere to sit. */
export interface SpineTail { kind: "tail"; key: string; startMs: number; endMs: number }
export type SpineEntry = SpineBlock | SpineGap | SpineTail;

export interface Spine {
  entries: SpineEntry[];
  now?: { entry: number; fraction: number };
}

export const TAIL_REM = 1.5;

export function buildSpine(items: CalendarItem[], day: Date, now: number): Spine {
  const { startMs: dayStart, endMs: dayEnd } = dayBounds(day);
  const entries = layoutDay(items, day, { maxColumns: SPINE_COLUMNS + 1, minHeightMinutes: 1 });
  if (!entries.length) return { entries: [] };

  // Group the entries into overlap clusters with the same sweep layoutDay uses (entries are sorted by top).
  const clusters: typeof entries[] = [];
  let clusterEnd = -Infinity;
  for (const entry of entries) {
    if (clusters.length && entry.top < clusterEnd) { clusters[clusters.length - 1].push(entry); clusterEnd = Math.max(clusterEnd, entry.visualBottom); }
    else { clusters.push([entry]); clusterEnd = entry.visualBottom; }
  }

  const clip = (startMs: number, endMs: number) => { const s = Math.max(startMs, dayStart); return { startMs: s, endMs: Math.max(s, Math.min(endMs, dayEnd)) }; };
  const blocks: SpineBlock[] = clusters.map((cluster) => {
    // layoutDay was asked for three columns so that the third lane (and its "+N") can be folded into `more` here.
    const lanes = Math.min(SPINE_COLUMNS, Math.max(...cluster.map((e) => e.lanes)));
    const columns: SpineColumn[] = Array.from({ length: lanes }, () => ({ events: [] }));
    let count = 0, hidden = 0;
    let first: PositionedEvent<CalendarItem> | undefined;
    let span = { startMs: Infinity, endMs: -Infinity };
    let hiddenSpan = { startMs: Infinity, endMs: -Infinity };
    for (const entry of cluster) {
      const range = entry.kind === "event" ? clip(entry.item.startMs, entry.item.endMs) : clip(entry.startMs, entry.endMs);
      span = { startMs: Math.min(span.startMs, range.startMs), endMs: Math.max(span.endMs, range.endMs) };
      const n = entry.kind === "event" ? 1 : entry.count;
      count += n;
      if (entry.lane >= SPINE_COLUMNS) {
        hidden += n;
        hiddenSpan = { startMs: Math.min(hiddenSpan.startMs, range.startMs), endMs: Math.max(hiddenSpan.endMs, range.endMs) };
      } else if (entry.kind === "event") {
        columns[entry.lane].events.push(entry);
        if (!first) first = entry;
      }
    }
    return { kind: "block", key: "b:" + (first?.id ?? cluster[0].id), ...span, tone: first?.item.readiness ?? "none", lanes, columns, more: hidden ? { count: hidden, ...hiddenSpan } : undefined, count };
  });

  const out: SpineEntry[] = [];
  const nowInDay = now >= dayStart && now < dayEnd;
  const gap = (startMs: number, endMs: number): SpineGap => {
    const minutes = Math.max(0, (endMs - startMs) / 60_000);
    return { kind: "gap", key: "g:" + startMs, startMs, endMs, minutes, heightRem: gapHeightRem(minutes), label: gapLabel(minutes) };
  };
  if (nowInDay && now < blocks[0].startMs) out.push(gap(now, blocks[0].startMs));
  blocks.forEach((block, i) => {
    out.push(block);
    const next = blocks[i + 1];
    if (next) out.push(gap(block.endMs, next.startMs));
  });
  const last = blocks[blocks.length - 1];
  if (nowInDay && now >= last.endMs) out.push({ kind: "tail", key: "t:" + last.endMs, startMs: last.endMs, endMs: Math.min(dayEnd, Math.max(now, last.endMs)) });

  let mark: Spine["now"];
  if (nowInDay) {
    const index = out.findIndex((e) => e.kind === "tail" ? now >= e.startMs : e.startMs <= now && now < e.endMs);
    if (index >= 0) {
      const e = out[index];
      mark = { entry: index, fraction: e.kind === "tail" || e.endMs <= e.startMs ? 0 : Math.min(1, Math.max(0, (now - e.startMs) / (e.endMs - e.startMs))) };
    }
  }
  return { entries: out, now: mark };
}
