import { describe, expect, test } from "vitest";
import { visibleCalendarRange } from "../../lib/public/state";
import { allDayLanes, defaultScrollMinutes, followToday, gapLabel, layoutDay, monthCell, periodRange, segmentForDay, shiftAnchor, weekdayNames, wallMinutes, dayBounds, dayKey, type TimedLike } from "./layout";

const day = new Date(2026, 9, 13); // Tuesday
const at = (h: number, m = 0, offset = 0) => new Date(2026, 9, 13 + offset, h, m).getTime();
const ev = (id: string, from: [number, number], to: [number, number]): TimedLike => ({ id, startMs: at(...from), endMs: at(...to) });
const allDay = (id: string, startDay: string, endDay: string): TimedLike => ({ id, startMs: 0, endMs: 0, allDay: { startDay, endDay } });
const events = (entries: ReturnType<typeof layoutDay>) => entries.filter((e) => e.kind === "event");

describe("day geometry", () => {
  test("a normal day is 24 hours and wall minutes count from local midnight", () => {
    const { startMs, endMs } = dayBounds(day);
    expect((endMs - startMs) / 3_600_000).toBe(24);
    expect(wallMinutes(at(9, 30), day)).toBe(570);
    expect(wallMinutes(endMs, day)).toBe(1440);
    expect(wallMinutes(startMs - 1000, day)).toBe(0);
  });
  test("an overnight event is clipped to each day and says where it continues", () => {
    const night = { startMs: at(22), endMs: at(2, 0, 1) };
    expect(segmentForDay(night, day)).toEqual({ top: 1320, bottom: 1440, continuesBefore: false, continuesAfter: true });
    expect(segmentForDay(night, new Date(2026, 9, 14))).toEqual({ top: 0, bottom: 120, continuesBefore: true, continuesAfter: false });
    expect(segmentForDay(night, new Date(2026, 9, 15))).toBeNull();
    expect(segmentForDay(night, new Date(2026, 9, 12))).toBeNull();
  });
  test("an event ending exactly at midnight is not on the next day and does not continue", () => {
    const e = { startMs: at(23), endMs: at(0, 0, 1) };
    expect(segmentForDay(e, day)).toMatchObject({ bottom: 1440, continuesAfter: false });
    expect(segmentForDay(e, new Date(2026, 9, 14))).toBeNull();
  });
});

