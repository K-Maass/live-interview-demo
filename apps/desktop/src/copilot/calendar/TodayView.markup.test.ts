import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CalendarView } from "./CalendarView";
import { TodayView } from "./TodayView";
import { NOW, allDayRow, at, timed } from "./calendarFixtures";

// Effects do not run in static markup, so this checks the first paint. Coverage comes from `calendarRange` with the
// public product off (the same trick CalendarView's tests use); with it on, the first paint is "loading".
const loadedRange = { startMs: at(12, 0), endMs: at(26, 0) };
const controller = (extra: Record<string, unknown> = {}, product: Record<string, unknown> = {}) => ({ calendarRange: loadedRange, publicProduct: { enabled: false, plans: [], accounts: [{ id: "a1", provider: "google", name: "Work", email: "me@example.test", status: "connected", selectedCalendarIds: ["c1"] }], coverage: [], loadRange: () => Promise.resolve(), ...product }, ...extra });
const rows = [
  timed("e1", "Customer discovery", 16, 11, 12, { joinUrl: "https://meet.example.test/x", attendees: [{ name: "Alex Morgan" }, { name: "Sam Lee" }], recurring: true }),
  timed("e2", "Pricing review", 16, 14, 15),
  timed("plan:abc", "Draft kickoff", 16, 16, 17),
  timed("e3", "Tomorrow standup", 17, 9, 10),
  timed("e4", "Review with finance", 19, 10, 11),
];
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(TodayView, { c: controller(), upcoming: rows, now: NOW, busy: false, query: "", onOpen() {}, onPick() {}, onStart() {}, onShowWeek() {}, onManageCalendars() {}, ...extra } as never));

