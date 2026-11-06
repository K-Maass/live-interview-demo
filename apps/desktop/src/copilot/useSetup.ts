import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CopilotController } from "./useCopilotController";
import type { AppLocation } from "./presentation/types";
import { native } from "../lib/localVoice";
import { PUBLIC_EDITION } from "../lib/edition";
import { describeModelSetup, describeSetupFailure } from "../lib/public/modelSetup";
import {
  deriveOnboarding,
  parseAccess,
  readAccessibility,
  readOnboardingFlags,
  readPermissions,
  shouldOpenWelcome,
  writeOnboardingFlag,
  type Access,
  type OnboardingFlags,
  type OnboardingState,
  type OnboardingStep,
} from "../lib/public/onboarding";

export interface Setup {
  /** Setup applies only to the public edition running in the native app. */
  active: boolean;
  state: OnboardingState;
  /** The last action's failure, in plain words. */
  message: string;
  welcomeOpen: boolean;
  openWelcome: () => void;
  /** Closes the welcome for good on this Mac; Settings › Setup can open it again. */
  finishWelcome: () => void;
  run: (step: OnboardingStep) => Promise<void>;
  /** The test sound came through (true) or not (false). Hearing it is the proof system audio works. */
  confirmSystemAudio: (heard: boolean) => void;
  /** True once the test sound has come through in this session. */
  systemAudioVerified: boolean;
  openPrivacy: (pane: "microphone" | "systemAudio" | "accessibility") => void;
}

const storage = () => { try { return window.localStorage; } catch { return undefined; } };

/**
 * One owner for setup state, shared by the first-launch welcome, the toolbar "Finish setup" button and Settings › Setup,
 * so all three agree. Nothing here records or gates recording.
 */
