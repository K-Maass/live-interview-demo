import { expect, test } from "vitest";
import type { PublicMeetingPlan } from "@live-interview/core";
import { newMeetingPlan } from "../public/state";
import { capturePlanForStart, startErrorTone, stopErrorStatus, replayRefusal, startErrorMessage, startRecordingSession } from "./startRecording";

const plan = { ...newMeetingPlan("plan-a", 0), title: "Client sync" } as PublicMeetingPlan;
const failing = () => Promise.reject(Error("planConflict"));

test("a failed plan save still yields the unsaved plan so recording can start", async () => {
  const result = await capturePlanForStart({ save: failing, acceptedCallPlan: failing, current: plan });
  expect(result).toEqual({ plan, saveFailed: true });
});

test("a saved plan starts without a save warning", async () => {
  const result = await capturePlanForStart({ save: async () => plan, acceptedCallPlan: failing, current: plan });
  expect(result).toEqual({ plan, saveFailed: false });
});

test("an accepted call whose plan cannot be saved records with an unsaved plan for that call", async () => {
  const result = await capturePlanForStart({ save: failing, acceptedCallPlan: failing, current: plan }, "Teams call with Acme");
  expect(result.saveFailed).toBe(true);
  expect(result.plan?.title).toBe("Teams call with Acme");
  // Accepting a call is not consent to reuse another plan's context.
  expect(result.plan?.sourceIds).toEqual([]);
  expect(result.plan?.retainAudio).toBe(false);
});

test("start rejections that are not permission problems get their own words", () => {
  const generic = startErrorMessage("somethingElse");
  expect(generic).toMatch(/microphone and system-audio permissions/);
  expect(startErrorMessage("captureFlushPending")).toBe("Finishing the previous recording. Try again in a moment.");
  expect(startErrorMessage("anotherInstance")).toBe("Live Interview is already open. Record and review meetings in that window; this one does not record.");
  for (const code of ["captureFlushPending", "startInProgress", "updateInProgress", "diskSpaceInsufficient", "anotherInstance"]) {
    expect(startErrorMessage(code)).not.toBe(generic);
    expect(startErrorMessage(code)).not.toContain(code);
  }
});

test("a test meeting is refused while a meeting runs or a start or stop is in flight", () => {
  expect(replayRefusal({ meetingActive: true, operationActive: false })).toBe("meetingActive");
  expect(replayRefusal({ meetingActive: false, operationActive: true })).toBe("meetingActive");
  expect(replayRefusal({ meetingActive: false, operationActive: false })).toBeUndefined();
});

test("a guidance runtime that throws after native recording started still leaves the meeting live, so Stop works", async () => {
  const steps: string[] = [];
  class ThrowingRuntime { constructor() { throw Error("runtime could not be built"); } }
  const session = await startRecordingSession({
    startNative: async () => { steps.push("native"); },
    startGuidance: () => new ThrowingRuntime(),
    markLive: () => steps.push("live"),
  });
  expect(steps).toEqual(["native", "live"]);
  expect(session).toEqual({ guidance: undefined, guidanceFailed: true });
});
test("a native start that fails never marks the meeting live", async () => {
  const steps: string[] = [];
  await expect(startRecordingSession({
    startNative: async () => { throw "diskSpaceInsufficient"; },
    startGuidance: () => steps.push("guidance"),
    markLive: () => steps.push("live"),
  })).rejects.toBe("diskSpaceInsufficient");
  expect(steps).toEqual([]);
});
test("a normal start returns the guidance runtime it started", async () => {
  const runtime = { started: true };
  expect(await startRecordingSession({ startNative: async () => {}, startGuidance: () => runtime, markLive: () => {} })).toEqual({ guidance: runtime, guidanceFailed: false });
});

test("a second app instance is a calm notice on start and stop; other failures stay alerts", () => {
  expect(startErrorTone("anotherInstance")).toBe("notice");
  expect(startErrorTone("diskSpaceInsufficient")).toBe("alert");
  expect(stopErrorStatus("anotherInstance")).toEqual({ text: startErrorMessage("anotherInstance"), tone: "notice" });
  expect(stopErrorStatus("notActive").tone).toBe("alert");
  expect(stopErrorStatus("notActive").text).toMatch(/meeting is still open/);
});
