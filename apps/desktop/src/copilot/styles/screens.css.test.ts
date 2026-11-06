import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The stylesheet is part of the contract: these are the rules the markup tests cannot see.
const css = readFileSync(new URL("./screens.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split("}").find((r) => r.trim().startsWith(selector + " {"));

describe("screens.css", () => {
  test("welcome rail rows grow with larger text instead of overlapping", () => {
    const item = rule(".welcome-rail-item");
    expect(item).toBeDefined();
    expect(item).not.toMatch(/[;{]\s*height:/);
    expect(item).toMatch(/min-height:/);
    // The fill follows the measured rows, so wrapped labels do not leave it short.
    expect(rule(".welcome-rail-fill")).toMatch(/var\(--fill-height/);
  });
});
