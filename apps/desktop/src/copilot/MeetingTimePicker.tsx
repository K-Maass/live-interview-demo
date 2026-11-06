import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { DAY_MINUTES, SNAP, atMinutes, dragRange, minutesOfDay, monthGrid, moveRange, onDay, resizeRange } from "../lib/public/calendarSave";
import { canMove, nudge, pastFloor, placeRange, sameRange, shownRange, type DayPanelMeeting, type DragMode, type EditEvent, type EditState, type TimeRange } from "../lib/public/dayEdit";
import { IconButton, timeText } from "./ui";
import { layoutDay, wallMinutes, weekdayNames, type DayEntry } from "./calendar/layout";
import { nowLabel } from "./calendar/spine";
import { useNow } from "./calendar/useNow";
import { NEAR_NOW_MINUTES } from "./calendar/WeekView";

export interface BusyMeeting { id: string; title: string; startMs: number; endMs: number }
type Range = { start: number; end: number };
type Drag = { mode: "new" | "move" | "resize"; anchor: number; grab: number; range: Range; moved: boolean };

const PX_PER_MIN = 0.8; // 48px an hour
/** A busy block shorter than this has no room for two lines, so its title and time share one line. */
const SHORT_BLOCK_MINUTES = 45;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Pick the day on a month grid, then draw the time on that day's timeline (`DayTimeline`).
 *
 * It borrows the Calendar's look (calendar.css, calendar-today.css): the Month view's weekday header and date numbers
 * (`cal-month-weekday`, `cal-date-num`) with the chosen day as a filled pill, and the Today spine's gutter, 4 px spine,
 * segments and orange now-marker (`spine-seg`, `spine-now`) over the Week grid's hour labels (`cal-hour-label`).
 */
export function MeetingTimePicker({ startMs, endMs, busy, onChange, onMonthShown, planId }: { startMs?: number; endMs?: number; busy: BusyMeeting[]; onChange: (range: { startMs: number; endMs: number }) => void; onMonthShown?: (month: Date) => void; planId?: string }) {
  const selectedDay = startMs !== undefined ? startOfDay(startMs) : undefined;
  return <div className="time-picker">
    <MonthDayPicker selectedDay={selectedDay} busy={busy} onPick={(day) => onChange(onDay(day, { startMs, endMs }))} onMonthShown={onMonthShown} />
    <DayTimeline startMs={startMs} endMs={endMs} busy={busy} onChange={onChange} scrollKey={planId} />
  </div>;
}

export interface PickerTimelineProps {
  startMs?: number; endMs?: number; busy: BusyMeeting[];
  onChange: (range: { startMs: number; endMs: number }) => void;
  /** Scroll to the meeting again when this changes (another plan shown). */
  scrollKey?: string;
  /** How the block times read; hour labels stay 24-hour so the gutter stays narrow. */
  timeLabel?: (minutes: number, dayMs: number) => string;
}

/**
 * One day's timeline, in two forms. With `startMs`/`endMs`/`busy`/`onChange` it is the time picker for one meeting
 * (the planning page and the New meeting popover). With `meetings` it is the meeting page's day panel timeline, where
 * every movable meeting of the day can be moved and resized (`EditableDayTimeline`).
 */
export function DayTimeline(props: PickerTimelineProps | EditableDayTimelineProps) {
  return "meetings" in props ? <EditableDayTimeline {...props} /> : <PickerTimeline {...props} />;
}

/**
 * One day's timeline: drag across empty time to draw the meeting, drag the block to move it, drag its lower edge to
 * change the length; Up and Down move the focused block by 15 minutes, with Shift they change the end. Other meetings
 * that day show as outlined blocks. Used by the planning page's picker and the Calendar's New meeting popover.
 *
 * It stays linear (48 px an hour) so a drag maps straight to a time; the Today spine draws gaps to scale instead.
 * During a drag Escape cancels it and Enter does nothing, so a surrounding dialog neither closes nor submits.
 * It scrolls to the meeting when the day (or `scrollKey`) changes and whenever it becomes visible after being hidden,
 * and keeps the meeting in view when its time changes from outside (length chips, keyboard).
 */
