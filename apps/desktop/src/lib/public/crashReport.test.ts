import { expect, test } from "vitest";
import {
  crashExplanation,
  crashHeadline,
  discardFailedMessage,
  resolveReport,
  sendFailedMessage,
  sendNote,
  sentMessage,
  type CrashReport,
} from "./crashReport";

const report: CrashReport = {
  format: 1,
  id: "11111111-2222-3333-4444-555555555555",
  kind: "panic",
  appVersion: "0.1.0",
  os: "macos 15.4 aarch64",
  day: "2026-10-15",
  frames: [],
};

test("the wording says what is in the report, what is not, and that sending is the person's choice", () => {
  expect(crashHeadline("panic")).toContain("internal error");
  expect(crashHeadline("unexpectedExit")).toContain("did not close normally");
  expect(crashExplanation("unexpectedExit")).toContain("force quit");
  for (const kind of ["panic", "unexpectedExit"]) {
    const text = crashExplanation(kind);
    for (const word of ["audio", "transcripts", "notes", "file paths", "account"]) expect(text).toContain(word);
  }
  expect(sendNote(true)).toContain("Nothing is sent unless you choose");
  expect(sendNote(true)).toContain("Recording");
  expect(sendNote(false)).toContain("cannot send");
});

test("a sent report finishes the notice with a thank-you", async () => {
  const calls: unknown[][] = [];
  const result = await resolveReport(report, true, async (...args) => (calls.push(args), { sent: true }));
  expect(calls).toEqual([[report.id, true]]);
  expect(result).toEqual({ done: true, message: sentMessage });
});

test("a failed send keeps the notice open with a retry message and never throws", async () => {
  const rejected = await resolveReport(report, true, () => Promise.reject("crashReportUnavailable"));
  expect(rejected).toEqual({ done: false, message: sendFailedMessage });
  const refused = await resolveReport(report, true, async () => ({}));
  expect(refused).toEqual({ done: false, message: sendFailedMessage });
  expect(sendFailedMessage).toContain("still saved");
});

test("discarding finishes silently, and a discard that failed says the report stays", async () => {
  expect(await resolveReport(report, false, async () => ({ discarded: true }))).toEqual({ done: true, message: "" });
  expect(await resolveReport(report, false, async () => ({ discarded: false }))).toEqual({ done: false, message: discardFailedMessage });
  expect(await resolveReport(report, false, () => Promise.reject("x"))).toEqual({ done: false, message: discardFailedMessage });
});
