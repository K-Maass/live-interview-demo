import { describe, expect, test } from "vitest";
import { backdropCloses, canReturnFocusTo, closeSettings, escapeClosesSettings, navigateTo, settingsGroups, trappedFocusIndex, unavailableDuringMeeting, visibleSection, type Navigation } from "./settingsOverlay";
import type { PageLocation } from "./types";

const meeting: PageLocation = { kind: "meeting", id: "plan-1", preparationOpen: false, artifact: "overview" };
const calendar: PageLocation = { kind: "meetings", view: "upcoming" };

describe("Settings opens over the current page", () => {
  test("a deep link opens Settings on its section and leaves the page as it was", () => {
    for (const page of [calendar, meeting, { kind: "people" } as const, { kind: "meetings", view: "past" } as const]) {
      const opened = navigateTo({ page }, { kind: "settings", section: "calendars" });
      expect(opened).toEqual({ page, settings: "calendars" });
      expect(opened.page).toBe(page);
    }
  });
  test("every deep link the app uses lands on its own section", () => {
    for (const section of ["setup", "speech", "calendars", "account"] as const) expect(navigateTo({ page: meeting }, { kind: "settings", section }).settings).toBe(section);
  });
  test("switching sections keeps the page underneath", () => {
    const state = navigateTo(navigateTo({ page: meeting }, { kind: "settings", section: "speech" }), { kind: "settings", section: "diagnostics" });
    expect(state).toEqual({ page: meeting, settings: "diagnostics" });
  });
  test("closing returns to exactly the page that was showing", () => {
    const before: Navigation = { page: { ...meeting, artifact: "notes" } };
    const closed = closeSettings(navigateTo(before, { kind: "settings", section: "account" }));
    expect(closed).toEqual(before);
    expect(closed.page).toBe(before.page);
    expect(closeSettings(before)).toBe(before);
  });
  test("a page link from inside Settings goes to that page and closes Settings", () => {
    expect(navigateTo({ page: meeting, settings: "diagnostics" }, { kind: "meetings", view: "past" })).toEqual({ page: { kind: "meetings", view: "past" } });
  });
  test("the same section again changes nothing", () => {
    const state: Navigation = { page: meeting, settings: "speech" };
    expect(navigateTo(state, { kind: "settings", section: "speech" })).toBe(state);
  });
});

describe("section grouping", () => {
  const ids = (groups: ReturnType<typeof settingsGroups>) => groups.map((g) => [g.label, g.items.map((i) => i.id)]);
  test("public product: Settings, Account and Support", () => {
    expect(ids(settingsGroups({ setupActive: true, publicProduct: true }))).toEqual([
      ["General", ["setup", "speech", "reasoning", "keyboard", "calendars"]],
      ["Account", ["account", "updates", "sharing"]],
      ["Support", ["diagnostics"]],
    ]);
  });
  test("Setup only while setup is active; without the public product there is no account, so the group is Data", () => {
    expect(ids(settingsGroups({ setupActive: false, publicProduct: false }))).toEqual([
      ["General", ["speech", "reasoning", "keyboard", "calendars"]],
      ["Data", ["sharing"]],
      ["Support", ["diagnostics"]],
    ]);
  });
  test("every section appears exactly once", () => {
    const all = settingsGroups({ setupActive: true, publicProduct: true }).flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(9);
  });
  test("a section this edition does not show falls back to the first shown", () => {
    const personal = settingsGroups({ setupActive: false, publicProduct: false });
    expect(visibleSection("account", personal)).toBe("speech");
    expect(visibleSection("setup", personal)).toBe("speech");
    expect(visibleSection("sharing", personal)).toBe("sharing");
  });
  test("the sections that wait for the meeting to end are the ones the live notice covers", () => {
    expect([...unavailableDuringMeeting]).toEqual(["reasoning", "keyboard", "calendars", "sharing"]);
  });
});

describe("closing and focus", () => {
  const key = (k: string, patch: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; defaultPrevented: boolean }> = {}) => ({ key: k, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, defaultPrevented: false, ...patch });
  test("plain Escape closes Settings", () => {
    expect(escapeClosesSettings(key("Escape"), false)).toBe(true);
  });
  test("Escape with a modifier (the global Stop & save shortcut is ⌘⌥Escape), another key, or an Escape already handled does not", () => {
    expect(escapeClosesSettings(key("Escape", { metaKey: true, altKey: true }), false)).toBe(false);
    expect(escapeClosesSettings(key("Escape", { ctrlKey: true }), false)).toBe(false);
    expect(escapeClosesSettings(key("Enter"), false)).toBe(false);
    expect(escapeClosesSettings(key("Escape", { defaultPrevented: true }), false)).toBe(false);
  });
  test("a confirmation sheet inside Settings closes first", () => {
    expect(escapeClosesSettings(key("Escape"), true)).toBe(false);
  });
  test("a click on the dimmed area closes only when it started there", () => {
    expect(backdropCloses(true, true)).toBe(true);
    expect(backdropCloses(false, true)).toBe(false);
    expect(backdropCloses(true, false)).toBe(false);
  });
  test("Tab wraps inside the panel in both directions", () => {
    expect(trappedFocusIndex(5, 4, false)).toBe(0);
    expect(trappedFocusIndex(5, 0, true)).toBe(4);
    expect(trappedFocusIndex(5, 2, false)).toBeUndefined();
    expect(trappedFocusIndex(5, 2, true)).toBeUndefined();
    expect(trappedFocusIndex(5, -1, false)).toBe(0);
    expect(trappedFocusIndex(5, -1, true)).toBe(4);
    expect(trappedFocusIndex(0, -1, false)).toBeUndefined();
  });
  test("focus returns to the opener only while it is still on screen and not inert", () => {
    const el = (patch: Partial<{ isConnected: boolean; rects: number; inside: boolean }> = {}) => ({ isConnected: patch.isConnected ?? true, getClientRects: () => ({ length: patch.rects ?? 1 }), closest: () => (patch.inside ? {} : null) });
    expect(canReturnFocusTo(el())).toBe(true);
    expect(canReturnFocusTo(el({ isConnected: false }))).toBe(false);
    expect(canReturnFocusTo(el({ rects: 0 }))).toBe(false);
    expect(canReturnFocusTo(el({ inside: true }))).toBe(false);
    expect(canReturnFocusTo(null)).toBe(false);
  });
});