function PickerTimeline({ startMs, endMs, busy, onChange, scrollKey, timeLabel = clock }: PickerTimelineProps) {
  const selectedDay = startMs !== undefined ? startOfDay(startMs) : undefined;
  const now = useNow();
  const today = startOfDay(now);
  const busyOn = (day: number) => busy.filter((b) => b.startMs < day + 86_400_000 && b.endMs > day);

  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const [announcement, setAnnouncement] = useState("");
  const current: Range | undefined = selectedDay !== undefined && startMs !== undefined && endMs !== undefined
    ? { start: minutesOfDay(startMs), end: Math.min(DAY_MINUTES, Math.round((endMs - selectedDay) / 60_000)) } : undefined;
  const shown = drag?.range ?? current;

  useScrollToRange(scroller, current, [selectedDay, scrollKey, current === undefined], !!drag, selectedDay === undefined);
  // While drawing, Escape cancels the drag (not the dialog around it) and Enter does not submit.
  useEffect(() => {
    if (!drag) return;
    const keydown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") setDrag(undefined);
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [!!drag]);

  // Overlapping meetings sit side by side so both titles stay readable.
  const busyRows = selectedDay === undefined ? [] : busyOn(selectedDay).map((b) => {
    const s = Math.max(0, (b.startMs - selectedDay) / 60_000), e = Math.min(DAY_MINUTES, (b.endMs - selectedDay) / 60_000);
    return { ...b, s, e, overlaps: !!shown && s < shown.end && e > shown.start };
  });
  const label = (minutes: number) => timeLabel(minutes, selectedDay ?? 0);
  const commit = (range: Range) => { if (selectedDay !== undefined) onChange({ startMs: atMinutes(selectedDay, range.start), endMs: range.end >= DAY_MINUTES ? selectedDay + 86_400_000 : atMinutes(selectedDay, range.end) }); };
  const minuteAt = (e: PointerEvent) => { const rect = track.current!.getBoundingClientRect(); return Math.min(DAY_MINUTES, Math.max(0, (e.clientY - rect.top) / PX_PER_MIN)); };
  const begin = (e: PointerEvent, mode: Drag["mode"]) => {
    if (e.button !== 0 || selectedDay === undefined) return;
    e.preventDefault(); e.stopPropagation();
    try { track.current?.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    const at = minuteAt(e);
    if (mode === "new") {
      // A click places a block of the current length; dragging draws one.
      const length = current ? current.end - current.start : 30;
      const start = Math.min(Math.floor(at / SNAP) * SNAP, DAY_MINUTES - length);
      setDrag({ mode, anchor: start, grab: 0, range: { start, end: start + length }, moved: false });
    } else if (current) setDrag({ mode, anchor: current.start, grab: at - current.start, range: current, moved: false });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const at = minuteAt(e);
    if (drag.mode === "new" && !drag.moved && Math.abs(at - drag.anchor) < SNAP) return;
    const range = drag.mode === "new" ? dragRange(drag.anchor, at)
      : drag.mode === "move" ? moveRange(drag.range.start, drag.range.end, at - drag.grab - drag.range.start)
      : resizeRange(drag.range.start, at);
    setDrag({ ...drag, range, moved: true });
  };
  const end = () => { if (drag) commit(drag.range); setDrag(undefined); };
  const keys = (e: KeyboardEvent) => {
    if (!current || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -SNAP : SNAP;
    const next = e.shiftKey ? resizeRange(current.start, current.end + delta) : moveRange(current.start, current.end, delta);
    commit(next);
    // The group's label is not re-read when it changes, so the new time is said once through a live region.
    setAnnouncement(`${label(next.start)} to ${label(next.end)}`);
  };

  const nowMinutes = selectedDay === today ? minutesOfDay(now) : undefined;
  const span = (from: number, to: number, min: number): CSSProperties => ({ top: from * PX_PER_MIN, height: Math.max(min, (to - from) * PX_PER_MIN) });

  return <div className="day-timeline">
    {selectedDay === undefined ? <p className="muted day-timeline-empty">Choose a day, then drag on its timeline to set the time.</p> : <>
      <div className="day-timeline-heading"><strong>{new Date(selectedDay).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</strong><small>Drag to set the time</small></div>
      <div className="day-timeline-scroll" ref={scroller}>
        <div className="day-timeline-body" style={{ height: DAY_MINUTES * PX_PER_MIN }}>
          <HourLabels nowMinutes={nowMinutes} />
          {busyRows.map((b) => <span key={b.id} className="spine-seg" style={span(b.s, b.e, 14)} aria-hidden />)}
          {shown && <span className="spine-seg is-chosen" style={span(shown.start, shown.end, 18)} aria-hidden />}
          <div className="day-timeline-track" ref={track} onPointerDown={(e) => begin(e, "new")} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(undefined)}>
            {busyRows.map((b) => <div key={b.id} className={"busy-block" + (b.overlaps ? " beside" : "") + (b.e - b.s < SHORT_BLOCK_MINUTES ? " is-short" : "")} style={span(b.s, b.e, 14)} title={b.title}>
              <span className="busy-block-title">{b.title}</span><span className="busy-block-time">{label(b.s)}–{label(b.e)}</span></div>)}
            {shown && <div className={"chosen-block" + (drag ? " dragging" : "") + (busyRows.some((b) => b.overlaps) ? " beside" : "")} style={span(shown.start, shown.end, 18)}
              tabIndex={0} role="group" aria-label={`Meeting ${label(shown.start)} to ${label(shown.end)}. Up and down arrows move it; with Shift they change the end.`}
              onPointerDown={(e) => begin(e, "move")} onKeyDown={keys} onBlur={() => setAnnouncement("")}>
              <span>{label(shown.start)}–{label(shown.end)}</span>
              <span className="resize-handle" onPointerDown={(e) => begin(e, "resize")} aria-hidden />
            </div>}
          </div>
          <NowMarker now={now} nowMinutes={nowMinutes} />
        </div>
      </div>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
    </>}
  </div>;
}

export interface EditableDayTimelineProps {
  /** Any time on the day shown. */
  dayMs: number;
  /** Every meeting that day, all-day ones included. */
  meetings: DayPanelMeeting[];
  /** The owner's edit state (`reduceEdit` in lib/public/dayEdit.ts); the timeline only reports `onEdit` events. */
  edit: EditState;
  onEdit: (event: EditEvent) => void;
  /** A calendar change the page is reviewing; drawn at its new time with the old one dashed. */
  pending?: { meetingId: string; startMs: number; endMs: number };
  /** Click, or Enter, on a meeting that is not this one. */
  onOpen?: (meeting: DayPanelMeeting) => void;
  /** Option+← / Option+→ on a meeting. */
  onDayStep?: (direction: -1 | 1) => void;
  /** Only while this meeting has no time: drawing on empty space (or a click) gives it one. */
  onDraw?: (range: TimeRange) => void;
  /** What the live region says; the owner words each change. */
  announcement?: string;
  /** How block times read; hour labels stay 24-hour so the gutter stays narrow. */
  timeLabel?: (minutes: number, dayMs: number) => string;
  /** Scroll to this meeting again when this changes. */
  scrollKey?: string;
}

type Press = { meeting?: DayPanelMeeting; mode: DragMode; grab: number; y: number; base: Range; anchor: number; started: boolean; moved?: boolean; editable: boolean };
/** Shortest drawn block (18 px), in minutes; also what layoutDay packs with so short meetings do not cover each other. */
const MIN_BLOCK_MINUTES = 23;
const DRAG_THRESHOLD_PX = 3;
const meetingClock = (minutes: number, dayMs: number) => timeText(atMinutes(dayMs, minutes)).replace(/ /g, " ");

/**
 * The day panel's timeline: every meeting of the day, overlapping ones side by side (`layoutDay`), all-day events in a
 * strip above the hours. A meeting that can move (see `movability`) is dragged by its body and resized by either edge,
 * on a 15-minute snap that never crosses midnight or lands in the past (shaded). Read-only ones show a lock and say why.
 * While a change is in progress the meeting is drawn at the new time, on top, with its old place dashed.
 *
 * Keyboard on a focused meeting: ↑/↓ move it 15 minutes, Shift+↑/↓ change the end, Option+↑/↓ the start, Option+←/→
 * step a day, Enter opens a meeting that is not this one. During a drag Escape cancels it and Enter does nothing.
 * Blocks keep the order of `meetings` in the document so focus stays on a block while it moves.
 */
function EditableDayTimeline({ dayMs, meetings, edit, onEdit, pending, onOpen, onDayStep, onDraw, announcement = "", timeLabel = meetingClock, scrollKey }: EditableDayTimelineProps) {
  const day = startOfDay(dayMs);
  const dayDate = new Date(day);
  const nextMidnight = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1).getTime();
  const now = useNow();
  const today = startOfDay(now);
  const floor = pastFloor(day, now);
  const nowMinutes = day === today ? minutesOfDay(now) : undefined;
  const pastMinutes = day < today ? DAY_MINUTES : nowMinutes ?? 0;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const press = useRef<Press | undefined>(undefined);
  const [drawing, setDrawing] = useState<Range>();
  const ids = useId();
  const label = (minutes: number) => timeLabel(minutes, day);
  const toMinutes = (r: TimeRange): Range => ({ start: wallMinutes(r.startMs, dayDate), end: wallMinutes(r.endMs, dayDate) });
  const toMs = (r: Range): TimeRange => ({ startMs: atMinutes(day, r.start), endMs: r.end >= DAY_MINUTES ? nextMidnight : atMinutes(day, r.end) });
  const dragging = edit.phase === "dragging";

  const shownOf = (m: DayPanelMeeting): TimeRange => {
    if (dragging && edit.meetingId === m.id) return edit.range;
    if (pending?.meetingId === m.id) return pending;
    return shownRange(edit, m.id) ?? m;
  };
  const originalOf = (m: DayPanelMeeting): TimeRange | undefined =>
    (edit.phase === "dragging" || edit.phase === "pending") && edit.meetingId === m.id ? edit.original : pending?.meetingId === m.id ? m : undefined;
  const timed = meetings.filter((m) => !m.allDay && m.endMs > day && m.startMs < nextMidnight);
  const allDay = meetings.filter((m) => m.allDay);

  // Lanes come from the settled times, so the other meetings hold still while one is dragged over them.
  const lanes = useRef<DayEntry<TimeRange & { id: string }>[]>([]);
  if (!dragging) lanes.current = layoutDay(timed.map((m) => ({ id: m.id, ...shownOf(m) })), dayDate, { maxColumns: 3, minHeightMinutes: MIN_BLOCK_MINUTES });
  const entries = lanes.current;
  const geometry = (id: string) => {
    const own = entries.find((e) => e.kind === "event" && e.id === id);
    return own ?? entries.find((e) => e.kind === "more" && e.hiddenIds.includes(id));
  };
  // Where each meeting sat before any change started, for the dashed outline of its old place.
  const restingLanes = useRef(entries);
  if (edit.phase === "idle" && !pending) restingLanes.current = entries;
  const restingPlace = (id: string) => restingLanes.current.find((e) => e.kind === "event" && e.id === id) ?? geometry(id);

  const thisMeeting = timed.find((m) => m.isThis);
  const focusRange = (edit.phase !== "idle" && timed.find((m) => m.id === edit.meetingId)) || pending && timed.find((m) => m.id === pending.meetingId) || thisMeeting;
  const target: Range | undefined = focusRange ? toMinutes(shownOf(focusRange)) : nowMinutes !== undefined ? { start: nowMinutes, end: nowMinutes + 30 } : timed[0] ? toMinutes(timed[0]) : { start: 8 * 60, end: 8 * 60 + 30 };
  useScrollToRange(scroller, target, [day, scrollKey, focusRange?.id], dragging, true);

  // While dragging or drawing, Escape cancels it (not the dialog or panel around it) and Enter does nothing.
  useEffect(() => {
    if (!dragging && !drawing) return;
    const keydown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault(); e.stopPropagation();
      if (e.key !== "Escape") return;
      press.current = undefined;
      if (drawing) setDrawing(undefined); else onEdit({ type: "cancel" });
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [dragging, !!drawing]);

  const editableOf = (m: DayPanelMeeting) => canMove(m.movability) && m.startMs >= day && m.endMs <= nextMidnight && floor < DAY_MINUTES;
  const minuteAt = (e: PointerEvent) => { const rect = track.current!.getBoundingClientRect(); return Math.min(DAY_MINUTES, Math.max(0, (e.clientY - rect.top) / PX_PER_MIN)); };
  const capture = (e: PointerEvent) => { try { track.current?.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ } };
  const pressMeeting = (e: PointerEvent, m: DayPanelMeeting, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // preventDefault keeps text from being selected but also stops the browser focusing the block, so focus it here.
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".dp-meeting")?.focus({ preventScroll: true });
    capture(e);
    const at = minuteAt(e), base = toMinutes(shownOf(m));
    press.current = { meeting: m, mode, grab: at - base.start, y: e.clientY, base, anchor: at, started: false, editable: editableOf(m) };
  };
  const pressEmpty = (e: PointerEvent) => {
    if (e.button !== 0 || !onDraw || thisMeeting || floor > DAY_MINUTES - SNAP) return;
    e.preventDefault();
    capture(e);
    const at = minuteAt(e);
    // A click places 30 minutes where it landed; dragging draws the time.
    const start = Math.min(DAY_MINUTES - 30, Math.max(floor, Math.floor(at / SNAP) * SNAP));
    press.current = { mode: "new", grab: 0, y: e.clientY, base: { start, end: start + 30 }, anchor: at, started: false, editable: true };
  };
  const move = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.started) {
      if (Math.abs(e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      // A read-only meeting does not move, and a press that wandered is not a click either.
      p.moved = true;
      if (!p.editable) return;
      p.started = true;
      if (p.meeting) onEdit({ type: "begin", meetingId: p.meeting.id, mode: p.mode, original: { startMs: p.meeting.startMs, endMs: p.meeting.endMs }, movability: p.meeting.movability });
    }
    const at = minuteAt(e);
    if (p.mode === "new") setDrawing(placeRange("new", p.base, at, floor, p.anchor));
    else onEdit({ type: "drag", range: toMs(placeRange(p.mode, p.base, p.mode === "move" ? at - p.grab : at, floor)) });
  };
  const release = () => {
    const p = press.current;
    press.current = undefined;
    if (!p) return;
    if (p.mode === "new") { const range = drawing ?? p.base; setDrawing(undefined); onDraw?.(toMs(range)); return; }
    if (p.started) onEdit({ type: "drop" });
    else if (p.meeting && !p.meeting.isThis && !p.moved) onOpen?.(p.meeting);
  };
  const abandon = () => { const p = press.current; press.current = undefined; setDrawing(undefined); if (p?.started && p.meeting) onEdit({ type: "cancel" }); };
  const keys = (e: KeyboardEvent, m: DayPanelMeeting) => {
    if (e.key === "Enter" && !m.isThis && edit.phase !== "pending" && !pending) { e.preventDefault(); onOpen?.(m); return; }
    const result = nudge(toMinutes(shownOf(m)), e.key, e, floor);
    if (!result) return;
    e.preventDefault(); e.stopPropagation();
    if ("day" in result) { onDayStep?.(result.day); return; }
    if (editableOf(m)) onEdit({ type: "propose", meetingId: m.id, original: { startMs: m.startMs, endMs: m.endMs }, range: toMs(result.range), movability: m.movability });
  };

  const span = (r: Range): CSSProperties => ({ top: r.start * PX_PER_MIN, height: Math.max(MIN_BLOCK_MINUTES * PX_PER_MIN, (r.end - r.start) * PX_PER_MIN) });
  const place = (g: { left: number; width: number } | undefined): CSSProperties => g ? { left: `calc(${g.left * 100}% + ${g.left ? 2 : 0}px)`, width: `calc(${g.width * 100}% - ${g.left ? 2 : 0}px)` } : {};


  return <div className="day-timeline dp-timeline">
    {allDay.length > 0 && <div className="dp-allday" role="group" aria-label="All day">
      <span className="dp-allday-label" aria-hidden>All day</span>
      <div className="dp-allday-items">{allDay.map((m) => {
        const reason = m.movability.kind === "readOnly" ? m.movability.reason : undefined;
        return <div key={m.id} className={"dp-allday-item" + (m.isThis ? " is-this" : "")} tabIndex={0} role={m.isThis ? undefined : "button"} title={reason}
          aria-label={`${m.title}, all day.${reason ? " " + reason : ""}${m.isThis ? "" : " Enter opens its plan."}`}
          onClick={() => { if (!m.isThis) onOpen?.(m); }} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !m.isThis) { e.preventDefault(); onOpen?.(m); } }}>
          {reason && <Lock size={11} strokeWidth={2} aria-hidden className="dp-lock" />}<span>{m.title}</span></div>;
      })}</div>
    </div>}
    <div className="day-timeline-scroll" ref={scroller}>
      <div className="day-timeline-body" style={{ height: DAY_MINUTES * PX_PER_MIN }}>
        <HourLabels nowMinutes={nowMinutes} />
        {timed.map((m) => { const r = toMinutes(shownOf(m)); return <span key={m.id} className={"spine-seg" + (m.isThis ? " is-chosen" : "")} style={span(r)} aria-hidden />; })}
        {drawing && <span className="spine-seg is-chosen" style={span(drawing)} aria-hidden />}
        <div className={"day-timeline-track dp-track" + (onDraw && !thisMeeting ? " can-draw" : "")} ref={track} onPointerDown={pressEmpty} onPointerMove={move} onPointerUp={release} onPointerCancel={abandon}>
          {pastMinutes > 0 && <div className="dp-past" style={{ height: pastMinutes * PX_PER_MIN }} aria-hidden />}
          {timed.map((m) => { const o = originalOf(m); return o && !sameRange(o, shownOf(m)) ? <div key={"ghost:" + m.id} className="dp-ghost" style={{ ...span(toMinutes(o)), ...place(restingPlace(m.id)) }} aria-hidden /> : null; })}
          {entries.filter((e) => e.kind === "more").map((e) => <span key={e.id} className="dp-more" style={{ ...span({ start: e.top, end: e.bottom }), ...place(e) }}
            title={e.hiddenIds.map((id) => meetings.find((m) => m.id === id)?.title).filter(Boolean).join(", ")}>+{e.count}</span>)}
          {timed.map((m) => {
            const g = geometry(m.id);
            const active = edit.phase !== "idle" && edit.meetingId === m.id || pending?.meetingId === m.id;
            // A meeting folded into "+N" is still drawn when it is this one or the one being changed.
            if (!g || (g.kind === "more" && !m.isThis && !active)) return null;
            const r = toMinutes(shownOf(m));
            const editable = editableOf(m);
            const reason = m.movability.kind === "readOnly" ? m.movability.reason : !editable && floor >= DAY_MINUTES ? "This day has passed." : undefined;
            const changing = dragging && edit.meetingId === m.id;
            const short = (r.end - r.start) * PX_PER_MIN < 34;
            const time = `${label(r.start)}–${label(r.end)}`;
            const help = editable ? " Up and down arrows move it; with Shift they change the end, with Option the start." : "";
            return <Fragment key={m.id}><div className={"dp-meeting" + (m.isThis ? " is-this" : "") + (editable ? " is-movable" : "") + (m.movability.kind === "readOnly" ? " is-locked" : "")
                + (changing ? " is-dragging" : "") + (active && !changing ? " is-pending" : "") + (shownOf(m).endMs <= now ? " is-past" : "") + (short ? " is-short" : "")}
              style={{ ...span(r), ...place(g) }} tabIndex={0} role="group" title={reason}
              aria-label={`${m.title}, ${time.replace(/–/, " to ")}${m.isThis ? ", this meeting" : ""}.${help}${m.isThis ? "" : " Enter opens its plan."}`}
              aria-describedby={reason ? ids + m.id : undefined}
              onPointerDown={(e) => pressMeeting(e, m, "move")} onKeyDown={(e) => keys(e, m)}>
              <span className="dp-meeting-title">{m.movability.kind === "readOnly" && <Lock size={11} strokeWidth={2} aria-hidden className="dp-lock" />}<span>{m.title}</span></span>
              <span className="dp-meeting-time">{time}</span>
              {editable && <><span className="dp-grip dp-grip-start" onPointerDown={(e) => pressMeeting(e, m, "start")} aria-hidden /><span className="dp-grip dp-grip-end" onPointerDown={(e) => pressMeeting(e, m, "end")} aria-hidden /></>}
            </div>{reason && <span id={ids + m.id} hidden>{reason}</span>}</Fragment>;
          })}
          {drawing && <div className="dp-meeting is-this is-dragging" style={span(drawing)} aria-hidden><span className="dp-meeting-time">{label(drawing.start)}–{label(drawing.end)}</span></div>}
        </div>
        <NowMarker now={now} nowMinutes={nowMinutes} />
      </div>
    </div>
    <span className="visually-hidden" aria-live="polite">{announcement}</span>
  </div>;
}

