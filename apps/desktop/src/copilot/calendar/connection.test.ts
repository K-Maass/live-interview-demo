import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CalendarAccount, CalendarCoverage, CalendarSource } from "@live-interview/core";
import { CalendarSetupNotice } from "./CalendarSetupNotice";
import { accountState, calendarColor, calendarConnection, calendarGroups, calendarListFooter, nothingToRead, sortAccounts, stateText, updatedText, type ConnectionInput } from "./connection";
import { dayCoverage } from "./coverage";

const apple = (extra: Partial<CalendarAccount> = {}): CalendarAccount => ({ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: ["c1"], ...extra });
const input = (accounts: CalendarAccount[], extra: Partial<ConnectionInput> = {}): ConnectionInput => ({ enabled: true, accountsLoaded: true, accounts, ...extra });

describe("calendarConnection", () => {
  test("no account, or only the 'disconnected' placeholder, is none", () => {
    expect(calendarConnection(input([]))).toEqual({ kind: "none" });
    expect(calendarConnection(input([apple({ status: "disconnected", selectedCalendarIds: [] })]))).toEqual({ kind: "none" });
  });
  test("macOS refusing access is accessOff, not none", () => {
    expect(calendarConnection(input([apple({ status: "accessOff", code: "calendarPermissionDenied", selectedCalendarIds: [] })]))).toEqual({ kind: "accessOff", name: "macOS Calendar" });
  });
  test("a connected account with no calendar chosen is noCalendars (the state that left Today 'not loaded' with 11 calendars)", () => {
    expect(calendarConnection(input([apple({ selectedCalendarIds: [] })]))).toEqual({ kind: "noCalendars", accounts: ["macOS Calendar"] });
  });
  test("one chosen calendar anywhere is enough; another account's access being off does not hide it", () => {
    const google: CalendarAccount = { id: "g", provider: "google", name: "Work", status: "connected", selectedCalendarIds: ["primary"] };
    expect(calendarConnection(input([apple({ status: "accessOff", selectedCalendarIds: [] }), google]))).toEqual({ kind: "ok" });
  });
  test("a load refused as a whole is failed with plain words; a success clears it (rangeError undefined)", () => {
    const failed = calendarConnection(input([apple()], { rangeError: "calendarReauthenticationRequired" }));
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.reason).toMatch(/sign in again/);
    const unknown = calendarConnection(input([], { rangeError: "calendarUnavailable" }));
    expect(unknown.kind === "failed" && unknown.reason).toBe("The calendars on this Mac didn’t answer.");
    expect(calendarConnection(input([apple()]))).toEqual({ kind: "ok" });
  });
  test("before the account list arrives it is checking, which is quiet rather than 'nothing to read'", () => {
    const checking = calendarConnection(input([], { accountsLoaded: false }));
    expect(checking).toEqual({ kind: "checking" });
    expect(nothingToRead(checking)).toBe(false);
  });
  test("the personal edition only knows calendarRange", () => {
    expect(calendarConnection({ enabled: false, accounts: [] })).toEqual({ kind: "none" });
    expect(calendarConnection({ enabled: false, accounts: [], calendarRange: { startMs: 0, endMs: 1 } })).toEqual({ kind: "ok" });
  });
});

describe("coverage with nothing to read", () => {
  test("an unloaded day is 'none' (plain), never 'missing' or 'loading'; a loaded day stays loaded", () => {
    const day = new Date(2026, 9, 14);
    expect(dayCoverage(day, { enabled: true, coverage: [], nothingToRead: true, loading: true })).toBe("none");
    const ready = [{ accountId: "a", calendarId: "c", startMs: new Date(2026, 9, 12).getTime(), endMs: new Date(2026, 9, 19).getTime(), status: "ready" as const }];
    expect(dayCoverage(day, { enabled: true, coverage: ready, nothingToRead: true })).toBe("loaded");
  });
});

