// The meeting page's day panel with real data: the shown day's calendar events and in-app plans, loading the day when
// it is not loaded, and the page's answer to each change. A plan only in this app is saved directly, with an instant
// Undo; a calendar event is moved only through the reviewed path (`calendarMove`, the app-owned action executor), and
// its Undo is the reverse move, reviewed again. The pure parts are in lib/public/dayPanelMeetings.ts.
import { useEffect, useRef, useState } from "react";
import type { PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import type { CopilotController } from "./useCopilotController";
import type { PublicProduct } from "../lib/public/usePublicProduct";
import type { AppLocation } from "./presentation/types";
import type { ActionNotice } from "./ui";
import { timeText } from "./ui";
import { MeetingDayPanel } from "./MeetingDayPanel";
import { PlanCalendarRow } from "./PlanWhenSection";
import { calendarConnection, nothingToRead } from "./calendar/connection";
import { dayCoverage, rangeStatus } from "./calendar/coverage";
import { INVITATION_MOVE_WARNING, calendarLabel, lengthText, withLength } from "../lib/public/calendarSave";
import { rangeText, type DayPanelMeeting, type TimeRange } from "../lib/public/dayEdit";
import { dayLoadRange, dayPanelMeetings, eventMovability, movedText, pendingForPanel, planMovability, planRowId, routeProposal } from "../lib/public/dayPanelMeetings";

/**
 * A passing confirmation with Undo, shown by the app's toast stack and announced there. `spoken` replaces the
 * announcement when the panel has already said the move itself.
 */
export type DayPanelNotice = ActionNotice & { action: () => void; spoken?: string };
const UNDO_SPOKEN = "Undo is in the notification.";

const LENGTHS = [15, 30, 45, 60];
const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const longDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const meetingLocation = (id: string): AppLocation => ({ kind: "meeting", id, preparationOpen: false, artifact: "overview" });
/** What `showDay()` focuses: this meeting on the timeline, or the day's date when it is not on the shown day. */
export const dayPanelFocusTarget = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>(".dp-meeting.is-this") ?? root?.querySelector<HTMLElement>(".dp-date") ?? undefined;

/** True while the element is on screen (not inside a hidden page). The page can be mounted while hidden. */
function useShown<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setShown(el.getClientRects().length > 0);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, shown] as const;
}

export interface DayPanelActionDeps {
  meetings: DayPanelMeeting[];
  events: PublicCalendarEvent[];
  current?: PublicMeetingPlan;
  untimedMeetingId?: string;
  /** The open plan's times (`c.setup.setSchedule`). */
  setSchedule: (range?: TimeRange) => void;
  /** Another in-app plan's times. */
  setPlanTimes: (planId: string, range: TimeRange) => Promise<boolean>;
  /** The plan open when it is called (not when the actions were built), so a late Undo edits the plan it moved. */
  openPlanId?: () => string | undefined;
  calendarMove: Pick<PublicProduct["calendarMove"], "pending" | "propose" | "proposeRevert" | "confirm" | "clearError">;
  setMessage: (message: string) => void;
  openPlan: (planId: string) => Promise<unknown> | void;
  selectUpcoming: (event: PublicCalendarEvent) => void;
  navigate: (location: AppLocation) => void;
  onNotice?: (notice: DayPanelNotice) => void;
  setNotice: (notice: string | undefined) => void;
  /** Lets the panel drop its own review card when a calendar move could not even be prepared. */
  setReleased: (pending: { meetingId: string; startMs: number; endMs: number }) => void;
  setDay: (dayMs: number) => void;
}

/**
 * The page's answers to the panel. `propose`: a plan only in this app is saved at once with an instant Undo; a calendar
 * event is prepared for review (nothing written). `confirm`: applies the reviewed move and offers Undo, which reopens
 * the review card with the reverse move. `open`: another meeting's plan.
 */
