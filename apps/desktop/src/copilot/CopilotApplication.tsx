import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CopilotController } from "./useCopilotController";
import type { AppLocation, PageLocation, SettingsSection } from "./presentation/types";
import { canReturnFocusTo, closeSettings, navigateTo, type Navigation } from "./presentation/settingsOverlay";
import { captureRows, deriveMeetingPresentation } from "./presentation/model";
import { DetectedCall } from "./shell/DetectedCall";
import { CrashReportNotice } from "./CrashReportNotice";
import { AppShell } from "./shell/AppShell";
import { MeetingsPage } from "./screens/MeetingsPage";
import { MeetingSetupPage } from "./screens/MeetingSetupPage";
import type { DayPanelNotice } from "./PlanDayPanel";
import { PreparationPage } from "./screens/PreparationPage";
import { LiveMeetingPage } from "./screens/LiveMeetingPage";
import { ReviewMeetingPage } from "./screens/ReviewMeetingPage";
import { KnowledgePage } from "./screens/KnowledgePage";
import { PeoplePage } from "./screens/PeoplePage";
import { SettingsDialog } from "./shell/SettingsDialog";
import { useWidgetOwner } from "./widget/bridge";
import type { Preview } from "./dev/installPreview";
import { useAnnouncer } from "./Announcer";
import { ActionToast, Toast, type ActionNotice } from "./ui";
import type { PublicMeetingPlan } from "@live-interview/core";
import { useLiveAnnouncements } from "./useLiveAnnouncements";
import { statusNotice } from "../lib/copilot/status";
import { useSetup } from "./useSetup";
import { WelcomeFlow } from "./WelcomeFlow";
import { ShortcutCheatSheet, cheatSheetRows, useModifierHold } from "./ShortcutCheatSheet";
import { useFramesStarted } from "./liveStore";
/**
 * A hidden page during a meeting keeps the element it last rendered, so the shell's own updates do not re-render it
 * (React skips an unchanged element). It stays mounted, so its scroll position, filters and drafts are kept, and it
 * renders fresh as soon as it is shown again.
 */
