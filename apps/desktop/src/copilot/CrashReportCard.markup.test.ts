import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import {
  chooseNotNow,
  crashNoticeVisible,
  notNowThisLaunch,
  resetNotNowForTests,
  shouldLoadCrashReport,
} from "../lib/public/crashNotice";
import type { CrashReport } from "../lib/public/crashReport";
import { CrashReportCard } from "./CrashReportCard";

// Static markup (no DOM environment in this package): the wording a person reads before choosing.
const report: CrashReport = {
  format: 1,
  id: "11111111-2222-3333-4444-555555555555",
  kind: "panic",
  appVersion: "0.1.0",
  os: "macos 15.4 aarch64",
  day: "2026-10-15",
  location: "src/commands.rs:42:9",
  frames: ["live_interview_lib::commands::start_local_meeting (src-tauri/src/commands.rs:42)"],
};
const render = (over: { sendAvailable?: boolean; busy?: boolean; message?: string; kind?: string } = {}) =>
  renderToStaticMarkup(
    createElement(CrashReportCard, {
      pending: {
        report: { ...report, kind: over.kind ?? "panic" },
        preview: JSON.stringify(report, null, 2),
        sendAvailable: over.sendAvailable ?? true,
      },
      busy: over.busy ?? false,
      message: over.message ?? "",
      onSend() {},
      onDiscard() {},
      onNotNow() {},
    }),
  );

describe("crash report notice markup", () => {
  test("it shows what is in the report, the exact text, and the three choices", () => {
    const html = render();
    expect(html).toContain("Live Interview hit an internal error last time.");
    expect(html).toContain("never holds meeting audio, transcripts, notes, names, file paths or your account");
    expect(html).toContain("Show exactly what would be sent");
    expect(html).toContain("src-tauri/src/commands.rs:42");
    expect(html).toContain("Nothing is sent unless you choose Send report.");
    for (const label of ["Send report", "Discard", "Not now"]) expect(html).toContain(`>${label}</button>`);
  });
  test("a build without an endpoint offers no Send button and says so", () => {
    const html = render({ sendAvailable: false });
    expect(html).not.toContain("Send report</button>");
    expect(html).toContain("This build cannot send reports");
    expect(html).toContain(">Discard</button>");
  });
  test("an unexpected exit is worded as such, and a result message is announced", () => {
    const html = render({ kind: "unexpectedExit", message: "Could not send the report." });
    expect(html).toContain("did not close normally");
    expect(html).toContain("force quit");
    expect(html).toContain('<p role="status">Could not send the report.</p>');
  });
  test("while a choice is being made every button is disabled", () => {
    expect(render({ busy: true }).match(/disabled=""/g)?.length).toBe(3);
  });
});

describe("crash report notice gating", () => {
  afterEach(resetNotNowForTests);
  test("it loads only in the app, outside a meeting, and not after Not now", () => {
    const open = { native: true, meetingActive: false, notNow: false };
    expect(shouldLoadCrashReport(open)).toBe(true);
    expect(shouldLoadCrashReport({ ...open, native: false })).toBe(false);
    expect(shouldLoadCrashReport({ ...open, meetingActive: true })).toBe(false);
    expect(shouldLoadCrashReport({ ...open, notNow: true })).toBe(false);
  });
  test("a waiting report is hidden during a meeting and shows again when it ends", () => {
    const waiting = { hasReport: true, notNow: false };
    expect(crashNoticeVisible({ ...waiting, meetingActive: false })).toBe(true);
    expect(crashNoticeVisible({ ...waiting, meetingActive: true })).toBe(false);
    expect(crashNoticeVisible({ ...waiting, meetingActive: false })).toBe(true);
    expect(crashNoticeVisible({ hasReport: false, meetingActive: false, notNow: false })).toBe(false);
  });
  test("Not now lasts for the launch, across meetings, until reset", () => {
    expect(notNowThisLaunch()).toBe(false);
    chooseNotNow();
    expect(notNowThisLaunch()).toBe(true);
    expect(crashNoticeVisible({ hasReport: true, meetingActive: false, notNow: notNowThisLaunch() })).toBe(false);
    expect(shouldLoadCrashReport({ native: true, meetingActive: false, notNow: notNowThisLaunch() })).toBe(false);
    resetNotNowForTests();
    expect(notNowThisLaunch()).toBe(false);
  });
});