export function dayPanelActions(d: DayPanelActionDeps) {
  const stamp = () => "move:" + Date.now() + ":" + Math.random().toString(36).slice(2, 6);
  const propose = (meetingId: string, range: TimeRange, meetings: DayPanelMeeting[] = d.meetings) => {
    d.setNotice(undefined);
    d.calendarMove.clearError();
    const route = routeProposal(meetingId, range, { meetings, events: d.events, current: d.current, untimedMeetingId: d.untimedMeetingId });
    if (route.kind === "refused") { d.setNotice(route.reason); return; }
    if (route.kind === "thisPlan") {
      d.setSchedule(route.range);
      const before = route.before;
      const movedPlanId = d.current?.id;
      const undo = () => {
        const openNow = d.openPlanId ? d.openPlanId() : movedPlanId;
        if (!movedPlanId || openNow === movedPlanId) d.setSchedule(before);
        else void d.setPlanTimes(movedPlanId, before!);
      };
      if (before) d.onNotice?.({ id: stamp(), text: `Moved “${route.title}”`, detail: rangeText(route.range), actionLabel: "Undo", spoken: UNDO_SPOKEN, action: undo });
      return;
    }
    if (route.kind === "otherPlan") {
      const { planId, before, title } = route;
      return d.setPlanTimes(planId, route.range).then((ok) => {
        if (!ok) { d.setNotice("The meeting could not be saved. Nothing was changed."); return; }
        d.onNotice?.({ id: stamp(), text: `Moved “${title}”`, detail: rangeText(route.range), actionLabel: "Undo", spoken: UNDO_SPOKEN, action: () => { void d.setPlanTimes(planId, before); } });
      });
    }
    return d.calendarMove.propose(route.event, route.range).then((pending) => { if (!pending) d.setReleased({ meetingId, ...range }); });
  };
  const confirm = async () => {
    if (!d.calendarMove.pending) return;
    const done = await d.calendarMove.confirm();
    if (!done) return;
    // The toast says it, with Undo; the plain message would say it twice.
    d.setMessage("");
    d.onNotice?.({ id: stamp(), text: movedText(done.calendarName, done.revert), detail: `${done.title} · ${rangeText(done.after)}`, actionLabel: "Undo",
      action: () => { d.setDay(startOfDay(done.before.startMs)); void d.calendarMove.proposeRevert(done); } });
  };
  const open = (meeting: DayPanelMeeting) => {
    if (meeting.planId && meeting.planId === d.current?.id) return;
    if (meeting.planId) { void d.openPlan(meeting.planId); d.navigate(meetingLocation(meeting.planId)); return; }
    const event = d.events.find((e) => e.id === (meeting.eventId ?? meeting.id));
    if (!event) return;
    d.selectUpcoming(event);
    d.navigate(meetingLocation(event.id));
  };
  return { propose, confirm, open };
}

