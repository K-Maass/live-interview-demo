import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, Check, Circle, Sparkles, Video, X } from "lucide-react";
import { meetingProfiles } from "@live-interview/core";
import { native } from "../../lib/localVoice";
import { lengthText } from "../../lib/public/calendarSave";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation } from "../presentation/types";
import { detectionStatusText } from "../presentation/model";
import { StubPanel, Avatar, IconButton, timeText } from "../ui";
import { PublicSourceSelection } from "../PublicSourceSelection";
import { PeoplePicker } from "../PeoplePicker";
import { SpeechWarmupNotice } from "../SpeechWarmupNotice";
import { PlanCalendarStatus } from "../PlanWhenSection";
import { PlanDayPanel, dayPanelFocusTarget, type DayPanelNotice } from "../PlanDayPanel";
import { PremiumCard, Switch } from "../PremiumCard";
import { NeedsSubscription, PublicPreparationEditor, briefActions } from "./PublicPreparationEditor";
import { openJoinUrl } from "../calendar/JoinButton";
import { useNow } from "../calendar/useNow";

// A plan always has a title; this placeholder name is shown as an empty field so it is never mistaken for a real one.
const UNTITLED = "Untitled meeting";
/** At this width and wider the day panel sits beside the page; narrower it opens as a drawer from "Show day". */
export const DAY_PANEL_BESIDE = "(min-width: 1100px)";

const shortDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function useMediaQuery(query: string, fallback = true) {
  const get = () => (typeof window === "undefined" || !window.matchMedia ? fallback : window.matchMedia(query).matches);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

/**
 * The meeting title, edited in place in the header (there is no separate Title field). Every change is saved as it is
 * typed, like the rest of the plan; an emptied title saves as "Untitled meeting" and shows as an empty field.
 * Enter or Escape finish editing. Hook-free so its saving can be checked without a DOM.
 */
export function MeetingTitle({ value, onChange }: { value: string; onChange: (title: string) => void }) {
  return <h1 className="meeting-title">
    <input className="meeting-title-input" aria-label="Meeting title" value={value === UNTITLED ? "" : value}
      placeholder="Name this meeting" onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
  </h1>;
}

/** The plain-words conditions for starting the recording when the Teams call begins. Each one is met or not. */
export function teamsAutoStartConditions({ hasBrief, title, armed, armedUntil }: { hasBrief: boolean; title: string; armed: boolean; armedUntil: number }) {
  const titled = !!title.trim() && title !== UNTITLED;
  return {
    ready: hasBrief && titled,
    conditions: [
      { met: hasBrief, text: hasBrief ? "A brief is in use for live assistance" : "Needs a brief in use (see Brief above)" },
      { met: titled, text: titled ? `The Teams call is titled “${title.trim()}”, matching exactly` : "Needs a meeting title that matches the Teams call" },
    ],
    duration: armed ? `On until ${timeText(armedUntil)}, then it turns itself off.` : "Stays on for one hour after you turn it on.",
  };
}

/** Objectives as rows: Enter adds the next row, Backspace in an empty row removes it, × appears on hover and focus. */
function ObjectivesEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = value.split("\n");
  const box = useRef<HTMLDivElement>(null);
  const [focusRow, setFocusRow] = useState<number>();
  useEffect(() => {
    if (focusRow === undefined) return;
    const input = box.current?.querySelectorAll("input")[focusRow];
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    setFocusRow(undefined);
  }, [focusRow, value]);
  const set = (next: string[]) => onChange(next.join("\n"));
  const key = (i: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); set([...rows.slice(0, i + 1), "", ...rows.slice(i + 1)]); setFocusRow(i + 1); }
    else if (event.key === "Backspace" && !rows[i] && rows.length > 1) { event.preventDefault(); set(rows.filter((_, n) => n !== i)); setFocusRow(Math.max(0, i - 1)); }
  };
  return <div className="objective-editor" ref={box}>
    {rows.map((text, i) => <div className="objective-row" key={i}>
      <span className="objective-bullet" aria-hidden />
      <input aria-label={"Objective " + (i + 1)} value={text} placeholder={i === 0 ? "What do you want to understand?" : "Another objective"} onChange={(e) => set(rows.map((v, n) => n === i ? e.target.value : v))} onKeyDown={key(i)} />
      <button type="button" className="icon-button objective-remove" aria-label={"Remove objective " + (i + 1)} onClick={() => { set(rows.length > 1 ? rows.filter((_, n) => n !== i) : [""]); setFocusRow(Math.max(0, i - 1)); }}><X size={15} aria-hidden /></button>
    </div>)}
    <p className="field-hint">Press Return for another objective.</p>
  </div>;
}

