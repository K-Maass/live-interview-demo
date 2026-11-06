import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  deriveOnboarding,
  parseAccess,
  readAccessibility,
  readOnboardingFlags,
  readPermissions,
  setupPill,
  shouldOpenWelcome,
  stepButtonClass,
  welcomeFill,
  writeOnboardingFlag,
  type OnboardingInput,
} from "./onboarding";

const ready: OnboardingInput = {
  modelsReady: true,
  modelsBusy: false,
  microphone: "granted",
  systemAudio: "granted",
  accessibility: "granted",
  accessibilityRequested: true,
  signedIn: true,
  calendarConnected: true,
  folderConnected: true,
  testMeetingRun: true,
};
const fresh: OnboardingInput = {
  ...ready,
  modelsReady: false,
  microphone: "notDetermined",
  systemAudio: "unchecked",
  accessibility: "unchecked",
  accessibilityRequested: false,
  signedIn: false,
  calendarConnected: false,
  folderConnected: false,
  testMeetingRun: false,
};
const step = (input: OnboardingInput, id: string) =>
  deriveOnboarding(input).steps.find((s) => s.id === id)!;

test("a brand-new user sees eight steps in order, only models and the two audio permissions required", () => {
  const { steps, ready: isReady } = deriveOnboarding(fresh);
  expect(steps.map((s) => s.id)).toEqual([
    "models",
    "microphone",
    "systemAudio",
    "accessibility",
    "account",
    "calendar",
    "folder",
    "testMeeting",
  ]);
  expect(steps.filter((s) => s.required).map((s) => s.id)).toEqual([
    "models",
    "microphone",
    "systemAudio",
  ]);
  expect(isReady).toBe(false);
});

test("sign-in, calendar, folder and test meeting never gate readiness", () => {
  const out = deriveOnboarding({
    ...ready,
    signedIn: false,
    calendarConnected: false,
    folderConnected: false,
    testMeetingRun: false,
  });
  expect(out.ready).toBe(true);
  expect(out.requiredRemaining).toBe(0);
});

test("models: checking while readiness is unknown, installable when missing, busy while downloading", () => {
  expect(step({ ...fresh, modelsReady: undefined }, "models").status).toBe("checking");
  const missing = step(fresh, "models");
  expect(missing.status).toBe("todo");
  expect(missing.action).toEqual({ kind: "install", label: "Set up local models" });
  const busy = step({ ...fresh, modelsBusy: true }, "models");
  expect(busy.status).toBe("checking");
  expect(busy.action).toEqual({ kind: "cancel", label: "Cancel download" });
  expect(step({ ...fresh, modelsBusy: true, modelsCancelling: true }, "models").action).toEqual({ kind: "cancel", label: "Cancelling…" });
  expect(step(ready, "models").status).toBe("done");
});

test("models: a running download shows its progress, and a failed one offers a retry that explains the recovery", () => {
  const progress = { fraction: 0.4, headline: "Downloading the speech recognition model", detail: "1.3 GB of 3.2 GB" };
  const running = step({ ...fresh, modelsBusy: true, modelsProgress: progress }, "models");
  expect(running.progress).toEqual(progress);
  expect(running.detail).toBe(progress.headline);
  const failed = step({ ...fresh, modelsFailure: { message: "The connection dropped.", recovery: "Choose Retry." } }, "models");
  expect(failed.status).toBe("todo");
  expect(failed.detail).toContain("The connection dropped. Choose Retry.");
  expect(failed.action).toEqual({ kind: "install", label: "Retry download" });
  // A download that finished elsewhere wins over an old failure.
  expect(step({ ...ready, modelsFailure: { message: "x", recovery: "y" } }, "models").status).toBe("done");
});

test("microphone: prompt when undetermined, Settings when denied or restricted, never auto-granted when unknown", () => {
  expect(step(fresh, "microphone").action).toEqual({ kind: "request", label: "Allow microphone" });
  for (const microphone of ["denied", "restricted"] as const) {
    const s = step({ ...fresh, microphone }, "microphone");
    expect(s.status).toBe("blocked");
    expect(s.action).toEqual({ kind: "openSettings", label: "Open Privacy settings" });
  }
  expect(step({ ...fresh, microphone: "unchecked" }, "microphone").status).toBe("todo");
  expect(step(ready, "microphone").status).toBe("done");
});

