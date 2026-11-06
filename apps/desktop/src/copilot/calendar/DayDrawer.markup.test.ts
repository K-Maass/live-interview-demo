import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DayDrawer } from "./DayDrawer";
import { NOW, allDayRow, itemsOf, planFor, timed } from "./calendarFixtures";

const rows = [
  timed("e1", "Customer discovery", 14, 14, 15, { joinUrl: "https://meet.example.test/x", attendees: [{ name: "Alex Morgan" }] }),
  timed("e2", "Pricing review", 14, 16, 17),
  timed("plan:abc", "Draft kickoff", 14, 9, 10),
  allDayRow("h1", "Public holiday", 14, 14),
  timed("e9", "Another day", 15, 9, 10),
];
const day = new Date(2026, 9, 14);
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DayDrawer, { day, items: itemsOf(rows, [planFor("e1")]), coverage: "loaded", now: NOW, busy: false, onOpen() {}, onClose() {}, ...extra } as never));

describe("day drawer markup", () => {
  test("a non-modal dialog named by its heading, reusing the guidance drawer panel", () => {
    const html = render();
    expect(html).toContain("guidance-drawer");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    const labelled = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`<h2 id="${labelled.replace(/[:]/g, "\\:")}" tabindex="-1"`));
    expect(html).toContain('aria-label="Close day details"');
  });
  test("lists the day only: all-day first, then rows in time order", () => {
    const html = render();
    expect(html).not.toContain("Another day");
    expect(html.indexOf("Public holiday")).toBeLessThan(html.indexOf("Draft kickoff"));
    expect(html.indexOf("Draft kickoff")).toBeLessThan(html.indexOf("Customer discovery"));
    expect(html.indexOf("Customer discovery")).toBeLessThan(html.indexOf("Pricing review"));
    expect(html).toContain("Brief ready");
    expect(html).toContain("No brief");
    expect(html).toContain("Only in this app");
  });
  test("Join is its own button with the meeting in its name, only for meetings that have a link, never inside the open button", () => {
    const html = render();
    expect(html.match(/cal-join/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Join call: Customer discovery"');
    for (const block of html.match(/<button[^>]*cal-event[\s\S]*?<\/button>/g)!) { expect(block).not.toContain("Join"); expect(block.match(/<button/g)).toHaveLength(1); }
  });
  test("busy makes rows and Join inert with aria-disabled, never disabled", () => {
    const html = render({ busy: true });
    for (const tag of html.match(/<button[^>]*(cal-event|cal-join)[^>]*>/g)!) { expect(tag).toContain('aria-disabled="true"'); expect(tag).not.toMatch(/\sdisabled(=|\s|>)/); }
    expect(render()).not.toContain("aria-disabled");
  });
  test("a day that is not loaded says so instead of reading as empty", () => {
    const html = render({ items: [], coverage: "missing" });
    expect(html).toContain("not loaded for this date");
    expect(html).not.toContain("No meetings on this day");
    expect(render({ items: [], coverage: "loaded" })).toContain("No meetings on this day");
  });
  test("a partly loaded day names the calendars", () => {
    expect(render({ coverage: "partial", partialAccounts: ["Work", "Family"] })).toContain("only partly loaded (Work, Family)");
  });
  test("Show week appears only when the owner offers it", () => {
    expect(render()).not.toContain("Show week");
    expect(render({ onShowWeek() {} })).toContain("Show week");
  });
  test("no pill, badge, invitation response, place or recording button", () => {
    const html = render({ onShowWeek() {} });
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
    expect(html).not.toContain("Start recording");
  });
});
