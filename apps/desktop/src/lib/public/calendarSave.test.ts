import { describe, expect, test } from "vitest";
import type { PublicMeetingPlan } from "@live-interview/core";
import { applyCalendarSave, atMinutes, dragRange, lengthText, monthGrid, moveRange, onDay, resizeRange, withLength, appOnlyPlanRows, calendarChangeSummary, calendarLabel, calendarSaveErrorMessage, calendarSaveState, icsSaveFailure, ICS_SAVE_RETRY, defaultMeetingTimes, writableCalendars } from "./calendarSave";
import { newMeetingPlan } from "./state";

const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
const sync = { nativeEventId: "EK-1", calendarId: "work", calendarName: "Work · iCloud", syncedTitle: "Client sync", syncedStartMs: at(14), syncedEndMs: at(14, 30) };
const plan = (patch: Partial<PublicMeetingPlan> = {}) => ({ ...newMeetingPlan("p", at(9)), title: "Client sync", ...patch });

describe("saving a meeting to a calendar", () => {
  test("a meeting made by hand starts at the next half hour and lasts 30 minutes", () => {
    expect(defaultMeetingTimes(at(9, 10))).toEqual({ startMs: at(9, 30), endMs: at(10) });
    expect(defaultMeetingTimes(at(9, 30))).toEqual({ startMs: at(10), endMs: at(10, 30) });
    const p = newMeetingPlan("p", at(9, 10));
    expect([p.startMs, p.endMs]).toEqual([at(9, 30), at(10)]);
  });
  test("a plan from a calendar event keeps that event's times", () => {
    const event = { id: "e", title: "Kickoff", startMs: at(11), endMs: at(12), accountId: "a", calendarId: "c", provider: "google" as const, sourceEventId: "s" };
    expect(newMeetingPlan("p", at(9), event)).toMatchObject({ startMs: at(11), endMs: at(12), eventId: "e" });
  });
  test("the state says whether the calendar has what the plan says", () => {
    expect(calendarSaveState(plan({ startMs: undefined, endMs: undefined }))).toBe("undated");
    expect(calendarSaveState(plan())).toBe("notSaved");
    expect(calendarSaveState(plan({ eventId: "google:x" }))).toBe("fromCalendar");
    const saved = plan({ eventId: "apple:x", startMs: at(14), endMs: at(14, 30), calendarSync: sync });
    expect(calendarSaveState(saved)).toBe("saved");
    expect(calendarSaveState({ ...saved, endMs: at(15) })).toBe("changed");
    expect(calendarSaveState({ ...saved, title: "Client sync (moved)" })).toBe("changed");
  });
  test("only calendars that accept new events are offered", () => {
    expect(writableCalendars([{ id: "w", name: "Work", account: "iCloud", add: true }, { id: "h", name: "Holidays", account: "Subscribed", add: false }, { id: "x", name: "X", account: "Y" }])).toEqual([{ id: "w", name: "Work", account: "iCloud" }]);
    expect(writableCalendars(undefined)).toEqual([]);
    expect(calendarLabel({ name: "Work", account: "" })).toBe("Work");
  });
  test("the confirmation reads as plain words, with before and after for an update", () => {
    const added = calendarChangeSummary({ after: { title: "Client sync", startMs: at(14), endMs: at(14, 30) }, calendar: "Work · iCloud", timeZone: "Europe/London", locale: "en-GB" });
    expect(added.heading).toBe("Add to calendar");
    expect(added.lines[0]).toBe("Add “Client sync” to Work · iCloud");
    expect(added.lines[1]).toMatch(/Wed.*21 Oct.*14:00.*14:30 \(Europe\/London\)/);
    expect(added.lines.join(" ")).not.toMatch(/[{}]/);
    const moved = calendarChangeSummary({ before: { title: "Client sync", startMs: at(14), endMs: at(14, 30) }, after: { title: "Client sync", startMs: at(15), endMs: at(15, 30) }, calendar: "Work · iCloud", timeZone: "Europe/London", locale: "en-GB" });
    expect(moved.heading).toBe("Update calendar event");
    expect(moved.lines.join("\n")).toMatch(/Time: .*14:00.*→.*15:00/);
    expect(moved.lines.join("\n")).not.toMatch(/Title:/);
  });
  test("errors say what to do and that nothing was changed", () => {
    expect(calendarSaveErrorMessage("calendarApplyFailedOrTargetChanged")).toMatch(/review the update again/i);
    expect(calendarSaveErrorMessage("calendarUnavailable")).toMatch(/Settings/);
    expect(calendarSaveErrorMessage(new Error("x"))).toMatch(/Nothing was changed/);
  });
  test("a calendar-file save offers saving again only when the writer reopened the proposal", () => {
    expect(icsSaveFailure("applyFailedOrTargetChanged")).toEqual({ retry: true, message: ICS_SAVE_RETRY });
    // A refused approval can never succeed under this proposal: say why and close it, no "save it again".
    const refused = icsSaveFailure("approvalFailed");
    expect(refused.retry).toBe(false);
    expect(refused.message).toBe(calendarSaveErrorMessage("approvalFailed"));
    expect(refused.message).not.toMatch(/save it again/i);
    expect(icsSaveFailure(new Error("x")).retry).toBe(false);
  });
  test("dated meetings not in a loaded calendar show on the calendar until an event stands for them", () => {
    const plans = [
      plan({ id: "only-app", startMs: at(14), endMs: at(15) }),
      plan({ id: "linked", eventId: "apple:1", startMs: at(16), endMs: at(17) }),
      plan({ id: "linked-not-loaded", eventId: "apple:2", startMs: at(16), endMs: at(17) }),
      plan({ id: "undated", startMs: undefined, endMs: undefined }),
      plan({ id: "past", startMs: at(8), endMs: at(8, 30) }),
      plan({ id: "cancelled", status: "cancelled", startMs: at(14), endMs: at(15) }),
    ];
    const rows = appOnlyPlanRows(plans, new Set(["apple:1"]), at(9));
    expect(rows.map((r) => r.planId)).toEqual(["only-app", "linked-not-loaded"]);
    expect(rows[0]).toMatchObject({ id: "plan:only-app", title: "Client sync", startMs: at(14) });
  });
  test("the month grid is six Monday-first weeks around the month", () => {
    const days = monthGrid(new Date(2026, 9, 17));
    expect(days).toHaveLength(42);
    expect(new Date(days[0]).toDateString()).toBe(new Date(2026, 8, 28).toDateString());
    expect(new Date(days[0]).getDay()).toBe(1);
    expect(days.some((d) => new Date(d).toDateString() === new Date(2026, 9, 31).toDateString())).toBe(true);
  });
  test("drawing, moving and resizing snap to 15 minutes and stay inside the day", () => {
    expect(dragRange(14 * 60 + 2, 15 * 60 + 31)).toEqual({ start: 14 * 60, end: 15 * 60 + 30 });
    expect(dragRange(15 * 60 + 30, 14 * 60)).toEqual({ start: 14 * 60, end: 15 * 60 + 30 });
    expect(dragRange(600, 603)).toEqual({ start: 600, end: 615 });
    expect(moveRange(14 * 60, 15 * 60, 125)).toEqual({ start: 16 * 60, end: 17 * 60 });
    expect(moveRange(23 * 60, 24 * 60, 90)).toEqual({ start: 23 * 60, end: 24 * 60 });
    expect(moveRange(30, 90, -120)).toEqual({ start: 0, end: 60 });
    expect(resizeRange(14 * 60, 14 * 60 + 3)).toEqual({ start: 14 * 60, end: 14 * 60 + 15 });
    expect(resizeRange(23 * 60, 25 * 60)).toEqual({ start: 23 * 60, end: 24 * 60 });
  });
  test("choosing a day keeps the time of day and length; a first date starts sensibly", () => {
    const current = { startMs: at(14), endMs: at(15, 15) };
    expect(onDay(new Date(2026, 9, 23).getTime(), current)).toEqual({ startMs: at(14, 0, 23), endMs: at(15, 15, 23) });
    expect(onDay(new Date(2026, 9, 23).getTime(), {}, at(9, 10))).toEqual({ startMs: at(9, 0, 23), endMs: at(9, 30, 23) });
    expect(onDay(new Date(2026, 9, 21).getTime(), {}, at(9, 10))).toEqual({ startMs: at(9, 30), endMs: at(10) });
    expect(atMinutes(new Date(2026, 9, 21, 18).getTime(), 90)).toBe(at(1, 30));
  });
  test("length choices keep the start and the length reads naturally", () => {
    expect(withLength({ startMs: at(14) }, 45)).toEqual({ startMs: at(14), endMs: at(14, 45) });
    expect(lengthText(at(14), at(14, 30))).toBe("30 min");
    expect(lengthText(at(14), at(15))).toBe("1 h");
    expect(lengthText(at(14), at(15, 15))).toBe("1 h 15 min");
  });
});

