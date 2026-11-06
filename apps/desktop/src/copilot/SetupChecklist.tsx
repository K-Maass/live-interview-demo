import { Check, CircleAlert, Circle, LoaderCircle } from "lucide-react";
import { stepButtonClass, type OnboardingStep } from "../lib/public/onboarding";
import type { Setup } from "./useSetup";

export const stepIcon = (status: OnboardingStep["status"], size = 18) =>
  status === "done" ? <Check size={size} aria-hidden /> : status === "blocked" ? <CircleAlert size={size} aria-hidden /> : status === "checking" ? <LoaderCircle size={size} aria-hidden /> : <Circle size={size} aria-hidden />;
export const statusText = { done: "Done", blocked: "Needs attention", checking: "Checking", todo: "To do" } as const;

/** Download progress for the speech models. A determinate bar only once the total size is known. */
export function ModelProgress({ view }: { view: { fraction?: number; headline: string; detail: string } }) {
  return <div className="model-progress">
    <progress max={1} value={view.fraction} aria-label={view.headline} aria-valuetext={view.detail || undefined} />
    {view.detail && <small>{view.detail}</small>}
  </div>;
}

/** A step's own action. Cancelling is never the main action, and a download already running cannot be started twice. */
export function StepButton({ step, setup, primary, onDone }: { step: OnboardingStep; setup: Setup; primary?: boolean; onDone?: () => void }) {
  if (!step.action) return null;
  const busy = setup.state.steps.find((s) => s.id === "models")?.status === "checking";
  const disabled = !!step.action.disabled || (step.action.kind === "install" && busy) || (step.action.kind === "cancel" && step.action.label === "Cancelling…");
  const className = primary === undefined ? stepButtonClass(step) : primary && step.action.kind !== "cancel" ? "primary" : "";
  return <button className={className} disabled={disabled} onClick={() => { onDone?.(); void setup.run(step); }}>{step.action.label}</button>;
}

/**
 * Settings › Setup: every step with its status and action, always available, so anything skipped in the welcome can be
 * finished here. The welcome itself can be opened again from here.
 */
export function SetupSection({ setup, meetingActive }: { setup: Setup; meetingActive: boolean }) {
  const { state } = setup;
  return <section className="setup-section" aria-labelledby="setup-section-title">
    <h2 id="setup-section-title">Setup</h2>
    <p className="muted">{state.ready ? (state.progress.done === state.progress.total ? "Everything is set up." : "Recording is ready. The remaining steps are optional.") : `${state.requiredRemaining} required step${state.requiredRemaining === 1 ? "" : "s"} left before the first meeting. Nothing is recorded while you set up.`}</p>
    <ol className="onboarding-steps">
      {state.steps.map((step) => <li key={step.id} className={"onboarding-step " + step.status}>
        <span className="onboarding-status" role="img" aria-label={statusText[step.status]}>{stepIcon(step.status)}</span>
        <div><strong>{step.title}</strong><small>{step.required ? " Required" : " Optional"}</small><p className="muted">{step.detail}</p>{step.progress && <ModelProgress view={step.progress} />}</div>
        <StepButton step={step} setup={setup} />
      </li>)}
    </ol>
    {setup.message && <p className="notice" role="alert">{setup.message}</p>}
    <button className="link-button" disabled={meetingActive} aria-describedby={meetingActive ? "setup-welcome-note" : undefined} onClick={setup.openWelcome}>Show the welcome again</button>
    {meetingActive && <p className="muted" id="setup-welcome-note">The welcome is available after the current meeting ends. Recording is not affected.</p>}
  </section>;
}