describe("layoutDay", () => {
  test("two overlapping meetings sit side by side", () => {
    const out = events(layoutDay([ev("a", [10, 0], [11, 0]), ev("b", [10, 30], [11, 30])], day));
    expect(out.map((e) => [e.id, e.lane, e.lanes, e.left, e.width])).toEqual([["a", 0, 2, 0, 0.5], ["b", 1, 2, 0.5, 0.5]]);
  });
  test("a lone meeting takes the whole column", () => {
    expect(layoutDay([ev("a", [10, 0], [11, 0])], day)).toMatchObject([{ kind: "event", lane: 0, lanes: 1, left: 0, width: 1, top: 600, bottom: 660 }]);
  });
  test("back-to-back meetings stay in one lane", () => {
    const out = events(layoutDay([ev("a", [10, 0], [11, 0]), ev("b", [11, 0], [12, 0])], day));
    expect(out.map((e) => [e.lane, e.lanes, e.width])).toEqual([[0, 1, 1], [0, 1, 1]]);
  });
  test("clusters are independent: a later lone meeting is full width", () => {
    const out = events(layoutDay([ev("a", [9, 0], [10, 0]), ev("b", [9, 30], [10, 30]), ev("c", [14, 0], [15, 0])], day));
    expect(out.map((e) => e.lanes)).toEqual([2, 2, 1]);
  });
  test("a lane is reused once its meeting has ended", () => {
    const out = events(layoutDay([ev("long", [9, 0], [12, 0]), ev("a", [9, 0], [10, 0]), ev("b", [10, 0], [11, 0])], day));
    expect(Object.fromEntries(out.map((e) => [e.id, e.lane]))).toEqual({ long: 0, a: 1, b: 1 });
  });
  test("four overlapping meetings with maxColumns 3 show two columns and one +2 item over the hidden pair", () => {
    const out = layoutDay([ev("a", [10, 0], [12, 0]), ev("b", [10, 0], [12, 0]), ev("c", [10, 30], [11, 30]), ev("d", [11, 0], [12, 30])], day, { maxColumns: 3 });
    expect(events(out).map((e) => [e.id, e.lane, e.lanes])).toEqual([["a", 0, 3], ["b", 1, 3]]);
    const more = out.find((e) => e.kind === "more")!;
    expect(more).toMatchObject({ kind: "more", count: 2, top: 630, bottom: 750, lane: 2, lanes: 3, left: 2 / 3, hiddenIds: ["c", "d"] });
    // The union spans from the first hidden start (10:30) to the last hidden end (12:30).
    expect(more.kind === "more" && [more.startMs, more.endMs]).toEqual([at(10, 30), at(12, 30)]);
  });
  test("three overlapping meetings with maxColumns 2 give one visible column and a +2 item in the second", () => {
    const out = layoutDay([ev("a", [10, 0], [12, 0]), ev("b", [10, 0], [11, 0]), ev("c", [10, 0], [11, 30])], day, { maxColumns: 2 });
    expect(events(out).map((e) => e.id)).toEqual(["a"]);
    expect(out.find((e) => e.kind === "more")).toMatchObject({ count: 2, lane: 1, lanes: 2, left: 0.5, width: 0.5 });
  });
  test("exactly maxColumns lanes need no overflow", () => {
    const out = layoutDay([ev("a", [10, 0], [11, 0]), ev("b", [10, 0], [11, 0]), ev("c", [10, 0], [11, 0])], day, { maxColumns: 3 });
    expect(out.every((e) => e.kind === "event")).toBe(true);
    expect(out.map((e) => e.lanes)).toEqual([3, 3, 3]);
  });
  test("one cluster gets one +N item over all its hidden meetings, even when they do not overlap each other", () => {
    const out = layoutDay([ev("wide", [8, 0], [14, 0]), ev("p", [9, 0], [10, 0]), ev("q", [9, 0], [10, 0]), ev("r", [12, 0], [13, 0]), ev("s", [12, 0], [13, 0])], day, { maxColumns: 2 });
    expect(events(out).map((e) => e.id)).toEqual(["wide"]);
    expect(out.filter((e) => e.kind === "more").map((m) => m.kind === "more" && [m.count, m.hiddenIds, m.top, m.bottom])).toEqual([[4, ["p", "q", "r", "s"], 540, 780]]);
  });
  test("a single hidden group is one item over the union of its meetings", () => {
    const out = layoutDay([ev("wide", [8, 0], [14, 0]), ev("zz", [8, 0], [14, 0]), ev("x", [9, 0], [10, 0])], day, { maxColumns: 2 });
    expect(events(out).map((e) => e.id)).toEqual(["wide"]);
    expect(out.filter((e) => e.kind === "more").map((m) => m.kind === "more" && m.hiddenIds)).toEqual([["zz", "x"]]);
  });
  test("ten-minute meetings are packed by their drawn height, not their length", () => {
    const out = events(layoutDay([ev("a", [10, 0], [10, 10]), ev("b", [10, 15], [10, 25])], day, { minHeightMinutes: 27 }));
    expect(out.map((e) => e.lane)).toEqual([0, 1]);
    expect(out[0]).toMatchObject({ top: 600, bottom: 610, visualBottom: 627 });
    // With a minimum height of 10 minutes they no longer collide.
    expect(events(layoutDay([ev("a", [10, 0], [10, 10]), ev("b", [10, 15], [10, 25])], day, { minHeightMinutes: 10 })).map((e) => e.lane)).toEqual([0, 0]);
  });
  test("an overnight meeting is positioned in each day's column with its continuation flags", () => {
    const night = { id: "n", startMs: at(22), endMs: at(2, 0, 1) };
    expect(layoutDay([night], day)).toMatchObject([{ top: 1320, bottom: 1440, continuesAfter: true, continuesBefore: false }]);
    expect(layoutDay([night], new Date(2026, 9, 14))).toMatchObject([{ top: 0, bottom: 120, continuesAfter: false, continuesBefore: true }]);
  });
  test("all-day items and other days' items are ignored", () => {
    expect(layoutDay([allDay("x", "2026-10-13", "2026-10-14"), ev("other", [9, 0], [10, 0])].map((e) => e.id === "other" ? { ...e, startMs: at(9, 0, 3), endMs: at(10, 0, 3) } : e), day)).toEqual([]);
  });
  test("fourteen meetings with three clusters lay out without throwing and keep every id reachable", () => {
    const items = [
      ev("1", [8, 0], [9, 0]), ev("2", [8, 0], [8, 30]), ev("3", [8, 15], [9, 30]), ev("4", [8, 30], [9, 0]), ev("5", [8, 45], [9, 15]),
      ev("6", [11, 0], [12, 0]), ev("7", [11, 30], [12, 30]), ev("8", [13, 0], [13, 10]), ev("9", [13, 5], [13, 15]), ev("10", [13, 10], [13, 20]),
      ev("11", [15, 0], [16, 0]), ev("12", [16, 0], [17, 0]), ev("13", [17, 0], [17, 15]), ev("14", [17, 15], [17, 30]),
    ];
    const out = layoutDay(items, day, { maxColumns: 3 });
    const reachable = new Set(out.flatMap((e) => e.kind === "event" ? [e.id] : e.hiddenIds));
    expect(reachable.size).toBe(14);
    expect(Math.max(...out.map((e) => e.lanes))).toBeLessThanOrEqual(3);
  });
});