describe("today view markup", () => {
  test("up next, the spine, the now-marker and Later this week, in that order", () => {
    const html = render();
    const order = ["today-upnext", "class=\"spine\"", "role=\"separator\"", "today-later"].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Up next · in 30 min");
    expect(html).toContain("Later this week");
    expect(html).toContain("Tomorrow standup");
    expect(html).toContain("Review with finance");
  });
  test("no pill or badge, no invitation responses or places, no previous/next arrows", () => {
    const html = render();
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
    expect(html).not.toMatch(/Previous|Next day|Next week/);
  });
  test("Start recording appears once, in the Up next strip, and nowhere else in Today, Week or Month", () => {
    const html = render();
    expect(html.match(/Start recording/g)).toHaveLength(1);
    expect(html.indexOf("Start recording")).toBeLessThan(html.indexOf('class="spine"'));
    for (const mode of ["week", "month"]) {
      const grid = renderToStaticMarkup(createElement(CalendarView, { c: controller(), mode, upcoming: rows, now: NOW, busy: false, query: "", onOpen() {} } as never));
      expect(grid).not.toContain("Start recording");
    }
  });
  test("Join is its own button, named 'Join call: …', once in the strip and once on the card, never inside an open button", () => {
    const html = render();
    expect(html.match(/aria-label="Join call: Customer discovery"/g)).toHaveLength(2);
    for (const open of html.match(/<button[^>]*today-card-open[\s\S]*?<\/button>/g)!) expect(open).not.toContain("Join");
  });
  test("the status line is always there for a live region and says nothing when all is well", () => {
    expect(render()).toContain('<p class="today-status" role="status"></p>');
  });
  test("chosen calendars that did not load today are a hatched panel with Refresh and Manage calendars, never 'Nothing'", () => {
    const later = { calendarRange: { startMs: at(18, 0), endMs: at(26, 0) } };
    const html = render({ c: controller(later) });
    expect(html).toContain("today-unloaded");
    expect(html).toContain("Today’s calendar isn’t loaded.");
    expect(html).toContain(">Refresh<");
    expect(html).toContain(">Manage calendars<");
    expect(html).not.toContain("Nothing");
    const empty = render({ c: controller(later), upcoming: [] });
    expect(empty).toContain("Today’s calendar isn’t loaded.");
    expect(empty).not.toContain("Nothing on your calendar today");
  });
  test("with no calendar to read Today is plain: no hatched panel, no 'Nothing', no 'not loaded' (the page notice says why)", () => {
    const products = {
      none: { accounts: [] },
      accessOff: { accounts: [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "accessOff", code: "calendarPermissionDenied", selectedCalendarIds: [] }] },
      noCalendars: { accounts: [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: [] }] },
      legacyNone: { enabled: false },
    };
    for (const [name, product] of Object.entries(products)) {
      const html = render({ c: controller({ calendarRange: undefined }, { enabled: true, ...product }), upcoming: [] });
      expect(html, name).not.toMatch(/today-unloaded|isn’t loaded|Nothing on your calendar|Nothing else on your calendar|not loaded|Couldn’t load/);
      expect(html, name).toContain("Later this week");
    }
  });
  test("while the account list is still arriving nothing is claimed either way", () => {
    const html = render({ c: controller({ calendarRange: undefined }, { enabled: true, accountsLoaded: false, accounts: [] }), upcoming: [] });
    expect(html).not.toMatch(/today-unloaded|Nothing on your calendar|Couldn’t load/);
  });
  test("a load refused as a whole is the status line with the reason and Retry, and no hatched panel", () => {
    const html = render({ c: controller({ calendarRange: undefined }, { enabled: true, rangeError: "calendarPermissionDenied" }), upcoming: [] });
    expect(html).toContain("Couldn’t load the calendar.");
    expect(html).toContain("Privacy &amp; Security → Calendars");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("today-unloaded");
    const unknown = render({ c: controller({ calendarRange: undefined }, { enabled: true, rangeError: "calendarUnavailable" }), upcoming: [] });
    expect(unknown).toContain("The calendars on this Mac didn’t answer.");
  });
  test("a fully loaded empty day says so and still shows Later this week", () => {
    const html = render({ upcoming: [] });
    expect(html).toContain("Nothing on your calendar today.");
    expect(html).toContain("Later this week");
    expect(html).toContain(">Open Week<");
    expect(html).not.toContain("today-unloaded");
    expect(html).not.toContain("class=\"spine\"");
  });
  test("while the range loads (first paint with the public product on) nothing is claimed either way", () => {
    const html = render({ c: controller({ calendarRange: undefined }, { enabled: true }), upcoming: [] });
    expect(html).not.toContain("Nothing on your calendar today");
    expect(html).not.toContain("isn’t loaded");
    expect(html).not.toContain("Partly loaded");
    expect(html).toContain('role="status"');
  });
  test("partial coverage is amber text", () => {
    const html = render({ c: controller({ calendarRange: { startMs: at(16, 12), endMs: at(26, 0) } }) });
    expect(html).toContain("today-status-warn");
    expect(html).toContain("Partly loaded");
    expect(html).not.toContain("today-unloaded");
    const empty = render({ c: controller({ calendarRange: { startMs: at(16, 12), endMs: at(26, 0) } }), upcoming: [] });
    expect(empty).not.toContain("Nothing on your calendar today");
    expect(empty).toContain("No meetings found in the calendars that loaded.");
  });
  test("busy: a notice in the status line and aria-disabled cards, Join, rows and the strip buttons disabled", () => {
    const html = render({ busy: true });
    expect(html).toContain("Unavailable during a live meeting");
    for (const tag of html.match(/<button[^>]*(today-card-open|today-later-row|cal-join)[^>]*>/g)!) expect(tag).toContain('aria-disabled="true"');
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(render()).not.toContain("Unavailable during a live meeting");
  });
  test("search filters the timeline and Later this week and says how many match; Up next is not hidden", () => {
    const html = render({ query: "review" });
    expect(html).toContain("2 of 5 match “review”");
    expect(html).toContain("Pricing review");
    expect(html).toContain("Review with finance");
    expect(html).not.toContain("Tomorrow standup");
    expect(html).not.toContain("Customer discovery</span>");
    expect(html).toContain("today-upnext");
    expect(render({ query: "zzz" })).toContain("No meeting today matches “zzz”.");
  });
  test("all-day events sit above the timeline as slim bars, three at most", () => {
    const html = render({ upcoming: [...rows, ...[1, 2, 3, 4].map((n) => allDayRow("h" + n, "Holiday " + n, 16, 16))] });
    expect(html.indexOf("today-allday")).toBeLessThan(html.indexOf('class="spine"'));
    expect(html.match(/today-allday-bar/g)).toHaveLength(3);
    expect(html).toContain("+1 all-day");
    expect(html).toContain("All day");
  });
  test("plan rows are dashed and say they exist only in this app", () => {
    const html = render();
    expect(html).toMatch(/<article[^>]*dashed[^>]*>[\s\S]*?Draft kickoff[\s\S]*?Only in this app/);
  });
  test("the selected meeting is marked", () => {
    expect(render({ selectedId: "e2" }).match(/aria-current="true"/g)).toHaveLength(1);
  });
  test("the day drawer is closed on first paint", () => {
    expect(render()).not.toContain('role="dialog"');
  });
});

describe("MeetingsPage wiring", () => {
  const source = readFileSync(new URL("../screens/MeetingsPage.tsx", import.meta.url), "utf8");
  test("the layout control is Today | Week | Month and Today is the upcoming view", () => {
    expect(source).toContain('(["today", "week", "month"] as const)');
    expect(source).toContain('view === "calendar" ? period : "today"');
    expect(source).not.toContain('"list"');
  });
  test("the old List and Up next card are gone; Start recording is only wired into TodayView", () => {
    expect(source).not.toContain("up-next");
    expect(source).not.toContain("agenda-day");
    expect(source).toContain("onStart={startEvent}");
    expect(source.match(/onStart=\{startEvent\}/g)).toHaveLength(1);
  });
  test("one setup notice above both views replaces 'No calendar covers these dates yet'", () => {
    expect(source).not.toContain("No calendar covers these dates yet");
    expect(source).not.toContain("Calendar events have not been loaded");
    expect(source.match(/<CalendarSetupNotice /g)).toHaveLength(1);
    expect(source).toContain('invoke("open_privacy_settings", { pane: "calendars" })');
  });
});