export function useSetup(c: CopilotController, navigate: (location: AppLocation) => void): Setup {
  const active = PUBLIC_EDITION && native();
  const [flags, setFlags] = useState<OnboardingFlags>(() => readOnboardingFlags(storage()));
  const [microphone, setMicrophone] = useState<Access>("unchecked");
  // A remembered grant is shown until the first status read; the status commands never prompt.
  const [systemAudio, setSystemAudio] = useState<Access>(flags.systemAudioGranted ? "granted" : "unchecked");
  // Teams call detection (Accessibility). Optional, read without prompting; recording never waits for it.
  const [accessibility, setAccessibility] = useState<Access>("unchecked");
  const [checked, setChecked] = useState(false);
  const [requested, setRequested] = useState(false);
  const [message, setMessage] = useState("");
  const [systemAudioVerified, setSystemAudioVerified] = useState(false);
  // A grant from the access check or from a heard test sound is not overturned by a later "not determined" status
  // read: on macOS 26 that read disagreed with a working tap. Only an explicit "denied" (a revocation) overrides it.
  const systemAudioTrusted = useRef(false);
  const flagsRef = useRef(flags);
  flagsRef.current = flags;
  const remember = (flag: keyof OnboardingFlags, value = true) => { writeOnboardingFlag(storage(), flag, value); setFlags((old) => ({ ...old, [flag]: value })); };
  const probeSystemAudio = async () => {
    const result = parseAccess(await invoke<string>("check_system_audio_access"));
    setSystemAudio(result);
    if (result === "granted" || result === "denied") remember("systemAudioGranted", result === "granted");
    systemAudioTrusted.current = result === "granted";
  };
  // Re-reads both permissions with the non-prompting status commands at launch and whenever the window regains focus,
  // so a grant revoked in System Settings no longer shows as done. Prompts come only from the step buttons.
  // Results are ordered: a read that finishes after a newer read or a button action is dropped.
  const sequence = useRef(0);
  const known = useRef({ microphone, systemAudio, accessibility });
  known.current = { microphone, systemAudio, accessibility };
  const recheck = () => {
    const mine = ++sequence.current;
    void readAccessibility((command) => invoke(command), known.current.accessibility).then((reading) => { if (mine === sequence.current) setAccessibility(reading); });
    void readPermissions((command) => invoke(command), known.current).then((reading) => {
      if (mine !== sequence.current) return;
      setMicrophone(reading.microphone);
      if (systemAudioTrusted.current && reading.systemAudio === "notDetermined") return setChecked(true);
      if (reading.systemAudio === "denied") { systemAudioTrusted.current = false; setSystemAudioVerified(false); }
      setSystemAudio(reading.systemAudio);
      if (reading.systemAudioGranted !== undefined && reading.systemAudioGranted !== flagsRef.current.systemAudioGranted) remember("systemAudioGranted", reading.systemAudioGranted);
      setChecked(true);
    });
  };
  useEffect(() => {
    if (!active) return;
    recheck();
    // A status read that never answers must not keep setup hidden.
    const fallback = window.setTimeout(() => setChecked(true), 3000);
    window.addEventListener("focus", recheck);
    return () => { window.clearTimeout(fallback); window.removeEventListener("focus", recheck); };
  }, [active]);

  const state = deriveOnboarding({
    modelsReady: c.ready ? c.ready.recognitionReady : undefined,
    modelsBusy: c.modelSetup.phase === "running",
    modelsCancelling: !!c.modelSetup.cancelling,
    modelsProgress: c.modelSetup.phase === "running" ? describeModelSetup(c.modelSetup) : undefined,
    modelsFailure: c.modelSetup.phase === "failed" && c.modelSetup.failure ? describeSetupFailure(c.modelSetup.failure) : undefined,
    microphone,
    systemAudio,
    accessibility,
    accessibilityRequested: flags.accessibilityRequested,
    signedIn: c.publicProduct.account?.signedIn,
    calendarConnected: c.publicProduct.accounts.length > 0,
    folderConnected: c.publicProduct.workspaces.some((w) => w.roots.length > 0),
    testMeetingRun: flags.testMeetingRun,
    meetingActive: !!c.activeMeeting,
  });
  const recordingActive = !!c.activeMeeting;
  // While a required permission is open, re-read it every two seconds: a grant made in System Settings must show up
  // without the person clicking back into the window, and the webview's focus event does not always fire on return.
  // Status reads only, so this can never raise a prompt.
  // Teams detection is optional, so it is re-read on this timer only after the person asked for it and it is still off.
  const permissionOpen = state.steps.some((s) => ((s.id === "microphone" || s.id === "systemAudio") && s.required && s.status !== "done") || (s.id === "accessibility" && s.action?.kind === "openSettings"));
  useEffect(() => {
    if (!active || !permissionOpen || recordingActive) return;
    const timer = window.setInterval(recheck, 2000);
    return () => window.clearInterval(timer);
  }, [active, permissionOpen, recordingActive]);
  const automatic = shouldOpenWelcome({ native: active, checked, welcomeSeen: flags.welcomeSeen, ready: state.ready, recordingActive });
  // A Mac that is already set up at its first launch never needs the welcome, so it is marked seen without showing it.
  useEffect(() => { if (active && checked && state.ready && !flags.welcomeSeen) remember("welcomeSeen"); }, [active, checked, state.ready, flags.welcomeSeen]);
  // Once open, the welcome stays until the person finishes it, even when the last required step completes inside it.
  useEffect(() => { if (automatic) setRequested(true); }, [automatic]);
  // A meeting always wins: the welcome steps aside. It comes back by itself afterwards only while it was never finished.
  useEffect(() => { if (recordingActive) setRequested(false); }, [recordingActive]);
  const welcomeOpen = active && !recordingActive && requested;

  const run = async (step: OnboardingStep) => {
    const kind = step.action?.kind;
    sequence.current++;
    setMessage("");
    try {
      if (kind === "install") c.installModels();
      else if (kind === "cancel") c.cancelModelInstall();
      else if (kind === "request" && step.id === "accessibility") { remember("accessibilityRequested"); setAccessibility(parseAccess(await invoke<string>("request_accessibility_access"))); }
      else if (kind === "request") setMicrophone(parseAccess(await invoke<string>("request_microphone_access")));
      else if (kind === "check") await probeSystemAudio();
      else if (kind === "openSettings") await invoke("open_privacy_settings", { pane: step.id === "microphone" || step.id === "accessibility" ? step.id : "systemAudio" });
      else if (kind === "go") navigate(step.id === "account" ? { kind: "settings", section: "account" } : step.id === "calendar" ? { kind: "settings", section: "calendars" } : { kind: "knowledge" });
      else if (kind === "run") { await c.startReplay(); remember("testMeetingRun"); }
    } catch (error) {
      setMessage(error === "meetingActive" ? (kind === "run" ? "Finish the current meeting before running a test meeting. Recording is not affected." : "Finish the current meeting before checking system audio.") : kind === "run" ? "The test meeting could not start. Try again." : "That did not work. Open System Settings → Privacy & Security and try again.");
    }
  };

  return {
    active,
    state,
    message,
    welcomeOpen,
    openWelcome: () => { if (!recordingActive) setRequested(true); },
    finishWelcome: () => { remember("welcomeSeen"); setRequested(false); },
    run,
    systemAudioVerified,
    confirmSystemAudio: (heard) => {
      setSystemAudioVerified(heard);
      if (!heard) return;
      systemAudioTrusted.current = true;
      setSystemAudio("granted");
      remember("systemAudioGranted");
    },
    openPrivacy: (pane) => { void invoke("open_privacy_settings", { pane }).catch(() => setMessage("That did not work. Open System Settings → Privacy & Security and try again.")); },
  };
}
