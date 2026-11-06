import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { GuidanceCard, LiveViewState } from "@live-interview/core";
import { defaultShortcuts } from "../lib/copilot/shortcuts";
import { LivePanel, shortcutText } from "./LivePanel";

// Static markup (no DOM environment in this package): checks the names and states a screen reader is given.
const card = (id: string, extra: Partial<GuidanceCard> = {}) =>
  ({ id, headline: "Clarify approval " + id, say: "Who decides?", why: "Because.", intent: "digDeeper", pinned: false, stale: false, evidence: [], uncertain: false, createdAtMs: 0, basis: { snapshot: { createdAtMs: 0, context: { sources: [], conversation: [] } }, transcriptDeltas: [], invalidatedSourceIds: [], observationSequence: 0, stateRevision: 0, profileId: "workClient", profileRevision: 0 }, ...extra }) as unknown as GuidanceCard;
const render = (view: LiveViewState) =>
  renderToStaticMarkup(createElement(LivePanel, { view, onRequest() {}, onPin() {}, onDismiss() {}, onExpand() {}, onCovered() {}, shortcuts: defaultShortcuts, assistancePaused: false, onTogglePause() {}, profile: "workClient" }));

describe("live guidance markup", () => {
  test("every card button names its card, and the pin button reports its state", () => {
    const html = render({ cards: [card("a", { pinned: true }), card("b")], savedPins: [], queued: 0 });
    expect(html).toContain('aria-label="Pin suggestion: Clarify approval a"');
    expect(html).toContain('aria-label="Pin suggestion: Clarify approval b"');
    expect(html).toContain('aria-label="Dismiss suggestion: Clarify approval a"');
    expect(html).toMatch(/aria-label="Pin suggestion: Clarify approval a"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Pin suggestion: Clarify approval b"[^>]*aria-pressed="false"/);
  });
  test("the evidence button says whether the details are open, and keeps its visible words in its name", () => {
    const closed = render({ cards: [card("a")], savedPins: [], queued: 0 });
    expect(closed).toContain('aria-expanded="false" aria-label="Why / evidence: Clarify approval a"');
    const open = render({ cards: [card("a")], savedPins: [], queued: 0, detailCardId: "a" });
    expect(open).toContain('aria-expanded="true" aria-label="Hide details: Clarify approval a"');
    expect(open).toContain('role="dialog" aria-label="Why this suggestion"');
  });
  test("a pinned mark is an image with a name, not an unlabelled icon", () => {
    expect(render({ cards: [card("a", { pinned: true })], savedPins: [], queued: 0 })).toMatch(/role="img" aria-label="Pinned"/);
  });
  // At 620-920 px the rail becomes a two-column grid. With the headings, text and lists as direct grid items they
  // interleaved row by row ("Meeting focus" beside "Discovery", bullets under one, "Saved topics" under the other).
  test("the side rail holds its two groups as the only grid items, so a narrow window keeps them in separate columns", () => {
    const html = render({ cards: [], savedPins: [card("a")], queued: 0 });
    expect(html).toMatch(/<aside class="live-rail"><div><h3>Meeting focus<\/h3>.*<\/div><div><h3>Saved topics \(1\)<\/h3>.*<\/div><\/aside>/);
    const css = readFileSync(new URL("./styles/live.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.live-rail\s*>\s*h3/);
    expect(css).toMatch(/\.live-rail >div \+ div\{margin:0;padding:0;border:0\}/);
  });
  test("the panel is a named region and the draft is a named busy article", () => {
    const html = render({ cards: [], savedPins: [], queued: 0, draft: { intent: "digDeeper", text: "Could you" } });
    expect(html).toContain('<section aria-label="Live assistance"');
    expect(html).toContain('aria-busy="true" aria-label="Draft guidance"');
  });
  test("help requests are visible buttons in a named group, each showing its shortcut", () => {
    const html = render({ cards: [], savedPins: [], queued: 0 });
    expect(html).toContain('role="group" aria-label="Request help"');
    for (const label of ["Dig deeper", "Help me respond", "Help me contribute", "Check conversation", "Check objectives"]) expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain("<kbd>⌘⌥1</kbd>");
    expect(html).not.toContain("<details");
  });
  test("the conversation feed, when given, is the first rail group", () => {
    const html = renderToStaticMarkup(createElement(LivePanel, { view: { cards: [], savedPins: [], queued: 0 }, onRequest() {}, onPin() {}, onDismiss() {}, onExpand() {}, onCovered() {}, shortcuts: defaultShortcuts, assistancePaused: false, onTogglePause() {}, profile: "workClient", conversation: createElement("h3", null, "Conversation") }));
    expect(html).toMatch(/<aside class="live-rail"><div class="rail-conversation"><h3>Conversation<\/h3><\/div><div><h3>Meeting focus<\/h3>/);
  });
  test("a pinned card offers Answered and Outdated as named buttons; an unpinned card does not", () => {
    const html = render({ cards: [card("a", { pinned: true }), card("b")], savedPins: [card("a", { pinned: true })], queued: 0 });
    const active = html.slice(0, html.indexOf('class="live-rail"'));
    expect(active).toContain('aria-label="Mark answered: Clarify approval a">Answered</button>');
    expect(active).toContain('aria-label="Mark outdated: Clarify approval a">Outdated</button>');
    expect(active).not.toContain("Mark answered: Clarify approval b");
  });
  test("the app's outdated suggestion reads as a suggestion, not a decision, and the pin stays open", () => {
    const pin = card("a", { pinned: true, outdatedSuggested: true });
    const html = render({ cards: [pin], savedPins: [pin], queued: 0 });
    expect(html).toContain("may be outdated: a cited source changed");
    expect(html).toContain("Saved topics (1)");
    expect(html).not.toContain("Done (");
  });
  test("answered and outdated pins leave Saved topics for a collapsed Done list, quietly", () => {
    const html = render({ cards: [card("c")], savedPins: [card("a", { pinned: true, pinOutcome: "answered" }), card("b", { pinned: true, pinOutcome: "outdated" }), card("c", { pinned: true })], queued: 0 });
    expect(html).toContain("Saved topics (1)");
    expect(html).toMatch(/<details class="pins-done"><summary>Done \(2\)<\/summary>/);
    expect(html).not.toMatch(/<details class="pins-done" open/);
    expect(html).toContain('aria-label="Reopen: Clarify approval a">Reopen</button>');
    expect(html).toMatch(/Clarify approval b<\/span><small class="muted"> · Outdated<\/small>/);
    expect(html).not.toMatch(/aria-live|role="status"|amber|pending|pill|badge/);
  });
  test("pinning keeps a card where it is, with its pin mark in place", () => {
    const html = render({ cards: [card("a"), card("b", { pinned: true }), card("c")], savedPins: [card("b", { pinned: true })], queued: 0 });
    const order = [...html.matchAll(/data-card-id="(\w)"/g)].map((m) => m[1]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(html).toMatch(/data-card-id="b" data-pinned="true"[\s\S]*role="img" aria-label="Pinned"[\s\S]*data-card-id="c"/);
  });
  test("card actions stay visible at low emphasis, not hover-only", () => {
    const css = readFileSync(new URL("./styles/live.css", import.meta.url), "utf8");
    const rule = css.match(/\.guidance-actions \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toMatch(/opacity:0[;\s]|pointer-events:none/);
    expect(rule).toMatch(/color:var\(--muted\)/);
  });
  test("shortcuts read as Mac keys", () => {
    expect(shortcutText("CommandOrControl+Alt+Backspace")).toBe("⌘⌥⌫");
    expect(shortcutText("CommandOrControl+Alt+Escape")).toBe("⌘⌥⎋");
    expect(shortcutText("CommandOrControl+Alt+Enter")).toBe("⌘⌥↩");
    expect(shortcutText("CommandOrControl+Alt+Space")).toBe("⌘⌥Space");
    expect(shortcutText("Control+Shift+P")).toBe("⌃⇧P");
    expect(shortcutText("CommandOrControl+Shift+Alt+1")).toBe("⌘⇧⌥1");
  });
  test("an inferred card says so on its face in plain text; a grounded card does not", () => {
    const inferred = render({ cards: [card("a", { uncertain: true, origin: "model" })], savedPins: [], queued: 0 });
    expect(inferred).toContain('<small class="guidance-condition">Inferred</small>');
    expect(inferred).not.toMatch(/pill|badge|amber/i);
    const grounded = render({ cards: [card("a", { uncertain: false, origin: "model" })], savedPins: [], queued: 0 });
    expect(grounded).not.toContain("Inferred");
    // A clarification already says what it is.
    const clarification = render({ cards: [card("a", { uncertain: true, origin: "clarification" })], savedPins: [], queued: 0 });
    expect(clarification).toContain('<small class="guidance-condition">Clarification</small>');
    expect(clarification).not.toContain("Inferred");
    const pending = render({ cards: [card("a", { uncertain: true, origin: "model", stale: true })], savedPins: [], queued: 0 });
    expect(pending).toContain('<small class="guidance-condition">Inferred · earlier context</small>');
  });
});