function Card({ title, status, className = "", children }: { title: ReactNode; status?: ReactNode; className?: string; children: ReactNode }) {
  const headingId = useId();
  return <section className={"meeting-card " + className} aria-labelledby={headingId}>
    <div className="card-heading"><h2 id={headingId}>{title}</h2>{status}</div>
    {children}
  </section>;
}

/**
 * The Brief card: a preview, and the editor opened in place. `focusRequest` (the Preparation route) opens the editor
 * and scrolls to the card each time the page becomes visible; the page can be mounted while hidden, so it waits for
 * the card to have a size.
 */
function BriefCard({ controller: c, prepare, navigate, focusRequest }: { controller: CopilotController; prepare: () => void; navigate: (location: AppLocation) => void; focusRequest?: boolean }) {
  const p = c.publicProduct;
  const plan = p.current;
  const [open, setOpen] = useState(!!focusRequest);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = card.current;
    if (!focusRequest || !el || typeof ResizeObserver === "undefined") return;
    let shown = false;
    const observer = new ResizeObserver(() => {
      const visible = el.offsetParent !== null;
      if (visible && !shown) { setOpen(true); requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: "smooth" })); }
      shown = visible;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [focusRequest]);
  const seePlans = () => navigate({ kind: "settings", section: "account" });
  if (!p.enabled) return <div ref={card}><Card title="Brief" className="brief-card" status={<span className={"card-status-inline" + (c.setup.brief ? " is-good" : "")}>{c.setup.brief ? "Ready" : "Optional"}</span>}>
    <p className="muted">{c.setup.brief ? "Live assistance uses it alongside your sources and the conversation." : "Draft a short brief from your sources and objectives. Live assistance also works without one."}</p>
    <div className="card-actions"><button type="button" onClick={prepare}><Sparkles size={16} aria-hidden />{c.setup.brief ? "Open brief" : "Prepare a brief"}</button></div>
  </Card></div>;
  if (!plan) return null;
  const actions = briefActions(plan, p.account, p.preparing || p.loading);
  const draft = plan.briefDraft.trim();
  const status = actions.inUse ? <span className="card-status-inline is-good">In use for live assistance</span>
    : draft ? <span className="card-status-inline">{plan.draftEvidence?.length ? "AI draft · not in use yet" : "Draft · not in use yet"}</span>
    : <span className="card-status-inline">Optional</span>;
  return <div ref={card} className="brief-card-anchor"><Card title="Brief" className={"brief-card" + (open ? " is-editing" : "")} status={status}>
    {open ? <PublicPreparationEditor key={plan.id} controller={c} onClose={() => setOpen(false)} onSeePlans={seePlans} autoFocus /> : <>
      {draft ? <p className="brief-preview">{draft}</p> : <p className="muted brief-empty">No brief yet. Live assistance works without one, from your context and the conversation.</p>}
      <div className="card-actions">
        <button type="button" onClick={() => setOpen(true)}>{draft ? "Edit brief" : "Write a brief"}</button>
        {actions.needsSubscription ? <NeedsSubscription onSeePlans={seePlans} />
          : <button type="button" disabled={!actions.canDraftWithAI} onClick={() => { setOpen(true); void p.prepare(""); }}><Sparkles size={16} aria-hidden />{p.preparing ? "Preparing…" : actions.aiLabel}</button>}
      </div>
    </>}
  </Card></div>;
}

