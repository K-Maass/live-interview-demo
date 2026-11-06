// Setup state for the first-launch welcome, the toolbar "Finish setup" button and Settings › Setup. Pure: everything is
// derived from existing product state; it owns no connection forms and no readiness truth, and never gates recording
// (AGENTS.md invariants).
import type { ModelSetupView, SetupFailureText } from "./modelSetup";
export type Access = "granted" | "denied" | "notDetermined" | "restricted" | "unsupported" | "unchecked";
export type StepId = "models" | "microphone" | "systemAudio" | "accessibility" | "account" | "calendar" | "folder" | "testMeeting";
export type StepStatus = "done" | "todo" | "blocked" | "checking";
export type StepActionKind = "install" | "request" | "check" | "openSettings" | "go" | "run" | "cancel";
export interface StepAction { kind: StepActionKind; label: string; disabled?: boolean }
export interface OnboardingStep { id: StepId; title: string; detail: string; required: boolean; status: StepStatus; action?: StepAction; progress?: ModelSetupView }
export interface OnboardingInput {
  /** undefined while the first readiness probe is still running */
  modelsReady: boolean | undefined;
  modelsBusy: boolean;
  /** Cancel was pressed and the download has not stopped yet. */
  modelsCancelling?: boolean;
  /** Live download facts while `modelsBusy`; without them the step falls back to a generic line. */
  modelsProgress?: ModelSetupView;
  /** Set after a failed download; the step offers a retry with the recovery text. */
  modelsFailure?: SetupFailureText;
  microphone: Access;
  systemAudio: Access;
  /** Accessibility access for Teams call detection. Optional: without it, meetings are started by hand. */
  accessibility: Access;
  /** The person has asked macOS once. macOS shows its prompt only once, so from then on the step offers System Settings. */
  accessibilityRequested: boolean;
  /** undefined until the account status has loaded */
  signedIn: boolean | undefined;
  calendarConnected: boolean;
  folderConnected: boolean;
  testMeetingRun: boolean;
  /** A meeting is recording or replaying: the test meeting would replace it, so it waits until the meeting ends. */
  meetingActive?: boolean;
}
/** Cancelling is never the main action: only the forward steps (install, retry, allow, open) use the primary style. */
export function stepButtonClass(step: Pick<OnboardingStep, "required" | "action">): string {
  return step.required && step.action && step.action.kind !== "cancel" ? "primary" : "";
}
export interface OnboardingState {
  steps: OnboardingStep[];
  ready: boolean;
  requiredRemaining: number;
  progress: { done: number; total: number };
}

const accessCodes: readonly string[] = ["granted", "denied", "notDetermined", "restricted", "unsupported"];
export const parseAccess = (value: unknown): Access => (typeof value === "string" && accessCodes.includes(value) ? (value as Access) : "unchecked");

const settings: StepAction = { kind: "openSettings", label: "Open Privacy settings" };
function microphoneStep(access: Access): OnboardingStep {
  const base = { id: "microphone" as const, title: "Microphone", required: true };
  const detail = "Your microphone is the “me” lane. Audio is processed on this Mac only.";
  if (access === "granted") return { ...base, detail, status: "done" };
  if (access === "denied" || access === "restricted") return { ...base, status: "blocked", action: settings, detail: access === "restricted" ? "Microphone access is restricted on this Mac. Ask whoever manages it, or open Privacy settings." : "Microphone access was turned off. Turn it on in Privacy settings, then return here." };
  return { ...base, detail, status: "todo", action: { kind: "request", label: "Allow microphone" } };
}
function systemAudioStep(access: Access): OnboardingStep {
  // Below macOS 14.2 nothing can be granted and recording still works from the microphone, so it must not hold setup open.
  const base = { id: "systemAudio" as const, title: "System audio", required: access !== "unsupported" };
  const detail = "Teams and other remote participants are the “remote” lane. macOS asks once; nothing is recorded by checking.";
  if (access === "granted") return { ...base, detail, status: "done" };
  if (access === "unsupported") return { ...base, status: "blocked", detail: "System audio capture needs macOS 14.2 or later. Recording would use the microphone only." };
  if (access === "denied") return { ...base, status: "blocked", action: settings, detail: "System audio recording was turned off. Turn it on in Privacy settings (Screen & System Audio Recording), then return here." };
  return { ...base, detail, status: "todo", action: { kind: "check", label: "Allow system audio" } };
}
/**
 * Teams call detection reads Teams' call controls through Accessibility. It is optional and never gates recording: a
 * meeting can always be started by hand. macOS reports only on or off, so "off" after one request means it was not
 * turned on in System Settings yet, and the step then links there instead of asking again.
 */
