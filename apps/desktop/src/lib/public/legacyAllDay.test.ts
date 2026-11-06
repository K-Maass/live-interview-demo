import { expect, test } from "vitest";
import { legacyAllDay } from "./legacyAllDay";

const localMidnight = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d).getTime();
const utcMidnight = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

test("a row with isAllDay set is never reinterpreted", () => {
  const start = localMidnight(2026, 10, 20);
  expect(
    legacyAllDay({ startMs: start, endMs: localMidnight(2026, 10, 21), isAllDay: true }),
  ).toBeUndefined();
  expect(
    legacyAllDay({ startMs: start, endMs: localMidnight(2026, 10, 21), isAllDay: false }),
  ).toBeUndefined();
});

test("local-midnight rows spanning whole days are all-day with an exclusive end", () => {
  expect(
    legacyAllDay({ startMs: localMidnight(2026, 10, 20), endMs: localMidnight(2026, 10, 21) }),
  ).toEqual({ startDay: "2026-10-20", endDay: "2026-10-21" });
  expect(
    legacyAllDay({ startMs: localMidnight(2026, 12, 30), endMs: localMidnight(2027, 1, 2) }),
  ).toEqual({ startDay: "2026-12-30", endDay: "2027-01-02" });
});

test("a whole-day row that crosses a clock change still ends on the right day", () => {
  // 24 days across the end of European summer time is 24 local days but not 24 * 24 hours.
  expect(
    legacyAllDay({ startMs: localMidnight(2026, 10, 20), endMs: localMidnight(2026, 11, 13) }),
  ).toEqual({ startDay: "2026-10-20", endDay: "2026-11-13" });
});

test("UTC-midnight rows are all-day on their UTC dates", () => {
  // Whatever the machine's zone, UTC midnight is read by its UTC date.
  expect(
    legacyAllDay({ startMs: utcMidnight(2026, 10, 20), endMs: utcMidnight(2026, 10, 22) }),
  ).toEqual({ startDay: "2026-10-20", endDay: "2026-10-22" });
});

test("timed and short rows are not all-day", () => {
  const nine = new Date(2026, 9, 20, 9).getTime();
  expect(legacyAllDay({ startMs: nine, endMs: nine + 3_600_000 })).toBeUndefined();
  // Long but not a whole number of days, and not at midnight.
  expect(legacyAllDay({ startMs: nine, endMs: nine + 26 * 3_600_000 })).toBeUndefined();
  // Midnight start but a working-day length.
  const midnight = localMidnight(2026, 10, 20);
  expect(legacyAllDay({ startMs: midnight, endMs: midnight + 9 * 3_600_000 })).toBeUndefined();
  // Whole days long but starting at 09:00.
  expect(legacyAllDay({ startMs: nine, endMs: nine + 24 * 3_600_000 })).toBeUndefined();
  expect(legacyAllDay({ startMs: midnight, endMs: midnight })).toBeUndefined();
  expect(legacyAllDay({ startMs: midnight, endMs: Number.NaN })).toBeUndefined();
});