function HourLabels({ nowMinutes }: { nowMinutes?: number }) {
  return <div className="day-timeline-hours" aria-hidden>{Array.from({ length: 23 }, (_, i) => (i + 1) * 60).map((m) =>
    <span key={m} className={"cal-hour-label" + (nowMinutes !== undefined && Math.abs(m - nowMinutes) <= NEAR_NOW_MINUTES ? " is-near-now" : "")} style={{ top: m * PX_PER_MIN }}>{clock(m)}</span>)}</div>;
}

function NowMarker({ now, nowMinutes }: { now: number; nowMinutes?: number }) {
  return nowMinutes === undefined ? null : <div className="spine-now" role="separator" aria-label={"Now, " + nowLabel(now)} style={{ top: nowMinutes * PX_PER_MIN }}>
    <span className="spine-now-time">{nowLabel(now)}</span><span className="spine-now-dot" aria-hidden="true" /><span className="spine-now-line" aria-hidden="true" />
  </div>;
}

/**
 * Brings a range into view, with an hour of context above it, when `keys` change and whenever the timeline becomes
 * visible after being hidden; keeps it in view when it changes from outside (length chips, keyboard) but not during a
 * drag. A hidden timeline (display:none, or not laid out yet) cannot scroll, so the scroll waits until it has a size:
 * the ResizeObserver catches it becoming visible.
 */
