import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DaySpine } from "./DaySpine";
import { NOW, at, itemsOf, planFor, timed } from "./calendarFixtures";

const day = new Date(2026, 9, 16);
const rows = [
  timed("e1", "Customer discovery", 16, 9, 10, { joinUrl: "https://meet.example.test/x", attendees: [{ name: "Alex Morgan", email: "alex@example.test" }, { name: "Me", email: "me@example.test" }], accountId: "a1", recurring: true }),
  timed("e2", "Pricing review", 16, 14, 15),
  timed("plan:abc", "Draft kickoff", 16, 16, 17),
];
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DaySpine, { day, items: itemsOf(rows, [planFor("e1")]), now: NOW, busy: false, onOpen() {}, onPick() {}, onMore() {}, ...extra } as never));

describe("day spine markup", () => {
  test("no pill or badge, no invitation responses or places, no Start recording", () => {
    const html = render();
    expect(html).not.toMatch(/pill|badge/);
    expect(html).not.toMatch(/accepted|declined|location/i);
    expect(html).not.toContain("Start recording");
  });
  test("one card per meeting with a spine segment; the segment carries the readiness tone", () => {
    const html = render();
    expect(html.match(/<article/g)).toHaveLength(3);
    expect(html.match(/class="spine-seg"/g)).toHaveLength(3);
    expect(html).toContain("spine-row spine-block tone-ready");
    expect(html).toContain("spine-row spine-block tone-none");
    expect(html).toContain("spine-row spine-block tone-unsynced");
  });
  test("a gap of 30 minutes or more is labelled, one of 15 minutes is not", () => {
    const html = render();
    expect(html).toContain("4 h free");
    expect(html).toContain("1 h free");
    const short = render({ items: itemsOf([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 10, 11, {}), timed("c", "C", 16, 11, 12)].map((r, i) => i === 1 ? { ...r, startMs: at(16, 10, 15) } : i === 2 ? { ...r, startMs: at(16, 11, 15) } : r)), now: at(16, 8) });
    expect(short).not.toMatch(/\d+ min free/);
    expect(short).toContain('class="spine-row spine-gap"');
    expect(short).toContain("height:0.855rem");
    const half = render({ items: itemsOf([timed("a", "A", 16, 9, 10), { ...timed("b", "B", 16, 10, 11), startMs: at(16, 10, 30) }]), now: at(16, 8) });
    expect(half).toContain("30 min free");
  });
  test("gaps are drawn to scale: 4 h is 13.68 rem, a day-long gap is clamped to 6.8 rem", () => {
    expect(render()).toContain("height:6.8rem");
    expect(render({ items: itemsOf([timed("a", "A", 16, 9, 10), timed("b", "B", 16, 11, 12)]) })).toContain("height:3.42rem");
  });
  test("the now-marker is one separator named with the time, inside the gap at its fraction", () => {
    const html = render();
    expect(html.match(/role="separator"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Now, 10:30"');
    const marker = html.match(/<div class="spine-now"[^>]*>/)![0];
    expect(marker).toContain("top:12.50%");
    expect(html.indexOf("spine-gap")).toBeLessThan(html.indexOf("spine-now"));
    expect(html.slice(html.indexOf("spine-now"))).toContain(">10:30<");
  });
  test("the marker rides inside the segment of the meeting in progress", () => {
    const html = render({ now: at(16, 14, 30) });
    expect(html).toContain('aria-label="Now, 14:30"');
    expect(html).toContain("top:50.00%");
    const block = html.slice(html.indexOf("Pricing review"));
    expect(block.indexOf("spine-now")).toBeGreaterThan(-1);
    expect(block.indexOf("spine-now")).toBeLessThan(block.indexOf("Draft kickoff"));
  });
  test("no marker when now is on another day", () => {
    expect(render({ now: at(17, 10) })).not.toContain("separator");
  });
  test("overlaps: two columns under a caption; the rest is a '+N more' text button on the caption row", () => {
    const two = render({ items: itemsOf([timed("a", "A", 16, 10, 11), timed("b", "B", 16, 10, 11)]), now: at(16, 8) });
    expect(two).toContain("Overlaps · 2 meetings");
    expect(two).toContain("--lanes:2");
    expect(two).not.toContain("more</button>");
    const five = render({ items: itemsOf([1, 2, 3, 4, 5].map((n) => timed("o" + n, "Overlap " + n, 16, 10, 11))), now: at(16, 8) });
    expect(five).toContain("Overlaps · 5 meetings");
    expect(five.match(/<article/g)).toHaveLength(2);
    expect(five).toMatch(/<div class="spine-caption"><p>Overlaps · 5 meetings<\/p><button[^>]*class="spine-more link-button"[^>]*>\+3 more<\/button><\/div>/);
    expect(five).toContain('aria-haspopup="dialog"');
    expect(five).toMatch(/aria-label="\+3 more, /);
    // the button is not in a column of its own
    expect(five.slice(five.indexOf("spine-cols"))).not.toContain("spine-more");
  });
  test("plan rows are dashed and say they exist only in this app", () => {
    const card = render().match(/<article[^>]*>[\s\S]*?<\/article>/g)!.find((a) => a.includes("Draft kickoff"))!;
    expect(card).toContain("dashed");
    expect(card).toContain("Only in this app");
    expect(render().match(/<article[^>]*dashed/g)).toHaveLength(1);
  });
  test("Join is its own button named 'Join call: …', never inside the open button", () => {
    const html = render();
    expect(html).toContain('aria-label="Join call: Customer discovery"');
    expect(html.match(/aria-label="Join call:/g)).toHaveLength(1);
    for (const open of html.match(/<button[^>]*today-card-open[\s\S]*?<\/button>/g)!) {
      expect(open.match(/<button/g)).toHaveLength(1);
      expect(open).not.toContain("cal-join");
    }
  });
  test("a card shows people as names only; the People toggle is collapsed", () => {
    const html = render();
    expect(html).toContain("Alex Morgan");
    expect(html).not.toContain(">Me<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("today-people-list");
    expect(html).toContain(">People<");
  });
  test("busy keeps the cards readable with aria-disabled", () => {
    const html = render({ busy: true });
    const opens = html.match(/<button[^>]*today-card-open[^>]*>/g)!;
    expect(opens).toHaveLength(3);
    for (const tag of opens) { expect(tag).toContain('aria-disabled="true"'); expect(tag).not.toMatch(/\sdisabled(=|\s|>)/); }
    expect(html.match(/<button[^>]*cal-join[^>]*>/)![0]).toContain('aria-disabled="true"');
    expect(render()).not.toContain("aria-disabled");
  });
  test("the selected meeting is marked and past meetings are muted", () => {
    const html = render({ selectedId: "e2", now: at(16, 15, 30) });
    expect(html.match(/<article[^>]*is-selected/g)).toHaveLength(1);
    expect(html).toContain('aria-current="true"');
    expect(html.match(/<article[^>]*is-past/g)).toHaveLength(2);
  });
  test("the card name starts with the visible time and title", () => {
    const tag = render().match(/<button[^>]*today-card-open[^>]*>/g)!.find((t) => t.includes("Customer discovery"))!;
    expect(tag).toMatch(/aria-label="09:00 AM – 10:00 AM Customer discovery, /);
    expect(tag).toContain("Brief ready");
    expect(tag).toContain("repeats");
  });
  test("nothing is drawn without timed meetings", () => {
    expect(render({ items: [] })).toBe("");
  });
});
