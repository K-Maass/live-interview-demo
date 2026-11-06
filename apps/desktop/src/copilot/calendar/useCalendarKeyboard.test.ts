import { describe, expect, test } from "vitest";
import { nextNavTarget, type NavTarget } from "./useCalendarKeyboard";

const t = (id: string, col: number, order: number, head = false): NavTarget => ({ id, col, order, head });

describe("week navigation", () => {
  const targets = [
    t("h0", 0, -2, true), t("e0a", 0, 540), t("e0b", 0, 840),
    t("h1", 1, -2, true),
    t("h2", 2, -2, true), t("e2a", 2, 600), t("e2b", 2, 900),
  ];
  const go = (from: string, key: string) => nextNavTarget(targets, from, key, "week");
  test("left and right keep the kind: header to header, event to the nearest event in time", () => {
    expect(go("h0", "ArrowRight")).toBe("h1");
    expect(go("h2", "ArrowLeft")).toBe("h1");
    expect(go("e0a", "ArrowRight")).toBe("h1");
    expect(go("e0b", "ArrowRight")).toBe("h1");
    expect(go("e2b", "ArrowLeft")).toBe("h1");
    expect(go("h1", "ArrowRight")).toBe("h2");
  });
  test("an event moves to the closest event of the next day when there is one", () => {
    const more = [...targets, t("e1a", 1, 870)];
    expect(nextNavTarget(more, "e0b", "ArrowRight", "week")).toBe("e1a");
    expect(nextNavTarget(more, "e2a", "ArrowLeft", "week")).toBe("e1a");
  });
  test("up and down walk the day, header first", () => {
    expect(go("h0", "ArrowDown")).toBe("e0a");
    expect(go("e0a", "ArrowDown")).toBe("e0b");
    expect(go("e0b", "ArrowDown")).toBeUndefined();
    expect(go("e0a", "ArrowUp")).toBe("h0");
    expect(go("h0", "ArrowUp")).toBeUndefined();
  });
  test("home and end jump to the first and last day", () => {
    expect(go("e2a", "Home")).toBe("h0");
    expect(go("h0", "End")).toBe("h2");
  });
  test("the edge of the week does nothing; unknown keys do nothing", () => {
    expect(go("h0", "ArrowLeft")).toBeUndefined();
    expect(go("h2", "ArrowRight")).toBeUndefined();
    expect(go("h0", "x")).toBeUndefined();
    expect(nextNavTarget(targets, "missing", "ArrowRight", "week")).toBeUndefined();
  });
});

describe("month navigation", () => {
  const targets = Array.from({ length: 42 }, (_, i) => t("d" + i, i, -1, true));
  targets.push(t("e9a", 9, 0), t("e9b", 9, 1), t("m9", 9, 4));
  const go = (from: string, key: string) => nextNavTarget(targets, from, key, "month");
  test("dates move by one day and by one week", () => {
    expect(go("d9", "ArrowRight")).toBe("d10");
    expect(go("d9", "ArrowLeft")).toBe("d8");
    expect(go("d9", "ArrowDown")).toBe("d16");
    expect(go("d9", "ArrowUp")).toBe("d2");
    expect(go("d2", "ArrowUp")).toBeUndefined();
    expect(go("d41", "ArrowRight")).toBeUndefined();
  });
  test("home and end are the start and end of the week", () => {
    expect(go("d9", "Home")).toBe("d7");
    expect(go("d9", "End")).toBe("d13");
    expect(go("d13", "Home")).toBe("d7");
  });
  test("inside a cell, up and down walk its entries and left and right go to the next date", () => {
    expect(go("d9", "ArrowDown")).toBe("d16");
    expect(go("e9a", "ArrowDown")).toBe("e9b");
    expect(go("e9b", "ArrowDown")).toBe("m9");
    expect(go("e9a", "ArrowUp")).toBe("d9");
    expect(go("e9a", "ArrowRight")).toBe("d10");
    expect(go("m9", "ArrowLeft")).toBe("d8");
  });
});