function accessibilityStep(access: Access, requested: boolean): OnboardingStep {
  const base = { id: "accessibility" as const, title: "Teams call detection", required: false };
  if (access === "granted") return { ...base, status: "done", detail: "Live Interview notices when a Teams call starts. It never reads what is said or shown." };
  if (access === "unsupported") return { ...base, status: "blocked", detail: "Not available on this Mac. Start meetings by hand." };
  if (requested || access === "denied" || access === "restricted") return { ...base, status: "todo", action: { kind: "openSettings", label: "Open Accessibility settings" }, detail: "Turn on Live Interview in Privacy & Security › Accessibility. It shows as on here once you have. Without it, start meetings by hand." };
  return { ...base, status: "todo", action: { kind: "request", label: "Allow Teams detection" }, detail: "Lets Live Interview notice when a Teams call starts, so a meeting you armed starts recording. It looks only at Teams’ call controls, never at what is said or shown. Without it, start meetings by hand." };
}
function modelsStep(input: OnboardingInput): OnboardingStep {
  const base = { id: "models" as const, title: "Local speech models", required: true };
  if (input.modelsReady) return { ...base, status: "done", detail: "Recognition runs on this Mac." };
  if (input.modelsBusy) return { ...base, status: "checking", detail: input.modelsProgress?.headline ?? "Downloading public model assets for offline use…", progress: input.modelsProgress, action: { kind: "cancel", label: input.modelsCancelling ? "Cancelling…" : "Cancel download" } };
  if (input.modelsFailure && input.modelsReady === false) return { ...base, status: "todo", detail: `${input.modelsFailure.message} ${input.modelsFailure.recovery}`, action: { kind: "install", label: "Retry download" } };
  if (input.modelsReady === undefined) return { ...base, status: "checking", detail: "Checking local models…" };
  return { ...base, status: "todo", detail: "Download the speech models once. Recognition and translation then work offline.", action: { kind: "install", label: "Set up local models" } };
}
const optional = (id: StepId, title: string, done: boolean | undefined, doneDetail: string, todoDetail: string, action: StepAction): OnboardingStep =>
  done === undefined ? { id, title, required: false, status: "checking", detail: "Checking…" } : done ? { id, title, required: false, status: "done", detail: doneDetail } : { id, title, required: false, status: "todo", detail: todoDetail, action };
function testMeetingStep(input: OnboardingInput): OnboardingStep {
  const step = optional("testMeeting", "Try a test meeting", input.testMeetingRun, "You have tried the review flow.", "Replays a short written conversation. The microphone is off and no audio is used, so it does not test live Teams audio or guidance quality.", { kind: "run", label: "Run test meeting" });
  if (!input.meetingActive || !step.action) return step;
  return { ...step, detail: "Available after the current meeting ends. Recording is not affected.", action: { ...step.action, disabled: true } };
}

export function deriveOnboarding(input: OnboardingInput): OnboardingState {
  const steps: OnboardingStep[] = [
    modelsStep(input),
    microphoneStep(input.microphone),
    systemAudioStep(input.systemAudio),
    accessibilityStep(input.accessibility, input.accessibilityRequested),
    optional("account", "Sign in", input.signedIn, "Managed text reasoning is available with your plan.", "Recording and transcription work without an account; sign in for managed guidance and summaries.", { kind: "go", label: "Open Account & plan" }),
    optional("calendar", "Connect a calendar", input.calendarConnected, "Upcoming meetings appear on Meetings.", "Connect Outlook, Google or a macOS calendar to prepare for upcoming meetings.", { kind: "go", label: "Open Calendars" }),
    optional("folder", "Connect a notes folder", input.folderConnected, "Meeting preparation can use your folder.", "Connect a folder so preparation can use your own notes and documents.", { kind: "go", label: "Open Knowledge" }),
    testMeetingStep(input),
  ];
  const requiredRemaining = steps.filter((s) => s.required && s.status !== "done").length;
  const done = steps.filter((s) => s.status === "done").length;
  return { steps, ready: requiredRemaining === 0, requiredRemaining, progress: { done, total: steps.length } };
}

/**
 * The welcome opens by itself once per Mac: in the native app, outside a meeting, after the first permission read (so it
 * never flashes for a Mac that is already set up) and only while a required step is open. "Show the welcome again" in
 * Settings opens it on request.
 */
export function shouldOpenWelcome(input: { native: boolean; checked: boolean; welcomeSeen: boolean; ready: boolean; recordingActive: boolean }): boolean {
  return input.native && input.checked && !input.welcomeSeen && !input.ready && !input.recordingActive;
}

/** How much of a required step is done: 1 when done or not required here, the download fraction while models download. */
function share(step: OnboardingStep): number {
  if (step.status === "done" || !step.required) return 1;
  return step.id === "models" && step.status === "checking" ? Math.max(0, Math.min(1, step.progress?.fraction ?? 0)) : 0;
}
const requiredIds: StepId[] = ["models", "microphone", "systemAudio"];
const shareOf = (steps: OnboardingStep[], id: StepId) => { const s = steps.find((x) => x.id === id); return s ? share(s) : 1; };