describe("allDayLanes", () => {
  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 12 + i));
  test("a bar spans its columns, is clamped to the week and says it continues", () => {
    const { bars } = allDayLanes([allDay("trip", "2026-10-09", "2026-10-14"), allDay("conf", "2026-10-16", "2026-10-25"), allDay("one", "2026-10-15", "2026-10-16")], week);
    expect(bars.find((b) => b.id === "trip")).toMatchObject({ colStart: 0, colEnd: 1, continuesBefore: true, continuesAfter: false });
    expect(bars.find((b) => b.id === "conf")).toMatchObject({ colStart: 4, colEnd: 6, continuesBefore: false, continuesAfter: true });
    expect(bars.find((b) => b.id === "one")).toMatchObject({ colStart: 3, colEnd: 3, lane: 0 });
  });
  test("end day is exclusive and events outside the week are skipped", () => {
    const { bars } = allDayLanes([allDay("ends-monday", "2026-10-10", "2026-10-12"), allDay("later", "2026-10-19", "2026-10-20"), allDay("fits", "2026-10-18", "2026-10-19")], week);
    expect(bars.map((b) => b.id)).toEqual(["fits"]);
    expect(bars[0]).toMatchObject({ colStart: 6, colEnd: 6, continuesAfter: false });
  });
  test("overlapping bars take separate lanes; touching bars share one", () => {
    const { bars, laneCount } = allDayLanes([allDay("a", "2026-10-12", "2026-10-14"), allDay("b", "2026-10-13", "2026-10-15"), allDay("c", "2026-10-14", "2026-10-16")], week);
    expect(Object.fromEntries(bars.map((b) => [b.id, b.lane]))).toEqual({ a: 0, b: 1, c: 0 });
    expect(laneCount).toBe(2);
  });
  test("two lanes then a per-column +N count", () => {
    const items = [allDay("a", "2026-10-13", "2026-10-15"), allDay("b", "2026-10-13", "2026-10-15"), allDay("c", "2026-10-14", "2026-10-16"), allDay("d", "2026-10-14", "2026-10-15")];
    const { bars, more, laneCount } = allDayLanes(items, week);
    expect(laneCount).toBe(2);
    expect(bars.map((b) => b.id).sort()).toEqual(["a", "b"]);
    expect(more).toEqual([{ col: 2, count: 2, hiddenIds: ["c", "d"] }, { col: 3, count: 1, hiddenIds: ["c"] }]);
  });
  test("timed items are ignored", () => {
    expect(allDayLanes([ev("t", [9, 0], [10, 0])], week).bars).toEqual([]);
  });
});

describe("monthCell", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ev("e" + i, [9 + i, 0], [9 + i, 30]));
  test("three entries fit with no overflow", () => {
    expect(monthCell(items(3), day)).toMatchObject({ more: 0, hiddenIds: [] });
    expect(monthCell(items(3), day).entries).toHaveLength(3);
  });
  test("four entries show three and +1 more", () => {
    const cell = monthCell(items(4), day);
    expect(cell.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
    expect(cell).toMatchObject({ more: 1, hiddenIds: ["e3"] });
  });
  test("all-day entries come first, overnight meetings appear on both days, other days are empty", () => {
    const list = [ev("late", [15, 0], [16, 0]), allDay("holiday", "2026-10-13", "2026-10-14"), { id: "night", startMs: at(23), endMs: at(1, 0, 1) }];
    expect(monthCell(list, day).entries.map((e) => e.id)).toEqual(["holiday", "late", "night"]);
    expect(monthCell(list, new Date(2026, 9, 14)).entries.map((e) => e.id)).toEqual(["night"]);
    expect(monthCell(list, new Date(2026, 9, 15)).entries).toEqual([]);
  });
  test("a custom maximum is respected", () => {
    expect(monthCell(items(4), day, 2)).toMatchObject({ more: 2 });
  });
});