describe("applying a reviewed Add to calendar", () => {
  const pending = { proposalId: "prop-1", calendar: { id: "work", name: "Work", account: "iCloud" } };
  const applied = { applied: true as const, event: { id: "EK-1", calendarId: "work", title: "Client sync", startMs: at(14), endMs: at(14, 30), version: "v1" }, publicEvent: null };
  test("a refused apply says nothing was changed and never touches the plan", async () => {
    let recorded = false;
    const outcome = await applyCalendarSave(pending, { apply: async () => { throw "calendarApplyFailed"; }, recordOnPlan: async () => { recorded = true; } });
    expect(outcome).toEqual({ status: "notApplied", error: "The calendar did not accept the change. Nothing was changed." });
    expect(recorded).toBe(false);
  });
  test("an earlier click that already saved the change is neither an error nor a second plan write", async () => {
    let recorded = false;
    const outcome = await applyCalendarSave(pending, { apply: async () => undefined, recordOnPlan: async () => { recorded = true; } });
    expect(outcome).toEqual({ status: "earlier" });
    expect(recorded).toBe(false);
  });
  test("a replayed apply that returns the earlier result is recorded like a fresh save", async () => {
    const outcome = await applyCalendarSave(pending, { apply: async () => ({ ...applied, alreadyApplied: true }), recordOnPlan: async () => {} });
    expect(outcome.status).toBe("saved");
  });
  test("a plan that cannot be saved after the event was written says the event is saved, and keeps the sync record", async () => {
    const outcome = await applyCalendarSave(pending, { apply: async () => applied, recordOnPlan: async () => { throw new Error("conflict"); } });
    expect(outcome.status).toBe("planNotSaved");
    if (outcome.status !== "planNotSaved") return;
    expect(outcome.error).toContain("Saved to Work · iCloud");
    expect(outcome.error).not.toContain("Nothing was changed");
    expect(outcome.patch.calendarSync).toMatchObject({ nativeEventId: "EK-1", calendarId: "work" });
    // With the record kept on the plan in memory, the plan no longer offers a second add.
    expect(calendarSaveState(plan({ startMs: at(14), endMs: at(14, 30), ...outcome.patch }))).toBe("saved");
  });
  test("a saved add records the native event on the plan", async () => {
    let recorded: Partial<PublicMeetingPlan> | undefined;
    const outcome = await applyCalendarSave(pending, { apply: async () => applied, recordOnPlan: async (patch) => { recorded = patch; } });
    expect(outcome.status).toBe("saved");
    expect(recorded?.calendarSync?.calendarName).toBe("Work · iCloud");
  });
});