function Frozen({ frozen, children }: { frozen: boolean; children: ReactNode }) {
  const last = useRef(children);
  if (!frozen) last.current = children;
  return <>{last.current}</>;
}
export function CopilotApplication({ controller: c }: { controller: CopilotController }) {
  // The page the window shows, and Settings when it is open over that page. Opening Settings never changes the page,
  // so closing it returns to the page exactly as it was (its state stays mounted behind the dimmed layer).
  const [nav, setNav] = useState<Navigation>({ page: { kind: "meetings", view: "upcoming" } });
  const location = nav.page;
  const setLocation = (update: PageLocation | ((old: PageLocation) => PageLocation)) => setNav((old) => ({ ...old, page: typeof update === "function" ? update(old.page) : update }));
  const lastSettings = useRef<SettingsSection>(c.publicProduct.enabled?"account":"speech");
  const lastMeeting = useRef<string | undefined>(undefined);
  // The control that opened Settings gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const navigate = (next: AppLocation) => {
    if (next.kind === "settings") {
      lastSettings.current = next.section;
      if (!nav.settings && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) opener.current = document.activeElement;
    } else if (nav.settings) returnFocus.current = false;
    setNav((old) => navigateTo(old, next));
  };
  const closeSettingsWindow = () => { returnFocus.current = true; setNav(closeSettings); };
  // Runs once the app behind is no longer inert, so the opener can take focus. A page link from inside Settings goes
  // to its page instead, where the page's heading takes focus as usual.
  useLayoutEffect(() => {
    if (nav.settings) return;
    const target = opener.current;
    opener.current = null;
    if (!returnFocus.current) return;
    returnFocus.current = false;
    if (target && canReturnFocusTo(target)) target.focus({ preventScroll: true });
    else document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [nav.settings]);
  const setup = useSetup(c, navigate);
  // "Show the welcome again" from Settings › Setup: the welcome replaces Settings rather than opening under it.
  const welcomeWasOpen = useRef(setup.welcomeOpen);
  useEffect(() => { if (setup.welcomeOpen && !welcomeWasOpen.current) setNav(closeSettings); welcomeWasOpen.current = setup.welcomeOpen; }, [setup.welcomeOpen]);
  const showLive = () => { if (c.activeMeeting) setLocation({ kind: "meeting", id: c.activeMeeting.id, preparationOpen: false, artifact: "overview" }); };
  // The widget asks for the live page explicitly, so Settings steps aside for it.
  const widget = useWidgetOwner(c, () => { setNav(closeSettings); showLive(); });
  const preview = import.meta.env.DEV ? (window as unknown as { __LIVE_INTERVIEW_PREVIEW__?: Preview }).__LIVE_INTERVIEW_PREVIEW__ : undefined;
  useEffect(() => {
    if (c.activeMeeting && lastMeeting.current !== c.activeMeeting.id) { lastMeeting.current = c.activeMeeting.id; showLive(); }
    else if (!c.activeMeeting && lastMeeting.current) { lastMeeting.current = undefined; if (c.selectedRecord) setLocation({ kind: "meeting", id: c.selectedRecord.id, preparationOpen: false, artifact: "overview" }); }
  }, [c.activeMeeting?.id, c.selectedRecord?.id]);
  const target = location.kind === "meeting" ? location.id : "setup";
  const stage = deriveMeetingPresentation({ targetId: target, activeMeetingId: c.activeMeeting?.id, selectedRecordId: c.selectedRecord?.id, preparationOpen: location.kind === "meeting" && location.preparationOpen });
  const setupLocation = { kind: "meeting", id: target, preparationOpen: false, artifact: "overview" } as const;
  // Only whether each lane has started: the shell does not re-render for every frame report.
  const framesStarted = useFramesStarted(c);
  const capture = captureRows(c.captureHealth, framesStarted, c.paused, !!c.activeMeeting && c.sessionKind === "recording");
  const failures = capture.filter((row) => row.status === "unavailable");
  const captureLabel = c.sessionKind === "replay" ? "Synthetic replay · microphone off" : failures.length ? "Recording needs attention" : c.paused ? "Recording paused" : capture.every((row) => row.status === "starting") ? "Starting audio capture" : "Recording locally";
  const openRecord = (id: string) => { const record = c.records.find((r) => r.id === id); if (record) { c.selectRecord(record); navigate({ kind: "meeting", id, preparationOpen: false, artifact: "overview" }); } };
  const openPlan = (id: string) => { void c.publicProduct.openPlan(id); navigate({ kind: "meeting", id, preparationOpen: false, artifact: "overview" }); };
  const { announce, regions } = useAnnouncer();
  // "Meeting created" after New meeting on the Calendar, with a way into the new plan.
  const [created, setCreated] = useState<ActionNotice & { planId: string }>();
  const planCreated = (plan: PublicMeetingPlan) => {
    const when = plan.startMs !== undefined ? new Date(plan.startMs).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    setCreated({ id: plan.id, planId: plan.id, text: `Meeting created: ${plan.title}`, detail: when ? `${when} · Only in this app` : "Only in this app", actionLabel: "Open plan" });
    announce({ politeness: "polite", text: `Meeting created: ${plan.title}${when ? ", " + when : ""}. Open plan is in the notification.` });
  };
  // The new plan is already the open one; open it from the store only if another plan was opened meanwhile.
  // "Moved in Work calendar · Undo" and "Moved “Focus time” · Undo" from the meeting page's day panel.
  const [dayMoved, setDayMoved] = useState<DayPanelNotice>();
  const dayPanelNotice = (notice: DayPanelNotice) => {
    setDayMoved(notice);
    announce({ politeness: "polite", text: notice.spoken ?? `${notice.text}${notice.detail ? ", " + notice.detail : ""}. Undo is in the notification.` });
  };
  const openCreated = () => { if (!created) return; if (c.publicProduct.current?.id === created.planId) navigate({ kind: "meeting", id: created.planId, preparationOpen: false, artifact: "overview" }); else openPlan(created.planId); };
  useLiveAnnouncements(c, c.activeMeeting ? captureLabel : undefined, announce);
  // The toast has no live role; its message is spoken here, once per report. The plan page shows the same message in
  // its own save-state status, so it is not spoken a second time there.
  const productMessage = useRef(c.publicProduct.messageId);
  useEffect(() => {
    if (productMessage.current === c.publicProduct.messageId) return;
    productMessage.current = c.publicProduct.messageId;
    if (c.publicProduct.enabled && c.publicProduct.message && !(location.kind === "meeting" && stage === "setup")) announce({ politeness: "polite", text: c.publicProduct.message, eventId: `product:${c.publicProduct.messageId}` });
  }, [c.publicProduct.messageId]);
  // Only while a meeting is live, when the global keys are held: outside a meeting ⌘⌥ means nothing here.
  const cheatSheet = useModifierHold(!!c.activeMeeting);
  return <><div className="app-root" inert={setup.welcomeOpen || !!nav.settings}><AppShell location={location} settings={nav.settings} navigate={(next) => navigate(next.kind === "settings" ? { ...next, section: lastSettings.current } : next)} controller={c}>
    {regions}
    {preview && <div className="demo-banner">Demo data · recording, connections and writes are simulated</div>}
    {c.activeMeeting && (location.kind !== "meeting" || stage !== "live") && <div className="live-return"><span className={"status-dot " + (failures.length ? "unavailable" : c.paused ? "paused" : "active")} /><div><strong>{captureLabel}</strong><span className="persistent-capture-detail">{c.activeMeeting.purpose} · {capture.map((row) => row.label + " " + row.status).join(" · ")}</span>{failures.map((row) => <p role="alert" key={row.lane}>{row.label} is not recording. {row.detail || "Check input permissions and availability."}</p>)}</div><button onClick={showLive}>Return to live</button></div>}
    <DetectedCall controller={c} />
    {c.publicProduct.enabled && <CrashReportNotice meetingActive={!!c.activeMeeting} />}
    <div className="toast-stack"><ActionToast notice={created} onAction={openCreated} onClose={() => setCreated(undefined)} /><ActionToast notice={dayMoved} onAction={() => dayMoved?.action()} onClose={() => setDayMoved(undefined)} /><Toast notice={c.publicProduct.enabled ? { id: c.publicProduct.messageId, text: c.publicProduct.message } : undefined} /><Toast notice={!(location.kind === "meeting" && stage === "live") ? statusNotice(c.assistance) : undefined} /></div>
    {c.statusTone !== "info" && !(location.kind === "meeting" && stage === "live") && <div className="notice error operation-status" role={c.statusTone === "alert" ? "alert" : undefined}>{c.status}</div>}
    <div hidden={location.kind !== "meetings"}><Frozen frozen={!!c.activeMeeting && location.kind !== "meetings"}><MeetingsPage controller={c} setup={setup} view={location.kind === "meetings" ? location.view : "calendar"} navigate={navigate} openEvent={(event) => { c.selectUpcoming(event); navigate({ kind: "meeting", id: event.id, preparationOpen: false, artifact: "overview" }); }} startEvent={(event) => { c.selectUpcoming(event); navigate({ kind: "meeting", id: event.id, preparationOpen: false, artifact: "overview", autoStart: true }); }} openRecord={openRecord} onPlanCreated={planCreated} /></Frozen></div>
    {!c.activeMeeting && <><div hidden={location.kind !== "meeting" || stage !== "setup"}><MeetingSetupPage controller={c} navigate={navigate} prepare={() => navigate({ ...setupLocation, preparationOpen: true })} autoStartFor={location.kind === "meeting" && location.autoStart ? location.id : undefined} clearAutoStart={() => setLocation((old) => old.kind === "meeting" ? { ...old, autoStart: false } : old)} onNotice={dayPanelNotice} /></div><div hidden={location.kind !== "meeting" || stage !== "preparation"}><PreparationPage controller={c} navigate={navigate} back={() => navigate(setupLocation)} /></div>{c.selectedRecord && <div hidden={location.kind !== "meeting" || stage !== "review"}><ReviewMeetingPage key={c.selectedRecord.id} controller={c} navigate={navigate} artifact={location.kind === "meeting" ? location.artifact : "overview"} synthesis={preview?.synthesis} /></div>}</>}
    {c.activeMeeting && <div hidden={location.kind !== "meeting" || stage !== "live"}><LiveMeetingPage controller={c} navigate={navigate} resetWidget={() => void widget.resetWidget().catch(() => c.setAssistanceStatus("Widget position could not reset; main assistance remains available."))} openWidget={() => void widget.openWidget().catch(() => c.setAssistanceStatus("Compact widget could not open; main assistance remains available."))} /></div>}
    <div hidden={location.kind !== "knowledge"}><Frozen frozen={!!c.activeMeeting && location.kind !== "knowledge"}><KnowledgePage controller={c} /></Frozen></div>
    <div hidden={location.kind !== "people"}><Frozen frozen={!!c.activeMeeting && location.kind !== "people"}><PeoplePage controller={c} openRecord={openRecord} openPlan={openPlan} /></Frozen></div>
  </AppShell></div>
    {/* Settings opened from the welcome stacks above it; the welcome is still there when Settings closes. */}
    {setup.welcomeOpen && <div className="welcome-layer" inert={!!nav.settings}><WelcomeFlow setup={setup} /></div>}
    {nav.settings && <SettingsDialog controller={c} setup={setup} section={nav.settings} navigate={navigate} onClose={closeSettingsWindow} />}
    <ShortcutCheatSheet rows={cheatSheetRows(c.shortcuts)} visible={cheatSheet && !!c.activeMeeting} /></>;
}
