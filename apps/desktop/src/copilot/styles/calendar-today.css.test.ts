import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./calendar-today.css", import.meta.url), "utf8");
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()|]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Today styles", () => {
  test("the now line is 1 px and orange; the dot stays", () => {
    expect(rule(".spine-now-line")).toMatch(/border-top: 1px solid var\(--now\)/);
    expect(rule(".spine-now-dot")).toMatch(/background: var\(--now\)/);
  });
  test("cards have no shadow and no gradient; the only gradient is the unloaded hatch", () => {
    expect(rule(".cal .today-card")).not.toMatch(/shadow|gradient/);
    expect(css.match(/linear-gradient\(/g)).toHaveLength(1);
    expect(rule(".today-unloaded")).toMatch(/repeating-linear-gradient/);
  });
  test("the card is 3.5 rem tall at least with the specified padding and radius", () => {
    const card = rule(".cal .today-card");
    expect(card).toMatch(/min-height: 3\.5rem/);
    expect(card).toMatch(/padding: 12px 14px/);
    expect(card).toMatch(/border-radius: var\(--radius\)/);
  });
  test("the title button is stretched over the card; People and Join sit above it", () => {
    expect(css).toMatch(/\.today-card-open::after \{ content: ""; position: absolute; inset: 0;/);
    expect(css).toMatch(/button\.today-people-toggle, \.cal \.today-card button\.cal-join \{ position: relative; z-index: 1; \}/);
  });
});