test("system audio: explicit check first, Settings when denied, blocked without an action when the OS cannot do it", () => {
  expect(step(fresh, "systemAudio").action).toEqual({ kind: "check", label: "Allow system audio" });
  const denied = step({ ...fresh, systemAudio: "denied" }, "systemAudio");
  expect(denied.status).toBe("blocked");
  expect(denied.action?.kind).toBe("openSettings");
  const unsupported = step({ ...fresh, systemAudio: "unsupported" }, "systemAudio");
  expect(unsupported.status).toBe("blocked");
  expect(unsupported.action).toBeUndefined();
  expect(unsupported.detail).toMatch(/macOS 14\.2/);
  expect(unsupported.required).toBe(false);
  expect(step(ready, "systemAudio").status).toBe("done");
});

test("a Mac without system audio capture is ready with the microphone alone and setup can finish", () => {
  const out = deriveOnboarding({ ...ready, systemAudio: "unsupported" });
  expect(out.ready).toBe(true);
  expect(out.requiredRemaining).toBe(0);
  const required = deriveOnboarding({ ...fresh, systemAudio: "unsupported" }).steps.filter((s) => s.required);
  expect(required.map((s) => s.id)).toEqual(["models", "microphone"]);
});

test("the microphone and system audio steps keep the me/remote lane wording", () => {
  expect(step(fresh, "microphone").detail).toMatch(/“me” lane/);
  expect(step(fresh, "systemAudio").detail).toMatch(/“remote” lane/);
});

test("optional steps carry navigation or run actions and tick only from real state", () => {
  expect(step(fresh, "account").action?.kind).toBe("go");
  expect(step(fresh, "calendar").action?.kind).toBe("go");
  expect(step(fresh, "folder").action?.kind).toBe("go");
  expect(step(fresh, "testMeeting").action).toEqual({ kind: "run", label: "Run test meeting" });
  expect(step(ready, "account").status).toBe("done");
  expect(step(ready, "calendar").status).toBe("done");
  expect(step(ready, "folder").status).toBe("done");
  expect(step(ready, "testMeeting").status).toBe("done");
  expect(step({ ...fresh, signedIn: undefined }, "account").status).toBe("checking");
});

test("the test meeting is described as text only, not audio or guidance acceptance", () => {
  expect(step(fresh, "testMeeting").detail).toMatch(/written conversation.*microphone is off.*no audio.*not test live Teams audio/is);
});

test("the test meeting cannot be started while a meeting runs, and says why in plain words", () => {
  const during = step({ ...fresh, meetingActive: true }, "testMeeting");
  expect(during.action).toEqual({ kind: "run", label: "Run test meeting", disabled: true });
  expect(during.detail).toMatch(/after the current meeting ends.*Recording is not affected/i);
  expect(step(fresh, "testMeeting").action?.disabled).toBeUndefined();
});

test("progress counts completed steps", () => {
  expect(deriveOnboarding(fresh).progress).toEqual({ done: 0, total: 8 });
  expect(deriveOnboarding(ready).progress).toEqual({ done: 8, total: 8 });
});

test("Teams detection: asks from a button first, then links to Accessibility settings, done only when granted", () => {
  const first = step({ ...fresh, accessibility: "notDetermined" }, "accessibility");
  expect(first).toMatchObject({ title: "Teams call detection", required: false, status: "todo", action: { kind: "request", label: "Allow Teams detection" } });
  expect(first.detail).toMatch(/notice when a Teams call starts/);
  expect(first.detail).toMatch(/never at what is said or shown/);
  expect(first.detail).toMatch(/Without it, start meetings by hand\./);
  // Before the first read finishes it is a to-do with the same button, never a guessed grant.
  expect(step(fresh, "accessibility").status).toBe("todo");
  const asked = step({ ...fresh, accessibility: "notDetermined", accessibilityRequested: true }, "accessibility");
  expect(asked.status).toBe("todo");
  expect(asked.action).toEqual({ kind: "openSettings", label: "Open Accessibility settings" });
  expect(asked.detail).toMatch(/Privacy & Security › Accessibility/);
  for (const access of ["denied", "restricted"] as const) expect(step({ ...fresh, accessibility: access }, "accessibility").action?.kind).toBe("openSettings");
  for (const [access, status] of [["granted", "done"], ["unsupported", "blocked"]] as const) {
    const s = step({ ...fresh, accessibility: access, accessibilityRequested: true }, "accessibility");
    expect(s.status).toBe(status);
    expect(s.action).toBeUndefined();
  }
});