describe("CalendarSetupNotice", () => {
  const render = (connection: Parameters<typeof calendarConnection>[0]) => renderToStaticMarkup(createElement(CalendarSetupNotice, { connection: calendarConnection(connection), onConnect() {}, onChooseCalendars() {}, onOpenPrivacy() {}, onCheckAgain() {} }));
  test("none: one clear action to connect", () => {
    const html = render(input([]));
    expect(html).toContain("No calendar connected");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(">Connect a calendar<");
  });
  test("access off: says so plainly, opens Privacy Settings and can check again", () => {
    const html = render(input([apple({ status: "accessOff", selectedCalendarIds: [] })]));
    expect(html).toContain("Calendar access is off");
    expect(html).toContain("Privacy &amp; Security → Calendars");
    expect(html).toContain(">Open Privacy Settings<");
    expect(html).toContain(">Check again<");
  });
  test("no calendars chosen: names the account and offers to choose", () => {
    const html = render(input([apple({ selectedCalendarIds: [] })]));
    expect(html).toContain("macOS Calendar is connected, but no calendar is chosen to show here.");
    expect(html).toContain(">Choose calendars<");
  });
  test("ok, checking and failed show nothing here (failed is the view's status line)", () => {
    expect(render(input([apple()]))).toBe("");
    expect(render(input([], { accountsLoaded: false }))).toBe("");
    expect(render(input([apple()], { rangeError: "calendarUnavailable" }))).toBe("");
  });
  test("outline icon, no amber text and no hatch", () => {
    const html = render(input([]));
    expect(html).toContain("lucide");
    expect(html).not.toMatch(/amber|warn|hatch/);
  });
});