function useScrollToRange(scroller: RefObject<HTMLDivElement | null>, current: Range | undefined, keys: unknown[], dragging: boolean, observeKey: unknown) {
  const pendingScroll = useRef(true);
  const currentRef = useRef(current);
  currentRef.current = current;
  const scrollToMeeting = () => {
    const el = scroller.current, range = currentRef.current;
    if (!el || !range) return;
    if (el.clientHeight === 0) { pendingScroll.current = true; return; }
    el.scrollTop = Math.max(0, (range.start - 60) * PX_PER_MIN);
    pendingScroll.current = false;
  };
  useEffect(() => { pendingScroll.current = true; scrollToMeeting(); }, keys);
  // A time changed from outside (length chips, arrow keys) that leaves the visible part: scroll just enough.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !current || dragging || pendingScroll.current || el.clientHeight === 0) return;
    const top = current.start * PX_PER_MIN, bottom = current.end * PX_PER_MIN;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 24);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.min(top - 24, bottom - el.clientHeight + 24);
  }, [current?.start, current?.end]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let wasHidden = el.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      const hidden = el.clientHeight === 0;
      if (!hidden && (wasHidden || pendingScroll.current)) scrollToMeeting();
      wasHidden = hidden;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [observeKey]);
}

/**
 * The month grid on its own: the Month view's weekday header and date numbers, the chosen day as a filled pill and a
 * dot on days that already have meetings. Past days cannot be chosen. Used by the time picker and the New meeting popover.
 */