/** Recording: microphone, keeping audio, speech readiness and the Teams auto-start with its conditions spelled out. */
function RecordingCard({ controller: c, navigate }: { controller: CopilotController; navigate: (location: AppLocation) => void }) {
  const setup = c.setup;
  const id = useId();
  const teams = teamsAutoStartConditions({ hasBrief: !!setup.brief, title: setup.purpose, armed: c.entry.armed, armedUntil: c.entry.armedUntil });
  const recognition = !!c.ready?.recognitionReady;
  const translation = !!c.ready?.translationReady;
  return <Card title="Recording" className="recording-card">
    <SpeechWarmupNotice status={c.speechStatus} onRetry={c.retrySpeech} />
    <label className="field">Microphone<select value={setup.inputDevice} onChange={(e) => setup.setInputDevice(e.target.value)}><option value="">System default input</option>{c.inputDevices.map((name) => <option key={name}>{name}</option>)}</select>{c.inputDeviceAvailability !== "ready" && <small>{c.inputDeviceAvailability === "loading" ? "Loading input names…" : "Input names unavailable or pending. System default remains available."}</small>}</label>
    <Switch id={id + "keep"} label="Keep the local audio after the meeting is saved" checked={setup.retain} onChange={(e) => setup.setRetain(e.target.checked)} />
    <div className="readiness-lines">
      <span className={recognition ? "is-good" : "is-bad"}>{recognition ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}{recognition ? "Recognition ready" : "Recognition setup required"}</span>
      <span className={translation ? "is-good" : ""}>{translation ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}{translation ? "Translation ready" : "Translation setup pending"}</span>
      <button type="button" className="link-button" onClick={() => navigate({ kind: "settings", section: "speech" })}>Local speech settings <ArrowRight size={14} aria-hidden /></button>
    </div>
    <div className="teams-auto-start">
      <Switch id={id + "teams"} label="Start recording when this Teams call begins" detail={teams.duration} checked={c.entry.armed} disabled={!c.entry.armed && !teams.ready} onChange={(e) => c.entry.arm(e.target.checked)} />
      <ul className="condition-list" aria-label="Conditions for starting automatically">
        {teams.conditions.map((condition) => <li key={condition.text} className={condition.met ? "is-met" : ""}>{condition.met ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}<span>{condition.text}</span></li>)}
      </ul>
      <p className="muted">Calendar timing alone never starts capture; unprepared calls ask first. {detectionStatusText(c.entry.detectionStatus)}.</p>
      {!c.publicProduct.enabled && <StubPanel title="Automatic Zoom detection" description="Not implemented." />}
    </div>
  </Card>;
}

/**
 * The day slot. Beside the page from 1100 px; narrower it is a drawer opened from "Show day" (the Calendar's day
 * drawer style). It holds the day panel (`PlanDayPanel`): every meeting that day, any movable one draggable, with this
 * meeting's time, length and calendar row as its footer. Without the public product only the end time is known.
 */
function MeetingDaySlot({ controller: c, navigate, beside, open, onClose, onNotice }: { controller: CopilotController; navigate: (location: AppLocation) => void; beside: boolean; open: boolean; onClose: () => void; onNotice?: (notice: DayPanelNotice) => void }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!beside && open) heading.current?.focus(); }, [beside, open]);
  useEffect(() => {
    if (beside || !open) return;
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [beside, open]);
  const content = c.publicProduct.enabled ? <PlanDayPanel controller={c} navigate={navigate} onNotice={onNotice} />
    : <p className="muted">{c.setup.scheduledEndMs ? "Ends " + timeText(c.setup.scheduledEndMs) : "No time set"}</p>;
  const panel = c.publicProduct.enabled ? " has-day-panel" : "";
  if (beside) return <aside className={"meeting-day-slot" + panel} data-slot="meeting-day-panel" aria-labelledby={titleId}>
    <h2 id={titleId} className="visually-hidden" tabIndex={-1} ref={heading}>Day</h2>
    {content}
  </aside>;
  if (!open) return null;
  return <aside className={"guidance-drawer meeting-day-drawer" + panel} data-slot="meeting-day-panel" role="dialog" aria-modal="false" aria-labelledby={titleId}>
    <div className="drawer-heading">
      <h2 id={titleId} tabIndex={-1} ref={heading}>Day</h2>
      <IconButton icon={X} label="Close day" onClick={onClose} />
    </div>
    {content}
  </aside>;
}

