import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { UpNextStrip, nextUpMeeting, upNextEyebrow } from "./UpNextStrip";
import { NOW, allDayRow, at, itemsOf, planFor, timed } from "./calendarFixtures";

const row = timed("e1", "Customer discovery", 16, 10, 11, { joinUrl: "https://meet.example.test/x", attendees: ["Alex Morgan", "Sam Lee", "Jo Park", "Kim Wu"].map((name) => ({ name })) });
const [item] = itemsOf([{ ...row, startMs: at(16, 10, 55), endMs: at(16, 11, 55) }], [planFor("e1")]);
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(UpNextStrip, { item, now: NOW, busy: false, onOpen() {}, onStart() {}, ...extra } as never));

describe("up next strip markup", () => {
  test("says when, shows title, time range, readiness as text and at most three avatars plus +N", () => {
    const html = render();
    expect(html).toContain("Up next · in 25 min");
    expect(html).toContain("Customer discovery");
    expect(html).toContain("10:55 AM – 11:55 AM");
    expect(html).toContain("Brief ready");
    expect(html.match(/class="avatar"/g)).toHaveLength(3);
    expect(html).toContain("+1");
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
  });
  test("has Open plan, Join (its own button) and Start recording", () => {
    const html = render();
    expect(html).toContain(">Open plan<");
    expect(html).toContain("Start recording");
    expect(html).toContain('aria-label="Join call: Customer discovery"');
    expect(html.match(/<button/g)).toHaveLength(3);
  });
  test("no Join without a link", () => {
    expect(render({ item: itemsOf([timed("e2", "No link", 16, 11, 12)])[0] })).not.toContain("Join call");
  });
  test("a live meeting disables Open plan and Start recording, as the old card did, and Join with aria-disabled", () => {
    const html = render({ busy: true });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*cal-join[^>]*>/)![0]).toContain('aria-disabled="true"');
  });
  test("in progress reads 'In progress'", () => {
    expect(render({ now: at(16, 11, 10) })).toContain("In progress");
    expect(render({ now: at(16, 11, 10) })).not.toContain("Up next ·");
  });
});

describe("up next choice and wording", () => {
  test("eyebrow", () => {
    expect(upNextEyebrow({ startMs: at(16, 10, 55), endMs: at(16, 12) }, NOW)).toBe("Up next · in 25 min");
    expect(upNextEyebrow({ startMs: at(16, 10, 30), endMs: at(16, 12) }, NOW)).toBe("In progress");
    expect(upNextEyebrow({ startMs: at(16, 10, 30, ), endMs: at(16, 12) }, at(16, 10, 29) + 40_000)).toBe("Up next · starting now");
    expect(upNextEyebrow({ startMs: at(16, 13, 30), endMs: at(16, 14) }, NOW)).toBe("Up next · in 3 h");
    expect(upNextEyebrow({ startMs: at(17, 10), endMs: at(17, 11) }, NOW)).toBe("Up next · Tomorrow");
  });
  test("the first meeting that has not ended wins; a running one beats a later one", () => {
    const items = itemsOf([timed("past", "Past", 16, 8, 9), timed("running", "Running", 16, 10, 11), timed("later", "Later", 16, 12, 13)]);
    expect(nextUpMeeting(items, NOW)?.id).toBe("running");
    expect(nextUpMeeting(items, at(16, 11, 30))?.id).toBe("later");
    expect(nextUpMeeting(items, at(16, 14))).toBeUndefined();
  });
  test("plan rows and all-day events are never Up next", () => {
    const items = itemsOf([timed("plan:x", "Plan", 16, 11, 12), allDayRow("h", "Holiday", 16, 16), timed("e", "Real", 17, 9, 10)]);
    expect(nextUpMeeting(items, NOW)?.id).toBe("e");
  });
});
