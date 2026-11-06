import { useMemo, useState } from "react";
import { processingClass, processingLabel, processingState } from "../presentation/processing";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ArrowRight, Plus, RotateCcw, RefreshCw, Search } from "lucide-react";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation, MeetingsView, UpcomingMeeting } from "../presentation/types";
import { filterAgenda } from "../presentation/agenda";
import { MeetingDetails } from "./MeetingDetails";
import { PageHeading, EmptyState, dayText, timeText, IconButton } from "../ui";
import { CalendarView } from "../calendar/CalendarView";
import { TodayView } from "../calendar/TodayView";
import { CalendarSetupNotice } from "../calendar/CalendarSetupNotice";
import { calendarConnection } from "../calendar/connection";
import { periodRange } from "../calendar/layout";
import { useNow } from "../calendar/useNow";
import { SetupPill } from "../SetupPill";
import type { Setup } from "../useSetup";
import { SpeechWarmupNotice } from "../SpeechWarmupNotice";
import { appOnlyPlanRows, isPlanRow } from "../../lib/public/calendarSave";
import { NewMeetingPopover } from "../calendar/NewMeetingPopover";
import type { PublicMeetingPlan } from "@live-interview/core";

type Layout = "today" | "week" | "month";

// Two views only: what is coming up (Today, Week or Month) and what is saved. Today is the default because it answers
// "what do I need to prepare next" without reading a grid; `upcoming` is Today and `calendar` is Week/Month.
export function MeetingsPage({ controller: c, view, navigate, openEvent, startEvent, openRecord, setup, onPlanCreated }: { controller: CopilotController; view: MeetingsView; navigate: (location: AppLocation) => void; openEvent: (event: UpcomingMeeting) => void; startEvent: (event: UpcomingMeeting) => void; openRecord: (id: string) => void; setup: Setup; onPlanCreated?: (plan: PublicMeetingPlan) => void }) {
  const [period, setPeriod] = useState<"week" | "month">("week");
  // Follows the clock (and re-renders the heading's date) past midnight.
  const date = new Date(useNow());
  const [shownRange, setShownRange] = useState<{ startMs: number; endMs: number }>();
  const [rechecking, setRechecking] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const layout: Layout = view === "calendar" ? period : "today";
  const setLayout = (next: Layout) => { if (next === "today") navigate({ kind: "meetings", view: "upcoming" }); else { setPeriod(next); navigate({ kind: "meetings", view: "calendar" }); } };
  // Today and Week/Month load their own range (TodayView, CalendarView); the footer Refresh reloads the one shown.
  const refreshRange = shownRange ?? periodRange(layout, date);
  // Meetings made in the app show beside calendar events until a calendar event stands for them.
  const now = Date.now();
  // The same array until the calendar, the plans or the minute changes, so TodayView's and CalendarView's memos hold.
  const minute = date.getTime();
  const { planRows, visible } = useMemo(() => {
    const planRows = c.publicProduct.enabled ? appOnlyPlanRows(c.publicProduct.plans, new Set(c.upcoming.map((e) => e.id)), minute) : [];
    return { planRows, visible: [...c.upcoming, ...planRows] as UpcomingMeeting[] };
  }, [c.upcoming, c.publicProduct.plans, c.publicProduct.enabled, minute]);
  const openPlanRow = (id: string) => { const planId = id.slice("plan:".length); void c.publicProduct.openPlan(planId); navigate({ kind: "meeting", id: planId, preparationOpen: false, artifact: "overview" }); };
  const open = (e: UpcomingMeeting) => isPlanRow(e.id) ? openPlanRow(e.id) : openEvent(e);
  const allAhead = [...c.upcoming].sort((a, b) => a.startMs - b.startMs).filter((e) => e.endMs >= now);
  const next = allAhead[0];
  const calendarSettings = () => navigate({ kind: "settings", section: "calendars" });
  const pp = c.publicProduct;
  // One notice for "there is nothing to read" (no account, macOS access off, no calendar chosen); the views stay plain.
  const connection = calendarConnection({ enabled: pp.enabled, accountsLoaded: pp.accountsLoaded, accounts: pp.accounts, rangeError: pp.rangeError, calendarRange: c.calendarRange });
  const openCalendarPrivacy = () => { void invoke("open_privacy_settings", { pane: "calendars" }).catch(() => pp.setMessage("Open System Settings → Privacy & Security → Calendars and turn on Live Interview.")); };
  const checkCalendarAccess = async () => {
    setRechecking(true);
    try { await pp.refreshAccounts().catch(() => {}); await pp.loadRange(refreshRange.startMs, refreshRange.endMs); } finally { setRechecking(false); }
  };
  const newMeeting = () => { if (c.publicProduct.enabled) void c.publicProduct.newPlan(); navigate({ kind: "meeting", id: "setup", preparationOpen: false, artifact: "overview" }); };
  // On the Calendar, New meeting stays here: the popover creates the in-app plan and the app shows a notification.
  const createQuick = async (meeting: { title: string; startMs: number; endMs: number }) => {
    const plan = await c.publicProduct.newPlan(undefined, meeting);
    if (plan) onPlanCreated?.(plan);
    return !!plan;
  };
  const busy = !!c.activeMeeting;
  // Plans not shown on the calendar at all: undated drafts and plans whose time has passed without a loaded event.
  const onCalendar = new Set(planRows.map((row) => row.planId));
  const plans = c.publicProduct.enabled ? filterAgenda(c.publicProduct.plans.filter((plan) => !onCalendar.has(plan.id) && (!plan.eventId || !c.upcoming.some((e) => e.id === plan.eventId))).map((plan) => ({ ...plan, title: plan.title || "Untitled meeting" })), query) : [];
  // The details panel shows only beside Today on wide windows; elsewhere a click opens the meeting straight away.
  const selected = allAhead.find((e) => e.id === selectedId) ?? next;
  const panelShown = () => window.matchMedia("(min-width: 1101px)").matches;
  const pick = (e: UpcomingMeeting) => { if (panelShown() && !isPlanRow(e.id)) setSelectedId(e.id); else open(e); };
  const planFor = (id: string) => c.publicProduct.plans.find((p) => p.eventId === id);
  // Launch recovery is already processing a meeting the app closed during; Retry stays for everything else.
  const pending = (r: (typeof c.records)[number]) => processingState(r) === "pending" && r.recovery?.state !== "recovering";
  const search = query.trim().toLocaleLowerCase();
  const records = c.records.filter((r) => !search || r.purpose.toLocaleLowerCase().includes(search));

  const layoutControl = <div className="segmented-control" role="group" aria-label="Layout">{(["today", "week", "month"] as const).map((p) => <button key={p} className={layout === p ? "selected" : ""} aria-pressed={layout === p} onClick={() => setLayout(p)}>{p === "today" ? "Today" : p === "week" ? "Week" : "Month"}</button>)}</div>;
  return <div className="screen-frame">
    <PageHeading leading={view !== "past" ? <div className="date-tile heading-date" aria-hidden="true"><span>{new Date(now).toLocaleDateString(undefined, { weekday: "short" })}</span><strong>{new Date(now).getDate()}</strong></div> : undefined} title={view === "past" ? "Archive" : "Calendar"} subtitle={view === "past" ? `${c.records.length} saved on this Mac` : new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} actions={<>{view !== "past" && layoutControl}<label className="search-field"><Search size={15} aria-hidden /><span className="visually-hidden">{view === "past" ? "Search saved meetings" : "Search meetings"}</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" /></label><SetupPill setup={setup} meetingActive={busy} onOpen={() => navigate({ kind: "settings", section: "setup" })} />{view !== "past" && c.publicProduct.enabled ? <NewMeetingPopover disabled={busy} busy={visible} shown={{ ...refreshRange, layout }} onCreate={createQuick} /> : <button className="primary" onClick={newMeeting} disabled={busy}><Plus size={16} />New meeting</button>}</>} />
    <div className="page-body">
      <SpeechWarmupNotice status={c.speechStatus} onRetry={c.retrySpeech} />
      {view !== "past" && <>
        <CalendarSetupNotice connection={connection} onConnect={calendarSettings} onChooseCalendars={calendarSettings} onOpenPrivacy={openCalendarPrivacy} onCheckAgain={() => void checkCalendarAccess()} checking={rechecking} />
        <div className={"calendar-columns" + (layout === "today" && selected ? " with-details" : "")}><div className="calendar-main">
        {layout === "today" ? <TodayView c={c} upcoming={visible} busy={busy} query={query} selectedId={selected?.id} onOpen={open} onPick={pick} onStart={startEvent} onShowWeek={() => setLayout("week")} onManageCalendars={calendarSettings} onRangeChange={setShownRange} />
          : <CalendarView c={c} mode={layout} upcoming={visible} busy={busy} query={query} onOpen={open} onPick={pick} onRangeChange={setShownRange} onModeChange={setPeriod} />}
        {plans.length > 0 && <section className="public-saved-plans"><h2>Drafts and saved plans</h2>{plans.map(plan => <button className="agenda-row" key={plan.id} disabled={busy} onClick={() => { void c.publicProduct.openPlan(plan.id); navigate({ kind: "meeting", id: plan.id, preparationOpen: false, artifact: "overview" }); }}><span className="agenda-time">{plan.startMs ? timeText(plan.startMs) : "Draft"}<small>{plan.startMs ? dayText(plan.startMs) : "Manual"}</small></span><span className="agenda-title">{plan.title || "Untitled meeting"}<small>{plan.status}{plan.automaticPreparation ? " · Automatic prep enabled" : ""}</small></span><ArrowRight size={16} aria-hidden /></button>)}</section>}
        <footer className="calendar-footer">
          {c.publicProduct.enabled && <div className="calendar-sources" role="group" aria-label="Calendar sources">{c.publicProduct.coverage.map((row, i) => <span className={"public-coverage " + row.status} key={i}>{c.publicProduct.accounts.find(a => a.id === row.accountId)?.name || row.accountId} · {row.status}{row.refreshedAtMs ? " · " + timeText(row.refreshedAtMs) : ""}{row.code ? " · " + row.code : ""}</span>)}<IconButton icon={RefreshCw} label={`Refresh calendars for ${dayText(refreshRange.startMs)} – ${dayText(refreshRange.endMs)}`} onClick={() => void c.publicProduct.loadRange(refreshRange.startMs, refreshRange.endMs)} /></div>}
          <button className="link-button" onClick={calendarSettings}>Manage calendars <ArrowRight size={15} /></button>
        </footer>
        </div>{layout === "today" && selected && <MeetingDetails event={selected} plan={planFor(selected.id)} calendarEvent={c.publicProduct.calendarEvents.find((e) => e.id === selected.id)} records={c.records} workspaceName={c.publicProduct.workspaces.find((w) => w.id === planFor(selected.id)?.workspaceId)?.name} disabled={busy} onOpen={() => openEvent(selected)} />}</div>
      </>}
      {view === "past" && <>
        <div className="calendar-toolbar"><div><h2 className="toolbar-title">Saved meetings</h2></div></div>
        {c.records.length ? (records.length ? <div className="record-table"><div className="record-table-heading"><span>Meeting</span><span>Date</span><span>Processing</span><span>Actions</span></div>{records.map((r) => <div className="record-row" key={r.id}><strong>{r.purpose}</strong><span>{dayText(r.date)}</span><span className={processingClass[processingState(r)]}>{r.recovery?.state === "recovering" ? "Recovering" : processingLabel[processingState(r)]}</span><div>{pending(r) && <button disabled={busy} onClick={() => void c.recover(r.id)}><RotateCcw size={15} />Retry processing</button>}<button disabled={busy} onClick={() => openRecord(r.id)}>Open <ArrowRight size={15} /></button></div></div>)}</div> : <p className="muted">No saved meeting matches “{query.trim()}”.</p>) : <EmptyState title="Your saved meetings will appear here" action={<button onClick={newMeeting} disabled={busy}><CalendarDays size={18} />Start a meeting</button>}>Records stay on this Mac. Source text remains available while local recognition or translation is pending.</EmptyState>}
      </>}
    </div>
  </div>;
}
