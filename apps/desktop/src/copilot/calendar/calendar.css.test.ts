import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The stylesheet is part of the contract: these are the rules the markup tests cannot see.
const css = readFileSync(new URL("../styles/calendar.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split("}").map((r) => r.trim()).filter((r) => r.startsWith(selector + " {") || r.startsWith(selector + "{"));

describe("calendar.css", () => {
  test("the day panel has no amber or brown status text: overlaps are muted, warnings neutral or the blue info tone", () => {
    const dayPanel = css.split("}").filter((r) => /(^|\s|,)\.dp[-\s.{]/.test(r.trim()));
    expect(dayPanel.length).toBeGreaterThan(10);
    for (const r of dayPanel) expect(r).not.toMatch(/var\(--amber\)|#8a5a12/);
    expect(rule(".dp-overlap")[0]).toMatch(/color: var\(--muted\)/);
    expect(rule(".dp-review-note.is-warn")[0]).toMatch(/color: var\(--blue\)/);
  });
  test("the header block sticks to the top of the scrolling grid, above the hour grid", () => {
    const [sticky] = rule(".cal-week-sticky");
    expect(sticky).toMatch(/position: sticky/);
    expect(sticky).toMatch(/top: 0/);
    expect(sticky).toMatch(/z-index: 4/);
    expect(css).toMatch(/\.cal-week-scroll \{[^}]*overflow: auto/);
  });
  test("focus rings are drawn inside the element so scrolling, sticky and clipped parents cannot cut them off", () => {
    const focus = css.match(/\.cal button:is\([^)]*\):focus-visible \{[^}]*\}/)![0];
    for (const name of [".cal-event", ".cal-day-head", ".cal-more", ".cal-bar-more", ".cal-month-more", ".cal-join"]) expect(focus).toContain(name);
    expect(focus).toContain("outline: 2px solid var(--focus-ring)");
    expect(focus).toContain("outline-offset: -2px");
  });
  test("hatching is defined for unloaded and partly loaded dates only", () => {
    const uses = [...css.matchAll(/--hatch: /g)];
    expect(uses).toHaveLength(2);
    expect(css).toMatch(/\.cov-missing \{ --hatch: repeating-linear-gradient\(135deg, transparent 0 6px, var\(--border\) 6px 7px\); background-color: var\(--surface-raised\)/);
    expect(css).toMatch(/\.cov-partial \{ --hatch: /);
    expect(css).not.toMatch(/is-outside[^{]*\{[^}]*--hatch/);
    expect(css).not.toMatch(/weekend[^{]*\{[^}]*--hatch/i);
  });
  test("no pill, badge, shadow on cards or decorative gradient", () => {
    expect(css).not.toMatch(/pill|badge/);
    const cards = css.split("}").filter((r) => /\.cal-event|\.cal-month-cell|\.cal-col\b/.test(r.split("{")[0]));
    for (const r of cards) expect(r).not.toContain("box-shadow");
    expect(css).not.toMatch(/(?<!repeating-)linear-gradient|radial-gradient/);
  });
  test("a Week block's time and title end in an ellipsis instead of being cut off", () => {
    expect(rule(".cal-ev-time")[0]).toMatch(/text-overflow: ellipsis/);
    expect(rule(".cal-ev-time")[0]).toMatch(/overflow: hidden/);
    // A two-line block too short for a two-line title clamps the title to one line, so the clamp's ellipsis shows.
    expect(rule(".cal button.cal-event.v-week.tier-two")[0]).toMatch(/container: cal-block \/ size/);
    expect(css).toMatch(/@container cal-block \(max-height: [\d.]+rem\) \{ \.cal-event\.tier-two \.cal-ev-title \{ -webkit-line-clamp: 1;/);
  });
  test("stacked avatars overlap little enough that every initial stays readable", () => {
    const [stack] = rule(".cal-avatars > * + *");
    const overlap = Number(stack.match(/margin-left: -([\d.]+)rem/)?.[1]);
    expect(overlap).toBeLessThanOrEqual(0.125);
  });
  test("the Month grid fits its container at any text size instead of scrolling sideways", () => {
    expect(rule(".cal-month")[0]).toMatch(/grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  });
  test("an hour label next to the now time is hidden", () => {
    expect(css).toMatch(/\.cal-hour-label\.is-near-now \{ visibility: hidden/);
  });
});
