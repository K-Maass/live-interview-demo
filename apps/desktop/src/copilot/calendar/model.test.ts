import { describe, expect, test } from "vitest";
import type { PublicMeetingPlan } from "@live-interview/core";
import type { UpcomingMeeting } from "../presentation/types";
import { legacyAllDay } from "../../lib/public/legacyAllDay";
import { itemDays, toCalendarItems } from "./model";
import { readinessFor } from "./readiness";

const at = (day: number, h = 9, m = 0) => new Date(2026, 9, day, h, m).getTime();
const event = (id: string, extra: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({ id, title: "Meeting " + id, startMs: at(13), endMs: at(13, 10), ...extra });
const plan = (eventId: string | undefined, extra: Partial<PublicMeetingPlan> = {}) => ({ id: "p-" + eventId, eventId, status: "draft", automaticPreparation: false, ...extra }) as PublicMeetingPlan;
const build = (upcoming: UpcomingMeeting[], rest: Partial<Parameters<typeof toCalendarItems>[0]> = {}) => toCalendarItems({ upcoming, plans: [], accounts: [], enabled: true, ...rest });

describe("readinessFor", () => {
  test("keeps the exact words the Calendar already used", () => {
    expect(readinessFor("e1", [plan("e1", { status: "prepared" })], true)).toEqual({ tone: "ready", text: "Brief ready" });
    expect(readinessFor("e1", [plan("e1", { automaticPreparation: true })], true)).toEqual({ tone: "draft", text: "Auto-prep on" });
    expect(readinessFor("e1", [plan("e1")], true)).toEqual({ tone: "draft", text: "Plan started" });
    expect(readinessFor("e1", [plan("other")], true)).toEqual({ tone: "none", text: "No brief" });
    expect(readinessFor("plan:abc", [], true)).toEqual({ tone: "unsynced", text: "Only in this app" });
  });
  test("a prepared plan beats auto-prep, and nothing is read when the public product is off", () => {
    expect(readinessFor("e1", [plan("e1", { status: "prepared", automaticPreparation: true })], true).text).toBe("Brief ready");
    expect(readinessFor("e1", [plan("e1", { status: "prepared" })], false)).toEqual({ tone: "none", text: "No brief" });
  });
});

describe("toCalendarItems", () => {
  test("carries readiness, recurrence, join link and the original row", () => {
    const source = event("e1", { recurring: true, joinUrl: "https://meet.example.test/x" });
    const [item] = build([source], { plans: [plan("e1", { status: "prepared" })] });
    expect(item).toMatchObject({ id: "e1", recurring: true, joinUrl: "https://meet.example.test/x", readiness: "ready", readinessText: "Brief ready", isPlan: false, allDay: undefined });
    expect(item.source).toBe(source);
  });
  test("plan rows are 'Only in this app' and never all-day", () => {
    const [item] = build([{ id: "plan:1", title: "Mine", startMs: at(13, 0), endMs: at(15, 0) }]);
    expect(item).toMatchObject({ isPlan: true, readiness: "unsynced", readinessText: "Only in this app", allDay: undefined });
  });
  test("the user's own address is not listed among the people, other accounts' addresses are", () => {
    const attendees = [{ name: "Demo User", email: "Demo@example.test" }, { name: "Alex Morgan", email: "alex@example.test" }, { name: "", email: "sam@example.test" }, { name: "Alex Morgan" }];
    const accounts = [{ id: "a", email: "demo@example.test" }, { id: "b", email: "alex@example.test" }];
    expect(build([event("e1", { attendees, accountId: "a" })], { accounts })[0].people).toEqual(["Alex Morgan", "sam@example.test"]);
    expect(build([event("e1", { attendees, accountId: "b" })], { accounts })[0].people).toEqual(["Demo User", "sam@example.test", "Alex Morgan"]);
    expect(build([event("e1", { attendees, accountId: "unknown" })], { accounts })[0].people).toEqual(["Demo User", "Alex Morgan", "sam@example.test"]);
  });
  test("filters by title, case-insensitively, and sorts by start", () => {
    const list = build([event("b", { title: "Budget review", startMs: at(14) }), event("a", { title: "Team review", startMs: at(13) }), event("c", { title: "Lunch", startMs: at(12) })], { query: " REVIEW " });
    expect(list.map((i) => i.id)).toEqual(["a", "b"]);
    expect(build([event("a")], { query: "   " })).toHaveLength(1);
  });
  test("uses the flags the data layer sends for all-day events", () => {
    const items = build([
      event("d", { isAllDay: true, startDay: "2026-10-14", endDay: "2026-10-16", startMs: at(14, 0), endMs: at(16, 0) }),
      event("t", { isAllDay: false, startMs: at(14, 0), endMs: at(15, 0) }),
    ]);
    const flagged = items.find((i) => i.id === "d")!, notAllDay = items.find((i) => i.id === "t")!;
    expect(flagged.allDay).toEqual({ startDay: "2026-10-14", endDay: "2026-10-16" });
    expect(notAllDay.allDay).toBeUndefined();
  });
  test("an all-day flag without days takes them from the local midnights, and a span is at least a day", () => {
    expect(build([event("d", { isAllDay: true, startMs: at(14, 0), endMs: at(15, 0) })])[0].allDay).toEqual({ startDay: "2026-10-14", endDay: "2026-10-15" });
    expect(build([event("d", { isAllDay: true, startDay: "2026-10-14", endDay: "2026-10-14", startMs: at(14, 0), endMs: at(14, 0) })])[0].allDay).toEqual({ startDay: "2026-10-14", endDay: "2026-10-15" });
  });
  test("a row from before the flag existed is guessed only when the flag is absent", () => {
    const midnight = { startMs: at(14, 0), endMs: at(15, 0) };
    expect(build([event("old", midnight)])[0].allDay).toEqual({ startDay: "2026-10-14", endDay: "2026-10-15" });
    expect(build([event("new", { ...midnight, isAllDay: false })])[0].allDay).toBeUndefined();
    expect(build([event("short", { startMs: at(14, 9), endMs: at(14, 10) })])[0].allDay).toBeUndefined();
  });
});

describe("legacyAllDay (shared helper)", () => {
  test("whole local days from local midnight, whole days from UTC midnight, nothing else", () => {
    expect(legacyAllDay({ startMs: at(14, 0), endMs: at(17, 0) })).toEqual({ startDay: "2026-10-14", endDay: "2026-10-17" });
    expect(legacyAllDay({ startMs: Date.UTC(2026, 9, 14), endMs: Date.UTC(2026, 9, 15) })).toEqual({ startDay: "2026-10-14", endDay: "2026-10-15" });
    expect(legacyAllDay({ startMs: at(14, 8), endMs: at(15, 8) })).toBeUndefined();
    expect(legacyAllDay({ startMs: at(14, 0), endMs: at(14, 12) })).toBeUndefined();
  });
});

describe("itemDays", () => {
  test("a timed meeting is on one day, an overnight one on two, one ending at midnight on one", () => {
    expect(itemDays({ startMs: at(14, 9), endMs: at(14, 10) })).toEqual(["2026-10-14"]);
    expect(itemDays({ startMs: at(14, 22), endMs: at(15, 2) })).toEqual(["2026-10-14", "2026-10-15"]);
    expect(itemDays({ startMs: at(14, 22), endMs: at(15, 0) })).toEqual(["2026-10-14"]);
    expect(itemDays({ startMs: at(14, 9), endMs: at(14, 9) })).toEqual(["2026-10-14"]);
  });
  test("an all-day event lists its days, end exclusive", () => {
    expect(itemDays({ startMs: 0, endMs: 0, allDay: { startDay: "2026-10-30", endDay: "2026-11-02" } })).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
