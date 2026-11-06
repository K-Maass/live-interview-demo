import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Check, Download, Mic, Volume2, PhoneCall, UserRound, CalendarDays, FolderOpen, CirclePlay, Clock3, type LucideIcon } from "lucide-react";
import { welcomeFill, type OnboardingStep, type StepId } from "../lib/public/onboarding";
import type { Setup } from "./useSetup";
import { ModelProgress, StepButton } from "./SetupChecklist";
import { MicCheck, SystemAudioCheck } from "./SetupAudioCheck";
import mark from "./assets/app-mark.png";

type Screen = "welcome" | "models" | "microphone" | "systemAudio" | "accessibility" | "extras" | "ready";
const screens: { id: Screen; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "models", label: "Speech models" },
  { id: "microphone", label: "Microphone" },
  { id: "systemAudio", label: "System audio" },
  { id: "accessibility", label: "Teams call detection" },
  { id: "extras", label: "Extras" },
  { id: "ready", label: "Ready" },
];
const optionalIds: StepId[] = ["account", "calendar", "folder", "testMeeting"];
const optionalIcons: Record<string, LucideIcon> = { account: UserRound, calendar: CalendarDays, folder: FolderOpen, testMeeting: CirclePlay };
const doneWords: Record<string, string> = { account: "Signed in", calendar: "Connected", folder: "Connected", testMeeting: "Done" };

/**
 * First-launch welcome: three required steps (speech models, microphone, system audio), optional Teams call detection
 * (Accessibility), one screen of optional extras and a summary. Every step can be skipped; whatever is left stays in Settings › Setup, and the toolbar shows "Finish setup"
 * until the required steps are done. The sidebar fills as steps complete. Nothing here records.
 */
