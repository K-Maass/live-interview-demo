import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LATER_MAX_ROWS, LaterThisWeek, laterDayLabel, laterRows } from "./LaterThisWeek";
import { allDayRow, itemsOf, planFor, timed } from "./calendarFixtures";

const today = new Date(2026, 9, 16);
const rows = [
  timed("t1", "Today meeting", 16, 15, 16),
  timed("a", "Pricing review", 17, 9, 10, { recurring: true }),
  timed("b", "Customer discovery", 17, 14, 15),
  timed("plan:p", "Draft kickoff", 19, 9, 10),
  allDayRow("h", "Public holiday", 20, 20),
  timed("far", "Beyond the week", 30, 9, 10),
];
const items = itemsOf(rows, [planFor("a")]);
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(LaterThisWeek, { rows: laterRows(items, today), busy: false, onOpen() {}, onPick() {}, onShowWeek() {}, ...extra } as never));

describe("laterRows", () => {
  test("lists items after today and within seven days, once each, in start order", () => {
    const list = laterRows(items, today);
    expect(list.map((r) => r.item.id)).toEqual(["a", "b", "plan:p", "h"]);
    expect(list.map((r) => r.firstOfDay)).toEqual([true, false, true, true]);
  });
  test("shows at most six rows", () => {
    const many = itemsOf(Array.from({ length: 10 }, (_, i) => timed("m" + i, "M" + i, 17, 8 + i, 9 + i)));
    expect(laterRows(many, today)).toHaveLength(LATER_MAX_ROWS);
  });
  test("a multi-day all-day event that started today is not repeated here", () => {
    expect(laterRows(itemsOf([allDayRow("x", "Offsite", 15, 18)]), today)).toEqual([]);
  });
  test("day labels", () => {
    expect(laterDayLabel("2026-10-17", today)).toBe("Tomorrow");
    expect(laterDayLabel("2026-10-21", today)).toMatch(/21/);
    expect(laterDayLabel("2026-10-21", today)).not.toBe("Tomorrow");
  });
});

describe("later this week markup", () => {
  test("heading, rows with day, time, title and readiness, then an Open Week link", () => {
    const html = render();
    expect(html).toContain("Later this week");
    expect(html).toContain("Tomorrow");
    expect(html).toContain("09:00 AM");
    expect(html).toContain("Pricing review");
    expect(html).toContain("Brief ready");
    expect(html).toContain("All day");
    expect(html).toContain(">Open Week<");
    expect(html).not.toContain("Today meeting");
    expect(html).not.toContain("Beyond the week");
    expect(html.match(/today-later-row/g)).toHaveLength(4);
  });
  test("the day is said once per day visually but every row's name starts with it", () => {
    const html = render();
    expect(html.match(/today-later-day is-repeat/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Tomorrow 09:00 AM – 10:00 AM Pricing review, /);
    expect(html).toMatch(/aria-label="Tomorrow 02:00 PM – 03:00 PM Customer discovery, /);
  });
  test("plan rows are dashed and say they exist only in this app; no pill, badge, recording or responses", () => {
    const html = render();
    expect(html.match(/<button[^>]*today-later-row[^>]*dashed[^>]*>/g)).toHaveLength(1);
    expect(html).toContain("Only in this app");
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
    expect(html).not.toContain("Start recording");
    expect(html).not.toContain("Join");
  });
  test("busy gives aria-disabled on every row", () => {
    const html = render({ busy: true });
    const tags = html.match(/<button[^>]*today-later-row[^>]*>/g)!;
    expect(tags).toHaveLength(4);
    for (const tag of tags) expect(tag).toContain('aria-disabled="true"');
    expect(render()).not.toContain("aria-disabled");
  });
  test("the selected row is marked", () => {
    expect(render({ selectedId: "b" }).match(/aria-current="true"/g)).toHaveLength(1);
  });
  test("an empty week says so only when everything is loaded", () => {
    expect(render({ rows: [] })).toContain("Nothing else on your calendar this week.");
    expect(render({ rows: [], note: "Some of these days are not loaded." })).not.toContain("Nothing else");
    expect(render({ rows: [], note: "Some of these days are not loaded." })).toContain("not loaded");
    expect(render({ rows: [], loading: true })).not.toContain("Nothing");
    expect(render({ rows: [] })).toContain("Open Week");
  });
});
