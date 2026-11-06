import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The stylesheet is part of the contract: these are the rules the markup tests cannot see.
const css = readFileSync(new URL("./live.css", import.meta.url), "utf8");

describe("live.css", () => {
  test("a draft or pending card's condition line is muted text, never amber", () => {
    const rule = css.split("}").find((r) => r.trim().startsWith(".guidance-condition {"));
    expect(rule).toBeDefined();
    expect(rule).toMatch(/color:var\(--muted\)/);
    expect(rule).not.toMatch(/--amber/);
  });
  test("the open transcript drawer reserves room under its last row for the floating help bar", () => {
    const rules = css.split("}").filter((r) => r.trim().startsWith(".live-drawer {"));
    expect(rules.some((r) => /padding-bottom:\s*calc\(var\(--intent-bar-space/.test(r))).toBe(true);
    expect(css).toMatch(/--intent-bar-space:\s*\d+px/);
  });
});
