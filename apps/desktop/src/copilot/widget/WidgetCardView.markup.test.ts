import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { WidgetCardView } from "./WidgetApp";
import type { WidgetCard } from "./bridge";

const card = (extra: Partial<WidgetCard>): WidgetCard => ({ id: "c1", headline: "Ask about Lieferzeiten", say: "Fragen Sie nach den Lieferzeiten.", pinned: false, stale: false, sourceHint: "Conversation", clarification: false, ...extra });
const render = (c: WidgetCard) => renderToStaticMarkup(createElement(WidgetCardView, { card: c, selected: false, onSelect() {}, act() {} }));

test("a pinned widget card offers plain Answered and Outdated buttons with accessible names", () => {
  const html = render(card({ pinned: true, settleable: true, outdatedSuggested: true }));
  expect(html).toContain('<button class="widget-pin-outcome" aria-label="Mark answered: Ask about Lieferzeiten">Answered</button>');
  expect(html).toContain('<button class="widget-pin-outcome" aria-label="Mark outdated: Ask about Lieferzeiten">Outdated</button>');
  expect(html).toContain("May be outdated: a cited source changed");
  expect(html).toContain("Fragen Sie nach den Lieferzeiten.");
  expect(html).not.toMatch(/aria-live|role="status"|Unpin|pill|badge|amber/i);
});

test("an inferred widget card says so in plain text; a grounded one does not", () => {
  expect(render(card({ inferred: true }))).toContain("<small>Inferred</small>");
  expect(render(card({ inferred: true, stale: true }))).toContain("<small>Inferred · Earlier context</small>");
  expect(render(card({ inferred: true }))).not.toMatch(/pill|badge|amber/i);
  expect(render(card({}))).not.toContain("Inferred");
});

test("an unpinned widget card has no outcome buttons", () => {
  const html = render(card({}));
  expect(html).not.toContain("widget-pin-outcome");
  expect(html).not.toContain("Mark answered");
});

test("a pinned card the main workspace cannot settle shows no outcome buttons", () => {
  const html = render(card({ pinned: true, settleable: false }));
  expect(html).toContain('aria-label="Pinned"');
  expect(html).not.toContain("widget-pin-outcome");
});