describe("defaultScrollMinutes", () => {
  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 12 + i));
  test("this week scrolls to 90 minutes before now", () => {
    expect(defaultScrollMinutes(week, [], at(14, 0))).toBe(14 * 60 - 90);
    expect(defaultScrollMinutes(week, [], at(1, 0))).toBe(0);
  });
  test("other weeks start at 08:00, or earlier when a meeting starts earlier", () => {
    const next = week.map((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 14));
    expect(defaultScrollMinutes(next, [], at(14, 0))).toBe(480);
    expect(defaultScrollMinutes(next, [{ id: "x", startMs: at(6, 0, 14), endMs: at(7, 0, 14) }], at(14, 0))).toBe(330);
    expect(defaultScrollMinutes(next, [{ id: "x", startMs: at(13, 0, 14), endMs: at(14, 0, 14) }], at(14, 0))).toBe(480);
  });
});

describe("period maths", () => {
  const anchor = new Date(2026, 9, 14, 15, 30);
  test("week and month are exactly the range the app already loads", () => {
    expect(periodRange("week", anchor)).toEqual(visibleCalendarRange(anchor, "week"));
    expect(periodRange("month", anchor)).toEqual(visibleCalendarRange(anchor, "month"));
  });
  test("today is the start of today plus eight calendar days", () => {
    expect(periodRange("today", anchor)).toEqual({ startMs: new Date(2026, 9, 14).getTime(), endMs: new Date(2026, 9, 22).getTime() });
  });
  test("shifting moves a day, a week or a month", () => {
    expect(dayKey(shiftAnchor("today", anchor, 1))).toBe("2026-10-15");
    expect(dayKey(shiftAnchor("week", anchor, -1))).toBe("2026-10-07");
    expect(dayKey(shiftAnchor("month", anchor, 1))).toBe("2026-11-14");
    expect(shiftAnchor("week", anchor, 1).getHours()).toBe(15);
  });
  test("month shifting is safe at the end of a month", () => {
    expect(dayKey(shiftAnchor("month", new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(dayKey(shiftAnchor("month", new Date(2026, 2, 31), -1))).toBe("2026-02-28");
    expect(dayKey(shiftAnchor("month", new Date(2024, 0, 31), 1))).toBe("2024-02-29");
    expect(dayKey(shiftAnchor("month", new Date(2026, 11, 15), 1))).toBe("2027-01-15");
  });
});

describe("labels", () => {
  test("weekday names start on Monday and follow the locale", () => {
    expect(weekdayNames("en-GB")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayNames("de-CH")[0]).toMatch(/^Mo/);
    expect(weekdayNames("en", "long")[6]).toBe("Sunday");
    expect(weekdayNames("en-GB")).toHaveLength(7);
  });
  test("a gap is named from 30 minutes", () => {
    expect(gapLabel(105)).toBe("1 h 45 free");
    expect(gapLabel(120)).toBe("2 h free");
    expect(gapLabel(30)).toBe("30 min free");
    expect(gapLabel(45)).toBe("45 min free");
    expect(gapLabel(29)).toBeUndefined();
    expect(gapLabel(0)).toBeUndefined();
    expect(gapLabel(-5)).toBeUndefined();
  });
});

describe("following today past midnight", () => {
  const sunday = new Date(2026, 9, 18, 23, 59).getTime(); // the last day of the week of 12 October
  const monday = new Date(2026, 9, 19, 0, 1).getTime();
  test("a week or month showing the old today moves to the new today's period", () => {
    expect(dayKey(followToday("week", new Date(sunday), sunday, monday))).toBe("2026-10-19");
    const lastOfMonth = new Date(2026, 9, 31, 23, 59).getTime(), firstOfNext = new Date(2026, 10, 1, 0, 1).getTime();
    expect(followToday("month", new Date(2026, 9, 15), lastOfMonth, firstOfNext).getMonth()).toBe(10);
  });
  test("a period the person navigated away to stays put, and nothing moves within a day", () => {
    const elsewhere = new Date(2026, 8, 1);
    expect(followToday("week", elsewhere, sunday, monday)).toBe(elsewhere);
    const anchor = new Date(sunday);
    expect(followToday("week", anchor, sunday - 60_000, sunday)).toBe(anchor);
  });
});