test("Teams detection never gates readiness or the Finish setup button", () => {
  for (const accessibility of ["unchecked", "notDetermined", "denied", "unsupported"] as const) {
    const state = deriveOnboarding({ ...ready, accessibility, accessibilityRequested: false });
    expect(state.ready).toBe(true);
    expect(setupPill(state)).toBeUndefined();
  }
  expect(setupPill(deriveOnboarding({ ...fresh, accessibility: "granted" }))?.label).toBe("Finish setup · 3 left");
});

test("silent Accessibility re-check calls only the non-prompting status command and keeps the last answer on failure", async () => {
  const call = stubStatus({ accessibility_access_status: "granted" });
  expect(await readAccessibility(call, "notDetermined")).toBe("granted");
  expect(call.mock.calls.map(([command]) => command)).toEqual(["accessibility_access_status"]);
  expect(await readAccessibility(stubStatus({ accessibility_access_status: "notDetermined" }), "granted")).toBe("notDetermined");
  expect(await readAccessibility(stubStatus({ accessibility_access_status: new Error("boom") }), "granted")).toBe("granted");
  expect(await readAccessibility(stubStatus({ accessibility_access_status: "yes" }), "notDetermined")).toBe("notDetermined");
});

test("the grant made in System Settings is picked up by the timed re-check, which runs only after the ask", () => {
  const source = readFileSync(new URL("../../copilot/useSetup.ts", import.meta.url), "utf8");
  expect(source).toContain('(s.id === "accessibility" && s.action?.kind === "openSettings")');
  expect(source).toContain('readAccessibility((command) => invoke(command), known.current.accessibility)');
  expect(source).toMatch(/kind === "request" && step\.id === "accessibility"\) \{ remember\("accessibilityRequested"\); setAccessibility\(parseAccess\(await invoke<string>\("request_accessibility_access"\)\)\); \}/);
});

const welcome = { native: true, checked: true, welcomeSeen: false, ready: false, recordingActive: false };
test("the welcome opens by itself once, only in the native app, outside a meeting and while a required step is open", () => {
  expect(shouldOpenWelcome(welcome)).toBe(true);
  expect(shouldOpenWelcome({ ...welcome, welcomeSeen: true })).toBe(false);
  expect(shouldOpenWelcome({ ...welcome, native: false })).toBe(false);
  expect(shouldOpenWelcome({ ...welcome, recordingActive: true })).toBe(false);
  expect(shouldOpenWelcome({ ...welcome, ready: true })).toBe(false);
});

test("the welcome waits for the first permission read, so a Mac that is already set up never sees it flash", () => {
  expect(shouldOpenWelcome({ ...welcome, checked: false })).toBe(false);
});

const steps = (input: Partial<OnboardingInput>) => deriveOnboarding({ ...fresh, ...input }).steps;
test("the sidebar fill is empty before Get started and full only on the last screen with every required step done", () => {
  expect(welcomeFill(steps({}), { started: false, reachedEnd: false })).toBe(0);
  expect(welcomeFill(steps({}), { started: true, reachedEnd: false })).toBe(1);
  expect(welcomeFill(deriveOnboarding(ready).steps, { started: true, reachedEnd: false })).toBe(5);
  expect(welcomeFill(deriveOnboarding(ready).steps, { started: true, reachedEnd: true })).toBe(7);
});

test("the Teams calls row fills once detection is on, and a skipped one does not hold the last screen short", () => {
  const audioDone = { modelsReady: true, microphone: "granted", systemAudio: "granted" } as const;
  expect(welcomeFill(steps({ ...audioDone, accessibility: "granted" }), { started: true, reachedEnd: false })).toBe(5);
  expect(welcomeFill(steps(audioDone), { started: true, reachedEnd: false })).toBe(4);
  expect(welcomeFill(steps(audioDone), { started: true, reachedEnd: true })).toBe(7);
});

