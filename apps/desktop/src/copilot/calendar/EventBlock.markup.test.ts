import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EventBlock } from "./EventBlock";
import { JoinButton, isJoinSoon } from "./JoinButton";
import { AvatarStack } from "./AvatarStack";
import { NOW, at, itemsOf, planFor, timed } from "./calendarFixtures";

const [ready] = itemsOf([timed("e1", "Customer discovery", 16, 14, 15, { joinUrl: "https://meet.example.test/x", recurring: true, attendees: [{ name: "Alex Morgan" }, { name: "Riley Chen" }, { name: "Sam Lee" }, { name: "Jo Park" }] })], [planFor("e1")]);
const [draft] = itemsOf([timed("e2", "Pricing review", 16, 16, 17)], [planFor("e2", "draft")]);
const [none] = itemsOf([timed("e3", "Standup", 16, 9, 9)]);
const [plan] = itemsOf([timed("plan:x", "Draft kickoff", 16, 11, 12)]);
const block = (item: unknown, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(EventBlock, { item, variant: "week", busy: false, now: NOW, onOpen() {}, ...props } as never));

describe("event block", () => {
  test("readiness decides the tone and nothing else", () => {
    expect(block(ready)).toContain("tone-ready");
    expect(block(draft)).toContain("tone-draft");
    expect(block(none)).toContain("tone-none");
    const dashed = block(plan);
    expect(dashed).toContain("tone-unsynced");
    expect(dashed).toContain("dashed");
    expect(dashed).toContain("Only in this app");
    expect(block(ready)).not.toContain("dashed");
  });
  test("past meetings use the past style, upcoming ones do not", () => {
    expect(block(none)).toContain("is-past");
    expect(block(ready)).not.toContain("is-past");
  });
  test("one button per block, in every variant", () => {
    for (const variant of ["week", "month", "drawer"]) expect(block(ready, { variant, tier: "full" }).match(/<button/g)).toHaveLength(1);
  });
  test("the name starts with the visible words and adds day, readiness, repeats and people", () => {
    const week = block(ready, { tier: "two" });
    const range = week.match(/cal-ev-time">([^<]+)</)![1];
    expect(week).toContain(`aria-label="${range} Customer discovery, `);
    expect(week).toContain("Brief ready, repeats, with Alex Morgan and 3 others");
    const month = block(ready, { variant: "month" });
    const start = month.match(/cal-ev-when">([^<]+)</)![1];
    expect(month).toContain(`aria-label="Customer discovery ${start}, `);
    expect(block(ready, { tier: "line" })).toMatch(/aria-label="Customer discovery [^",]+, /);
  });
  test("one-line and month blocks put the title first and the time after it", () => {
    for (const html of [block(ready, { tier: "line" }), block(ready, { variant: "month" })]) {
      expect(html).toMatch(/cal-ev-title">Customer discovery<\/span><span class="cal-ev-when">[^<]+<\/span>/);
      expect(html).not.toContain(" · ");
    }
  });
  test("a one-line block under 140 px drops the visible time; the name still starts with the title and has the time", () => {
    const wide = block(ready, { tier: "line", widthRem: 10 });
    const tight = block(ready, { tier: "line", widthRem: 9.9 });
    expect(wide).toContain("cal-ev-when");
    expect(tight).not.toContain("cal-ev-when");
    expect(tight).toMatch(/aria-label="Customer discovery [^",]*[AP]M, /);
    expect(tight).toContain("Customer discovery</span>");
    expect(tight).toMatch(/title="[^"]*[AP]M – [^"]*[AP]M Customer discovery"/);
    expect(wide).toContain('title="Customer discovery"');
  });
  test("busy gives aria-disabled and not disabled", () => {
    const html = block(ready, { busy: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(block(ready)).not.toContain("aria-disabled");
  });
  test("height tiers: one line, time and title, full card with readiness words and avatars", () => {
    expect(block(ready, { tier: "line" })).not.toContain("cal-ev-time");
    expect(block(ready, { tier: "two" })).toContain("cal-ev-time");
    expect(block(ready, { tier: "two" })).not.toContain("cal-ev-ready");
    const full = block(ready, { tier: "full" });
    expect(full).toContain("cal-ev-ready");
    expect(full).toContain("cal-avatars");
  });
  test("nav attributes and tab index are passed through", () => {
    const html = block(ready, { nav: { id: "e:1", col: 2, order: 840 }, tabIndex: -1 });
    expect(html).toContain('data-nav="e:1"');
    expect(html).toContain('data-col="2"');
    expect(html).toContain('tabindex="-1"');
  });
  test("no pill, badge, invitation response or place", () => {
    for (const item of [ready, draft, none, plan]) for (const variant of ["week", "month", "drawer"]) {
      const html = block(item, { variant, tier: "full" });
      expect(html).not.toMatch(/pill|badge/);
      expect(html).not.toMatch(/accepted|declined|location/i);
    }
  });
});

describe("join button", () => {
  const join = (item: unknown, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(JoinButton, { item, busy: false, now: NOW, ...extra } as never));
  test("renders only with a link, as its own button named after the meeting", () => {
    expect(join(ready)).toContain('aria-label="Join call: Customer discovery"');
    expect(join(ready)).toContain(">Join<");
    expect(join(none)).toBe("");
    expect(join({ title: "x", joinUrl: "javascript:alert(1)", startMs: 0, endMs: 1 })).toBe("");
  });
  test("accent border from ten minutes before the start until the end, none earlier or later", () => {
    expect(isJoinSoon({ startMs: at(16, 11), endMs: at(16, 12) }, at(16, 10, 50))).toBe(true);
    expect(isJoinSoon({ startMs: at(16, 11), endMs: at(16, 12) }, at(16, 10, 49))).toBe(false);
    expect(isJoinSoon({ startMs: at(16, 11), endMs: at(16, 12) }, at(16, 11, 30))).toBe(true);
    expect(isJoinSoon({ startMs: at(16, 11), endMs: at(16, 12) }, at(16, 12))).toBe(false);
    expect(join(ready, { now: at(16, 13, 55) })).toContain("is-soon");
    expect(join(ready, { now: at(16, 8) })).not.toContain("is-soon");
  });
  test("is inert while a live meeting runs, and never starts a recording", () => {
    const html = join(ready, { busy: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).not.toMatch(/record/i);
  });
});

describe("avatar stack", () => {
  test("shows three people and counts the rest, decorative only", () => {
    const html = renderToStaticMarkup(createElement(AvatarStack, { people: ["Alex Morgan", "Riley Chen", "Sam Lee", "Jo Park", "Kim Wu"], size: "today" }));
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/class="avatar"/g)).toHaveLength(3);
    expect(html).toContain("+2");
    expect(html).toContain("size-today");
    expect(renderToStaticMarkup(createElement(AvatarStack, { people: [], size: "week" }))).toBe("");
  });
});
