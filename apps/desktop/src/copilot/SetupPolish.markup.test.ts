import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SetupPill } from "./SetupPill";
import { SetupSection } from "./SetupChecklist";
import { TeamsDetectionCard, WelcomeFlow } from "./WelcomeFlow";
import { MicCheck, SystemAudioCheck } from "./SetupAudioCheck";
import type { Setup } from "./useSetup";
import { deriveOnboarding, type OnboardingInput } from "../lib/public/onboarding";
import { SpeechWarmupNotice } from "./SpeechWarmupNotice";
import { settingsGroups } from "./presentation/settingsOverlay";

// Static markup and source checks (no DOM environment in this package) for the setup polish of #106.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("one-time speech warm-up notice", () => {
  test("is a plain note, not an alert or a live region, while the load runs", () => {
    const html = renderToStaticMarkup(createElement(SpeechWarmupNotice, { status: "Preparing local speech (one-time, a few minutes) · recording continues" }));
    expect(html).toContain('role="note"');
    expect(html).toContain("Preparing local speech (one-time, a few minutes)");
    expect(html).toContain("Recording continues");
    expect(html).not.toMatch(/role="(alert|status)"|aria-live/);
  });
  test("renders nothing once speech is ready or when the status is something else", () => {
    for (const status of ["Local", "Warm · local", "Warming local model…"]) expect(renderToStaticMarkup(createElement(SpeechWarmupNotice, { status }))).toBe("");
  });
  test("a warm-up that did not finish still says recording is available", () => {
    expect(renderToStaticMarkup(createElement(SpeechWarmupNotice, { status: "Warm-up pending · local recording still available" }))).toContain("Recording is still available");
  });
  test("is wired into the live page and the setup surfaces, each with Retry", () => {
    for (const file of ["./screens/LiveMeetingPage.tsx", "./screens/MeetingsPage.tsx", "./screens/MeetingSetupPage.tsx", "./screens/SettingsPage.tsx"]) expect(source(file), file).toContain("<SpeechWarmupNotice status={c.speechStatus} onRetry={c.retrySpeech} />");
  });
  test("shows a spinner only while loading; an overdue or unfinished load offers Retry instead (#58)", () => {
    const loading = renderToStaticMarkup(createElement(SpeechWarmupNotice, { status: "Preparing local speech · recording continues", onRetry: () => {} }));
    expect(loading).toContain("<svg");
    expect(loading).not.toContain("Retry");
    for (const status of ["Local speech is taking longer than usual · recording continues", "Warm-up pending · local recording still available"]) {
      const html = renderToStaticMarkup(createElement(SpeechWarmupNotice, { status, onRetry: () => {} }));
      expect(html, status).not.toContain("<svg");
      expect(html, status).toContain(">Retry local speech</button>");
      expect(html, status).toMatch(/Recording (continues|is still available)/);
    }
  });
});

const input: OnboardingInput = { modelsReady: false, modelsBusy: false, microphone: "notDetermined", systemAudio: "unchecked", accessibility: "notDetermined", accessibilityRequested: false, signedIn: false, calendarConnected: false, folderConnected: false, testMeetingRun: false };
const done: OnboardingInput = { ...input, modelsReady: true, microphone: "granted", systemAudio: "granted" };
const setupFor = (state: OnboardingInput, extra: Partial<Setup> = {}): Setup => ({ active: true, state: deriveOnboarding(state), message: "", welcomeOpen: false, openWelcome() {}, finishWelcome() {}, async run() {}, confirmSystemAudio() {}, systemAudioVerified: false, openPrivacy() {}, ...extra });
const render = (type: unknown, props: object) => renderToStaticMarkup(createElement(type as never, props as never));

