import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Every colour comes from a token in tokens.css, so light and dark mode change together (System Settings ›
// Appearance). A literal colour in any other stylesheet would stay the same in both themes.
const dir = new URL("./", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = readdirSync(dir).filter((name) => name.endsWith(".css"));
const colour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![-\w])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow)(?![-\w])/;
/** Declarations as [property, value], including those nested in @media and @keyframes. */
const declarations = (source: string) =>
  [...source.matchAll(/\{([^{}]*)\}/g)].flatMap((rule) =>
    rule[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as const;
    }),
  );
/**
 * The one justified exception: a transparent black in a shadow. A shadow darkens whatever is behind it, so the same
 * value works on light and dark surfaces, and it carries no text or state.
 */
const neutralShadow = (property: string, value: string) =>
  /^(box|text)-shadow$/.test(property) && value.replace(/#000(?:[0-9a-fA-F]|000[0-9a-fA-F]{2})\b/g, "").match(colour) === null;

describe("colours come from tokens", () => {
  test("the stylesheets were found", () => {
    expect(sheets).toEqual(expect.arrayContaining(["tokens.css", "live.css", "widget.css", "settings.css", "shell.css", "screens.css"]));
  });
  test.each(sheets.filter((name) => name !== "tokens.css"))("%s has no hard-coded colour", (name) => {
    const found = declarations(read(name)).filter(([property, value]) => colour.test(value) && !neutralShadow(property, value));
    expect(found.map(([p, v]) => `${p}: ${v}`)).toEqual([]);
  });
  test("tokens.css sets colours only in custom properties", () => {
    const found = declarations(read("tokens.css")).filter(([property, value]) => !property.startsWith("--") && colour.test(value) && !neutralShadow(property, value));
    expect(found.map(([p, v]) => `${p}: ${v}`)).toEqual([]);
  });
  test("the main stylesheet only imports the token-based sheets", () => {
    const main = readFileSync(new URL("../copilot.css", dir), "utf8");
    expect(main).not.toMatch(colour);
  });
});
