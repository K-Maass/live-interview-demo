import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import { timeText } from "../ui";
import { DayTimeline, MonthDayPicker, type BusyMeeting } from "../MeetingTimePicker";
import { atMinutes } from "../../lib/public/calendarSave";
import { QUICK_LENGTHS, lengthLabel, quickMeetingDefaults, quickMeetingProblem, quickMeetingRange, withDay, withLength, withRange, type QuickMeetingDraft } from "../../lib/public/quickMeeting";

const CONTROL = "input, textarea, select, button, a[href], [contenteditable=\"true\"], [role=spinbutton], [role=slider]";

export type ShownRange = { startMs: number; endMs: number; layout: "today" | "week" | "month" };

/**
 * New meeting on the Calendar: a dialog under the button with the title, the day (the planning page's month grid) and
 * the time, drawn on that day's timeline like on the planning page (`DayTimeline`), with length chips as a shortcut.
 * Wide windows show the grid and the timeline side by side; narrow ones stack them. Create makes the in-app plan only.
 * Escape, Cancel, Create and a click outside close it, and focus goes back to the button. While a time is being
 * dragged, Escape cancels the drag and Enter does not submit (the timeline handles both).
 */
export function NewMeetingPopover({ disabled, busy, shown, onCreate, initiallyOpen = false }: {
  disabled: boolean; busy: BusyMeeting[]; shown?: ShownRange;
  /** Resolves true when the plan was saved. */
  onCreate: (meeting: { title: string; startMs: number; endMs: number }) => Promise<boolean>;
  /** For markup tests only. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [draft, setDraft] = useState<QuickMeetingDraft>(() => quickMeetingDefaults(Date.now(), shown));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const now = Date.now();

  const close = (refocus = true) => { setOpen(false); setFailed(false); if (refocus) button.current?.focus(); };
  const show = () => { setDraft(quickMeetingDefaults(Date.now(), shown)); setFailed(false); setOpen(true); };
  // A live meeting starts while it is open: close it like the button is disabled.
  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) titleInput.current?.focus(); }, [open]);
  // Opens to the left of a button near the right edge (the usual place), to the right when there is no room. The
  // popover's width comes from CSS (two columns or stacked), so it is measured rather than assumed.
  const popover = useRef<HTMLDivElement>(null);
  const [alignStart, setAlignStart] = useState(false);
  // It also stops 16px above the window's bottom wherever the button sits (the heading wraps on narrow windows), so
  // Create stays in view and the body scrolls instead.
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!open || !anchor.current || !popover.current) return;
    setAlignStart(anchor.current.getBoundingClientRect().right < popover.current.offsetWidth + 16);
    const fit = () => { if (popover.current) setMaxHeight(Math.min(760, Math.max(280, window.innerHeight - popover.current.getBoundingClientRect().top - 16))); };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (anchor.current?.contains(event.target as Node)) return;
      setOpen(false);
      // A click on a control keeps its focus; a click on empty page (or a focusable container) gives it back to the button.
      requestAnimationFrame(() => { if (!document.activeElement?.matches(CONTROL)) button.current?.focus(); });
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const problem = quickMeetingProblem(draft, now);
  const range = quickMeetingRange(draft);
  const clash = busy.find((b) => b.startMs < range.endMs && b.endMs > range.startMs);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || saving) return;
    setSaving(true); setFailed(false);
    const ok = await onCreate({ title: draft.title.trim(), ...range }).catch(() => false);
    setSaving(false);
    if (ok) close(); else setFailed(true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    close();
  };
  // Times read as on the Calendar, in the Mac's 12- or 24-hour format.
  const clock = (minutes: number) => timeText(atMinutes(draft.dayMs, minutes));
  // Each time stays on one line, so a block narrowed beside another meeting wraps after the dash, not inside "02:00 PM".
  const timelineLabel = (minutes: number, dayMs: number) => timeText(atMinutes(dayMs, minutes)).replace(/ /g, "\u00a0");
  const dayLabel = new Date(draft.dayMs).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  return <div className="new-meeting-anchor" ref={anchor} onKeyDown={keys}>
    <button ref={button} type="button" className="primary" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : show()}><Plus size={16} aria-hidden />New meeting</button>
    {open && <div id={id} className={"new-meeting-popover" + (alignStart ? " align-start" : "")} ref={popover} style={maxHeight ? { maxHeight } : undefined} role="dialog" aria-labelledby={id + "-heading"}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="new-meeting-body">
          <h2 id={id + "-heading"}>New meeting</h2>
          <label className="new-meeting-title">Title
            <input ref={titleInput} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Client sync with Acme" required aria-required="true" aria-describedby={!draft.title.trim() ? id + "-reason" : undefined} autoComplete="off" />
          </label>
          <div className="new-meeting-when">
            <div className="new-meeting-field" role="group" aria-label={"Date, " + dayLabel}>
              <span className="new-meeting-label" aria-hidden>Date</span>
              <MonthDayPicker selectedDay={draft.dayMs} busy={busy} onPick={(day) => setDraft(withDay(draft, day))} />
            </div>
            <div className="new-meeting-field" role="group" aria-label={`Time, ${clock(draft.startMinutes)} to ${clock(draft.startMinutes + draft.lengthMinutes)}`}>
              <span className="new-meeting-label" aria-hidden>Time</span>
              <DayTimeline startMs={range.startMs} endMs={range.endMs} busy={busy} timeLabel={timelineLabel} onChange={(r) => setDraft((d) => withRange(d, r))} />
            </div>
          </div>
          <div className="length-choices segmented-control" role="group" aria-label="Length">{QUICK_LENGTHS.map((m) => <button key={m} type="button" aria-pressed={draft.lengthMinutes === m} onClick={() => setDraft(withLength(draft, m))}>{lengthLabel(m)}</button>)}</div>
          <p className="new-meeting-summary"><strong>{dayLabel} · {clock(draft.startMinutes)}–{clock(draft.startMinutes + draft.lengthMinutes)}</strong>{clash && <span className="muted"> · Overlaps “{clash.title}”</span>}</p>
          <p className="muted new-meeting-note">Only in this app. Add it to a calendar from its plan.</p>
        </div>
        <div className="new-meeting-footer">
          <span id={id + "-reason"} className={"new-meeting-reason" + (failed ? " is-error" : "")} role={failed ? "alert" : undefined}>{failed ? "Could not create the meeting. Try again." : problem}</span>
          <button type="button" onClick={() => close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!!problem || saving}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </div>}
  </div>;
}
