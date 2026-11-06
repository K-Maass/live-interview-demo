import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CalendarToolbar, periodLabel } from "./CalendarToolbar";

const render = (status: object, mode = "week") => renderToStaticMarkup(createElement(CalendarToolbar, { mode, label: "12 – 18 October 2026", onPrev() {}, onNext() {}, onToday() {}, status, onRetry() {} } as never));

describe("toolbar", () => {
  test("previous, next and Today, with the period title as a polite live heading", () => {
    const html = render({});
    expect(html).toContain('aria-label="Previous week"');
    expect(html).toContain('aria-label="Next week"');
    expect(html).toContain(">Today<");
    expect(html).toContain('<h2 aria-live="polite">12 – 18 October 2026</h2>');
    expect(render({}, "month")).toContain("Next month");
  });
  test("the status region is always there so announcements work, and empty when all is well", () => {
    expect(render({})).toMatch(/<p class="cal-status" role="status"><\/p>/);
  });
  test("loading, partly loaded with names, error with Retry, and search matches", () => {
    expect(render({ loading: true })).toContain("Loading calendar…");
    const partial = render({ partial: ["Work", "Family"] });
    expect(partial).toContain("cal-status-warn\">Partly loaded");
    expect(partial).toContain("Partly loaded</span>: Work, Family");
    expect(partial).not.toContain(" :");
    const error = render({ error: ["Work"] });
    expect(error).toContain("Couldn’t load Work.");
    expect(error).toContain(">Retry<");
    expect(render({ error: [] })).toContain("Couldn’t load the calendar.");
    expect(render({ matches: { shown: 3, total: 12 } })).toContain("3 of 12 meetings match");
    expect(render({ matches: { shown: 1, total: 1 } })).toContain("1 of 1 meeting matches");
  });
  test("an empty loaded range says so", () => {
    expect(render({ empty: "No meetings this week" })).toContain("No meetings this week");
    expect(render({ empty: "No meetings this week", partial: ["Work"] })).not.toContain("No meetings this week");
    expect(render({ empty: "No meetings this week", error: [] })).not.toContain("No meetings this week");
  });
  test("no pill or badge", () => {
    expect(render({ partial: ["Work"], matches: { shown: 1, total: 2 } })).not.toMatch(/pill|badge/);
  });
});

describe("periodLabel", () => {
  test("weeks inside a month, across months and across years; months; a day", () => {
    const l = (mode: "today" | "week" | "month", d: Date, first?: Date) => periodLabel(mode, d, first).replace(/ /g, " ");
    expect(l("week", new Date(2026, 9, 14), new Date(2026, 9, 12))).toMatch(/^12 – 18 .+ 2026$/);
    const across = l("week", new Date(2026, 8, 30), new Date(2026, 8, 28));
    expect(across).toMatch(/^28 .+ – 4 .+ 2026$/);
    expect(l("week", new Date(2026, 11, 30), new Date(2026, 11, 28))).toMatch(/^28 .+ 2026 – 3 .+ 2027$/);
    expect(l("month", new Date(2026, 9, 14))).toMatch(/2026/);
    expect(l("today", new Date(2026, 9, 17))).toMatch(/17/);
  });
});
