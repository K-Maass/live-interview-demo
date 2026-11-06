import { describe, expect, test } from "vitest";
import type { PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import { READ_ONLY_REASONS } from "./dayEdit";
import { NOT_LOADED_REASON, dayLoadRange, dayPanelMeetings, eventMovability, movedText, pendingForPanel, planMovability, routeProposal } from "./dayPanelMeetings";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, 21 + d, h, m).getTime();
const DAY = at(0, 0);
const ev = (id: string, h: number, extra: Partial<PublicCalendarEvent> = {}): PublicCalendarEvent => ({
  id, title: id, startMs: at(0, h), endMs: at(0, h, 30), accountId: "device", calendarId: "work", provider: "apple", sourceEventId: id,
  readOnly: false, calendarWritable: true, ...extra,
});
const plan = (id: string, extra: Partial<PublicMeetingPlan> = {}): PublicMeetingPlan => ({
  id, title: id, startMs: at(0, 13), endMs: at(0, 13, 30), workspaceId: "default", sourceIds: [], sharedLibraryIds: [], profileId: "workClient",
  attendees: [], objectives: [], publicResearchTopics: [], briefDraft: "", automaticPreparation: false, revision: 1, updatedAtMs: 0, status: "draft", ...extra,
} as PublicMeetingPlan);
const names = (id: string) => (id === "work" ? "Work" : undefined);

describe("movability mapping", () => {
  test("Google and Microsoft are read-only; macOS writable single timed events are reviewed", () => {
    expect(eventMovability(ev("g", 9, { provider: "google" }))).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.google });
    expect(eventMovability(ev("m", 9, { provider: "microsoft" }))).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.microsoft });
    expect(eventMovability(ev("a", 9), { calendarName: "Work" })).toEqual({ kind: "review", calendarName: "Work" });
  });
  test("repeating, all-day and read-only calendars are locked with their reason", () => {
    expect(eventMovability(ev("r", 9, { recurring: true }))).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.recurring });
    expect(eventMovability(ev("d", 0, { isAllDay: true }))).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.allDay });
    expect(eventMovability(ev("ro", 9, { readOnly: true, calendarWritable: false }))).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.calendar });
    // A macOS event the list does not say is writable is not offered.
    expect(eventMovability(ev("unknown", 9, { readOnly: undefined, calendarWritable: undefined })).kind).toBe("readOnly");
  });
  test("an invitation is reviewed with the warning; the native read overrides the list; the app's own event is not one", () => {
    expect(eventMovability(ev("i", 9, { invitation: true }), { calendarName: "Work" })).toEqual({ kind: "review", calendarName: "Work", invitation: true });
    expect(eventMovability(ev("i", 9, { invitation: true }), { invitation: false })).toEqual({ kind: "review", calendarName: "your calendar" });
    expect(eventMovability(ev("own", 9), { invitation: true })).toMatchObject({ invitation: true });
    expect(eventMovability(ev("app", 9, { invitation: true }), { appCreated: true })).toEqual({ kind: "review", calendarName: "your calendar" });
  });
  test("plans: only in this app or added by it are direct; opened from an unloaded calendar event is locked", () => {
    expect(planMovability(plan("p"))).toEqual({ kind: "direct" });
    expect(planMovability(plan("p", { eventId: "x", calendarSync: { nativeEventId: "n", calendarId: "work", calendarName: "Work", syncedTitle: "p", syncedStartMs: 0, syncedEndMs: 0 } }))).toEqual({ kind: "direct" });
    expect(planMovability(plan("p", { eventId: "x" }))).toEqual({ kind: "readOnly", reason: NOT_LOADED_REASON });
  });
});

