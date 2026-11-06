import { describe, expect, test } from "vitest";
import { lengthLabel, quickMeetingDefaults, quickMeetingProblem, quickMeetingRange, withDay, withRange, withLength } from "./quickMeeting";

const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
const midnight = (day: number) => at(0, 0, day);

describe("New meeting popover", () => {
  test("opens on today at the next half hour for 30 minutes, with no title", () => {
    expect(quickMeetingDefaults(at(9, 10))).toEqual({ title: "", dayMs: midnight(21), startMinutes: 9 * 60 + 30, lengthMinutes: 30 });
    expect(quickMeetingDefaults(at(9, 30)).startMinutes).toBe(10 * 60);
  });
  test("opens on the week or month the Calendar shows when that is later, otherwise on today", () => {
    const nextWeek = { startMs: midnight(26), endMs: midnight(26) + 7 * 86_400_000, layout: "week" as const };
    expect(quickMeetingDefaults(at(9, 10), nextWeek)).toMatchObject({ dayMs: midnight(26), startMinutes: 9 * 60 });
    // November's grid starts on Monday 26 October; the popover opens on 1 November.
    const november = { startMs: midnight(26), endMs: new Date(2026, 11, 7).getTime(), layout: "month" as const };
    expect(quickMeetingDefaults(at(9, 10), november).dayMs).toBe(new Date(2026, 10, 1).getTime());
    const thisWeek = { startMs: midnight(19), endMs: midnight(26), layout: "week" as const };
    expect(quickMeetingDefaults(at(9, 10), thisWeek).dayMs).toBe(midnight(21));
    const lastWeek = { startMs: midnight(12), endMs: midnight(19), layout: "week" as const };
    expect(quickMeetingDefaults(at(9, 10), lastWeek).dayMs).toBe(midnight(21));
    expect(quickMeetingDefaults(at(9, 10), { ...nextWeek, layout: "today" }).dayMs).toBe(midnight(21));
  });
  test("choosing another day keeps the time and length", () => {
    const draft = { title: "Sync", dayMs: midnight(21), startMinutes: 14 * 60, lengthMinutes: 45 };
    expect(withDay(draft, at(16, 0, 23))).toEqual({ ...draft, dayMs: midnight(23) });
  });
  test("the time drawn on the day timeline becomes the start and length", () => {
    const draft = { title: "", dayMs: midnight(21), startMinutes: 9 * 60 + 30, lengthMinutes: 30 };
    expect(withRange(draft, { startMs: at(14, 15), endMs: at(15, 45) })).toMatchObject({ dayMs: midnight(21), startMinutes: 14 * 60 + 15, lengthMinutes: 90 });
    // A meeting drawn to the end of the day ends at midnight, 24:00.
    expect(withRange(draft, { startMs: at(23, 30), endMs: midnight(22) })).toMatchObject({ startMinutes: 23 * 60 + 30, lengthMinutes: 30 });
    expect(withLength({ ...draft, startMinutes: 23 * 60 + 30 }, 60)).toMatchObject({ startMinutes: 23 * 60, lengthMinutes: 60 });
  });
  test("the range is wall-clock time on the chosen day", () => {
    expect(quickMeetingRange({ title: "", dayMs: midnight(21), startMinutes: 14 * 60, lengthMinutes: 45 })).toEqual({ startMs: at(14), endMs: at(14, 45) });
  });
  test("Create needs a title and a time that has not passed", () => {
    const draft = { title: "", dayMs: midnight(21), startMinutes: 14 * 60, lengthMinutes: 30 };
    expect(quickMeetingProblem(draft, at(9))).toBe("Add a title to create the meeting.");
    expect(quickMeetingProblem({ ...draft, title: "   " }, at(9))).toBe("Add a title to create the meeting.");
    expect(quickMeetingProblem({ ...draft, title: "Client sync" }, at(9))).toBeUndefined();
    expect(quickMeetingProblem({ ...draft, title: "Client sync" }, at(15))).toBe("This time has passed. Choose a later time.");
    // A meeting already under way can still be created.
    expect(quickMeetingProblem({ ...draft, title: "Client sync" }, at(14, 10))).toBeUndefined();
  });
  test("lengths read as on the planning page", () => {
    expect([15, 30, 45, 60].map(lengthLabel)).toEqual(["15 min", "30 min", "45 min", "1 h"]);
  });
});
