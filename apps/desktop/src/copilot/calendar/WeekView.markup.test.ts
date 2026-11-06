import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CoverageState } from "../presentation/accessibility";
import { WeekView } from "./WeekView";
import { NOW, WEEK_DAYS, allDayRow, everyDay, itemsOf, planFor, timed } from "./calendarFixtures";

// Static markup (the package has no DOM): what the Week grid draws, in words.
const rows = [
  timed("e1", "Customer discovery", 14, 14, 15, { joinUrl: "https://meet.example.test/x", attendees: [{ name: "Alex Morgan", email: "alex@example.test" }, { name: "Me", email: "me@example.test" }], accountId: "a1", recurring: true }),
  timed("plan:abc", "Draft kickoff", 15, 9, 10),
  allDayRow("h1", "Public holiday", 15, 15),
  ...[1, 2, 3, 4, 5].map((n) => timed("o" + n, "Overlap " + n, 13, 10, 11)),
];
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(WeekView, { days: WEEK_DAYS, items: itemsOf(rows, [planFor("e1")]), now: NOW, coverage: everyDay, busy: false, onOpen() {}, onDay() {}, ...extra } as never));

describe("week view markup", () => {
  test("says nothing about invitation responses or places, and has no pill or badge", () => {
    const html = render();
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
  });
  test("app-only plan rows are dashed and say they exist only in this app", () => {
    const html = render();
    const plan = html.match(/<button[^>]*cal-event[^>]*>/g)!.find((tag) => tag.includes("Draft kickoff"))!;
    expect(plan).toContain("dashed");
    expect(plan).toContain("tone-unsynced");
    expect(plan).toContain("Only in this app");
  });
  test("unloaded days are hatched and labelled, partial ones say partly loaded", () => {
    const coverage = (d: Date): CoverageState => (d.getDate() === 14 ? "missing" : d.getDate() === 16 ? "partial" : "loaded");
    const html = render({ coverage });
    expect(html).toContain("Not loaded");
    expect(html).toContain("Partly loaded");
    expect(html).toContain("cov-missing");
    expect(html).toContain("calendar not loaded for this date");
    expect(render()).not.toContain("Not loaded");
  });
  test("all-day items sit in the all-day row, not in the hour grid", () => {
    const html = render();
    const body = html.slice(html.indexOf("cal-week-body"));
    expect(html).toContain("Public holiday");
    expect(body).not.toContain("Public holiday");
    expect(html.slice(0, html.indexOf("cal-week-body"))).toContain("cal-allday");
  });
  test("no all-day row when the week has no all-day items", () => {
    expect(render({ items: itemsOf([rows[0]]) })).not.toContain("cal-allday");
  });
  test("a cluster wider than three columns shows one +N button with a spoken label", () => {
    const html = render();
    expect(html).toMatch(/class="cal-more"[^>]*>\+3</);
    expect(html).toMatch(/aria-label="3 more meetings, /);
  });
  test("two columns on a narrow week fold more into +N", () => {
    expect(render({ maxColumns: 2 })).toMatch(/class="cal-more"[^>]*>\+4</);
  });
  test("three lanes only when a day column is at least 240 px (17.15 rem at 14 px)", () => {
    expect(render({ dayWidthRem: 17.2 })).toMatch(/class="cal-more"[^>]*>\+3</);
    expect(render({ dayWidthRem: 17 })).toMatch(/class="cal-more"[^>]*>\+4</);
    expect(render({ dayWidthRem: 11 })).toMatch(/class="cal-more"[^>]*>\+4</);
  });
  test("a block narrower than 96 px shows the title alone; the time stays in the title attribute and the name", () => {
    const pick = (name: string) => (html: string) => html.match(/<button[^>]*cal-event[^>]*>[\s\S]*?<\/button>/g)!.find((b) => b.includes(name))!;
    const overlap = pick("Overlap 1");
    const narrow = overlap(render({ dayWidthRem: 11, maxColumns: 3 }));
    expect(narrow).toContain("is-narrow");
    expect(narrow).not.toContain("cal-ev-time");
    expect(narrow).toMatch(/title="\S+ [AP]M – \S+ [AP]M Overlap 1"|title="[^"]*Overlap 1"/);
    expect(narrow).toMatch(/aria-label="Overlap 1 [^",]*[AP]M, /);
    const wide = pick("Customer discovery")(render({ dayWidthRem: 20 }));
    expect(wide).not.toContain("is-narrow");
    expect(wide).toContain("cal-ev-time");
  });
  test("the hour label next to the now time is hidden but keeps its hour as a title", () => {
    const html = render({ now: new Date(2026, 9, 16, 19, 52).getTime() });
    expect(html).toMatch(/cal-hour-label is-near-now" title="20:00"/);
    expect(html.match(/is-near-now/g)).toHaveLength(1);
    expect(html).toContain("19:52");
    expect(render({ now: new Date(2026, 9, 16, 19, 40).getTime() })).not.toContain("is-near-now");
    expect(render({ now: new Date(2026, 9, 16, 20, 14).getTime() }).match(/is-near-now/g)).toHaveLength(1);
    expect(render({ now: new Date(2026, 9, 25, 19, 52).getTime() })).not.toContain("is-near-now");
  });
  test("the header and the all-day row are one sticky block that comes before the hour grid", () => {
    const html = render();
    const sticky = html.indexOf("cal-week-sticky");
    expect(sticky).toBeGreaterThan(-1);
    expect(sticky).toBeLessThan(html.indexOf("cal-week-head"));
    expect(html.indexOf("cal-week-head")).toBeLessThan(html.indexOf("cal-allday"));
    expect(html.indexOf("cal-allday")).toBeLessThan(html.indexOf("cal-week-body"));
    const stickyBlock = html.slice(sticky, html.indexOf("cal-week-body"));
    expect(stickyBlock).toContain("cal-day-head");
    expect(stickyBlock).toContain("cal-allday");
  });
  test("each meeting is one button; Join and Start recording are not part of the grid", () => {
    const html = render();
    expect(html).not.toContain("cal-join");
    expect(html).not.toContain("Start recording");
    for (const block of html.match(/<button[^>]*cal-event[\s\S]*?<\/button>/g)!) expect(block.match(/<button/g)).toHaveLength(1);
  });
  test("busy keeps blocks readable with aria-disabled instead of disabled", () => {
    const html = render({ busy: true });
    const blocks = html.match(/<button[^>]*cal-event[^>]*>/g)!;
    expect(blocks.length).toBeGreaterThan(3);
    for (const tag of blocks) { expect(tag).toContain('aria-disabled="true"'); expect(tag).not.toMatch(/\sdisabled(=|\s|>)/); }
    expect(render()).not.toContain("aria-disabled");
  });
  test("today is marked, the now line crosses today's column only, and there is one tab stop", () => {
    const html = render();
    expect(html.match(/cal-now-line/g)).toHaveLength(1);
    expect(html.match(/cal-now-time/g)).toHaveLength(1);
    expect(html).toContain("10:30");
    expect(html.match(/col-head[^"]*is-today/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('data-nav="h:2026-10-16"');
    expect(html.match(/tabindex="0"[^>]*data-nav="h:2026-10-16"/)).not.toBeNull();
  });
  test("no now line when today is not in the week", () => {
    expect(render({ now: new Date(2026, 9, 25, 10).getTime() })).not.toContain("cal-now-line");
  });
  test("the blocks carry readiness words and recurrence in their name, starting with the visible time", () => {
    const html = render();
    const tag = html.match(/<button[^>]*cal-event[^>]*>/g)!.find((t) => t.includes("Customer discovery"))!;
    expect(tag).toContain("Brief ready");
    expect(tag).toContain("repeats");
    expect(tag).toContain("with Alex Morgan");
    expect(tag).not.toContain("with Alex Morgan and");
    expect(tag).toContain("tone-ready");
  });
});
