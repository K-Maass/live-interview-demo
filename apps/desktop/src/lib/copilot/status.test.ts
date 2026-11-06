import { describe, expect, test } from "vitest";
import { describeStatus, liveStatusLine, recoveryStatus, statusNotice, type StatusEvent } from "./status";

const codes: StatusEvent[] = [
  { code: "notConnected" }, { code: "guidanceReady", detail: "prepared · 412 ms" }, { code: "refinementPending" },
  { code: "clarificationProvisional" }, { code: "workspaceRefreshing" }, { code: "contextPending" }, { code: "summaryPending" },
  { code: "profilePending" }, { code: "publicEvidence" }, { code: "clarificationOnly" }, { code: "staleWithheld" },
  { code: "refinementUnavailable" }, { code: "reasoningUnavailable" }, { code: "publicResearchUnavailable" },
  { code: "decisionsUnavailable" }, { code: "shortcutUnavailable", detail: "CommandOrControl+Alt+Escape" },
  { code: "recordRecovering" }, { code: "recordRecovered" }, { code: "recordInterrupted" },
];

describe("assistance status model", () => {
  test("a ready guidance status has no words; its timing stays as a diagnostic detail", () => {
    const status = describeStatus({ code: "guidanceReady", detail: "prepared · 412 ms" }, 3);
    expect(status).toMatchObject({ id: 3, severity: "ok", text: "", detail: "prepared · 412 ms", degraded: false });
    expect(liveStatusLine(status)).toBeUndefined();
    expect(statusNotice(status)).toBeUndefined();
  });
  test("no user copy carries timings, codes, pilot labels or raw accelerators", () => {
    for (const event of codes) {
      const { text } = describeStatus(event, 1);
      expect(text).not.toMatch(/\bms\b|pilot|unrated|·|CommandOrControl|Alt\+|[a-z][A-Z]/);
    }
  });
  test("an unavailable shortcut is named with Mac key symbols", () => {
    const status = describeStatus({ code: "shortcutUnavailable", detail: "CommandOrControl+Alt+Escape" }, 1);
    expect(status.text).toBe("The shortcut ⌘⌥⎋ is unavailable. The buttons still work.");
    expect(status.degraded).toBe(true);
  });
  test("the live page shows only impaired assistance; notices carry anything with words, keyed by report", () => {
    expect(liveStatusLine(describeStatus({ code: "contextPending" }, 1))).toBeUndefined();
    expect(liveStatusLine(describeStatus({ code: "reasoningUnavailable" }, 1))).toMatch(/Recording continues/);
    expect(statusNotice(describeStatus({ code: "contextPending" }, 7))?.id).toBe(7);
    const again = [describeStatus({ code: "message", text: "Saved" }, 1), describeStatus({ code: "message", text: "Saved" }, 2)];
    expect(again.map((s) => statusNotice(s)?.id)).toEqual([1, 2]);
  });
  test("free-text messages keep their words and the producer's severity", () => {
    expect(describeStatus({ code: "message", text: "Widget could not open.", severity: "degraded" }, 1)).toMatchObject({ text: "Widget could not open.", degraded: true });
    expect(describeStatus({ code: "message", text: "Saved." }, 1)).toMatchObject({ severity: "info", degraded: false });
  });
  test("a meeting recovered after a crash gets a calm plain line while recovering and once recovered", () => {
    expect(recoveryStatus(undefined)).toBeUndefined();
    const recovering = describeStatus(recoveryStatus({ state: "recovering" })!, 1);
    expect(recovering).toMatchObject({ severity: "info", degraded: false });
    expect(recovering.text).toBe("The app closed during this meeting. What it saved is being processed now.");
    expect(describeStatus(recoveryStatus({ state: "recovered" })!, 1).text).toBe("Recovered after the app closed unexpectedly.");
    const stopped = describeStatus(recoveryStatus({ state: "interrupted" })!, 1);
    expect(stopped.text).toMatch(/Retry processing/);
    expect(liveStatusLine(stopped)).toBeUndefined();
  });
});