test("the models row fills with the download, and a skipped permission leaves its row empty", () => {
  const downloading = steps({ modelsBusy: true, modelsProgress: { fraction: 0.5, headline: "Downloading", detail: "" } });
  expect(welcomeFill(downloading, { started: true, reachedEnd: false })).toBe(1.5);
  expect(welcomeFill(steps({ modelsBusy: true, modelsProgress: { headline: "Starting", detail: "" } }), { started: true, reachedEnd: false })).toBe(1);
  const micSkipped = steps({ modelsReady: true, systemAudio: "granted" });
  expect(welcomeFill(micSkipped, { started: true, reachedEnd: true })).toBe(6);
});

test("a Mac without system audio capture fills that row, since it is not required there", () => {
  expect(welcomeFill(steps({ modelsReady: true, microphone: "granted", systemAudio: "unsupported" }), { started: true, reachedEnd: true })).toBe(7);
});

test("the toolbar button counts required steps left and disappears once recording is ready", () => {
  expect(setupPill(deriveOnboarding(fresh))).toEqual({ label: "Finish setup · 3 left", fraction: 0 });
  expect(setupPill(deriveOnboarding({ ...fresh, modelsReady: true }))?.label).toBe("Finish setup · 2 left");
  expect(setupPill(deriveOnboarding({ ...ready, signedIn: false }))).toBeUndefined();
  expect(setupPill(deriveOnboarding(ready))).toBeUndefined();
});

test("the toolbar button returns when a required permission is revoked", () => {
  expect(setupPill(deriveOnboarding({ ...ready, microphone: "denied" }))?.label).toBe("Finish setup · 1 left");
});

test("while only the download is left, the toolbar button shows the download", () => {
  const input = { ...ready, modelsReady: false, modelsBusy: true };
  expect(setupPill(deriveOnboarding({ ...input, modelsProgress: { fraction: 0.643, headline: "Downloading", detail: "" } }))).toEqual({ label: "Speech models · 64%", fraction: (0.643 + 2) / 3 });
  expect(setupPill(deriveOnboarding({ ...input, modelsProgress: { headline: "Starting", detail: "" } }))?.label).toBe("Downloading speech models");
});

test("parseAccess accepts only the known codes and never invents a grant", () => {
  for (const code of ["granted", "denied", "notDetermined", "restricted", "unsupported"])
    expect(parseAccess(code)).toBe(code);
  for (const bad of ["", "Granted", "authorized", undefined, null, 3, {}])
    expect(parseAccess(bad)).toBe("unchecked");
});

test("flags default to false, persist per key and survive unavailable storage", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  expect(readOnboardingFlags(storage)).toEqual({ welcomeSeen: false, testMeetingRun: false, systemAudioGranted: false, accessibilityRequested: false });
  writeOnboardingFlag(storage, "welcomeSeen");
  writeOnboardingFlag(storage, "systemAudioGranted");
  writeOnboardingFlag(storage, "accessibilityRequested");
  expect(readOnboardingFlags(storage)).toEqual({ welcomeSeen: true, testMeetingRun: false, systemAudioGranted: true, accessibilityRequested: true });
  writeOnboardingFlag(storage, "systemAudioGranted", false);
  expect(readOnboardingFlags(storage).systemAudioGranted).toBe(false);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(readOnboardingFlags(broken)).toEqual({ welcomeSeen: false, testMeetingRun: false, systemAudioGranted: false, accessibilityRequested: false });
  expect(() => writeOnboardingFlag(broken, "welcomeSeen")).not.toThrow();
  expect(readOnboardingFlags(undefined).welcomeSeen).toBe(false);
});

const none = { microphone: "unchecked", systemAudio: "unchecked" } as const;
const stubStatus = (answers: Record<string, string | Error>) =>
  vi.fn(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer;
  });

test("silent re-check calls only the two non-prompting status commands", async () => {
  const call = stubStatus({ microphone_access_status: "granted", system_audio_access_status: "granted" });
  await readPermissions(call, none);
  expect(call.mock.calls.map(([command]) => command).sort()).toEqual(["microphone_access_status", "system_audio_access_status"]);
});