export function PlanDayPanel({ controller: c, navigate, onNotice }: { controller: CopilotController; navigate: (location: AppLocation) => void; onNotice?: (notice: DayPanelNotice) => void }) {
  const p = c.publicProduct;
  const plan = p.current;
  const move = p.calendarMove;
  const planDay = plan?.startMs !== undefined ? startOfDay(plan.startMs) : undefined;
  const [day, setDay] = useState(() => planDay ?? startOfDay(Date.now()));
  const [notice, setNotice] = useState<string>();
  // A calendar move that could not even be prepared: handed to the panel for one render so it lets go of its own card.
  const [released, setReleased] = useState<{ meetingId: string; startMs: number; endMs: number }>();
  const [loadingDay, setLoadingDay] = useState(false);
  const [box, shown] = useShown<HTMLDivElement>();

  // Another meeting opened, or this one moved to another day: show its day.
  useEffect(() => { setDay(planDay ?? startOfDay(Date.now())); }, [plan?.id, planDay]);
  useEffect(() => { setNotice(undefined); move.clearError(); }, [plan?.id]);
  useEffect(() => { if (released) setReleased(undefined); }, [released]);

  const connection = calendarConnection({ enabled: p.enabled, accountsLoaded: p.accountsLoaded, accounts: p.accounts, rangeError: p.rangeError, calendarRange: c.calendarRange });
  const quiet = nothingToRead(connection);
  const toLoad = dayLoadRange(day, p.range);
  // Load the shown day when it is not in the loaded range (only while the panel is on screen). The loaded range is
  // widened, not replaced, so the Calendar keeps what it showed.
  useEffect(() => {
    if (!shown || quiet || connection.kind === "checking" || !toLoad) return;
    setLoadingDay(true);
    void Promise.resolve(p.loadRange(toLoad.startMs, toLoad.endMs)).finally(() => setLoadingDay(false));
  }, [shown, quiet, connection.kind, toLoad?.startMs, toLoad?.endMs]);
  const retry = () => {
    const r = p.range && p.range.startMs <= day && p.range.endMs > day ? p.range : dayLoadRange(day);
    if (!r) return;
    setLoadingDay(true);
    void Promise.resolve(p.loadRange(r.startMs, r.endMs)).finally(() => setLoadingDay(false));
  };
  const coverage = dayCoverage(new Date(day), { enabled: true, coverage: p.coverage, loading: loadingDay || (!!toLoad && !quiet) || connection.kind === "checking", nothingToRead: quiet });
  const dayEnd = new Date(new Date(day).getFullYear(), new Date(day).getMonth(), new Date(day).getDate() + 1).getTime();
  const accountName = (id: string) => p.accounts.find((a) => a.id === id)?.name || id;
  const status = rangeStatus(p.coverage.filter((row) => row.startMs < dayEnd && row.endMs > day), accountName);

  const calendarName = (id: string) => { const w = p.calendarSave.writable?.find((x) => x.id === id); return w ? calendarLabel(w) : undefined; };
  const pendingMove = move.pending ? { eventId: move.pending.eventId, calendarName: move.pending.calendarName, invitation: move.pending.invitation } : undefined;
  const build = (onDayMs: number) => dayPanelMeetings({ day: onDayMs, events: p.calendarEvents, plans: p.plans, current: plan, calendarName, pendingMove });
  const meetings = build(day);
  const untimedMeetingId = plan && plan.startMs === undefined && !plan.eventId ? planRowId(plan.id) : undefined;

  const openPlanRef = useRef(plan?.id);
  openPlanRef.current = plan?.id;
  const { propose, confirm, open } = dayPanelActions({
    meetings, events: p.calendarEvents, current: plan, untimedMeetingId, openPlanId: () => openPlanRef.current,
    setSchedule: c.setup.setSchedule, setPlanTimes: p.setPlanTimes, calendarMove: move, setMessage: p.setMessage,
    openPlan: p.openPlan, selectUpcoming: c.selectUpcoming, navigate, onNotice, setNotice, setReleased, setDay,
  });

  // The footer: this meeting's time, its length (when it can change) and the calendar row.
  const dated = plan?.startMs !== undefined && plan.endMs !== undefined;
  const thisEvent = plan?.eventId ? p.calendarEvents.find((e) => e.id === plan.eventId) : undefined;
  const thisMovability = !plan ? undefined : thisEvent ? eventMovability(thisEvent, { appCreated: !!plan.calendarSync }) : planMovability(plan);
  const thisRowId = plan && (thisEvent ? thisEvent.id : planRowId(plan.id));
  const setLength = (minutes: number) => {
    if (!plan || !dated || !thisRowId) return;
    const range = withLength({ startMs: plan.startMs! }, minutes);
    if (range.endMs === plan.endMs) return;
    const list = planDay === day ? meetings : build(plan.startMs!);
    if (planDay !== undefined) setDay(planDay);
    void propose(thisRowId, range, list);
  };

  return <div ref={box} className="plan-day-panel">
    {/* Mounted again when it comes on screen, so the timeline scrolls to this meeting (it cannot scroll while hidden). */}
    <MeetingDayPanel key={shown ? "shown" : "hidden"} day={day} meetings={meetings} coverage={coverage} partialAccounts={status.kind === "partial" ? status.accounts : undefined}
      pending={pendingForPanel(move.pending) ?? released} confirming={move.busy && !!move.pending} notice={notice || move.error || undefined}
      invitationWarning={INVITATION_MOVE_WARNING} untimedMeetingId={untimedMeetingId}
      onDayChange={(d) => { setDay(startOfDay(d)); setNotice(undefined); move.clearError(); }}
      onPropose={(id, range) => void propose(id, range)} onConfirm={() => void confirm()} onCancel={() => move.cancel()} onOpen={open}
      onRetry={retry} onConnectCalendar={() => navigate({ kind: "settings", section: "calendars" })}>
      <div className="when-summary dp-when-summary">
        {dated ? <><strong>{longDay(plan!.startMs!)} · {timeText(plan!.startMs!)}–{timeText(plan!.endMs!)}</strong><span className="muted">{lengthText(plan!.startMs!, plan!.endMs!)}</span></>
          : <span className="muted">{plan?.eventId ? "Time set by your calendar" : "No time yet"}</span>}
        {dated && thisMovability && thisMovability.kind !== "readOnly" && <div className="length-choices segmented-control" role="group" aria-label="Length">{LENGTHS.map((m) =>
          <button type="button" key={m} aria-pressed={plan!.endMs! - plan!.startMs! === m * 60_000} disabled={move.busy || !!move.pending} onClick={() => setLength(m)}>{m < 60 ? `${m} min` : "1 h"}</button>)}</div>}
      </div>
      <PlanCalendarRow controller={c} navigate={navigate} />
    </MeetingDayPanel>
  </div>;
}
