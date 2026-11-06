import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// WCAG 2.x contrast for the colours the product UI actually uses (#37). Token values are read from tokens.css, so a
// change to a token is checked here rather than by eye. Text needs 4.5:1; non-text parts that identify a control or a
// state need 3:1.
const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const tokens = css("tokens.css");
// Light tokens are the declarations outside the dark block; dark tokens are the ones inside it, falling back to light.
const darkStart = tokens.indexOf("@media (prefers-color-scheme:dark)");
const darkBlock = tokens.slice(darkStart, tokens.indexOf("\n}", darkStart));
const lightBlock = tokens.slice(0, darkStart);
export type Theme = "light" | "dark";
const tokenIn = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{3,6})\\b`))?.[1];
const token = (name: string, theme: Theme = "light"): string => {
  const hex = (theme === "dark" ? tokenIn(darkBlock, name) : undefined) ?? tokenIn(lightBlock, name);
  if (!hex) throw new Error("missing token --" + name);
  return "#" + (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex);
};
type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (foreground: Rgb, alpha: number, background: Rgb): Rgb => foreground.map((v, i) => v * alpha + background[i] * (1 - alpha)) as Rgb;
const themes: Theme[] = ["light", "dark"];

// [description, foreground token, background token]; a background may also be [token, alpha-of-accent] for a tinted state.
const textPairs: [string, string, string][] = [
  ["ink on surface", "ink", "surface"],
  ["muted on surface", "muted", "surface"],
  ["muted on shell", "muted", "shell"],
  ["ink on shell", "ink", "shell"],
  ["ink-soft on shell (sidebar items)", "ink-soft", "shell"],
  ["muted on the stub panel", "muted", "stub"],
  ["accent on surface", "accent", "surface"],
  ["accent on accent-soft", "accent", "accent-soft"],
  ["text on the primary button", "on-accent", "accent"],
  ["text on the primary button while hovered", "on-accent", "accent-hover"],
  ["text on the live Stop & save button", "on-danger", "danger"],
  ["text on the hovered live Stop & save button", "on-danger", "danger-hover"],
  ["error on surface", "error", "surface"],
  ["error on the error notice", "error", "error-soft"],
  ["ink on the error notice", "ink", "error-soft"],
  ["amber on surface", "amber", "surface"],
  ["amber on accent-soft (live-return banner)", "amber", "accent-soft"],
  ["amber on the notice", "amber", "notice-soft"],
  ["ink on the notice", "ink", "notice-soft"],
  ["ink on the success notice", "ink", "success-soft"],
  ["amber on surface-raised (page heading)", "amber", "surface-raised"],
  ["capture warning text", "warning-text", "warning-soft"],
  ["demo banner", "demo-text", "demo-soft"],
  ["selected navigation item", "selected-text", "selected"],
  ["selected type pill", "selected-text", "accent-soft"],
  ["ink on a settings card", "ink", "panel-soft"],
  ["muted on a settings card", "muted", "panel-soft"],
  ["accent on a settings card (links, details)", "accent", "panel-soft"],
  ["disabled button text on a settings card", "disabled-text", "panel-soft"],
  ["muted on the settings section list (group labels, version)", "muted", "sidebar-soft"],
  ["ink on the settings section list", "ink", "sidebar-soft"],
  ["ink on the live toolbar and saved reminders", "ink", "panel-soft"],
  ["ink on the conversation feed", "ink", "feed-soft"],
  ["muted on the conversation feed", "muted", "feed-soft"],
  ["ink on the first suggestion", "ink", "guidance-first"],
  ["muted on the first suggestion", "muted", "guidance-first"],
  ["muted on the global message", "muted", "message-soft"],
  ["ink on the active session link", "ink", "rec-soft"],
  ["muted on the active session link", "muted", "rec-soft"],
  ["ink on a blockquote", "ink", "tint-soft"],
  ["ink on a code or diff preview", "ink", "code-soft"],
  ["ink on the review panel", "ink", "review-soft"],
  ["ink on the calendar delete confirmation", "ink", "confirm-soft"],
  ["ink on a form field", "ink", "field"],
  ["input placeholder", "placeholder", "surface"],
  ["input placeholder in a field", "placeholder", "field"],
  ["ink on a hovered row", "ink", "hover-soft"],
  ["ink on a hovered navigation item", "ink", "nav-hover"],
  ["ink on a hovered toggle", "ink", "hover-strong"],
  ["muted detail on the speech warm-up notice", "muted", "accent-soft"],
  ["ink on the speech warm-up notice", "ink", "accent-soft"],
  // Disabled controls are exempt from WCAG, but a disabled button still carries its reason ("Cancelling…"), so it is held to 4.5:1 too (#106).
  ["disabled button text on its fill", "disabled-text", "disabled-fill"],
  ["disabled button text on the page (transparent disabled controls)", "disabled-text", "surface"],
  ["disabled button text on the shell", "disabled-text", "shell"],
  ["disabled button text on accent-soft (disabled calendar events)", "disabled-text", "accent-soft"],
  // Calendar redesign (#123): readiness colours on their soft backgrounds, and the now marker.
  ["blue on blue-soft (plan started)", "blue", "blue-soft"],
  ["ink on blue-soft", "ink", "blue-soft"],
  ["muted on accent-soft (readiness text on a ready block)", "muted", "accent-soft"],
  ["muted on blue-soft", "muted", "blue-soft"],
  ["muted on surface-raised", "muted", "surface-raised"],
  ["now-text on surface", "now-text", "surface"],
  ["muted on fill (no-brief blocks, avatars)", "muted", "fill"],
  ["today's date on accent", "on-accent", "accent"],
  ["disabled button text on blue-soft (disabled calendar events)", "disabled-text", "blue-soft"],
  // Today view (#123): readiness and secondary text on the Up next strip (surface-raised) and on a selected card (accent-soft).
  ["accent on surface-raised (Up next label, ready text)", "accent", "surface-raised"],
  ["blue on surface-raised (plan started text)", "blue", "surface-raised"],
  ["ink-soft on surface-raised (Up next time line)", "ink-soft", "surface-raised"],
  ["blue on accent-soft (plan started text on a selected card)", "blue", "accent-soft"],
  ["ink-soft on accent-soft (names on a selected card)", "ink-soft", "accent-soft"],
  ["now-text on surface-raised", "now-text", "surface-raised"],
  ["disabled primary button text on its fill", "disabled-primary-text", "disabled-primary-fill"],
  // Meeting page (redesign chunk C): the when line, the "Calendar not updated" status, chips and the day slot.
  ["ink-soft on surface (meeting when line)", "ink-soft", "surface"],
  ["blue on surface (Calendar not updated)", "blue", "surface"],
  ["ink on fill (person chips)", "ink", "fill"],
  ["muted on surface-raised (day slot headings)", "muted", "surface-raised"],
  ["ink-soft on fill (hovered type pill)", "ink-soft", "fill"],
];

describe.each(themes)("text on the product surfaces (%s)", (theme) => {
  const t = (name: string) => rgb(token(name, theme));
  test.each(textPairs)("%s is at least 4.5:1", (_name, foreground, background) => {
    expect(ratio(t(foreground), t(background))).toBeGreaterThanOrEqual(4.5);
  });
  // Meeting time picker: the time on the meeting being drawn, at rest, hovered (6% accent) and while dragged (10% accent).
  test.each([0.06, 0.1])("accent on the drawn meeting tinted %s accent is at least 4.5:1", (alpha) => {
    expect(ratio(t("accent"), over(t("accent"), alpha, t("accent-soft")))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("every light token has a dark counterpart", () => {
  const names = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+):\s*(?:#|rgba?\()/g)].map((m) => m[1]));
  // The widget is dark glass in both appearances, so its tokens are deliberately shared (see tokens.css).
  const shared = (name: string) => name.startsWith("--widget-");
  test("each colour token in :root is redefined for dark mode", () => {
    const light = [...names(lightBlock)].filter((name) => !shared(name));
    const dark = names(darkBlock);
    expect(light.length).toBeGreaterThan(40);
    expect(light.filter((name) => !dark.has(name))).toEqual([]);
  });
  test("dark mode defines no token the light theme lacks", () => {
    const light = names(lightBlock);
    expect([...names(darkBlock)].filter((name) => !light.has(name))).toEqual([]);
  });
  test("native controls and scrollbars follow the appearance", () => {
    expect(lightBlock).toMatch(/:root \{ color-scheme:light dark;/);
  });
  test("increased contrast is also defined for dark mode", () => {
    expect(tokens).toMatch(/prefers-contrast:more\) and \(prefers-color-scheme:dark\)\{ :root\{--border:#[0-9a-f]{6};--muted:#[0-9a-f]{6}\} \}/);
    const dark = tokens.match(/prefers-color-scheme:dark\)\{ :root\{--border:#[0-9a-f]{6};--muted:(#[0-9a-f]{6})/)![1];
    expect(ratio(rgb(dark), rgb(token("surface", "dark")))).toBeGreaterThanOrEqual(7);
  });
});

describe.each(themes)("controls and state marks (%s)", (theme) => {
  const t = (name: string) => rgb(token(name, theme));
  const surface = t("surface");
  test("a form field's border is at least 3:1 against the page and the field", () => {
    expect(ratio(t("control-border"), surface)).toBeGreaterThanOrEqual(3);
    expect(ratio(t("control-border"), t("field"))).toBeGreaterThanOrEqual(3);
    expect(tokens).toMatch(/border:1px solid var\(--control-border\)/);
  });
  test.each([
    ["the dashed outline of an app-only plan (control-border)", "control-border"],
    ["the now line and marker", "now"],
    ["the ready edge (accent)", "accent"],
    ["the plan-started edge (blue)", "blue"],
    ["the recording dot", "rec"],
    ["the remote lane of the capture meter", "meter-remote"],
  ])("%s is at least 3:1 on the surface", (_name, name) => {
    expect(ratio(t(name), surface)).toBeGreaterThanOrEqual(3);
  });
  test("the focus ring is at least 3:1 on the surface, the shell and a settings card", () => {
    expect(tokens).toMatch(/:focus-visible[^{]*\{\s*outline:2px solid var\(--focus-ring\)/);
    for (const background of ["surface", "shell", "panel-soft", "surface-raised"]) expect(ratio(t("focus-ring"), t(background)), background).toBeGreaterThanOrEqual(3);
  });
  test("a disabled button is an explicit grey state, not a faded enabled one", () => {
    const rule = (selector: string) => tokens.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()|]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    const base = rule("button:disabled");
    expect(base).not.toMatch(/opacity/);
    expect(base).toMatch(/color:var\(--disabled-text\)/);
    expect(base).toMatch(/cursor:not-allowed/);
    // A disabled primary must not stay green: the fill is a different, grey colour from the enabled accent.
    expect(t("disabled-primary-fill")).not.toEqual(t("accent"));
    expect(ratio(t("disabled-primary-fill"), surface)).toBeLessThan(2);
    expect(tokens).toMatch(/button\.primary:disabled[^{]*\{[^}]*--disabled-primary-fill/);
    // A disabled link button or tab must also turn grey.
    expect(tokens).toMatch(/\.link-button,[^{]*\):disabled \{ color:var\(--disabled-text\)/);
    // Only the always-on-dark widget keeps the faded look, because its text is white.
    expect(tokens).toMatch(/\.widget-panel button:disabled \{ opacity:\.48;/);
  });
  test("the disabled fill is distinguishable from the enabled button", () => {
    expect(ratio(t("disabled-fill"), surface)).toBeGreaterThan(1.05);
    expect(ratio(t("disabled-text"), t("ink"))).toBeGreaterThan(1.5);
  });
  test.each(["dot-active", "dot-unavailable", "dot-paused", "dot-starting", "dot-idle"])("status dot %s is at least 3:1 on the surface", (dot) => {
    expect(ratio(t(dot), surface)).toBeGreaterThanOrEqual(3);
  });
});

// The live widget floats over whatever is on screen. Its glass is --widget-glass; the worst case for white text is a
// white window behind it, so that is what is checked, along with black, a mid grey and a bright green. The widget's
// tokens are the same in both appearances.
describe("the always-visible live widget over any background", () => {
  const widget = css("widget.css");
  const rgba = (name: string) => {
    const m = tokens.match(new RegExp(`--${name}:rgba\\((\\d+),(\\d+),(\\d+),([\\d.]+)\\)`));
    if (!m) throw new Error("missing token --" + name);
    return { colour: [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb, alpha: Number(m[4]) };
  };
  const glass = rgba("widget-glass");
  const backgrounds: [string, Rgb][] = [["white", [255, 255, 255]], ["mid grey", [128, 128, 128]], ["black", [0, 0, 0]], ["bright green", [60, 180, 100]]];
  const ink = rgb(token("widget-ink"));
  test("the panel uses the widget tokens", () => {
    expect(widget).toMatch(/\.widget-panel \{[^}]*color:var\(--widget-ink\);background:var\(--widget-glass\)/);
    expect(darkBlock).not.toMatch(/--widget-/);
  });
  test.each(backgrounds)("white text is at least 4.5:1 over %s", (_name, behind) => {
    expect(ratio(ink, over(glass.colour, glass.alpha, behind))).toBeGreaterThanOrEqual(4.5);
  });
  test.each(backgrounds)("the warning text on its tinted strip is at least 4.5:1 over %s", (_name, behind) => {
    const strip = rgba("widget-warning-strip");
    const base = over(strip.colour, strip.alpha, over(glass.colour, glass.alpha, behind));
    expect(widget).toMatch(/\.widget-warning \{[^}]*background:var\(--widget-warning-strip\)[^}]*color:var\(--widget-warning-text\)/);
    expect(ratio(rgb(token("widget-warning-text")), base)).toBeGreaterThanOrEqual(4.5);
  });
  test.each(backgrounds)("status dots and the pinned mark are at least 3:1 over %s", (_name, behind) => {
    const base = over(glass.colour, glass.alpha, behind);
    for (const name of ["widget-pin", "widget-dot-active", "widget-dot-unavailable", "widget-dot-paused"])
      expect(ratio(rgb(token(name)), base), name).toBeGreaterThanOrEqual(3);
  });
  test("an opaque panel is used when transparency or contrast is reduced", () => {
    expect(widget).toMatch(/prefers-reduced-transparency:reduce\),\(prefers-contrast:more\)\{ \.widget-panel\{background:var\(--widget-opaque\)/);
    expect(ratio(ink, rgb(token("widget-opaque")))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("motion", () => {
  test("reduced motion switches off animation, transitions and smooth scrolling for the whole product UI", () => {
    expect(tokens).toMatch(/prefers-reduced-motion:reduce\)\{ \*,\*::before,\*::after\{animation:none!important;transition:none!important;scroll-behavior:auto!important\}/);
  });
});
