import { describe, expect, test, vi } from "vitest";

// The time zone must be set before any Date is used in this file; vi.hoisted runs before the imports below.
vi.hoisted(() => { process.env.TZ = "Europe/Zurich"; });
import { allDayLanes, dayBounds, dayKey, layoutDay, monthCell, periodRange, segmentForDay, shiftAnchor, wallMinutes } from "./layout";

const hours = (day: Date) => { const { startMs, endMs } = dayBounds(day); return (endMs - startMs) / 3_600_000; };

describe("DST days in Europe/Zurich", () => {
  test("canary: the time zone really is Europe/Zurich in this file", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Europe/Zurich");
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-60);
  });
  test("25 October 2026 has 25 hours and 29 March 2026 has 23", () => {
    expect(hours(new Date(2026, 9, 25))).toBe(25);
    expect(hours(new Date(2026, 2, 29))).toBe(23);
    expect(hours(new Date(2026, 9, 26))).toBe(24);
  });
  test("an evening meeting on the 25 hour day is still at its printed wall-clock time", () => {
    const day = new Date(2026, 9, 25);
    const seg = segmentForDay({ startMs: new Date(2026, 9, 25, 20, 0).getTime(), endMs: new Date(2026, 9, 25, 21, 0).getTime() }, day);
    expect(seg).toEqual({ top: 1200, bottom: 1260, continuesBefore: false, continuesAfter: false });
    expect(wallMinutes(new Date(2026, 9, 26).getTime(), day)).toBe(1440);
  });
  test("a meeting crossing the repeated hour never gets a negative height", () => {
    const day = new Date(2026, 9, 25);
    // 02:30 CEST (first pass) to 02:30 CET (second pass): one real hour, the same wall minute.
    const startMs = Date.UTC(2026, 9, 25, 0, 30), endMs = Date.UTC(2026, 9, 25, 1, 30);
    const seg = segmentForDay({ startMs, endMs }, day)!;
    expect(seg.top).toBe(150);
    expect(seg.bottom).toBeGreaterThanOrEqual(seg.top);
    expect(layoutDay([{ id: "x", startMs, endMs }], day)).toHaveLength(1);
  });
  test("a meeting that ends after midnight on the 25 hour day continues into the 26th and is clipped to 24 wall hours", () => {
    const day = new Date(2026, 9, 25);
    const item = { startMs: new Date(2026, 9, 25, 23, 0).getTime(), endMs: new Date(2026, 9, 26, 1, 0).getTime() };
    expect(segmentForDay(item, day)).toEqual({ top: 1380, bottom: 1440, continuesBefore: false, continuesAfter: true });
    expect(segmentForDay(item, new Date(2026, 9, 26))).toEqual({ top: 0, bottom: 60, continuesBefore: true, continuesAfter: false });
  });
  test("on the 23 hour day the skipped hour does not break positions", () => {
    const day = new Date(2026, 2, 29);
    const seg = segmentForDay({ startMs: new Date(2026, 2, 29, 1, 30).getTime(), endMs: new Date(2026, 2, 29, 3, 30).getTime() }, day)!;
    expect(seg.top).toBe(90);
    expect(seg.bottom).toBe(210);
  });
  test("an event ending at midnight after a DST change is not on the next day", () => {
    const item = { startMs: new Date(2026, 9, 25, 22, 0).getTime(), endMs: new Date(2026, 9, 26, 0, 0).getTime() };
    expect(segmentForDay(item, new Date(2026, 9, 26))).toBeNull();
  });
  test("periods and month cells survive the change", () => {
    const range = periodRange("today", new Date(2026, 9, 24, 15, 0));
    expect(range.startMs).toBe(new Date(2026, 9, 24).getTime());
    expect(range.endMs).toBe(new Date(2026, 9, 32).getTime()); // 1 Nov 00:00, eight calendar days later, not 192 hours
    expect(range.endMs - range.startMs).toBe(193 * 3_600_000);
    expect(dayKey(shiftAnchor("week", new Date(2026, 9, 21, 12), 1))).toBe("2026-10-28");
    expect(shiftAnchor("week", new Date(2026, 9, 21, 12), 1).getHours()).toBe(12);
    expect(monthCell([{ id: "a", startMs: 0, endMs: 0, allDay: { startDay: "2026-10-25", endDay: "2026-10-26" } }], new Date(2026, 9, 25)).entries).toHaveLength(1);
    const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 19 + i));
    expect(allDayLanes([{ id: "a", startMs: 0, endMs: 0, allDay: { startDay: "2026-10-24", endDay: "2026-10-27" } }], week).bars[0]).toMatchObject({ colStart: 5, colEnd: 6, continuesAfter: true });
  });
});