/**
 * How far the welcome's sidebar fill reaches, in rail rows from 0 to 7 (Welcome, Speech models, Microphone, System
 * audio, Teams calls, Extras, Ready). Started fills the first row, each required step its own row (the models row creeps
 * with the download), Teams calls fills once detection is on, and reaching the last screen fills the optional rows and
 * Ready. A skipped required step leaves its row empty, so the fill stops short and shows that something is left.
 */
export function welcomeFill(steps: OnboardingStep[], progress: { started: boolean; reachedEnd: boolean }): number {
  if (!progress.started) return 0;
  const teams = progress.reachedEnd || steps.find((s) => s.id === "accessibility")?.status === "done" ? 1 : 0;
  return 1 + requiredIds.reduce((sum, id) => sum + shareOf(steps, id), 0) + teams + (progress.reachedEnd ? 2 : 0);
}

/**
 * The toolbar button shown until every required step is done; undefined once recording is ready. While only the
 * download is left it shows the download; otherwise it counts the required steps left. `fraction` (0–1) drives its ring.
 */
export function setupPill(state: OnboardingState): { label: string; fraction: number } | undefined {
  if (state.ready) return undefined;
  const fraction = requiredIds.reduce((sum, id) => sum + shareOf(state.steps, id), 0) / requiredIds.length;
  const open = state.steps.filter((s) => s.required && s.status !== "done");
  const downloading = open.length === 1 && open[0].id === "models" && open[0].status === "checking" && !!open[0].progress;
  if (downloading) {
    const f = open[0].progress?.fraction;
    return { label: f === undefined ? "Downloading speech models" : `Speech models · ${Math.floor(f * 100)}%`, fraction };
  }
  return { label: `Finish setup · ${state.requiredRemaining} left`, fraction };
}

export interface PermissionReading {
  microphone: Access;
  systemAudio: Access;
  /** Set when the system-audio status was conclusive, so the remembered grant follows a revocation. */
  systemAudioGranted?: boolean;
}
/**
 * Silent permission re-check for launch, focus and when setup is shown. It calls only the two
 * non-prompting status commands, never the request or probe commands, so it cannot raise a macOS
 * prompt. When a status cannot be read, the previous answer is kept (for system audio at launch that is
 * the remembered grant), so a failed read never turns a known state into a to-do or a guess.
 */
export async function readPermissions(call: (command: "microphone_access_status" | "system_audio_access_status") => Promise<unknown>, previous: { microphone: Access; systemAudio: Access }): Promise<PermissionReading> {
  const read = (command: "microphone_access_status" | "system_audio_access_status") => call(command).then(parseAccess, (): Access => "unchecked");
  const [microphoneNow, systemAudio] = await Promise.all([read("microphone_access_status"), read("system_audio_access_status")]);
  const microphone = microphoneNow === "unchecked" ? previous.microphone : microphoneNow;
  if (systemAudio === "unchecked") return { microphone, systemAudio: previous.systemAudio };
  return { microphone, systemAudio, systemAudioGranted: systemAudio === "granted" };
}

/**
 * Silent Accessibility re-check, beside `readPermissions`: it calls only the non-prompting status command, so it can run
 * at launch, on focus and while the person is in System Settings. A failed read keeps the previous answer.
 */
export async function readAccessibility(call: (command: "accessibility_access_status") => Promise<unknown>, previous: Access): Promise<Access> {
  const now = await call("accessibility_access_status").then(parseAccess, (): Access => "unchecked");
  return now === "unchecked" ? previous : now;
}

/**
 * `systemAudioGranted` remembers a past grant so a later launch can show it without probing, which can raise a macOS prompt.
 * `accessibilityRequested` remembers that macOS already showed its Accessibility prompt, so the step links to System Settings.
 */
export interface OnboardingFlags { welcomeSeen: boolean; testMeetingRun: boolean; systemAudioGranted: boolean; accessibilityRequested: boolean }
const flagKey = (flag: keyof OnboardingFlags) => "liveInterview.onboarding." + flag;
const flagNames: (keyof OnboardingFlags)[] = ["welcomeSeen", "testMeetingRun", "systemAudioGranted", "accessibilityRequested"];
export function readOnboardingFlags(storage: Pick<Storage, "getItem"> | undefined): OnboardingFlags {
  const read = (flag: keyof OnboardingFlags) => { try { return storage?.getItem(flagKey(flag)) === "1"; } catch { return false; } };
  return Object.fromEntries(flagNames.map((flag) => [flag, read(flag)])) as unknown as OnboardingFlags;
}
export function writeOnboardingFlag(storage: Pick<Storage, "setItem"> | undefined, flag: keyof OnboardingFlags, value = true) {
  try { storage?.setItem(flagKey(flag), value ? "1" : "0"); } catch { /* setup still works for this session */ }
}
