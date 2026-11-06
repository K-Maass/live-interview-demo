import { describe, expect, test } from "vitest";
import type { CalendarCoverage } from "@live-interview/core";
import { coverageText, dayCoverage, rangeStatus } from "./coverage";

const day = (n: number) => new Date(2026, 9, n);
const row = (extra: Partial<CalendarCoverage> = {}): CalendarCoverage => ({ accountId: "a1", calendarId: "c1", startMs: day(12).getTime(), endMs: day(19).getTime(), status: "ready", ...extra });
const input = (coverage: CalendarCoverage[], extra: object = {}) => ({ enabled: true, coverage, ...extra });

describe("dayCoverage", () => {
  test("a day inside a ready row is loaded; outside every row it is missing", () => {
    expect(dayCoverage(day(14), input([row()]))).toBe("loaded");
    expect(dayCoverage(day(19), input([row()]))).toBe("missing");
    expect(dayCoverage(day(14), input([]))).toBe("missing");
  });
  test("the day at the edge of a ready row is loaded only when the row covers all of it", () => {
    expect(dayCoverage(day(18), input([row({ endMs: new Date(2026, 9, 18, 12).getTime() })]))).toBe("missing");
  });
  test("a partial or stale row makes the day partial, an error row does not", () => {
    expect(dayCoverage(day(14), input([row({ status: "partial" })]))).toBe("partial");
    expect(dayCoverage(day(14), input([row({ status: "stale" })]))).toBe("partial");
    expect(dayCoverage(day(14), input([row({ status: "error" })]))).toBe("missing");
  });
  test("every source must be ready for the day to count as loaded", () => {
    expect(dayCoverage(day(14), input([row(), row({ accountId: "a2", status: "error" })]))).toBe("partial");
    expect(dayCoverage(day(14), input([row(), row({ accountId: "a2" })]))).toBe("loaded");
  });
  test("first half ready, second half partial", () => {
    const rows = [row({ endMs: day(15).getTime() }), row({ startMs: day(15).getTime(), status: "partial" })];
    expect(dayCoverage(day(13), input(rows))).toBe("loaded");
    expect(dayCoverage(day(16), input(rows))).toBe("partial");
  });
  test("while loading, missing days read as loading and nothing else changes", () => {
    expect(dayCoverage(day(14), input([], { loading: true }))).toBe("loading");
    expect(dayCoverage(day(14), input([row()], { loading: true }))).toBe("loaded");
  });
  test("outside the public edition only the loaded range is known", () => {
    const range = { startMs: day(14).getTime(), endMs: new Date(2026, 9, 16, 12).getTime() };
    const base = { enabled: false, coverage: [], calendarRange: range };
    expect(dayCoverage(day(14), base)).toBe("loaded");
    expect(dayCoverage(day(16), base)).toBe("partial");
    expect(dayCoverage(day(17), base)).toBe("missing");
    expect(dayCoverage(day(14), { enabled: false, coverage: [] })).toBe("missing");
  });
});

describe("rangeStatus and coverageText", () => {
  const name = (id: string) => ({ a1: "Work", a2: "Family" })[id] ?? id;
  test("fine, partly loaded with names, or failed with names", () => {
    expect(rangeStatus([row()], name)).toEqual({ kind: "ok" });
    expect(rangeStatus([], name)).toEqual({ kind: "ok" });
    expect(rangeStatus([row(), row({ accountId: "a2", status: "partial" })], name)).toEqual({ kind: "partial", accounts: ["Family"] });
    expect(rangeStatus([row({ status: "error" }), row({ accountId: "a2", status: "error" })], name)).toEqual({ kind: "error", accounts: ["Work", "Family"] });
    expect(rangeStatus([row(), row({ accountId: "a2", status: "error" })], name)).toEqual({ kind: "partial", accounts: ["Family"] });
  });
  test("short notes for headers and cells", () => {
    expect(coverageText("missing")).toBe("Not loaded");
    expect(coverageText("partial")).toBe("Partly loaded");
    expect(coverageText("loaded")).toBeUndefined();
    expect(coverageText("loading")).toBeUndefined();
  });
});
