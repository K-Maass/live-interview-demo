import { useEffect, useState } from "react";
import { CalendarPlus, RefreshCw } from "lucide-react";
import type { PublicMeetingPlan } from "@live-interview/core";
import type { CopilotController } from "./useCopilotController";
import type { AppLocation } from "./presentation/types";
import { Section, dayText, timeText } from "./ui";
import { CalendarConfirmSheet } from "./CalendarConfirmSheet";
import { MeetingTimePicker } from "./MeetingTimePicker";
import { visibleCalendarRange } from "../lib/public/state";
import { appOnlyPlanRows, calendarChangeSummary, calendarLabel, calendarSaveState, lengthText, withLength } from "../lib/public/calendarSave";

const LAST_CALENDAR = "liveInterview.lastCalendarId";
const remembered = () => { try { return localStorage.getItem(LAST_CALENDAR) ?? ""; } catch { return ""; } };
const remember = (id: string) => { try { localStorage.setItem(LAST_CALENDAR, id); } catch { /* a convenience only */ } };
const LENGTHS = [15, 30, 45, 60];
const longDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Whether the plan is in a calendar, as coloured plain text (no badge): the meeting page header shows it. */
export function PlanCalendarStatus({ plan }: { plan: PublicMeetingPlan }) {
  const state = calendarSaveState(plan);
  return state === "saved" ? <span className="calendar-status saved">In {plan.calendarSync?.calendarName}</span>
    : state === "changed" ? <span className="calendar-status changed">Calendar not updated</span>
    : state === "notSaved" ? <span className="calendar-status">Only in this app</span>
    : state === "fromCalendar" ? <span className="calendar-status saved">From your calendar</span>
    : <span className="calendar-status">No date yet</span>;
}

/** The focusable meeting title on the page that is showing (the page can be mounted twice, once hidden). */
const focusVisibleTitle = () => [...document.querySelectorAll<HTMLInputElement>(".meeting-title-input")].find((el) => el.offsetParent !== null)?.focus();

/**
 * When the meeting happens, and whether it is in a calendar. The day is picked on a month grid and the time drawn on
 * that day's timeline; Add to calendar is always offered and explains what to do when no calendar can take it.
 *
 * On the meeting page this is the content of the day slot (beside the page, or in the "Show day" drawer). When the
 * day panel lands (`MeetingDayPanel`, chunk A) it replaces the picker part; `PlanCalendarRow` stays as its footer.
 */
export function PlanWhenSection({ controller: c, navigate }: { controller: CopilotController; navigate: (location: AppLocation) => void }) {
  const p = c.publicProduct;
  const plan = p.current;
  if (!plan) return null;
  const state = calendarSaveState(plan);
  const dated = plan.startMs !== undefined && plan.endMs !== undefined;
  if (state === "fromCalendar") return <Section title="Date & time" className="plan-when">
    <p className="when-readonly">{dated ? `${dayText(plan.startMs!)} · ${timeText(plan.startMs!)}–${timeText(plan.endMs!)}` : "Time set by your calendar"}</p>
    <span className="calendar-status saved">From your calendar</span>
  </Section>;
  // Other meetings, so the timeline shows what the new one would clash with. Its own event is left out.
  const busy = [...p.calendarEvents.filter((e) => e.id !== plan.eventId), ...appOnlyPlanRows(p.plans.filter((x) => x.id !== plan.id), new Set(p.calendarEvents.map((e) => e.id)))];
  const clash = dated ? busy.find((b) => b.startMs < plan.endMs! && b.endMs > plan.startMs!) : undefined;
  return <Section title="Date & time" className="plan-when">
    <MeetingTimePicker planId={plan.id} startMs={plan.startMs} endMs={plan.endMs} busy={busy} onChange={(range) => c.setup.setSchedule(range)} onMonthShown={(month) => { if (!p.enabled) return; const r = visibleCalendarRange(month, "month"); void p.loadRange(r.startMs, r.endMs); }} />
    {dated && <div className="when-summary">
      <strong>{longDay(plan.startMs!)} · {timeText(plan.startMs!)}–{timeText(plan.endMs!)}</strong>
      <span className="muted">{lengthText(plan.startMs!, plan.endMs!)}</span>
      <div className="length-choices segmented-control" role="group" aria-label="Length">{LENGTHS.map((m) => <button key={m} aria-pressed={plan.endMs! - plan.startMs! === m * 60_000} onClick={() => c.setup.setSchedule(withLength({ startMs: plan.startMs! }, m))}>{m < 60 ? `${m} min` : "1 h"}</button>)}</div>
    </div>}
    {clash && <p className="muted when-clash">Overlaps “{clash.title}”</p>}
    <PlanCalendarRow controller={c} navigate={navigate} />
  </Section>;
}

