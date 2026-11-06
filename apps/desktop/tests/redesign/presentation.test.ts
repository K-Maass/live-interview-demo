import { expect, test } from "vitest";
import { deriveMeetingPresentation, captureRows, laneHealthMessage, validateWidgetAction, consumeWidgetAction } from "../../src/copilot/presentation/model";

test("opening a future meeting stays setup until an actual session exists", () => {
  expect(deriveMeetingPresentation({ targetId: "calendar-event" })).toBe("setup");
  expect(deriveMeetingPresentation({ targetId: "calendar-event", preparationOpen: true })).toBe("preparation");
});
test("an active session does not hijack an unrelated saved record", () => {
  expect(deriveMeetingPresentation({ targetId: "saved-1", selectedRecordId: "saved-1", activeMeetingId: "live-2" })).toBe("review");
  expect(deriveMeetingPresentation({ targetId: "live-2", selectedRecordId: "saved-1", activeMeetingId: "live-2", preparationOpen: true })).toBe("live");
});
test("latest capture failure wins over historical positive audio frames", () => {
  const rows = captureRows({ me: { code: "captureStarted" }, remote: { code: "permissionDenied", detail: "Check system audio permission" } }, { me: 20, remote: 80 }, false, true);
  expect(rows.find((r) => r.lane === "remote")?.status).toBe("unavailable");
  expect(rows.find((r) => r.lane === "me")?.status).toBe("active");
});
test("unknown input health is not advertised as verified capture", () => {
  expect(captureRows({}, {}, false, true).map((r) => r.status)).toEqual(["starting", "starting"]);
  expect(captureRows({}, {}, false, false).map((r) => r.status)).toEqual(["idle", "idle"]);
});
test("a journal or disk warning keeps the lane active with its detail", () => {
  const rows = captureRows({ me: { code: "journalRetrying", detail: "disk I/O error" }, remote: { code: "diskSpaceLow", detail: "1.2 GB free" } }, {}, false, true);
  expect(rows.map((r) => r.status)).toEqual(["active", "active"]);
  expect(rows[0].detail).toBe("disk I/O error");
  expect(captureRows({ remote: { code: "captureRecovered" } }, {}, false, true)[1].status).toBe("active");
  expect(captureRows({ remote: { code: "captureStalled" } }, { remote: 80 }, false, true)[1].status).toBe("unavailable");
});
test("lane health codes become plain sentences; only a lane that stopped capturing is an alert", () => {
  for (const code of ["captureStarting", "captureStarted", "captureRecovered"]) expect(laneHealthMessage("remote", code).tone).toBe("info");
  expect(laneHealthMessage("remote", "captureRecovered").text).toBe("System audio recovered and is recording again.");
  const disk = laneHealthMessage("me", "diskSpaceLow", "Only 1.2 GB free on the recording disk. Recording continues; free space soon.");
  expect(disk).toEqual({ tone: "notice", text: "Only 1.2 GB free on the recording disk. Recording continues; free space soon." });
  const journal = laneHealthMessage("me", "journalRetrying", "disk I/O error");
  expect(journal.tone).toBe("notice");
  expect(journal.text).toMatch(/Recording continues/);
  for (const code of ["captureStalled", "captureInterrupted", "system-audio-silent", "captureEnded", "journalFailed", "captureUnavailable", "somethingNew"]) {
    const message = laneHealthMessage("remote", code);
    expect(message.tone).toBe("alert");
    expect(message.text).toMatch(/^System audio /);
    expect(message.text).not.toContain(code);
  }
});
test("a degraded lane that is still recording carries its notice for the per-lane row", () => {
  const rows = captureRows({ me: { code: "diskSpaceLow", detail: "Only 1.2 GB free on the recording disk. Recording continues; free space soon." }, remote: { code: "captureStarted" } }, {}, false, true);
  expect(rows[0]).toMatchObject({ status: "active", message: { tone: "notice" } });
  expect(rows[1].message).toBeUndefined();
  expect(captureRows({ remote: { code: "captureStalled" } }, {}, false, true)[1].message?.tone).toBe("alert");
});
test("a restarting input is not advertised as active from its older frame count", () => {
  expect(captureRows({ remote: { code: "captureStarting" } }, { remote: 80 }, false, true).find((row) => row.lane === "remote")?.status).toBe("starting");
});
test("a valid widget action targets the existing card in the current owner", () => {
  expect(validateWidgetAction({ version: 1, requestId: "request-a", ownerId: "owner-a", meetingId: "m1", kind: "pin", cardId: "c1" }, "owner-a", "m1", ["c1"])).toEqual({ version: 1, requestId: "request-a", ownerId: "owner-a", meetingId: "m1", kind: "pin", cardId: "c1" });
});
test("stale widget owner, meeting and replaced card actions are ignored", () => {
  const action = { version: 1, requestId: "request-a", ownerId: "owner-a", meetingId: "m1", kind: "dismiss", cardId: "c1" };
  expect(validateWidgetAction(action, "owner-b", "m1", ["c1"])).toBeUndefined();
  expect(validateWidgetAction(action, "owner-a", "m2", ["c1"])).toBeUndefined();
  expect(validateWidgetAction(action, "owner-a", "m1", ["c2"])).toBeUndefined();
});
test("the widget cannot introduce native writes or reasoning operations", () => {
  expect(validateWidgetAction({ version: 1, requestId: "request-a", ownerId: "o", meetingId: "m", kind: "apply_action", cardId: "c" }, "o", "m", ["c"])).toBeUndefined();
  expect(validateWidgetAction(null, "o", "m", [])).toBeUndefined();
});

test("a replayed widget request dispatches only once even while its card remains current", () => {
  const seen = new Set<string>();
  const action = { version: 1, requestId: "request-a", ownerId: "owner-a", meetingId: "m1", kind: "pin", cardId: "c1" };
  expect(consumeWidgetAction(action, "owner-a", "m1", ["c1"], seen)).toBeDefined();
  expect(consumeWidgetAction(action, "owner-a", "m1", ["c1"], seen)).toBeUndefined();
  expect(consumeWidgetAction({ ...action, requestId: "request-b" }, "owner-a", "m1", ["c1"], seen)).toBeDefined();
});

test("the widget can mark only a visible saved pin answered or outdated", () => {
  const action = (kind: string) => ({ version: 1, requestId: "r-" + kind, ownerId: "o", meetingId: "m", kind, cardId: "c1" });
  for (const kind of ["answered", "outdated"]) {
    expect(validateWidgetAction(action(kind), "o", "m", ["c1"], ["c1"])).toEqual(action(kind));
    expect(validateWidgetAction(action(kind), "o", "m", ["c1"], [])).toBeUndefined();
    expect(validateWidgetAction(action(kind), "o", "m", ["c1"])).toBeUndefined();
    expect(validateWidgetAction(action(kind), "o", "m", [], ["c1"])).toBeUndefined();
    expect(validateWidgetAction({ ...action(kind), cardId: undefined }, "o", "m", ["c1"], ["c1"])).toBeUndefined();
  }
  expect(validateWidgetAction(action("unpin"), "o", "m", ["c1"], ["c1"])).toBeUndefined();
  expect(validateWidgetAction(action("reopen"), "o", "m", ["c1"], ["c1"])).toBeUndefined();
});
