// Everything on one day, in the drawer that slides in from the right (#123). Reuses the `.guidance-drawer` panel.
//
//   <DayDrawer key={dayKey} day items coverage now busy onOpen onClose onShowWeek? partialAccounts? />
//
// A non-modal dialog (`role="dialog" aria-modal="false"`) named by its heading. The heading takes focus when the drawer
// opens; the owner (CalendarView) returns focus to the element that opened it on close and closes on Escape.
// Lists all-day bars, then timed rows: time, readiness edge, title, readiness words, avatars, and a separate Join button.
// A day whose calendar is not loaded (or only partly) says so instead of reading as an empty day.
// `onShowWeek` adds the "Show week" link (Month only).
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "../ui";
import type { CoverageState } from "../presentation/accessibility";
import { EventBlock } from "./EventBlock";
import { JoinButton } from "./JoinButton";
import { monthCell } from "./layout";
import type { CalendarItem } from "./model";

export interface DayDrawerProps {
  day: Date;
  /** All items; the drawer picks the ones on `day`. */
  items: CalendarItem[];
  coverage: CoverageState;
  /** Names of the calendars that are only partly loaded, when known. */
  partialAccounts?: string[];
  now: number;
  busy: boolean;
  onOpen(item: CalendarItem): void;
  onClose(): void;
  onShowWeek?(): void;
}

export function DayDrawer({ day, items, coverage, partialAccounts, now, busy, onOpen, onClose, onShowWeek }: DayDrawerProps) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const onDay = monthCell(items, day, Number.MAX_SAFE_INTEGER).entries;
  const allDay = onDay.filter((item) => item.allDay);
  const timed = onDay.filter((item) => !item.allDay);
  const row = (item: CalendarItem) => <li key={item.id} className="cal-drawer-row"><EventBlock item={item} variant="drawer" busy={busy} now={now} onOpen={onOpen} /><JoinButton item={item} busy={busy} now={now} /></li>;
  return <aside className="guidance-drawer cal-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId}>
    <div className="drawer-heading">
      <h2 id={titleId} tabIndex={-1} ref={heading}>{day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</h2>
      <IconButton icon={X} label="Close day details" onClick={onClose} />
    </div>
    {coverage === "missing" && <p className="notice cal-notice">The calendar is not loaded for this date, so meetings on it may be missing here.</p>}
    {coverage === "partial" && <p className="notice cal-notice">This date is only partly loaded{partialAccounts?.length ? " (" + partialAccounts.join(", ") + ")" : ""}, so some meetings may be missing.</p>}
    {!onDay.length && coverage === "none" && <p className="muted">No calendar is being read, so meetings can’t be shown here.</p>}
    {!onDay.length && coverage !== "missing" && coverage !== "none" && <p className="muted">No meetings on this day.</p>}
    {allDay.length > 0 && <><h3>All day</h3><ul className="cal-drawer-list">{allDay.map(row)}</ul></>}
    {timed.length > 0 && <><h3>{allDay.length ? "Scheduled" : "Meetings"}</h3><ul className="cal-drawer-list">{timed.map(row)}</ul></>}
    {onShowWeek && <button type="button" className="link-button cal-show-week" onClick={onShowWeek}>Show week</button>}
  </aside>;
}
