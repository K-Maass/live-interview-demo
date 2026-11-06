// The Today timeline (#123): the day spine.
//
//   <DaySpine day items now busy selectedId? onOpen onPick onMore />
//
// A continuous 4 px vertical line in the left gutter. Each meeting (or overlap cluster) has a spine segment coloured by
// brief readiness (ready accent, plan started blue, no brief grey, app-only dashed). The gaps between meetings are drawn
// to scale (gapHeightRem) and labelled "1 h 45 free" from 30 minutes. The orange now-marker (role="separator", named
// "Now, 13:52") rides on the spine: in the gap at its fraction, or inside the segment of the meeting in progress.
// Overlaps use two columns under the caption "Overlaps · N meetings"; meetings beyond two lanes are counted by a
// "+N more" text button on the right of the caption that calls `onMore` (the owner opens the day drawer). Geometry: spine.ts.
//
//   day       local midnight of the day shown
//   items     calendar items; timed ones that touch `day` are drawn, all-day ones are ignored here
//   now       minute-aligned clock (useNow)
//   onOpen    open the plan; onPick  select for the details panel (opens when no panel is shown)
//   onMore    the "+N overlapping" button was pressed; receives the button so focus can return to it
import { useMemo, type CSSProperties } from "react";
import { timeText } from "../ui";
import { TodayCard } from "./TodayCard";
import { buildSpine, nowLabel, type SpineBlock, type SpineEntry } from "./spine";
import type { CalendarItem } from "./model";

export interface DaySpineProps {
  day: Date;
  items: CalendarItem[];
  now: number;
  busy: boolean;
  selectedId?: string;
  onOpen(item: CalendarItem): void;
  onPick(item: CalendarItem): void;
  onMore(opener: HTMLElement): void;
}

function NowMarker({ now, fraction }: { now: number; fraction: number }) {
  const label = nowLabel(now);
  return <div className="spine-now" role="separator" aria-label={"Now, " + label} style={{ top: `${(fraction * 100).toFixed(2)}%` }}>
    <span className="spine-now-time">{label}</span><span className="spine-now-dot" aria-hidden="true" /><span className="spine-now-line" aria-hidden="true" />
  </div>;
}

export function DaySpine({ day, items, now, busy, selectedId, onOpen, onPick, onMore }: DaySpineProps) {
  const spine = useMemo(() => buildSpine(items, day, now), [items, day, now]);
  if (!spine.entries.length) return null;
  const marker = (index: number) => spine.now?.entry === index ? <NowMarker now={now} fraction={spine.now.fraction} /> : null;
  const block = (entry: SpineBlock, index: number) => <li key={entry.key} className={"spine-row spine-block tone-" + entry.tone + (entry.lanes > 1 ? " is-cluster" : "")}>
    <span className="spine-seg" aria-hidden="true" />
    {entry.lanes > 1 && <div className="spine-caption">
      <p>Overlaps · {entry.count} meetings</p>
      {entry.more && <button type="button" className="spine-more link-button" aria-haspopup="dialog"
        aria-label={`+${entry.more.count} more, ${timeText(entry.more.startMs)} to ${timeText(entry.more.endMs)}, ${day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`}
        onClick={(event) => onMore(event.currentTarget)}>+{entry.more.count} more</button>}
    </div>}
    <div className="spine-cols" style={{ "--lanes": entry.lanes } as CSSProperties}>
      {entry.columns.map((column, i) => <div key={i} className="spine-col">
        {column.events.map((event) => <TodayCard key={event.id} item={event.item} now={now} busy={busy} selected={selectedId === event.item.id} onOpen={onOpen} onPick={onPick} />)}
      </div>)}
    </div>
    {marker(index)}
  </li>;
  const other = (entry: Exclude<SpineEntry, SpineBlock>, index: number) => entry.kind === "gap"
    ? <li key={entry.key} className="spine-row spine-gap" style={{ height: entry.heightRem + "rem" }}>{entry.label && <span className="spine-gap-label">{entry.label}</span>}{marker(index)}</li>
    : <li key={entry.key} className="spine-row spine-tail">{marker(index)}</li>;
  return <ol className="spine" aria-label="Today’s meetings">
    {spine.entries.map((entry, index) => entry.kind === "block" ? block(entry, index) : other(entry, index))}
  </ol>;
}
