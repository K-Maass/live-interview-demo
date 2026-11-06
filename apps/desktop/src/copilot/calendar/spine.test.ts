import { describe, expect, test } from "vitest";
import { GAP_MAX_REM, GAP_MIN_REM, buildSpine, gapHeightRem, nowLabel } from "./spine";
import { at, itemsOf, timed } from "./calendarFixtures";

const day = new Date(2026, 9, 16);
const build = (rows: ReturnType<typeof timed>[], now: number) => buildSpine(itemsOf(rows), day, now);

describe("gapHeightRem", () => {
  test("scales at 0.057 rem per minute", () => {
    expect(gapHeightRem(60)).toBeCloseTo(3.42, 5);
    expect(gapHeightRem(105)).toBeCloseTo(5.985, 5);
  });
  test("clamps to 0.75 rem at the bottom and 6.8 rem at the top", () => {
    expect(gapHeightRem(0)).toBe(GAP_MIN_REM);
    expect(gapHeightRem(10)).toBe(0.75);
    expect(gapHeightRem(-5)).toBe(0.75);
    expect(gapHeightRem(Number.NaN)).toBe(0.75);
    expect(gapHeightRem(8 * 60)).toBe(GAP_MAX_REM);
  });
});

describe("nowLabel", () => {
  test("is 24 h and padded", () => {
    expect(nowLabel(at(16, 9, 5))).toBe("09:05");
    expect(nowLabel(at(16, 13, 52))).toBe("13:52");
  });
});

describe("buildSpine", () => {
  const rows = [timed("a", "A", 16, 9, 10), timed("b", "B", 16, 11, 12), timed("c", "C", 16, 13, 13)];
  test("has no spine and no marker for a day without timed meetings", () => {
    expect(build([], at(16, 10))).toEqual({ entries: [] });
  });
  test("alternates blocks and gaps; only gaps of 30 minutes or more get a label", () => {
    const spine = build([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 10, 12), timed("c", "C", 16, 12, 13), timed("d", "D", 16, 13, 14)].map((r, i) => i === 1 ? { ...r, startMs: at(16, 10, 15) } : i === 2 ? { ...r, startMs: at(16, 12, 30) } : r), at(16, 8));
    const gaps = spine.entries.filter((e) => e.kind === "gap");
    expect(spine.entries.map((e) => e.kind)).toEqual(["gap", "block", "gap", "block", "gap", "block", "gap", "block"]);
    // now (08:00) is before the first meeting: a leading gap from now to 09:00 is a 1 h gap
    expect(gaps.map((g) => g.kind === "gap" && g.label)).toEqual(["1 h free", undefined, "30 min free", undefined].map((l) => l));
    expect(gaps[1].kind === "gap" && gaps[1].minutes).toBe(15);
    expect(gaps[1].kind === "gap" && gaps[1].heightRem).toBeCloseTo(0.855, 5);
  });
  test("labels a 1 h 45 gap and sizes it to scale", () => {
    const spine = build([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 11, 12)].map((r, i) => i === 1 ? { ...r, startMs: at(16, 11, 45) } : r), at(16, 9, 30));
    const gap = spine.entries.find((e) => e.kind === "gap");
    expect(gap?.kind === "gap" && gap.label).toBe("1 h 45 free");
    expect(gap?.kind === "gap" && gap.heightRem).toBeCloseTo(5.985, 5);
  });
  test("now inside a gap sits at its fraction", () => {
    const spine = build(rows, at(16, 10, 30));
    expect(spine.entries[spine.now!.entry].kind).toBe("gap");
    expect(spine.now!.fraction).toBeCloseTo(0.5, 5);
    const early = build(rows, at(16, 10, 15));
    expect(early.now!.fraction).toBeCloseTo(0.25, 5);
  });
  test("now inside a meeting sits at its fraction of the segment", () => {
    const spine = build(rows, at(16, 11, 15));
    const entry = spine.entries[spine.now!.entry];
    expect(entry.kind).toBe("block");
    expect(entry.kind === "block" && entry.columns[0].events[0].id).toBe("b");
    expect(spine.now!.fraction).toBeCloseTo(0.25, 5);
  });
  test("now before the first meeting makes a leading gap and sits at its top", () => {
    const spine = build(rows, at(16, 7, 40));
    expect(spine.entries[0].kind).toBe("gap");
    expect(spine.now).toEqual({ entry: 0, fraction: 0 });
    const lead = spine.entries[0];
    expect(lead.kind === "gap" && lead.label).toBe("1 h 20 free");
  });
  test("now after the last meeting sits on a tail row", () => {
    const spine = build([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 11, 12)], at(16, 15));
    expect(spine.entries.at(-1)!.kind).toBe("tail");
    expect(spine.now).toEqual({ entry: spine.entries.length - 1, fraction: 0 });
  });
  test("back-to-back meetings leave a minimum gap with no label", () => {
    const spine = build([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 10, 11)], at(16, 8));
    const gap = spine.entries.filter((e) => e.kind === "gap")[1];
    expect(gap.kind === "gap" && gap.heightRem).toBe(0.75);
    expect(gap.kind === "gap" && gap.label).toBeUndefined();
  });
  test("no marker when now is on another day", () => {
    expect(build(rows, at(17, 10)).now).toBeUndefined();
  });
  test("overlapping meetings form one two-column block counted as N meetings", () => {
    const spine = build([timed("a", "A", 16, 10, 11), timed("b", "B", 16, 10, 11, ), timed("c", "C", 16, 14, 15)], at(16, 8));
    const blocks = spine.entries.filter((e) => e.kind === "block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind === "block" && [blocks[0].lanes, blocks[0].count]).toEqual([2, 2]);
    expect(blocks[1].kind === "block" && blocks[1].lanes).toBe(1);
  });
  test("two columns are drawn; the meetings of every lane beyond them are counted in `more`", () => {
    const three = build([1, 2, 3].map((n) => timed("o" + n, "O" + n, 16, 10, 11)), at(16, 8)).entries.find((e) => e.kind === "block");
    expect(three?.kind === "block" && [three.lanes, three.count, three.more?.count]).toEqual([2, 3, 1]);
    const four = build([1, 2, 3, 4].map((n) => timed("o" + n, "O" + n, 16, 10, 11)), at(16, 8)).entries.find((e) => e.kind === "block");
    expect(four?.kind === "block" && four.columns.map((c) => c.events.length)).toEqual([1, 1]);
    expect(four?.kind === "block" && four.count).toBe(4);
    expect(four?.kind === "block" && four.more).toMatchObject({ count: 2, startMs: at(16, 10), endMs: at(16, 11) });
    const two = build([timed("a", "A", 16, 10, 11), timed("b", "B", 16, 10, 11)], at(16, 8)).entries.find((e) => e.kind === "block");
    expect(two?.kind === "block" && two.more).toBeUndefined();
  });
  test("the segment takes the readiness of the first meeting", () => {
    const spine = buildSpine(itemsOf([timed("plan:x", "Plan", 16, 9, 10)]), day, at(16, 8));
    expect(spine.entries.find((e) => e.kind === "block")).toMatchObject({ tone: "unsynced" });
  });
});