test("a permission revoked in System Settings no longer reads as done, and the remembered grant follows it", async () => {
  const reading = await readPermissions(stubStatus({ microphone_access_status: "denied", system_audio_access_status: "denied" }), { microphone: "granted", systemAudio: "granted" });
  expect(reading).toEqual({ microphone: "denied", systemAudio: "denied", systemAudioGranted: false });
  expect(step({ ...ready, ...reading }, "microphone").status).toBe("blocked");
  expect(step({ ...ready, ...reading }, "systemAudio").status).toBe("blocked");
  expect(deriveOnboarding({ ...ready, ...reading }).ready).toBe(false);
});

test("a grant made in System Settings is picked up and remembered", async () => {
  const reading = await readPermissions(stubStatus({ microphone_access_status: "granted", system_audio_access_status: "granted" }), none);
  expect(reading).toEqual({ microphone: "granted", systemAudio: "granted", systemAudioGranted: true });
});

test("not determined stays a to-do and is never reported as granted by a re-check", async () => {
  const reading = await readPermissions(stubStatus({ microphone_access_status: "notDetermined", system_audio_access_status: "notDetermined" }), none);
  expect(reading.microphone).toBe("notDetermined");
  expect(reading.systemAudio).toBe("notDetermined");
  expect(reading.systemAudioGranted).toBe(false);
});

test("when macOS cannot report system audio, the remembered grant is the answer and is not rewritten", async () => {
  const unchecked = { microphone_access_status: "granted", system_audio_access_status: "unchecked" };
  expect(await readPermissions(stubStatus(unchecked), { microphone: "unchecked", systemAudio: "granted" })).toEqual({ microphone: "granted", systemAudio: "granted" });
  expect(await readPermissions(stubStatus(unchecked), none)).toEqual({ microphone: "granted", systemAudio: "unchecked" });
  expect(await readPermissions(stubStatus(unchecked), { microphone: "granted", systemAudio: "denied" })).toEqual({ microphone: "granted", systemAudio: "denied" });
});

test("a failing status command degrades to unchecked instead of throwing", async () => {
  const reading = await readPermissions(stubStatus({ microphone_access_status: new Error("boom"), system_audio_access_status: new Error("boom") }), none);
  expect(reading).toEqual({ microphone: "unchecked", systemAudio: "unchecked" });
  const known = await readPermissions(stubStatus({ microphone_access_status: new Error("boom"), system_audio_access_status: new Error("boom") }), { microphone: "granted", systemAudio: "denied" });
  expect(known).toEqual({ microphone: "granted", systemAudio: "denied" });
});

test("older macOS reports system audio unsupported without blocking the checklist", async () => {
  const reading = await readPermissions(stubStatus({ microphone_access_status: "granted", system_audio_access_status: "unsupported" }), none);
  expect(reading.systemAudio).toBe("unsupported");
  expect(deriveOnboarding({ ...ready, ...reading }).ready).toBe(true);
});

test("Cancel download is a neutral action while Set up and Retry stay primary", () => {
  const modelStep = (input: Partial<OnboardingInput>) => deriveOnboarding({ ...fresh, microphone: "granted", systemAudio: "granted", ...input }).steps.find((s) => s.id === "models")!;
  const running = modelStep({ modelsReady: false, modelsBusy: true });
  expect(running.action?.kind).toBe("cancel");
  expect(stepButtonClass(running)).toBe("");
  expect(stepButtonClass(modelStep({ modelsReady: false, modelsBusy: true, modelsCancelling: true }))).toBe("");
  const first = modelStep({ modelsReady: false });
  expect(first.action?.kind).toBe("install");
  expect(stepButtonClass(first)).toBe("primary");
  const failed = modelStep({ modelsReady: false, modelsFailure: { message: "Offline.", recovery: "Reconnect and retry." } as never });
  expect(failed.action?.label).toBe("Retry download");
  expect(stepButtonClass(failed)).toBe("primary");
  expect(stepButtonClass({ required: false, action: { kind: "go", label: "Open Calendars" } })).toBe("");
  expect(stepButtonClass({ required: true })).toBe("");
});
