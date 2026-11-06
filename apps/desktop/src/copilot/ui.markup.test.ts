import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Toast } from "./ui";

test("the toast has no live role of its own: its words are spoken once, through the Announcer", () => {
  const html = renderToStaticMarkup(createElement(Toast, { notice: { id: 1, text: "Meeting synthesis saved." } }));
  expect(html).toContain('class="toast"');
  expect(html).not.toMatch(/role="(status|alert)"|aria-live/);
});
