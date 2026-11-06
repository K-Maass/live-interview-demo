import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CalendarCoverage } from "@live-interview/core";
import { CalendarView } from "./CalendarView";
import { NOW, timed } from "./calendarFixtures";

// Effects do not run in static markup, so this checks the first paint: toolbar, grid, search status and legend.
const monday = new Date(2026, 9, 12).getTime();
const coverage: CalendarCoverage[] = [{ accountId: "a1", calendarId: "c1", startMs: monday, endMs: monday + 4 * 86_400_000, status: "ready" }];
const controller = { calendarRange: undefined, publicProduct: { enabled: true, plans: [], accounts: [{ id: "a1", provider: "google", name: "Work", email: "me@example.test", status: "connected", selectedCalendarIds: ["c1"] }], coverage, loadRange: () => Promise.resolve() } };
const upcoming = [timed("e1", "Customer discovery", 14, 14, 15), timed("e2", "Pricing review", 14, 16, 17)];
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(CalendarView, { c: controller, mode: "week", upcoming, now: NOW, busy: false, query: "", onOpen() {}, ...props } as never));

describe("calendar view first paint", () => {
  test("week: toolbar, grid and the shortcuts on the container", () => {
    const html = render();
    expect(html).toContain("cal-toolbar");
    expect(html).toContain("cal-week-scroll");
    expect(html).toContain('aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown T Escape"');
    expect(html).not.toContain("role=\"dialog\"");
    expect(html).not.toMatch(/pill|badge/);
  });
  test("month renders the month grid for the same items", () => {
    expect(render({ mode: "month" })).toContain("cal-month-cell");
  });
  test("first paint of an account-backed range reads as loading, not as unloaded", () => {
    const html = render();
    expect(html).toContain("cov-loading");
    expect(html).not.toContain("Not loaded");
  });
  test("days outside the loaded range are labelled, with a legend", () => {
    const html = render({ c: { calendarRange: { startMs: monday, endMs: monday + 3 * 86_400_000 }, publicProduct: { ...controller.publicProduct, enabled: false } } });
    expect(html).toContain("Not loaded");
    expect(html).toContain("Hatched dates are not loaded");
  });
  test("a covered week or month with nothing in it says so; unloaded or loading ones never do", () => {
    const loadedRange = { calendarRange: { startMs: monday - 30 * 86_400_000, endMs: monday + 60 * 86_400_000 }, publicProduct: { ...controller.publicProduct, enabled: false } };
    expect(render({ c: loadedRange, upcoming: [] })).toContain("No meetings this week");
    expect(render({ c: loadedRange, upcoming: [], mode: "month" })).toContain("No meetings this month");
    expect(render({ c: loadedRange })).not.toContain("No meetings this");
    expect(render({ c: { ...loadedRange, calendarRange: { startMs: monday, endMs: monday + 3 * 86_400_000 } }, upcoming: [] })).not.toContain("No meetings this");
    expect(render({ upcoming: [] })).not.toContain("No meetings this");
  });
  test("with no calendar to read the grid is plain: no hatch, no 'Not loaded', no legend, no 'No meetings'", () => {
    const states = {
      none: { accounts: [] },
      accessOff: { accounts: [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "accessOff", code: "calendarPermissionDenied", selectedCalendarIds: [] }] },
      noCalendars: { accounts: [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: [] }] },
    };
    for (const [name, product] of Object.entries(states)) {
      for (const mode of ["week", "month"]) {
        const html = render({ mode, upcoming: [], c: { calendarRange: undefined, publicProduct: { ...controller.publicProduct, coverage: [], ...product } } });
        expect(html, name + " " + mode).toContain("cov-none");
        expect(html, name + " " + mode).not.toMatch(/cov-missing|Not loaded|Hatched dates|No meetings this/);
      }
    }
  });
  test("a load refused as a whole says why, with Retry", () => {
    const html = render({ upcoming: [], c: { calendarRange: undefined, publicProduct: { ...controller.publicProduct, coverage: [], rangeError: "calendarReauthenticationRequired" } } });
    expect(html).toContain("Couldn’t load the calendar.");
    expect(html).toContain("needs you to sign in again");
    expect(html).toContain(">Retry<");
  });
  test("a search says how many meetings match", () => {
    expect(render({ query: "pricing" })).toContain("1 of 2 meetings match");
  });
  test("the Today button and the arrows exist and nothing offers to start a recording", () => {
    const html = render();
    expect(html).toContain("Previous week");
    expect(html).not.toContain("Start recording");
  });
});
