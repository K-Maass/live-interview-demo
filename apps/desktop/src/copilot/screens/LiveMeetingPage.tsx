import { useState, useRef, useEffect } from "react";
import { conversationLines } from "../presentation/conversation";
import { ArrowLeft, Square, ChevronDown, ChevronUp, PanelTop, FileText, Pause, Play } from "lucide-react";
import { meetingProfiles } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation } from "../presentation/types";
import { captureMessages, captureRows } from "../presentation/model";
import { PageHeading, useDismissableDetails } from "../ui";
import { LivePanel } from "../LivePanel";
import { SpeechWarmupNotice } from "../SpeechWarmupNotice";
import { speechStatusSettled, speechStatusText, warmupNotice } from "../../lib/public/speechWarmup";
import { TranscriptView } from "../live/TranscriptView";
import { liveStatusLine, shortcutAvailabilityLine, stopPromptLine } from "../../lib/copilot/status";
import { useFramesStarted, useLiveEvents, useLiveStore, useLiveView, type LiveStore } from "../liveStore";
/**
 * One combined capture meter for both lanes. It shows whether audio frames are still arriving on each lane (microphone
 * bars, then system-audio bars), not loudness: no level is read from the audio, so it never claims more than capture.
 */
// Reads the frame counts on its own timer instead of re-rendering for each 500 ms frame report; it renders only when a
// lane starts or stops arriving.
function CaptureMeter({ store, paused }: { store: LiveStore; paused: boolean }) {
  const seen = useRef(store.get().frames);
  const [live, setLive] = useState({ me: false, remote: false });
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = store.get().frames, before = seen.current;
      const me = (now.me ?? 0) > (before.me ?? 0), remote = (now.remote ?? 0) > (before.remote ?? 0);
      setLive((old) => (old.me === me && old.remote === remote ? old : { me, remote }));
      seen.current = now;
    }, 700);
    return () => window.clearInterval(timer);
  }, [store]);
  const label = paused ? "Capture paused" : live.me && live.remote ? "Capturing microphone and system audio" : live.me ? "Capturing microphone only" : live.remote ? "Capturing system audio only" : "Waiting for audio";
  return <span className={"capture-meter" + (paused ? " paused" : "")} role="img" aria-label={label} title={label}>{[0, 1, 2].map((i) => <span key={"me" + i} className={"bar me" + (live.me && !paused ? " live" : "")} />)}{[0, 1, 2, 3, 4].map((i) => <span key={"remote" + i} className={"bar remote" + (live.remote && !paused ? " live" : "")} />)}</span>;
}
export function LiveMeetingPage({ controller: c, navigate, openWidget, resetWidget }: { controller: CopilotController; navigate: (location: AppLocation) => void; openWidget: () => void; resetWidget: () => void }) {
  const [drawer, setDrawer] = useState<"transcript">();
  const [expanded, setExpanded] = useState(false);
  const dock = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDetailsElement>(null);
  useDismissableDetails(controls);
  const drawerRegion = useRef<HTMLDivElement>(null);
  const drawerToggle = useRef<HTMLButtonElement | null>(null);
  // The drawer sits before the dock in the page, so opening it from the dock would otherwise leave keyboard focus
  // behind it. Focus goes to the drawer; Escape closes it and returns to the button that opened it.
  useEffect(() => { if (drawer) drawerRegion.current?.focus({ preventScroll: true }); }, [drawer]);
  const closeDrawer = () => { setDrawer(undefined); setExpanded(false); drawerToggle.current?.focus(); };
  useEffect(() => {
    const footer = dock.current;
    if (!footer) return;
    const header = footer.parentElement?.querySelector<HTMLElement>(".page-heading");
    const update = () => {
      footer.parentElement?.style.setProperty("--live-dock-height", footer.offsetHeight + "px");
      footer.parentElement?.style.setProperty("--live-header-height", (header?.offsetHeight ?? 0) + "px");
    };
    const observer = new ResizeObserver(update); observer.observe(footer); if (header) observer.observe(header); update();
    return () => observer.disconnect();
  }, []);
  // The live surfaces subscribe to the live store: this page follows new lines and guidance, not each frame report.
  const store = useLiveStore(c);
  const events = useLiveEvents(c);
  const view = useLiveView(c);
  const started = useFramesStarted(c);
  const meeting = c.activeMeeting;
  if (!meeting) return null;
  // Newest first, like the full transcript; the rail keeps only the last few lines so it never needs scrolling.
  // A non-English line shows what was said with its English translation beside it (source-language evidence stays).
  const recent = conversationLines(events, 6);
  const openTranscript = (event: { currentTarget: HTMLButtonElement }) => { drawerToggle.current = event.currentTarget; setDrawer("transcript"); setExpanded(true); };
  const conversation = <><div className="rail-heading"><h3>Conversation</h3><button className="link-button" onClick={openTranscript}>Full transcript</button></div>{recent.length ? <ol className="conversation-feed" aria-label="Latest transcript lines">{recent.map((entry) => <li key={entry.segmentId} className={"lane-" + entry.lane}><span className="lane-label">{entry.lane === "me" ? "Me" : "Remote"}{entry.language && entry.language !== "en" ? " · " + entry.language : ""}</span><p lang={entry.language}>{entry.text}</p>{entry.english && <p className="conversation-english" lang="en">{entry.english}</p>}</li>)}</ol> : <p className="muted">Listening. Lines appear here as people speak.</p>}</>;
  const rows = captureRows(c.captureHealth, started, c.paused, c.sessionKind === "recording");
  // Stays until a later registration succeeds, unlike the assistance line, which the next report replaces.
  const shortcutLine = shortcutAvailabilityLine(c.unavailableShortcuts);
  const errors = rows.filter((r) => r.status === "unavailable");
  const starting = rows.every((row) => row.status === "starting");
  const capture = <div className="capture-summary"><span><span className={"status-dot " + (c.sessionKind === "replay" ? "" : errors.length ? "unavailable" : c.paused ? "paused" : starting ? "starting" : "active")} />{c.sessionKind === "replay" ? "Synthetic replay · microphone off" : c.paused ? "Recording paused" : errors.length ? "Recording needs attention" : starting ? "Starting audio capture" : "Recording locally"}</span><small>{rows.map((r) => r.label + " " + r.status).join(" · ")}</small></div>;
  return <div className="screen-frame live-meeting-page">
    <PageHeading eyebrow={<button onClick={() => navigate({ kind: "meetings", view: "upcoming" })}><ArrowLeft size={15} />Meetings</button>} title={meeting.purpose} subtitle={meeting.attendees.length ? meeting.attendees.map((p) => p.name).join(" · ") + " · " + meetingProfiles[c.profile].label : meetingProfiles[c.profile].label} actions={<>{capture}<CaptureMeter store={store} paused={c.paused} /><button className="icon-button round-icon" aria-label={c.paused ? "Resume recording" : "Pause recording"} title={c.paused ? "Resume recording" : "Pause recording"} disabled={c.sessionKind !== "recording"} onClick={() => void c.toggleRecordingPause().catch(() => c.setAssistanceStatus("Pause change needs attention"))}>{c.paused ? <Play size={15} fill="currentColor" /> : <Pause size={15} fill="currentColor" />}</button><details className="meeting-controls" ref={controls}><summary>Meeting controls <ChevronDown size={15} /></summary><div className="controls-popover"><button onClick={resetWidget}>Reset widget position</button><p className="muted">Local speech: {speechStatusText(c.speechStatus)}{c.assistanceStatus && <><br />{c.assistanceStatus}</>}</p><label>Meeting profile<select value={c.profile} onChange={(e) => c.changeProfile(e.target.value as typeof c.profile)}>{Object.values(meetingProfiles).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><button onClick={c.toggleAssistance}>{c.assistancePaused ? "Resume assistance" : "Pause assistance"}</button><button onClick={() => void c.toggleRecordingPause().catch(() => c.setAssistanceStatus("Pause change needs attention"))}>{c.paused ? "Resume recording" : "Pause recording"}</button></div></details><button className="stop" disabled={c.busy} onClick={() => void c.stop()}><Square size={15} />Stop & save</button></>} />
    {captureMessages(rows).map((message) => message.tone === "alert"
      ? <div className="capture-warning" role="alert" key={message.text}>{message.text}</div>
      : <div className="capture-notice" role="status" key={message.text}>{message.text}</div>)}
    {c.statusTone === "alert" && !rows.some((row) => row.message?.text === c.status) && <div className="capture-warning" role="alert">{c.status}</div>}
    {warmupNotice(c.speechStatus) ? <SpeechWarmupNotice status={c.speechStatus} onRetry={c.retrySpeech} /> : !speechStatusSettled(c.speechStatus) && <div className="live-speech-health">Local speech: {speechStatusText(c.speechStatus)}</div>}
    {liveStatusLine(c.assistance) && <div className="live-assistance-health">{liveStatusLine(c.assistance)}</div>}
    {shortcutLine && shortcutLine !== liveStatusLine(c.assistance) && <div className="live-assistance-health">{shortcutLine}</div>}
    {c.stopPending && <div className="live-assistance-health">{stopPromptLine(c.shortcuts.stop, c)}</div>}
    <div className={"live-page-content " + (drawer ? "with-drawer" : "")}><LivePanel view={view} profile={c.profile} objectives={meeting.objectives} onRequest={(intent) => void c.request(intent)} onPin={c.pin} onSettle={c.settle} onReopen={c.reopen} onDismiss={c.dismiss} onExpand={c.expand} onCovered={c.coverReminder} reminders={c.reminders} conversation={conversation} shortcuts={c.shortcuts} assistancePaused={c.assistancePaused} onTogglePause={c.toggleAssistance} /></div>
    <div ref={drawerRegion} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape" && !event.altKey && !event.metaKey && !event.ctrlKey) { event.stopPropagation(); closeDrawer(); } }} className={"live-drawer " + (expanded ? "expanded" : "")} hidden={!drawer} role="region" aria-label="Transcript drawer">{drawer === "transcript" && <><div className="drawer-tools"><button className="link-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Reduce transcript" : "Expand transcript"}</button><button className="icon-button" aria-label="Close transcript" onClick={closeDrawer}><ChevronDown size={18} /></button></div><TranscriptView events={events} english={c.english} onEnglish={c.setEnglish} /></>}</div>
    <footer ref={dock} className="live-drawer-bar"><div className="live-compact-controls">{capture}<button className="stop" disabled={c.busy} onClick={() => void c.stop()}><Square size={15} />Stop &amp; save</button></div><button onClick={(event) => { drawerToggle.current = event.currentTarget; setDrawer(drawer === "transcript" ? undefined : "transcript"); setExpanded(false); }} aria-expanded={drawer === "transcript"}><FileText size={18} />Full transcript{drawer === "transcript" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button><button onClick={openWidget}><PanelTop size={18} />Open compact widget</button></footer>
  </div>;
}
