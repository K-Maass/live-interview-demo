// The Up next strip at the top of Today (#123): the next or in-progress meeting and what to do about it.
//
//   <UpNextStrip item now busy onOpen onStart />
//
//   item     a CalendarItem chosen by nextUpMeeting(items, now): the first calendar event (never an app-only plan row or
//            an all-day event) that has not ended, in start order. A meeting already running wins over a later one.
//   busy     a live meeting is running: [Open plan] and [Start recording] are disabled, as the old Up next card did.
//   onOpen   open the plan (the controller's openEvent); onStart  start recording for it (startEvent).
//
// Shows "Up next · in 25 min" (or "In progress"), the title, the time range, readiness as coloured text (never a badge),
// up to three avatars, and the actions [Open plan] [Join] [Start recording]. Start recording exists ONLY here: no
// card, block, row or drawer in Today, Week or Month offers it. Join is its own button and only appears with a link.
import { useId } from "react";
import { Mic } from "lucide-react";
import { agendaDayLabel } from "../presentation/agenda";
import { timeText } from "../ui";
import { AvatarStack } from "./AvatarStack";
import { JoinButton } from "./JoinButton";
import type { CalendarItem } from "./model";

/** The meeting Up next shows: first non-plan, non-all-day item that has not ended yet, in start order. */
export function nextUpMeeting(items: CalendarItem[], now: number): CalendarItem | undefined {
  return items.filter((item) => !item.isPlan && !item.allDay && item.endMs > now).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))[0];
}

/** "In progress", "Up next · in 25 min", "Up next · in 3 h", "Up next · Tomorrow". */
export function upNextEyebrow(item: { startMs: number; endMs: number }, now: number): string {
  if (item.startMs <= now && item.endMs > now) return "In progress";
  const minutes = Math.round((item.startMs - now) / 60_000);
  const when = minutes < 1 ? "starting now" : minutes < 60 ? `in ${minutes} min` : minutes < 12 * 60 ? `in ${Math.round(minutes / 60)} h` : agendaDayLabel(item.startMs, now);
  return "Up next · " + when;
}

export function UpNextStrip({ item, now, busy, onOpen, onStart }: { item: CalendarItem; now: number; busy: boolean; onOpen(item: CalendarItem): void; onStart(item: CalendarItem): void }) {
  const titleId = useId();
  const eyebrow = upNextEyebrow(item, now);
  const day = agendaDayLabel(item.startMs, now);
  // The eyebrow already names the day for meetings that are far away, and "Today" is not worth saying.
  const showDay = day !== "Today" && !eyebrow.endsWith(day);
  return <section className="today-upnext" aria-labelledby={titleId}>
    <div className="today-upnext-copy">
      <p className="today-upnext-eyebrow"><span className="status-dot active" aria-hidden="true" />{eyebrow}</p>
      <h2 id={titleId}>{item.title}</h2>
      <p className="today-upnext-when">
        {showDay && <>{day} · </>}{timeText(item.startMs)} – {timeText(item.endMs)} · <span className={"today-card-ready tone-" + item.readiness}>{item.readinessText}</span>
        <AvatarStack people={item.people} size="today" />
      </p>
    </div>
    <div className="today-upnext-actions">
      <button type="button" disabled={busy} onClick={() => onOpen(item)}>Open plan</button>
      <JoinButton item={item} busy={busy} now={now} />
      <button type="button" className="primary" disabled={busy} onClick={() => onStart(item)}><Mic size={15} aria-hidden />Start recording</button>
    </div>
  </section>;
}