export function MeetingSetupPage({ controller: c, navigate, prepare, autoStartFor, clearAutoStart, focusBrief, onNotice }: { controller: CopilotController; navigate: (location: AppLocation) => void; prepare: () => void; autoStartFor?: string; clearAutoStart?: () => void; focusBrief?: boolean; onNotice?: (notice: DayPanelNotice) => void }) {
  const setup = c.setup;
  // "Start recording" on the Calendar opens this meeting's plan and starts once that plan has loaded. The request is
  // cleared before starting so it can only fire once; without ready speech it stays here, where Start shows why.
  const p = c.publicProduct;
  const plan = p.current;
  const planReady = !p.enabled || (!p.loading && plan?.eventId === autoStartFor);
  useEffect(() => {
    if (!autoStartFor || !planReady) return;
    clearAutoStart?.();
    if (native() && !c.busy && c.ready?.recognitionReady) void c.start();
  }, [autoStartFor, planReady]);
  const now = useNow();
  const beside = useMediaQuery(DAY_PANEL_BESIDE);
  const [dayOpen, setDayOpen] = useState(false);
  const showDayButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const typeName = useId();
  useEffect(() => { if (beside) setDayOpen(false); }, [beside]);
  // The day panel sticks below the header, whose height changes with the window and the title.
  useLayoutEffect(() => {
    const el = header.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => page.current?.style.setProperty("--meeting-header-h", el.offsetHeight + "px"));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const closeDay = () => { setDayOpen(false); showDayButton.current?.focus(); };
  const showDay = () => {
    if (!beside) { setDayOpen(true); return; }
    const slot = page.current?.querySelector<HTMLElement>(".meeting-day-slot");
    slot?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    dayPanelFocusTarget(slot)?.focus({ preventScroll: true });
  };

  const notReady = !c.ready?.recognitionReady;
  const saved = p.loading ? "Loading meeting plan…" : p.dirty ? "Saving…" : "Saved on this Mac";
  // The plan message repeats the saved state most of the time; show it only when it says something else.
  const message = p.message && !/^(Saved )?meeting plan (saved|loaded)( locally)?$/i.test(p.message.trim()) ? p.message : "";
  const start = plan?.startMs, end = plan?.endMs;
  const dated = start !== undefined && end !== undefined;
  const event = plan?.eventId ? p.calendarEvents.find((e) => e.id === plan.eventId) : undefined;
  const joinUrl = event?.joinUrl && /^https?:\/\//i.test(event.joinUrl) ? event.joinUrl : undefined;
  const timeRange = dated ? `${timeText(start!)}–${timeText(end!)}` : "";
  const whenText = p.enabled
    ? dated ? `${shortDay(start!)} · ${timeRange} · ${lengthText(start!, end!)}` : ""
    : setup.scheduledEndMs ? `${shortDay(setup.scheduledEndMs)} · Ends ${timeText(setup.scheduledEndMs)}` : "";
  const profiles = Object.values(meetingProfiles);

  return <div className="screen-frame meeting-page" ref={page}>
    <header className="meeting-header" ref={header}>
      <div className="meeting-header-bar">
        <button type="button" className="link-button meeting-back" onClick={() => navigate({ kind: "meetings", view: "upcoming" })}><ArrowLeft size={15} aria-hidden /> Meetings</button>
        <div className="meeting-header-actions">
          {joinUrl && <button type="button" onClick={() => void openJoinUrl(joinUrl)}><Video size={16} aria-hidden />Join</button>}
          <button type="button" className="primary start-meeting" aria-describedby={notReady ? reasonId : undefined} disabled={!native() || c.busy || p.loading || notReady} onClick={() => void c.start()}><span className="record-dot" aria-hidden />Start meeting</button>
        </div>
      </div>
      <MeetingTitle value={setup.purpose} onChange={setup.setPurpose} />
      <p className="meeting-when">
        {whenText ? <button type="button" className="meeting-when-link" onClick={showDay} title={beside ? "Show this meeting in the day" : "Show the day"}>{whenText}</button>
          : p.enabled && plan && !plan.eventId ? <button type="button" className="meeting-when-link" onClick={showDay}>Choose a time</button>
          : !p.enabled ? <span>Prepare as much or as little as you need. A brief is optional.</span> : null}
        {p.enabled && plan && (whenText || !plan.eventId) && <span aria-hidden className="meeting-when-sep">·</span>}
        {p.enabled && plan && <PlanCalendarStatus plan={plan} />}
      </p>
      <div className="meeting-header-meta">
        {p.enabled && <span className="plan-save-state"><span role="status">{saved}{message && " · " + message}</span>{plan?.revision ? <><span aria-hidden>·</span><button type="button" className="link-button" disabled={p.loading} title="Loads the last saved version and keeps your unsaved edits on top" onClick={() => void p.reloadPlan()}>Reload saved</button></> : null}</span>}
        {notReady && <span id={reasonId} className="start-reason">Start needs local speech. <button type="button" className="link-button" onClick={() => navigate({ kind: "settings", section: "speech" })}>Set up speech</button></span>}
      </div>
    </header>
    {/* 820–1100 px: the day is one row here and opens as a drawer. Not rendered while the panel sits beside the page. */}
    {!beside && <div className="meeting-when-row">
      <CalendarDays size={16} aria-hidden />
      <span>{p.enabled && dated ? timeRange : p.enabled && plan?.eventId ? "Time set by your calendar" : whenText || "No time yet"}</span>
      <span aria-hidden>·</span>
      <button type="button" className="link-button" ref={showDayButton} aria-expanded={dayOpen} onClick={() => setDayOpen((o) => !o)}>Show day</button>
    </div>}
    <div className="meeting-layout">
      <div className="meeting-main">
        <Card title="Who & why" className="who-card">
          <div className="field">
            <span className="field-label" id={typeName}>Type</span>
            {profiles.length <= 5
              ? <div className="type-pills" role="radiogroup" aria-labelledby={typeName}>{profiles.map((profile) => <label key={profile.id} className={"type-pill" + (c.profile === profile.id ? " is-selected" : "")}><input type="radio" name={typeName} value={profile.id} checked={c.profile === profile.id} onChange={() => c.changeProfile(profile.id as typeof c.profile)} />{profile.label}</label>)}</div>
              : <select value={c.profile} onChange={(e) => c.changeProfile(e.target.value as typeof c.profile)} aria-labelledby={typeName}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select>}
          </div>
          <div className="field"><span className="field-label">People</span><PeoplePicker value={setup.participants} onChange={setup.setParticipants} model={c.people} /></div>
          <div className="field"><span className="field-label">Objectives</span><ObjectivesEditor value={setup.objectives} onChange={setup.setObjectives} /></div>
        </Card>
        <BriefCard controller={c} prepare={prepare} navigate={navigate} focusRequest={focusBrief} />
        <Card title="Context" className="context-card">
          <label className="field">Meeting workspace<select value={setup.workspace} onChange={(e) => setup.setWorkspace(e.target.value)}><option value="default">Conversation only</option>{c.workspaces.map((w) => <option key={w.id} value={w.id}>{p.workspaces.find((x) => x.id === w.id)?.name || w.root.split("/").at(-1)}</option>)}</select></label>
          <button type="button" className="link-button" onClick={() => navigate({ kind: "knowledge" })}>Manage workspaces <ArrowRight size={14} aria-hidden /></button>
          <label className="field">Public research topics <small>(optional)</small><textarea value={setup.publicTopics} onChange={(e) => setup.setPublicTopics(e.target.value)} placeholder="A public topic, company domain or relevant standard" /><small>These topics can be sent to public web search when useful.</small></label>
          {p.enabled ? <PublicSourceSelection controller={c} /> : <StubPanel title="Source selection" />}
          {p.enabled && <p className="muted">Only selected context excerpts and transcript text are sent for online reasoning. Audio stays on this Mac.</p>}
        </Card>
        <RecordingCard controller={c} navigate={navigate} />
        {p.enabled && <PremiumCard account={p.account} plan={plan} now={now} onAutomaticPreparation={(on) => p.edit({ automaticPreparation: on })}
          onSeePremium={() => navigate({ kind: "settings", section: "account" })} onSignIn={() => navigate({ kind: "settings", section: "account" })} />}
        {p.enabled && <p className="meeting-footer-note">You are responsible for telling participants about recording and assistance.</p>}
      </div>
      <MeetingDaySlot controller={c} navigate={navigate} beside={beside} open={dayOpen} onClose={closeDay} onNotice={onNotice} />
    </div>
  </div>;
}
export function PreparationPeople({ controller: c }: { controller: CopilotController }) {
  return <div className="preparation-people">{c.setup.participants.length ? c.setup.participants.map((p) => <div key={p.id}><Avatar name={p.name} /><span>{p.name}</span></div>) : <p className="muted">No attendees selected.</p>}</div>;
}