export function MonthDayPicker({ selectedDay, busy, onPick, onMonthShown }: { selectedDay?: number; busy: BusyMeeting[]; onPick: (dayMs: number) => void; onMonthShown?: (month: Date) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(selectedDay ?? Date.now()); return new Date(d.getFullYear(), d.getMonth(), 1); });
  useEffect(() => { onMonthShown?.(month); }, [month.getTime()]);
  // Follow the chosen day to another month when it changes elsewhere.
  useEffect(() => { if (selectedDay !== undefined) { const d = new Date(selectedDay); if (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear()) setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); } }, [selectedDay]);
  const today = startOfDay(useNow());
  const busyOn = (day: number) => busy.filter((b) => b.startMs < day + 86_400_000 && b.endMs > day);
  return <div className="month-picker">
    <div className="month-picker-heading">
      <strong aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
      <IconButton icon={ChevronLeft} label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
      <IconButton icon={ChevronRight} label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
    </div>
    <div className="month-picker-grid" role="group" aria-label="Choose a day">
      {weekdayNames().map((d) => <span key={d} className="cal-month-weekday" aria-hidden>{d}</span>)}
      {monthGrid(month).map((day) => {
        const date = new Date(day), outside = date.getMonth() !== month.getMonth(), past = day < today, count = busyOn(day).length;
        return <button key={day} type="button" disabled={past} aria-pressed={day === selectedDay} aria-current={day === today ? "date" : undefined}
          aria-label={date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) + (day === today ? ", today" : "") + (count ? `, ${count} meeting${count > 1 ? "s" : ""}` : "")}
          className={"month-picker-day" + (outside ? " is-outside" : "") + (day === today ? " is-today" : "") + (day === selectedDay ? " selected" : "")}
          onClick={() => onPick(day)}><span className="cal-date-num">{date.getDate()}</span>{count > 0 && <span className="busy-dot" aria-hidden />}</button>;
      })}
    </div>
  </div>;
}
