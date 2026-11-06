import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PinnedTopicsList, parsePinnedTopics } from "./PinnedTopicsReview";

describe("pins note parsing", () => {
  test("each saved pin keeps its source-language text and the person's outcome", () => {
    const note = JSON.stringify([
      { id: "a", say: "Fragen Sie nach den Lieferzeiten.", pinOutcome: "answered", pinned: true },
      { id: "b", say: "Confirm the pilot budget", pinOutcome: "outdated" },
      { id: "c", say: "Ask who signs off", outdatedSuggested: true },
    ]);
    expect(parsePinnedTopics(note)).toEqual([
      { id: "a", text: "Fragen Sie nach den Lieferzeiten.", outcome: "Answered" },
      { id: "b", text: "Confirm the pilot budget", outcome: "Outdated" },
      // The app's "may be outdated" suggestion is never shown as the person's decision.
      { id: "c", text: "Ask who signs off", outcome: "Still open" },
    ]);
  });
  test("a missing or malformed note from an older record yields no topics", () => {
    for (const text of [undefined, null, "", "   ", "{not json", "{\"id\":\"a\"}", "42", "null", "\"pins\""]) expect(parsePinnedTopics(text)).toEqual([]);
  });
  test("damaged entries are skipped and the rest remain", () => {
    const note = JSON.stringify([null, 7, "text", { id: "x" }, { id: "y", say: "  " }, { say: 3 }, { id: "a", say: "Keep me", pinOutcome: "deleted" }, { id: "a", say: "Duplicate" }, { say: "No id" }]);
    expect(parsePinnedTopics(note)).toEqual([
      { id: "a", text: "Keep me", outcome: "Still open" },
      { id: "pin-8", text: "No id", outcome: "Still open" },
    ]);
  });
});

describe("pinned topics section", () => {
  test("lists each topic with its outcome in plain muted text, read-only", () => {
    const html = renderToStaticMarkup(createElement(PinnedTopicsList, { topics: parsePinnedTopics(JSON.stringify([{ id: "a", say: "Fragen Sie nach den Lieferzeiten.", pinOutcome: "answered" }, { id: "b", say: "Ask who signs off" }])) }));
    expect(html).toContain('<h3 id="pinned-topics-heading">Pinned topics</h3>');
    expect(html).toContain('<li><span>Fragen Sie nach den Lieferzeiten.</span><span class="muted"> · Answered</span></li>');
    expect(html).toContain('<span class="muted"> · Still open</span>');
    expect(html).not.toMatch(/<button|<input|aria-live|role="status"|pill|badge|amber|warning/i);
  });
  test("renders nothing without topics", () => {
    expect(renderToStaticMarkup(createElement(PinnedTopicsList, { topics: [] }))).toBe("");
  });
});