/**
 * The Add to calendar / Update calendar event row with its confirmation sheets and errors. Today it closes the
 * Date & time section; after integration it is the day panel's footer.
 */
export function PlanCalendarRow({ controller: c, navigate }: { controller: CopilotController; navigate: (location: AppLocation) => void }) {
  const p = c.publicProduct;
  const cal = p.calendarSave;
  const plan = p.current;
  const macConnected = p.accounts.some((a) => a.provider === "apple" && a.status === "connected");
  useEffect(() => { void cal.refresh(); }, [macConnected]);
  const writable = macConnected ? cal.writable ?? [] : [];
  const [chosen, setChosen] = useState(remembered);
  const [noCalendar, setNoCalendar] = useState(false);
  const calendar = writable.find((w) => w.id === chosen) ?? writable[0];
  const [needsTitle, setNeedsTitle] = useState(false);
  const untitled = !plan?.title.trim() || plan.title === "Untitled meeting";
  useEffect(() => { if (!untitled) setNeedsTitle(false); }, [untitled]);
  if (!plan) return null;
  const state = calendarSaveState(plan);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pending = cal.pending?.planId === plan.id ? cal.pending : undefined;
  const sheet = pending && (pending.kind === "calendar"
    ? { ...calendarChangeSummary({ after: pending.after, before: pending.before, calendar: calendarLabel(pending.calendar), timeZone }), confirmLabel: pending.before ? "Update event" : "Add to calendar" }
    : { heading: "Save calendar file", lines: [`Save “${pending.after.title}” as ${pending.path.split("/").at(-1)}`, `${dayText(pending.after.startMs)}, ${timeText(pending.after.startMs)}–${timeText(pending.after.endMs)} (${timeZone})`, "Open the file afterwards to add it to any calendar."], confirmLabel: "Save file" });
  const add = () => {
    // A calendar event named "Untitled meeting" helps nobody: ask for the name first.
    if (untitled) { setNeedsTitle(true); focusVisibleTitle(); return; }
    if (!calendar) { setNoCalendar(true); return; }
    remember(calendar.id); void cal.propose(calendar);
  };
  const dated = plan.startMs !== undefined && plan.endMs !== undefined;

  if (state === "fromCalendar") return null;
  return <>
    <div className="when-footer">
      <div className="when-calendar" role="status"><PlanCalendarStatus plan={plan} />{dated && !plan.calendarSync && <button className="link-button" onClick={() => c.setup.setSchedule(undefined)}>Clear date</button>}</div>
      {state === "notSaved" && <div className="when-actions">
        {writable.length > 1 && <label className="when-calendar-choice"><span className="visually-hidden">Calendar</span><select value={calendar?.id} onChange={(e) => { setChosen(e.target.value); remember(e.target.value); }}>{writable.map((w) => <option key={w.id} value={w.id}>{calendarLabel(w)}</option>)}</select></label>}
        {writable.length === 1 && <span className="muted">{calendarLabel(writable[0])}</span>}
        <button disabled={cal.busy} onClick={add}><CalendarPlus size={16} />Add to calendar</button>
      </div>}
      {state === "changed" && plan.calendarSync && <div className="when-actions"><button disabled={cal.busy} onClick={() => void cal.propose({ id: plan.calendarSync!.calendarId, name: plan.calendarSync!.calendarName, account: "" })}><RefreshCw size={16} />Update calendar event</button></div>}
    </div>
    {needsTitle && <p className="calendar-error" role="alert">Give the meeting a title first. It is the name your calendar shows.</p>}
    {cal.error && <p className="calendar-error" role="alert">{cal.error}</p>}
    {sheet && <CalendarConfirmSheet heading={sheet.heading} lines={sheet.lines} confirmLabel={sheet.confirmLabel} busy={cal.busy} onConfirm={() => void cal.confirm()} onCancel={cal.cancel} />}
    {noCalendar && !sheet && <CalendarConfirmSheet heading="Connect a calendar first"
      lines={["No calendar on this Mac is connected yet, so there is nowhere to add the meeting.", "Connect your calendars once and every meeting can be added in one click. Or save a calendar file and open it in any calendar app."]}
      confirmLabel="Connect calendars" onConfirm={() => { setNoCalendar(false); navigate({ kind: "settings", section: "calendars" }); }}
      secondary={{ label: "Save .ics file", onClick: () => { setNoCalendar(false); void cal.proposeIcs(); } }}
      onCancel={() => setNoCalendar(false)} />}
  </>;
}
