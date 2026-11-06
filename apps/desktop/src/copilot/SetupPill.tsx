import { setupPill } from "../lib/public/onboarding";
import type { Setup } from "./useSetup";

/**
 * Toolbar button on Calendar while a required setup step is open. It opens Settings › Setup and disappears once
 * recording is ready. Hidden during a meeting and while the welcome is open.
 */
export function SetupPill({ setup, meetingActive, onOpen }: { setup: Setup; meetingActive: boolean; onOpen: () => void }) {
  const pill = setup.active && !meetingActive && !setup.welcomeOpen ? setupPill(setup.state) : undefined;
  if (!pill) return null;
  const circumference = 2 * Math.PI * 7;
  return <button className="setup-pill" onClick={onOpen} aria-label={pill.label + ". Open setup"}>
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden><circle className="track" cx="9" cy="9" r="7" /><circle className="value" cx="9" cy="9" r="7" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pill.fraction)} /></svg>
    {pill.label}
  </button>;
}