describe("accountState (Settings → Calendar connections)", () => {
  const NOW = new Date(2026, 9, 18, 12, 0).getTime();
  const src = (id: string, extra: Partial<CalendarSource> = {}): CalendarSource => ({ id, accountId: "apple-local", name: id, read: true, edit: true, selected: true, ...extra });
  const five = ["a", "b", "c", "d", "e"].map((id) => src(id));
  test("precedence: updating, access off, sign in again, withdrawn, scope, failed, list incomplete, nothing chosen, ok", () => {
    const a = apple({ status: "accessOff", code: "calendarReauthenticationRequired" });
    expect(accountState(a, { busyId: "apple-local" }).kind).toBe("updating");
    expect(accountState(a).kind).toBe("accessOff");
    expect(accountState(apple({ code: "calendarReauthenticationRequired", status: "error" })).kind).toBe("signInAgain");
    expect(accountState(apple({ code: "calendarAccessDenied" })).kind).toBe("accessWithdrawn");
    expect(accountState(apple({ code: "calendarScopeIncomplete" })).kind).toBe("scopeIncomplete");
    expect(accountState(apple({ status: "error" })).kind).toBe("failed");
    expect(accountState(apple({ status: "error", code: "calendarNetworkUnavailable" })).kind).toBe("failed");
    expect(accountState(apple({ status: "partial" })).kind).toBe("listIncomplete");
    expect(accountState(apple({ selectedCalendarIds: [] })).kind).toBe("nothingChosen");
    expect(accountState(apple()).kind).toBe("ok");
  });
  test("failed comes from error or stale coverage or a refused range, and remembers the last ready snapshot", () => {
    const ready = new Date(2026, 9, 18, 9, 40).getTime();
    const coverage: CalendarCoverage[] = [{ accountId: "apple-local", startMs: 0, endMs: 1, status: "ready", refreshedAtMs: ready }, { accountId: "apple-local", startMs: 1, endMs: 2, status: "stale" }, { accountId: "other", startMs: 0, endMs: 1, status: "error" }];
    const failed = accountState(apple(), { coverage });
    expect(failed).toMatchObject({ kind: "failed", showingFrom: ready });
    expect(stateText(failed, NOW)).toEqual(["Couldn’t update", "Showing meetings from 9:40"]);
    expect(accountState(apple(), { rangeError: "calendarUnavailable" }).kind).toBe("failed");
    // A refused range does not make an account with nothing chosen "failed".
    expect(accountState(apple({ selectedCalendarIds: [] }), { rangeError: "calendarUnavailable" }).kind).toBe("nothingChosen");
  });
  test("Mac calendars before a saved choice count as all ticked; after it, the saved ticks count", () => {
    const unsaved = accountState(apple({ selectionSaved: false }), { sources: five.map((s) => ({ ...s, selected: false })) });
    expect(unsaved).toMatchObject({ kind: "ok", ticked: 5, readable: 5 });
    const saved = accountState(apple({ selectionSaved: true }), { sources: five, ticked: ["a", "b", "c", "d"] });
    expect(stateText(saved, NOW)).toEqual(["Connected", "4 of 5 calendars"]);
    expect(stateText(accountState(apple({ lastSyncMs: NOW - 120000 }), { sources: five }), NOW)).toEqual(["Connected", "All 5 calendars", "Updated 2 min ago"]);
    expect(stateText(accountState(apple(), { sources: [src("a")] }), NOW)).toEqual(["Connected", "1 calendar"]);
    expect(accountState(apple({ selectionSaved: true }), { sources: five, ticked: [] }).kind).toBe("nothingChosen");
  });
  test("an unreadable (free/busy) calendar never counts", () => {
    const sources = [src("a"), src("b", { read: false })];
    expect(accountState({ ...apple(), provider: "google", selectionSaved: true }, { sources, ticked: ["a", "b"] })).toMatchObject({ ticked: 1, readable: 1 });
  });
  test("ordering: access off, sign in again, withdrawn, failed, list incomplete, nothing chosen, then healthy; Mac, Microsoft, Google", () => {
    const rows = [
      { ...apple({ id: "g-ok" }), provider: "google" as const, email: "b@example.test" },
      { ...apple({ id: "m-sign", code: "calendarReauthenticationRequired" }), provider: "microsoft" as const, email: "m@example.test" },
      { ...apple({ id: "g-none", selectedCalendarIds: [] }), provider: "google" as const, email: "a@example.test" },
      apple({ id: "mac-ok" }),
      { ...apple({ id: "g-fail", status: "error" }), provider: "google" as const, email: "c@example.test" },
      { ...apple({ id: "m-ok" }), provider: "microsoft" as const, email: "z@example.test" },
    ];
    expect(sortAccounts(rows, (a) => accountState(a).kind).map((a) => a.id)).toEqual(["m-sign", "g-fail", "g-none", "mac-ok", "m-ok", "g-ok"]);
  });
  test("updated times read like the menu bar: just now, minutes, hours, then the date", () => {
    expect(updatedText(NOW - 30000, NOW)).toBe("just now");
    expect(updatedText(NOW - 2 * 60000, NOW)).toBe("2 min ago");
    expect(updatedText(NOW - 3600000, NOW)).toBe("1 h ago");
    expect(updatedText(new Date(2026, 9, 14, 8).getTime(), NOW)).toBe("14 Oct");
  });
  test("footers replace the old selection hint", () => {
    expect(calendarListFooter({ provider: "apple" })).toBe("All calendars are read until you untick one.");
    expect(calendarListFooter({ provider: "apple", selectionSaved: true })).toBe("New calendars on this Mac start unticked.");
    expect(calendarListFooter({ provider: "microsoft" })).toBe("Read only. Live Interview can’t change Microsoft calendars.");
    expect(calendarListFooter({ provider: "google", selectionSaved: true })).toBe("Read only. Live Interview can’t change Google calendars.");
  });
  test("Mac calendars group by account; older '{account} · {name}' names are split; other providers have no groups", () => {
    const groups = calendarGroups("apple", [src("a", { name: "Home", group: "iCloud" }), src("b", { name: "Exchange · Calendar" }), src("c", { name: "Work", group: "iCloud" })]);
    expect(groups.map((g) => [g.group, g.sources.map((s) => s.label)])).toEqual([["iCloud", ["Home", "Work"]], ["Exchange", ["Calendar"]]]);
    expect(calendarGroups("google", [src("a", { name: "Team · rota", group: "x" })]).map((g) => [g.group, g.sources[0].label])).toEqual([[undefined, "Team · rota"]]);
  });
  test("colours are drawn only when they are #rrggbb", () => {
    expect(calendarColor("#1BADF8")).toBe("#1BADF8");
    expect(calendarColor("red")).toBeUndefined();
    expect(calendarColor("#fff;background:url(x)")).toBeUndefined();
    expect(calendarColor(undefined)).toBeUndefined();
  });
});