export function WelcomeFlow({ setup }: { setup: Setup }) {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [started, setStarted] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // Each screen change moves focus to the new heading, so a screen reader says where it is.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus({ preventScroll: true });
  }, [screen]);
  const { state } = setup;
  const step = (id: StepId) => state.steps.find((s) => s.id === id)!;
  const go = (next: Screen) => { if (next === "ready") setReachedEnd(true); setScreen(next); };
  const finish = () => setup.finishWelcome();
  const begin = () => {
    setStarted(true);
    const models = step("models");
    if (models.action?.kind === "install" && models.status === "todo") void setup.run(models);
    go("models");
  };
  const fill = welcomeFill(state.steps, { started, reachedEnd });
  // Rows grow with larger text, so the fill is measured to the bottom of the last filled row rather than counted in fixed rows.
  const rail = useRef<HTMLElement>(null);
  const [fillHeight, setFillHeight] = useState<number>();
  useLayoutEffect(() => {
    const measure = () => {
      const nav = rail.current; const rows = nav?.querySelectorAll("li");
      if (!nav || !rows) return;
      setFillHeight(fill > 0 && rows[fill - 1] ? rows[fill - 1].getBoundingClientRect().bottom - nav.getBoundingClientRect().top + 2 : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [fill, screen, state]);
  const railStatus = (id: Screen): { text: string; done: boolean } => {
    if (id === "welcome") return { text: started ? "Done" : "", done: started };
    if (id === "extras") { const n = optionalIds.filter((o) => step(o).status === "done").length; return { text: n ? `${n} of ${optionalIds.length}` : "Optional", done: false }; }
    if (id === "ready") return { text: reachedEnd && state.ready ? "Done" : "", done: reachedEnd && state.ready };
    const s = step(id);
    if (s.status === "done") return { text: "Done", done: true };
    if (id === "accessibility") return { text: "Optional", done: false };
    if (id === "models" && s.status === "checking" && s.progress?.fraction !== undefined) return { text: Math.floor(s.progress.fraction * 100) + "%", done: false };
    if (s.status === "blocked") return { text: s.required ? "Turned off" : "Not available", done: false };
    return { text: "", done: false };
  };
  const order = screens.map((s) => s.id);
  const back = () => go(order[Math.max(0, order.indexOf(screen) - 1)]);
  const forward = () => go(order[Math.min(order.length - 1, order.indexOf(screen) + 1)]);
  const title = (text: string) => <h1 id="welcome-heading" ref={heading} tabIndex={-1}>{text}</h1>;

  return <div className="welcome-flow" role="dialog" aria-modal="true" aria-labelledby="welcome-heading">
    <div className="welcome-titlebar" data-tauri-drag-region />
    <div className="welcome-window">
      <nav className="welcome-rail" ref={rail} aria-label="Setup steps" style={{ "--fill-rows": fill, ...(fillHeight === undefined ? {} : { "--fill-height": fillHeight + "px" }), "--fill-complete": fill >= screens.length ? 1 : 0 } as CSSProperties}>
        <div className="welcome-rail-fill" aria-hidden />
        <div className="welcome-rail-label">Set up</div>
        <ol>
          {screens.map(({ id, label }, i) => {
            const status = railStatus(id);
            return <li key={id}><button className={"welcome-rail-item" + (screen === id ? " current" : "") + (status.done ? " done" : "")} aria-current={screen === id ? "step" : undefined} disabled={!started && id !== "welcome"} onClick={() => go(id)}>
              <span className="welcome-rail-dot" aria-hidden>{status.done ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
              <span className="welcome-rail-name">{label}</span>
              {status.text && <span className="welcome-rail-status">{status.text}</span>}
            </button></li>;
          })}
        </ol>
        <div className="welcome-rail-foot">
          <p>Nothing is recorded while you set up. Audio stays on this Mac.</p>
          <button className="link-button" onClick={finish}>Set up later</button>
        </div>
      </nav>

      <div className="welcome-content">
        <div className="welcome-screen" key={screen}>
          {screen === "welcome" && <>
            <img className="welcome-mark" src={mark} alt="" />
            {title("Welcome to Live Interview")}
            <p className="welcome-lead">Three quick steps and you’re ready to record. Everything else is optional and can wait.</p>
            <div className="welcome-cards">
              <Card icon={Download} title="Speech models">About 3.2&nbsp;GB, once. Runs offline.</Card>
              <Card icon={Mic} title="Microphone">Your voice, the “me” lane.</Card>
              <Card icon={Volume2} title="System audio">Teams callers, the “remote” lane.</Card>
            </div>
            <Footer><button className="primary" onClick={begin}>Get started <ArrowRight size={15} aria-hidden /></button></Footer>
          </>}

          {screen === "models" && (() => { const s = step("models"); const fraction = s.status === "done" ? 1 : s.progress?.fraction; return <>
            <span className="welcome-eyebrow">Step 1 of 3</span>
            {title("Speech runs on this Mac")}
            <p className="welcome-lead">The models download once. After that, recognition and translation work offline and nothing you say leaves this Mac. You can carry on while it downloads.</p>
            <div className="welcome-download">
              <Ring fraction={fraction} done={s.status === "done"} />
              <div>
                <strong>{s.status === "done" ? "Speech models are ready" : s.status === "checking" && s.progress ? s.progress.headline : s.status === "checking" ? "Checking local models…" : "Ready to download"}</strong>
                <p className="muted">{s.status === "checking" && s.progress ? "Recording is never blocked by this download." : s.detail}</p>
                {s.progress && <ModelProgress view={s.progress} />}
                <StepButton step={s} setup={setup} />
              </div>
            </div>
            <Footer back={back}><button className="primary" onClick={forward}>{s.status === "done" ? "Continue" : "Continue while it downloads"}</button></Footer>
          </>; })()}

          {(screen === "microphone" || screen === "systemAudio") && (() => { const s = step(screen); const mic = screen === "microphone"; return <>
            <span className="welcome-eyebrow">{mic ? "Step 2 of 3" : "Step 3 of 3"}</span>
            {title(mic ? "Let it hear you" : "Hear the other side")}
            <p className="welcome-lead">{mic ? "macOS asks once. Your side of every meeting is captured from this microphone." : "This lets Live Interview hear the people on the other end of a Teams or other call. macOS asks once."}</p>
            <div className={"welcome-permission " + s.status}>
              <span className="welcome-permission-icon" aria-hidden>{mic ? <Mic size={22} /> : <Volume2 size={22} />}</span>
              <div>
                <strong>{s.status === "done" ? (mic ? "Microphone access is on" : setup.systemAudioVerified ? "System audio comes through" : "Check it with a test sound") : s.status === "blocked" ? (s.required ? "Access is turned off" : "Not available on this Mac") : mic ? "Microphone access" : "System audio access"}</strong>
                <p className="muted">{s.status === "done" ? (mic ? "Your side of each meeting is captured as “me”." : setup.systemAudioVerified ? "Remote participants are captured as “remote”." : "macOS does not always say whether access is on. Play the chime below; if macOS asks for permission, allow it.") : s.detail}</p>
              </div>
              <StepButton step={s} setup={setup} primary />
            </div>
            {s.status === "done" && (mic ? <MicCheck /> : <SystemAudioCheck onResult={setup.confirmSystemAudio} openPrivacy={() => setup.openPrivacy("systemAudio")} />)}
            {setup.message && <p className="notice" role="alert">{setup.message}</p>}
            <Footer back={back}>{s.status !== "done" && s.required && <button className="link-button welcome-skip" onClick={forward}>Not now</button>}<button className="primary" disabled={s.required && s.status !== "done"} onClick={forward}>Continue</button></Footer>
          </>; })()}

          {screen === "accessibility" && (() => { const s = step("accessibility"); return <>
            <span className="welcome-eyebrow">Optional</span>
            {title("Know when a Teams call starts")}
            <p className="welcome-lead">With Accessibility access, Live Interview notices when a Teams call begins, so a meeting you armed starts recording. It looks only at Teams’ call controls and never reads what is said or shown.</p>
            <TeamsDetectionCard step={s} setup={setup} />
            {setup.message && <p className="notice" role="alert">{setup.message}</p>}
            <Footer back={back}>{s.status !== "done" && <button className="link-button welcome-skip" onClick={forward}>Skip, I’ll start meetings by hand</button>}<button className="primary" onClick={forward}>Continue</button></Footer>
          </>; })()}

          {screen === "extras" && <>
            <span className="welcome-eyebrow">Optional</span>
            {title("Make it yours")}
            <p className="welcome-lead">None of these are needed to record. Each one opens where it is set up and closes this welcome; the rest stays in Settings › Setup.</p>
            <div className="welcome-extras">
              {optionalIds.map((id) => { const s = step(id); const Icon = optionalIcons[id]; return <div key={id} className="welcome-extra">
                <div className="welcome-extra-title"><Icon size={20} aria-hidden /><strong>{s.title}</strong></div>
                <p className="muted">{s.detail}</p>
                {s.status === "done" ? <span className="welcome-done"><Check size={15} aria-hidden />{doneWords[id]}</span> : s.status === "checking" ? <span className="muted">Checking…</span> : <StepButton step={s} setup={setup} onDone={finish} />}
              </div>; })}
            </div>
            <Footer back={back}><button className="link-button welcome-skip" onClick={() => go("ready")}>Skip for now</button><button className="primary" onClick={() => go("ready")}>Continue</button></Footer>
          </>}

          {screen === "ready" && (() => { const permissionsLeft = state.steps.filter((s) => s.required && s.id !== "models" && s.status !== "done").length; const downloadingOnly = !state.ready && permissionsLeft === 0; return <>
            <span className={"welcome-badge" + (state.ready ? " done" : "")} aria-hidden>{state.ready ? <Check size={32} strokeWidth={2.5} /> : <Clock3 size={30} />}</span>
            {title(state.ready ? "You’re ready to record" : downloadingOnly ? "Almost there" : "Finish the rest whenever you like")}
            <p className="welcome-lead">{state.ready ? "Microphone and system audio are on, and speech runs on this Mac. Optional extras live in Settings › Setup." : downloadingOnly ? "The speech models are still downloading. Look around in the meantime; recording is available as soon as they finish." : state.requiredRemaining === 1 ? "1 required step is left. A “Finish setup” button stays in the toolbar until it’s done." : `${state.requiredRemaining} required steps are left. A “Finish setup” button stays in the toolbar until they’re done.`}</p>
            <ul className="welcome-summary">
              {(["models", "microphone", "systemAudio"] as const).map((id) => { const s = step(id); const f = s.progress?.fraction; const text = s.status === "done" ? "Done" : id === "models" && s.status === "checking" && f !== undefined ? Math.floor(f * 100) + "%" : s.status === "blocked" ? (s.required ? "Turned off" : "Not available") : "To do"; return <li key={id}><span>{s.title}</span><span className={s.status === "done" ? "welcome-done" : "muted"}>{text}</span></li>; })}
              {(() => { const s = step("accessibility"); return <li><span>{s.title}</span><span className={s.status === "done" ? "welcome-done" : "muted"}>{s.status === "done" ? "Done" : "Start meetings by hand"}</span></li>; })()}
            </ul>
            <Footer back={back}><button className="primary" onClick={finish}>Open Live Interview</button></Footer>
          </>; })()}
        </div>
      </div>
    </div>
  </div>;
}

/**
 * The Teams detection (Accessibility) card: status from the non-prompting read, the request button before the first ask,
 * then a link to System Settings › Accessibility. The status line is plain text, never a coloured pending label.
 */
export function TeamsDetectionCard({ step: s, setup }: { step: OnboardingStep; setup: Setup }) {
  const heading = s.status === "done" ? "Teams detection is on" : s.status === "blocked" ? "Not available on this Mac" : s.action?.kind === "openSettings" ? "Turn it on in System Settings" : "Accessibility access";
  return <div className={"welcome-permission " + s.status} role="group" aria-label={`Teams call detection: ${heading}`}>
    <span className="welcome-permission-icon" aria-hidden><PhoneCall size={22} /></span>
    <div>
      <strong>{heading}</strong>
      <p className="muted">{s.status === "done" ? "Armed meetings start when the Teams call does." : s.detail}</p>
    </div>
    <StepButton step={s} setup={setup} primary />
  </div>;
}

function Card({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return <div className="welcome-card"><Icon size={20} aria-hidden /><strong>{title}</strong><span className="muted">{children}</span></div>;
}

function Footer({ back, children }: { back?: () => void; children: ReactNode }) {
  return <div className="welcome-footer">{back && <button className="link-button welcome-back" onClick={back}>Back</button>}<span className="welcome-footer-gap" />{children}</div>;
}

/** Download ring: determinate once the size is known, a slow spin before that, a check when done. */
function Ring({ fraction, done }: { fraction?: number; done: boolean }) {
  const circumference = 2 * Math.PI * 52;
  return <div className={"welcome-ring" + (fraction === undefined && !done ? " indeterminate" : "")} aria-hidden>
    <svg viewBox="0 0 124 124"><circle className="track" cx="62" cy="62" r="52" /><circle className="value" cx="62" cy="62" r="52" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (done ? 1 : fraction ?? 0.18))} /></svg>
    <span>{done ? <Check size={34} strokeWidth={2.5} /> : fraction !== undefined ? Math.floor(fraction * 100) + "%" : ""}</span>
  </div>;
}
