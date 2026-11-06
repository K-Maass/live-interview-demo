import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Design rule for the whole product UI (not only the calendar): status is plain text, not pills or badges.
// The calendar's markup tests check rendered views; this checks every class name written in the product's components.
const root = fileURLToPath(new URL(".", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
const pillClasses = (source: string) =>
  [...source.matchAll(/className=("[^"]*"|\{[^}]*\})/g)].flatMap((m) => m[1].match(/[a-z][a-z0-9-]*(?:pill|badge|chip)[a-z0-9-]*/g) ?? []);

// Existing uses awaiting a design decision; none may be added. Remove an entry once that control is restyled.
const KNOWN = new Map([
  ["SetupPill.tsx", ["setup-pill"]],
  ["MeetingSetupPage.tsx", ["type-pills", "type-pill"]],
  ["WelcomeFlow.tsx", ["welcome-badge"]],
]);

test("no product component adds a pill, badge or chip class", () => {
  const found = new Map<string, string[]>();
  for (const path of files(root)) {
    const classes = [...new Set(pillClasses(readFileSync(path, "utf8")))];
    if (classes.length) found.set(path.slice(root.length).split("/").at(-1)!, classes);
  }
  expect(Object.fromEntries(found)).toEqual(Object.fromEntries(KNOWN));
});

// Pill-shaped rounding is for controls only (buttons, the segmented control, switches, the search field and the known
// exceptions above). A container or a label never gets it, so status and people never read as pills or chips.
const stylesheets = [join(root, "copilot.css"), ...readdirSync(join(root, "styles")).filter((n) => n.endsWith(".css")).map((n) => join(root, "styles", n))];
const CONTROL = /button|summary|input|segmented-control|round-icon|evidence-action|cal-date-num|type-pill|setup-pill|:root/;
test("only controls are rounded into a pill", () => {
  const offenders = stylesheets.flatMap((path) => readFileSync(path, "utf8").split("}").flatMap((rule) => {
    const [selector, body = ""] = rule.split("{");
    if (!/border-radius:\s*(var\(--radius-pill\)|999px)/.test(body)) return [];
    return selector.split(",").map((s) => s.trim()).filter((s) => s && !CONTROL.test(s));
  }));
  expect(offenders).toEqual([]);
});

test("length choices use the segmented control", () => {
  for (const name of ["calendar/NewMeetingPopover.tsx", "PlanDayPanel.tsx", "PlanWhenSection.tsx"])
    expect(readFileSync(join(root, name), "utf8")).toContain('className="length-choices segmented-control"');
});
