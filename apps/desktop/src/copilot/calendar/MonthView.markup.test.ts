import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CoverageState } from "../presentation/accessibility";
import { MonthView } from "./MonthView";
import { MONTH_DAYS, NOW, allDayRow, everyDay, itemsOf, planFor, timed } from "./calendarFixtures";

const rows = [
  ...[1, 2, 3, 4, 5].map((n) => timed("b" + n, "Busy " + n, 14, 8 + n, 9 + n)),
  timed("plan:abc", "Draft kickoff", 15, 9, 10),
  allDayRow("h1", "Public holiday", 16, 16),
  timed("e1", "Customer discovery", 20, 14, 15, { joinUrl: "https://meet.example.test/x" }),
];
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(MonthView, { days: MONTH_DAYS, items: itemsOf(rows, [planFor("e1")]), now: NOW, coverage: everyDay, busy: false, onOpen() {}, onDay() {}, month: 9, ...extra } as never));

describe("month view markup", () => {
  test("no pill, badge, invitation response or place anywhere", () => {
    const html = render();
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
  });
  test("seven weekday names and 42 date buttons, one of them the tab stop", () => {
    const html = render();
    expect(html.match(/cal-month-weekday/g)).toHaveLength(7);
    expect(html.match(/class="cal-month-date"/g)).toHaveLength(42);
    expect(html.match(/<button[^>]*cal-month-date[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('data-nav="d:2026-10-16"');
  });
  test("a cell shows three entries and the rest as a +N more link", () => {
    const html = render();
    expect(html).toContain("+2 more");
    expect(html).toMatch(/aria-label="\+2 more meetings, Wednesday, 14 October"|aria-label="\+2 more meetings, [^"]*14/);
    expect(html.match(/cal-event v-month[^"]*"[^>]*aria-label="[^"]*Busy/g)).toHaveLength(3);
  });
  test("an all-day entry is a bar, app-only rows are dashed and say so", () => {
    const html = render();
    expect(html).toMatch(/cal-event v-month tone-none is-bar[^>]*>/);
    const plan = html.match(/<button[^>]*cal-event[^>]*>/g)!.find((tag) => tag.includes("Draft kickoff"))!;
    expect(plan).toContain("dashed");
    expect(plan).toContain("Only in this app");
  });
  test("unloaded dates are hatched and say Not loaded, weekends are not special", () => {
    const coverage = (d: Date): CoverageState => (d.getDate() === 14 ? "missing" : d.getDate() === 21 ? "partial" : "loaded");
    const html = render({ coverage });
    expect(html).toContain("Not loaded");
    expect(html).toContain("Partly loaded");
    expect(html).toContain("cov-missing");
    expect(html).not.toMatch(/weekend/i);
    expect(render()).not.toContain("Not loaded");
  });
  test("today and dates outside the month are marked", () => {
    const html = render();
    expect(html.match(/cal-month-cell[^"]*is-today/g)).toHaveLength(1);
    expect(html.match(/cal-month-cell[^"]*is-outside/g)).toHaveLength(11);
  });
  test("entries of the active cell are reachable by Tab, all others are skipped", () => {
    const html = render({ activeId: "d:2026-10-14" });
    const entries = html.match(/<button[^>]*cal-event v-month[^>]*>/g)!;
    expect(entries.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(3);
    expect(html).toMatch(/<button[^>]*cal-month-more[^>]*tabindex="0"/);
    expect(entries.filter((tag) => tag.includes('tabindex="-1"')).length).toBeGreaterThan(0);
  });
  test("busy gives aria-disabled; Join and Start recording are not part of the month grid", () => {
    const html = render({ busy: true });
    for (const tag of html.match(/<button[^>]*cal-event[^>]*>/g)!) expect(tag).toContain('aria-disabled="true"');
    expect(html).not.toContain("cal-join");
    expect(html).not.toContain("Start recording");
    for (const block of html.match(/<button[^>]*cal-event[\s\S]*?<\/button>/g)!) expect(block.match(/<button/g)).toHaveLength(1);
  });
});
