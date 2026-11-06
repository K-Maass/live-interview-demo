// The meeting page's day panel (Chunk A of the meeting page redesign).
//
//   <MeetingDayPanel day meetings coverage pending? onDayChange onPropose onConfirm onCancel onOpen ...>
//     {footer: time summary, length chips, calendar row}
//   </MeetingDayPanel>
//
// The header steps through days (‹ day › Today; the date opens the month picker), the timeline shows every meeting
// that day and lets any movable one be dragged or resized, and a review card at the bottom asks before a calendar
// change. The panel only reports proposed ranges (`onPropose`) and the person's answer (`onConfirm`, `onCancel`); the
// page decides whether to save directly or prepare a calendar change through the app-owned action executor. Nothing
// here saves or writes to a calendar.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton, timeText } from "./ui";
import { DayTimeline, MonthDayPicker } from "./MeetingTimePicker";
import type { CoverageState } from "./presentation/accessibility";
import { IDLE, INVITATION_WARNING, ORGANISER_NOTE, overlapNote, rangeText, reviewHeading, reduceEdit, sameRange, type DayPanelMeeting, type EditEvent, type EditState, type TimeRange } from "../lib/public/dayEdit";
import { atMinutes } from "../lib/public/calendarSave";

export interface MeetingDayPanelProps {
  /** Any time on the day shown. */
  day: number;
  /** Every meeting that day, this one included (`isThis`), all-day events too. */
  meetings: DayPanelMeeting[];
  /** Whether the calendar is loaded for the day (calendar/coverage.ts `dayCoverage`). */
  coverage: CoverageState;
  /** Names of the calendars that are only partly loaded, when known. */
  partialAccounts?: string[];
  /** A calendar change waiting for review. Without it the panel still shows its own until the page answers. */
  pending?: { meetingId: string; startMs: number; endMs: number };
  /** ‹ › Today, the month picker and Option+←/→: show another day (local midnight). */
  onDayChange: (dayMs: number) => void;
  /** A meeting was dropped at a new time, a key moved it, or a time was drawn for this meeting. */
  onPropose: (meetingId: string, range: TimeRange) => void;
  /** "Move event" on the review card, or Enter while a change is pending. */
  onConfirm: () => void;
  /** "Cancel" on the review card, or Escape while a change is pending. */
  onCancel: () => void;
  /** A click on a meeting that is not this one: open its plan. */
  onOpen: (meeting: DayPanelMeeting) => void;
  /** "Retry" when the day's calendar did not load. */
  onRetry?: () => void;
  /** "Connect a calendar" when no calendar is being read. */
  onConnectCalendar?: () => void;
  /** This meeting has no time yet: drawing on the timeline reports a range for this id. */
  untimedMeetingId?: string;
  /** Warning on the review card for an invitation (Movability `invitation`). */
  invitationWarning?: string;
  /** The page is applying the change: the review card's button says "Moving…". */
  confirming?: boolean;
  /** One line from the page, e.g. "The event changed in your calendar. Nothing was changed." */
  notice?: string;
  /** How times read inside the timeline blocks; defaults to the Mac's 12- or 24-hour format. */
  timeLabel?: (minutes: number, dayMs: number) => string;
  /** The footer: time summary, length chips, calendar row. */
  children?: ReactNode;
}

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (dayMs: number, n: number) => { const d = new Date(dayMs); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const headingDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
// A direct save that the page has not reflected after this long slides back (the page refused it or failed).
const DIRECT_SETTLE_MS = 1500;
const REVIEW_SETTLE_MS = 15_000;
const SLIDE_MS = 140;

export function MeetingDayPanel({ day, meetings, coverage, partialAccounts, pending, onDayChange, onPropose, onConfirm, onCancel, onOpen, onRetry, onConnectCalendar, untimedMeetingId, invitationWarning = INVITATION_WARNING, confirming, notice, timeLabel, children }: MeetingDayPanelProps) {
  const dayMs = startOfDay(day);
  const today = startOfDay(Date.now());
  const ids = useId();
  const [edit, setEdit] = useState<EditState>(IDLE);
  const editRef = useRef(edit);
  editRef.current = edit;
  const [announcement, setAnnouncement] = useState("");
  const [picking, setPicking] = useState(false);
  const pickerAnchor = useRef<HTMLDivElement>(null);
  const byId = (id: string) => meetings.find((m) => m.id === id);
  const clock = (ms: number) => timeText(ms);
  const say = (text: string) => { setAnnouncement(""); window.setTimeout(() => setAnnouncement(text), 30); };

  // What was last reported to the page, so a drop at the same place is not proposed twice; cleared when settled.
  const proposedRef = useRef<{ meetingId: string; range: TimeRange }>(undefined);
  const set = (next: EditState) => { editRef.current = next; setEdit(next); if (next.phase === "idle") proposedRef.current = undefined; };
  // Every change the person makes goes through here: the reducer decides, then the page hears about it.
  const apply = (event: EditEvent) => {
    const before = editRef.current, after = reduceEdit(before, event);
    if (after === before) return;
    set(after);
    const meeting = after.phase !== "idle" ? byId(after.meetingId) : undefined;
    const title = meeting?.title ?? "Meeting";
    if ((after.phase === "pending" || after.phase === "confirmed") && event.type !== "confirm") {
      const last = proposedRef.current;
      if (!last || last.meetingId !== after.meetingId || !sameRange(last.range, after.range)) {
        proposedRef.current = { meetingId: after.meetingId, range: after.range };
        onPropose(after.meetingId, after.range);
        const what = `${title} to ${clock(after.range.startMs)} to ${clock(after.range.endMs)}`;
        say(after.phase === "pending" ? `Move ${what}? Enter moves it, Escape cancels.` : `Moved ${what}.`);
      }
    }
    if (after.phase === "cancelled" && before.phase !== "cancelled") {
      // Only a change the page heard about needs cancelling there.
      if (proposedRef.current) { proposedRef.current = undefined; onCancel(); say(`Not moved. ${title} stays at ${clock(after.original.startMs)} to ${clock(after.original.endMs)}.`); }
      else if (before.phase === "dragging" && !sameRange(before.range, before.original)) say("Move cancelled.");
    }
    if (event.type === "confirm") onConfirm();
  };

  // Keep in step with the page: a pending change it supplies (Undo's reverse) is shown for review; when it withdraws
  // one (done, failed, or the event changed meanwhile) the panel lets go of it without reporting a cancel.
  const lastPending = useRef(pending);
  useEffect(() => {
    const was = lastPending.current;
    lastPending.current = pending;
    const current = editRef.current;
    if (pending) {
      const meeting = byId(pending.meetingId);
      const ours = "range" in current && current.meetingId === pending.meetingId && sameRange(current.range, pending);
      if (!meeting || ours || current.phase === "dragging") return;
      const next = reduceEdit(current, { type: "propose", meetingId: meeting.id, original: meeting, range: pending, movability: meeting.movability });
      if (next === current) return;
      proposedRef.current = { meetingId: meeting.id, range: pending };
      set(next);
      if (next.phase === "pending") say(`Move ${meeting.title} to ${clock(pending.startMs)} to ${clock(pending.endMs)}? Enter moves it, Escape cancels.`);
    } else if (was) {
      proposedRef.current = undefined;
      if (current.phase === "pending") set(reduceEdit(current, { type: "cancel" }));
      else if (current.phase === "confirmed") set(reduceEdit(current, { type: "settle" }));
    }
  }, [pending?.meetingId, pending?.startMs, pending?.endMs]);
  // A confirmed change shows at its new time until the page's times match; a cancelled one slides back first.
  const editedMeeting = edit.phase !== "idle" ? byId(edit.meetingId) : undefined;
  useEffect(() => {
    if (edit.phase === "cancelled") { const t = window.setTimeout(() => apply({ type: "settle" }), SLIDE_MS); return () => window.clearTimeout(t); }
    if (edit.phase !== "confirmed") return;
    if (editedMeeting && sameRange(editedMeeting, edit.range)) { apply({ type: "settle" }); return; }
    // The page refused or failed without saying so: slide back after a while.
    const t = window.setTimeout(() => apply({ type: "settle" }), editedMeeting?.movability.kind === "direct" ? DIRECT_SETTLE_MS : REVIEW_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [edit, editedMeeting?.startMs, editedMeeting?.endMs]);

  // The review card: the page's pending change, or the panel's own until the page answers.
  const review = (() => {
    const id = pending?.meetingId ?? (edit.phase === "pending" || edit.phase === "confirmed" && confirming ? edit.meetingId : undefined);
    const meeting = id ? byId(id) : undefined;
    if (!meeting || meeting.movability.kind !== "review") return undefined;
    const to = pending?.meetingId === meeting.id ? pending : "range" in edit ? edit.range : meeting;
    const from = "original" in edit && edit.meetingId === meeting.id ? edit.original : meeting;
    return { meeting, calendarName: meeting.movability.calendarName, invitation: !!meeting.movability.invitation, from, to };
  })();

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (review) { e.preventDefault(); e.stopPropagation(); cancel(); }
      return;
    }
    if (e.key === "Enter" && review && !confirming && !(e.target as HTMLElement).closest("button, input, textarea, select, a")) { e.preventDefault(); confirm(); return; }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target as HTMLElement).closest("input, textarea")) { e.preventDefault(); onDayChange(addDays(dayMs, e.key === "ArrowLeft" ? -1 : 1)); }
  };
  const confirm = () => { if (edit.phase === "pending") apply({ type: "confirm" }); else onConfirm(); };
  const cancel = () => { if (edit.phase === "pending") apply({ type: "cancel" }); else onCancel(); };

  // The month picker closes on a click outside it and on Escape (before anything else hears it).
  useEffect(() => {
    if (!picking) return;
    const outside = (event: PointerEvent) => { if (!pickerAnchor.current?.contains(event.target as Node)) setPicking(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setPicking(false); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [picking]);

  const active = editedMeeting ?? (pending ? byId(pending.meetingId) : undefined) ?? meetings.find((m) => m.isThis && !m.allDay);
  const activeRange = active && (pending?.meetingId === active.id ? pending : "range" in edit && edit.meetingId === active.id ? edit.range : active);
  const overlap = active && activeRange ? overlapNote({ id: active.id, ...activeRange }, meetings) : undefined;
  const hasThis = meetings.some((m) => m.isThis);
  const timedOthers = meetings.filter((m) => !m.isThis).length;
  const label = timeLabel ?? ((minutes: number, d: number) => timeText(atMinutes(d, minutes)).replace(/ /g, " "));

  return <section className="dp" aria-labelledby={ids + "-day"} onKeyDown={keys}>
    <header className="dp-header">
      <IconButton icon={ChevronLeft} label="Previous day" onClick={() => onDayChange(addDays(dayMs, -1))} />
      <div className="dp-date-anchor" ref={pickerAnchor}>
        <button type="button" id={ids + "-day"} className="dp-date" aria-haspopup="dialog" aria-expanded={picking} aria-label={longDay(dayMs) + (dayMs === today ? ", today" : "") + ". Choose another day"} onClick={() => setPicking(!picking)}>{headingDay(dayMs)}</button>
        {picking && <div className="dp-month" role="dialog" aria-label="Choose a day">
          <MonthDayPicker selectedDay={dayMs} busy={[]} onPick={(d) => { setPicking(false); onDayChange(d); }} />
        </div>}
      </div>
      <IconButton icon={ChevronRight} label="Next day" onClick={() => onDayChange(addDays(dayMs, 1))} />
      <button type="button" className="dp-today" disabled={dayMs === today} onClick={() => onDayChange(today)}>Today</button>
    </header>

    {(coverage === "missing" || coverage === "loading") && <p className="dp-note is-warn">Calendar not loaded for this day. Other meetings may be missing.{coverage === "missing" && onRetry && <> <button type="button" className="link-button" onClick={onRetry}>Retry</button></>}</p>}
    {coverage === "partial" && <p className="dp-note is-warn">This date is only partly loaded{partialAccounts?.length ? " (" + partialAccounts.join(", ") + ")" : ""}, so some meetings may be missing.</p>}
    {coverage === "none" && <p className="dp-note">{onConnectCalendar ? <button type="button" className="link-button" onClick={onConnectCalendar}>Connect a calendar to see the rest of your day →</button> : "Connect a calendar to see the rest of your day."}</p>}
    {untimedMeetingId && !hasThis && <p className="dp-note is-hint">Drag on the timeline to give this meeting a time.</p>}

    <DayTimeline dayMs={dayMs} meetings={meetings} edit={edit} onEdit={apply} pending={pending} onOpen={onOpen} timeLabel={label}
      onDayStep={(direction) => onDayChange(addDays(dayMs, direction))} announcement={announcement}
      onDraw={untimedMeetingId && !hasThis ? (range) => { onPropose(untimedMeetingId, range); say(`Time set: ${clock(range.startMs)} to ${clock(range.endMs)}.`); } : undefined} />

    <div className="dp-status">
      {overlap && <p className="dp-overlap">{overlap}</p>}
      {notice && <p className="dp-notice">{notice}</p>}
      {!overlap && !notice && timedOthers === 0 && coverage === "loaded" && <span className="visually-hidden">No other meetings this day.</span>}
    </div>

    {review && <div className="dp-review" role="group" aria-labelledby={ids + "-review"}>
      <h3 id={ids + "-review"}>{reviewHeading(review.calendarName)}</h3>
      <p className="dp-review-change"><span>{headingDay(review.from.startMs)}</span> <span className="dp-review-from">{rangeText(review.from)}</span> <span aria-hidden>→</span><span className="visually-hidden">to</span> <strong>{rangeText(review.to)}</strong></p>
      <p className={"dp-review-note" + (review.invitation ? " is-warn" : "")}>{review.invitation ? invitationWarning : ORGANISER_NOTE}</p>
      <div className="dp-review-actions">
        <button type="button" onClick={cancel}>Cancel</button>
        <button type="button" className="primary" disabled={confirming} onClick={confirm}>{confirming ? "Moving…" : "Move event"}</button>
      </div>
    </div>}

    {children && <footer className="dp-footer">{children}</footer>}
  </section>;
}