describe("the day's meetings", () => {
  test("events and in-app plans of the day, a linked plan once (as its event), this meeting marked", () => {
    const events = [ev("standup", 9, { recurring: true }), ev("partner", 11, { invitation: true }), ev("client", 15), ev("tomorrow", 9, { startMs: at(1, 9), endMs: at(1, 10) })];
    const linked = plan("p-client", { eventId: "client", startMs: at(0, 15), endMs: at(0, 15, 30) });
    const focus = plan("p-focus", { startMs: at(0, 13), endMs: at(0, 14) });
    const cancelled = plan("p-cancelled", { status: "cancelled" });
    const undated = plan("p-undated", { startMs: undefined, endMs: undefined });
    const list = dayPanelMeetings({ day: DAY + 5 * 3_600_000, events, plans: [linked, focus, cancelled, undated], current: linked, calendarName: names });
    expect(list.map((m) => m.id)).toEqual(["standup", "partner", "plan:p-focus", "client"]);
    const client = list.find((m) => m.id === "client")!;
    expect(client).toMatchObject({ isThis: true, planId: "p-client", eventId: "client", movability: { kind: "review", calendarName: "Work" } });
    expect(list.filter((m) => m.isThis)).toHaveLength(1);
    expect(list.find((m) => m.id === "plan:p-focus")).toMatchObject({ isThis: false, movability: { kind: "direct" }, planId: "p-focus" });
    expect(list.find((m) => m.id === "partner")!.movability).toEqual({ kind: "review", calendarName: "Work", invitation: true });
    expect(list.find((m) => m.id === "standup")!.movability.kind).toBe("readOnly");
  });
  test("the open plan is used over its saved copy, and a plan whose event is not loaded shows as itself", () => {
    const saved = plan("p-this", { startMs: at(0, 9), endMs: at(0, 10) });
    const open = { ...saved, startMs: at(0, 10), endMs: at(0, 11) };
    const fromCalendar = plan("p-other", { eventId: "not-loaded", startMs: at(0, 16), endMs: at(0, 17) });
    const list = dayPanelMeetings({ day: DAY, events: [], plans: [saved, fromCalendar], current: open });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "plan:p-this", startMs: at(0, 10), isThis: true });
    expect(list[1]).toMatchObject({ id: "plan:p-other", movability: { kind: "readOnly" } });
  });
  test("a move under review gives the calendar's own name and invitation answer", () => {
    const list = dayPanelMeetings({ day: DAY, events: [ev("e", 9)], plans: [], pendingMove: { eventId: "e", calendarName: "Work · iCloud", invitation: true } });
    expect(list[0].movability).toEqual({ kind: "review", calendarName: "Work · iCloud", invitation: true });
  });
  test("an all-day event is kept as all-day and an overnight event shows on both days", () => {
    const allDay = ev("holiday", 0, { isAllDay: true, startMs: at(0, 0), endMs: at(1, 0) });
    const late = ev("late", 22, { startMs: at(0, 22), endMs: at(1, 2) });
    expect(dayPanelMeetings({ day: DAY, events: [allDay, late], plans: [] }).map((m) => [m.id, !!m.allDay])).toEqual([["holiday", true], ["late", false]]);
    expect(dayPanelMeetings({ day: at(1, 0), events: [allDay, late], plans: [] }).map((m) => m.id)).toEqual(["late"]);
  });
});

describe("routing a change", () => {
  const events = [ev("cal", 9), ev("locked", 10, { recurring: true })];
  const current = plan("p-this", { startMs: at(0, 13), endMs: at(0, 13, 30) });
  const other = plan("p-other", { startMs: at(0, 15), endMs: at(0, 16) });
  const meetings = dayPanelMeetings({ day: DAY, events, plans: [other], current });
  const range = { startMs: at(0, 14), endMs: at(0, 14, 30) };
  test("this meeting only in the app: its own times, with the old ones for Undo", () => {
    expect(routeProposal("plan:p-this", range, { meetings, events, current })).toEqual({ kind: "thisPlan", range, before: { startMs: at(0, 13), endMs: at(0, 13, 30) }, title: "p-this" });
  });
  test("another in-app plan: its plan is saved", () => {
    expect(routeProposal("plan:p-other", range, { meetings, events, current })).toEqual({ kind: "otherPlan", planId: "p-other", range, before: { startMs: at(0, 15), endMs: at(0, 16) }, title: "p-other" });
  });
  test("a calendar event: reviewed, with the loaded event", () => {
    expect(routeProposal("cal", range, { meetings, events, current })).toEqual({ kind: "calendar", event: events[0], range });
  });
  test("locked, unknown or unloaded: refused with a plain reason, nothing saved", () => {
    expect(routeProposal("locked", range, { meetings, events, current })).toEqual({ kind: "refused", reason: READ_ONLY_REASONS.recurring });
    expect(routeProposal("gone", range, { meetings, events, current }).kind).toBe("refused");
    expect(routeProposal("cal", range, { meetings, events: [], current })).toMatchObject({ kind: "refused", reason: expect.stringContaining("not loaded") });
  });
  test("drawing a time for this untimed meeting sets it", () => {
    const untimed = plan("p-new", { startMs: undefined, endMs: undefined });
    expect(routeProposal("plan:p-new", range, { meetings: [], events, current: untimed, untimedMeetingId: "plan:p-new" })).toEqual({ kind: "thisPlan", range, title: "p-new" });
  });
});

describe("words and ranges", () => {
  test("the toast", () => {
    expect(movedText("Work")).toBe("Moved in Work calendar");
    expect(movedText("Work Calendar")).toBe("Moved in Work Calendar");
    expect(movedText("Work", true)).toBe("Moved back in Work calendar");
  });
  test("the panel's pending for a move", () => {
    expect(pendingForPanel({ eventId: "e", after: { startMs: 1, endMs: 2 } })).toEqual({ meetingId: "e", startMs: 1, endMs: 2 });
    expect(pendingForPanel(undefined)).toBeUndefined();
  });
  test("loading a day widens what is loaded, and loads nothing when it is covered", () => {
    const week = { startMs: at(-2, 0), endMs: at(5, 0) }; // Mon 19 – Mon 26 Oct
    expect(dayLoadRange(at(1, 9), week)).toBeUndefined();
    expect(dayLoadRange(at(7, 9), week)).toEqual({ startMs: week.startMs, endMs: at(12, 0) });
    expect(dayLoadRange(at(0, 9))).toEqual(week);
    // Far away: only that week, not months in between.
    expect(dayLoadRange(at(100, 9), week)).toEqual({ startMs: new Date(2027, 0, 25).getTime(), endMs: new Date(2027, 1, 1).getTime() });
  });
});