describe("Finish setup button", () => {
  test("counts the required steps left and names where it goes", () => {
    const html = render(SetupPill, { setup: setupFor(input), meetingActive: false, onOpen() {} });
    expect(html).toContain("Finish setup · 3 left");
    expect(html).toContain('aria-label="Finish setup · 3 left. Open setup"');
  });
  test("is gone once recording is ready, during a meeting, while the welcome is open and outside the native app", () => {
    expect(render(SetupPill, { setup: setupFor(done), meetingActive: false, onOpen() {} })).toBe("");
    expect(render(SetupPill, { setup: setupFor(input), meetingActive: true, onOpen() {} })).toBe("");
    expect(render(SetupPill, { setup: setupFor(input, { welcomeOpen: true }), meetingActive: false, onOpen() {} })).toBe("");
    expect(render(SetupPill, { setup: setupFor(input, { active: false }), meetingActive: false, onOpen() {} })).toBe("");
  });
  test("sits in the Calendar heading next to New meeting, and the old card is gone from the page", () => {
    const page = source("./screens/MeetingsPage.tsx");
    // New meeting is the popover on the Calendar, and the plain button on the Archive and without the public product.
    expect(page).toMatch(/<SetupPill setup=\{setup\} .*? \/>\{view !== "past" && c\.publicProduct\.enabled \? <NewMeetingPopover .*?: <button className="primary" onClick=\{newMeeting\}/);
    expect(page).not.toContain("OnboardingCard");
  });
});

describe("Settings › Setup", () => {
  test("lists every step with its status, including finished ones", () => {
    const html = render(SetupSection, { setup: setupFor(done), meetingActive: false });
    for (const title of ["Local speech models", "Microphone", "System audio", "Teams call detection", "Sign in", "Connect a calendar", "Connect a notes folder", "Try a test meeting"]) expect(html).toContain(title);
    expect(html).toContain("Recording is ready. The remaining steps are optional.");
  });
  test("can open the welcome again, except during a meeting, and says why", () => {
    expect(render(SetupSection, { setup: setupFor(input), meetingActive: false })).toMatch(/<button class="link-button">Show the welcome again<\/button>/);
    const during = render(SetupSection, { setup: setupFor(input), meetingActive: true });
    expect(during).toMatch(/<button class="link-button" disabled="" aria-describedby="setup-welcome-note">Show the welcome again/);
    expect(during).toContain("available after the current meeting ends");
  });
  test("is the first Settings section and replaces the old heading button", () => {
    const page = source("./screens/SettingsPage.tsx");
    expect(settingsGroups({ setupActive: true, publicProduct: true })[0].items[0]).toEqual({ id: "setup", label: "Setup" });
    expect(settingsGroups({ setupActive: false, publicProduct: true })[0].items.map((i) => i.id)).not.toContain("setup");
    expect(page).not.toContain("SetupChecklistEntry");
  });
});

describe("first-launch welcome", () => {
  const html = render(WelcomeFlow, { setup: setupFor(input, { welcomeOpen: true }) });
  test("is a modal dialog named by its heading, and the app behind it is inert", () => {
    expect(html).toMatch(/<div class="welcome-flow" role="dialog" aria-modal="true" aria-labelledby="welcome-heading">/);
    expect(html).toContain('<h1 id="welcome-heading" tabindex="-1">Welcome to Live Interview</h1>');
    expect(source("./CopilotApplication.tsx")).toContain('<div className="app-root" inert={setup.welcomeOpen || !!nav.settings}><AppShell');
  });
  test("names the Accessibility step the same as Settings › Setup", () => {
    expect(html).toContain('<span class="welcome-rail-name">Teams call detection</span>');
    expect(html).not.toContain(">Teams calls<");
  });
  test("lists seven steps in the sidebar, locked until Get started, with the fill empty", () => {
    expect(html.match(/class="welcome-rail-item/g)).toHaveLength(7);
    expect(html.match(/class="welcome-rail-item[^"]*" disabled=""/g)).toHaveLength(6);
    expect(html).toContain('<span class="welcome-rail-name">Teams call detection</span>');
    expect(html).toContain("--fill-rows:0");
    expect(html).toContain('aria-current="step"');
  });
  test("can always be left: Set up later is on every screen, and recording is never mentioned as blocked", () => {
    expect(html).toContain(">Set up later</button>");
    expect(html).toContain("Nothing is recorded while you set up.");
    expect(html).toContain("Get started");
  });
});

describe("Teams call detection (Accessibility)", () => {
  const card = (state: Partial<OnboardingInput>) => {
    const s = deriveOnboarding({ ...done, ...state }).steps.find((x) => x.id === "accessibility")!;
    return render(TeamsDetectionCard, { step: s, setup: setupFor({ ...done, ...state }) });
  };
  test("before the first ask: explains why, says what it never reads, and asks only from the button", () => {
    const html = card({});
    expect(html).toContain('role="group" aria-label="Teams call detection: Accessibility access"');
    expect(html).toContain("notice when a Teams call starts");
    expect(html).toContain("never at what is said or shown");
    expect(html).toContain("Without it, start meetings by hand.");
    expect(html).toMatch(/<button class="primary">Allow Teams detection<\/button>/);
  });
  test("after the ask it links to System Settings › Accessibility instead of asking again", () => {
    const html = card({ accessibilityRequested: true });
    expect(html).toContain("Turn it on in System Settings");
    expect(html).toContain("Privacy &amp; Security › Accessibility");
    expect(html).toContain(">Open Accessibility settings</button>");
    expect(html).not.toContain("Allow Teams detection");
  });
  test("once granted it says so without any button, and uses no pill, badge or pending colour classes", () => {
    const html = card({ accessibility: "granted", accessibilityRequested: true });
    expect(html).toContain("Teams detection is on");
    expect(html).not.toContain("<button");
    for (const state of [{}, { accessibilityRequested: true }, { accessibility: "granted" as const }]) expect(card(state)).not.toMatch(/pill|badge|amber|pending|warning/);
  });
  test("the welcome screen can always be skipped and never disables Continue", () => {
    const flow = source("./WelcomeFlow.tsx");
    expect(flow).toContain("Skip, I’ll start meetings by hand");
    expect(flow).toContain('<TeamsDetectionCard step={s} setup={setup} />');
    expect(flow).toMatch(/Skip, I’ll start meetings by hand<\/button>\}<button className="primary" onClick=\{forward\}>Continue/);
  });
  test("is listed in Settings › Setup as optional with its own action, and does not hold recording back", () => {
    const html = render(SetupSection, { setup: setupFor(done), meetingActive: false });
    expect(html).toMatch(/<strong>Teams call detection<\/strong><small> Optional<\/small>/);
    // "Optional" is said once, by the label; no description repeats it.
    expect(html).not.toMatch(/<p class="muted">Optional\./);
    expect(html).toContain(">Allow Teams detection</button>");
    expect(html).toContain("Recording is ready.");
  });
});

describe("setup audio check", () => {
  test("the microphone meter opens as starting, never as a false 'not listening'", () => {
    const html = render(MicCheck, {});
    expect(html).toContain('role="img" aria-label="Microphone level: not listening"');
    expect(html).toContain("Starting the microphone…");
    expect(html).not.toContain("Not listening.");
    expect(html.match(/class="audio-meter-bar quiet"/g)).toHaveLength(48);
  });
  test("the system audio check waits for a button press before playing anything", () => {
    const html = render(SystemAudioCheck, { onResult() {}, openPrivacy() {} });
    expect(html).toContain("Play a short chime");
    expect(html).toMatch(/<button>.*Play a test sound<\/button>/);
  });
  test("is shown only once access is on, so it can never raise a macOS prompt", () => {
    expect(source("./WelcomeFlow.tsx")).toContain('{s.status === "done" && (mic ? <MicCheck /> : <SystemAudioCheck onResult={setup.confirmSystemAudio} openPrivacy={() => setup.openPrivacy("systemAudio")} />)}');
  });
  test("native side: levels only, refused during a meeting, ended by a meeting start, and never a record", () => {
    const native = readFileSync(new URL("../../src-tauri/src/audio_check.rs", import.meta.url), "utf8");
    const commands = readFileSync(new URL("../../src-tauri/src/commands.rs", import.meta.url), "utf8");
    expect(native).toContain('return Err("meetingActive".into());');
    expect(native).toContain('return Err("notGranted".into());');
    expect(native).toContain("Ok(frames) => loudest = loudest.max(level(&frames.pcm)),");
    expect(native).not.toMatch(/RecordStore|atomic_write|std::fs|transcription::|reasoning::/);
    expect(commands).toContain("if id == crate::audio_check::CHECK_ID {");
    expect(commands).toMatch(/app\.state::<crate::audio_check::AudioCheck>\(\)\.stop\(\);\s*state\.begin_start\(\)\?;/);
  });
});

describe("Settings sections at narrow widths", () => {
  const css = source("./styles/settings.css");
  const narrow = css.match(/@media \(max-width:620px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  test("the section list becomes its own step (list, then section with Back) instead of scrolling sideways with sections out of sight", () => {
    expect(narrow).toContain('.settings-window[data-view="section"] .settings-sidebar,.settings-window[data-view="list"] .settings-main { display:none; }');
    expect(narrow).toContain(".settings-back { display:inline-flex;");
    expect(css).not.toMatch(/\.settings-sidebar \{[^}]*overflow-x/);
  });
});
