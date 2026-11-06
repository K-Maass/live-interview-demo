// Previous / Today / Next, the period title and the one-line status (#123). Presentational.
//
//   <CalendarToolbar mode label onPrev onNext onToday status onRetry trailing? />
//
// `label` is the period title (see periodLabel); it sits in an <h2 aria-live="polite"> so a screen reader hears the new
// period after navigating. `status` is one of:
//   loading  "Loading calendar…" (CalendarView only sets it after 300 ms, so a quick load never flashes)
//   partial  amber "Partly loaded" with the account names
//   error    "Couldn't load …" with the reason (when known) and a Retry button
//   matches  "3 of 12 meetings match" while a search is active
//   empty    "No meetings this week" for a fully loaded range with nothing in it
// The status line is always rendered (empty when nothing applies) because a live region must exist before its text changes.
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../ui";
import { addDays, type PeriodMode } from "./layout";

export interface CalendarStatus {
  loading?: boolean;
  partial?: string[];
  error?: string[];
  /** Plain words for why the load failed, shown after "Couldn't load …". */
  reason?: string;
  matches?: { shown: number; total: number };
  /** "No meetings this week": only when every date in the range is loaded and nothing is in it. */
  empty?: string;
}

const unit: Record<PeriodMode, string> = { today: "day", week: "week", month: "month" };

/** "12 – 18 October 2026", "28 Sep – 4 Oct 2026", "October 2026", or the full date for Today. */
export function periodLabel(mode: PeriodMode, anchor: Date, firstDay?: Date): string {
  if (mode === "today") return anchor.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (mode === "month") return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = firstDay ?? anchor;
  const last = addDays(first, 6);
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const sameYear = first.getFullYear() === last.getFullYear();
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: sameMonth ? "long" : "short" });
  if (sameMonth) return `${first.getDate()} – ${last.getDate()} ${month(last)} ${last.getFullYear()}`;
  return sameYear ? `${first.getDate()} ${month(first)} – ${last.getDate()} ${month(last)} ${last.getFullYear()}` : `${first.getDate()} ${month(first)} ${first.getFullYear()} – ${last.getDate()} ${month(last)} ${last.getFullYear()}`;
}

export function CalendarToolbar({ mode, label, onPrev, onNext, onToday, status, onRetry, trailing }: { mode: PeriodMode; label: string; onPrev(): void; onNext(): void; onToday(): void; status: CalendarStatus; onRetry(): void; trailing?: ReactNode }) {
  return <div className="cal-toolbar">
    <div className="cal-toolbar-main">
      <IconButton icon={ChevronLeft} label={"Previous " + unit[mode]} onClick={onPrev} />
      <IconButton icon={ChevronRight} label={"Next " + unit[mode]} onClick={onNext} />
      <button type="button" className="today-button" onClick={onToday}>Today</button>
      <h2 aria-live="polite">{label}</h2>
      {trailing}
    </div>
    <p className="cal-status" role="status">
      {status.error ? <><span className="cal-status-error">Couldn’t load {status.error.join(", ") || "the calendar"}.</span>{status.reason && <span className="cal-status-reason">{status.reason}</span>} <button type="button" className="link-button" onClick={onRetry}>Retry</button></>
        : status.partial ? <span><span className="cal-status-warn">Partly loaded</span>{status.partial.length > 0 && ": " + status.partial.join(", ")}</span>
        : status.loading ? "Loading calendar…" : status.empty ? status.empty : null}
      {status.matches && <span className="cal-status-matches">{status.matches.shown} of {status.matches.total} {status.matches.total === 1 ? "meeting matches" : "meetings match"}</span>}
    </p>
  </div>;
}
