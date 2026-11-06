import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { LiveViewState } from "@live-interview/core";
import { LivePanel } from "../../src/copilot/LivePanel";

const panel = (view: LiveViewState) =>
  renderToStaticMarkup(
    createElement(LivePanel, {
      view,
      onRequest: () => {},
      onPin: () => {},
      onDismiss: () => {},
      onExpand: () => {},
      onCovered: () => {},
      assistancePaused: false,
      onTogglePause: () => {},
      profile: "interview",
      shortcuts: {
        digDeeper: "",
        respond: "",
        contribute: "",
        checkConversation: "",
        checkObjectives: "",
      },
    }),
  );

test("a draft is shown as unchecked text with no pin, dismiss or evidence actions", () => {
  const html = panel({
    cards: [],
    savedPins: [],
    queued: 0,
    draft: { intent: "respond", text: "Who signs off on the launch?" },
  });
  expect(html).toContain("Draft · still being checked");
  expect(html).toContain("Who signs off on the launch?");
  expect(html).not.toContain("Listening for a useful opportunity");
  expect(html).not.toContain("Pin suggestion");
  expect(html).not.toContain("Dismiss guidance");
  expect(html).not.toContain("Why / evidence");
});

test("without a draft the panel keeps its usual empty state", () => {
  const html = panel({ cards: [], savedPins: [], queued: 0 });
  expect(html).not.toContain("Draft");
  expect(html).toContain("Listening for a useful opportunity");
});
