import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { NewMeetingPopover } from "./NewMeetingPopover";
import { ActionToast, timeText } from "../ui";

// Static markup (no DOM environment in this package). The popover renders closed unless `initiallyOpen` is set.
const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
const busy = [{ id: "e1", title: "Team review", startMs: at(9, 45), endMs: at(10, 30) }];
const render = (props: Partial<Parameters<typeof NewMeetingPopover>[0]> = {}) =>
  renderToStaticMarkup(createElement(NewMeetingPopover, { disabled: false, busy, onCreate: async () => true, ...props }));

describe("New meeting popover", () => {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(at(9, 10)); });
  afterAll(() => vi.useRealTimers());
  test("closed, it is the New meeting button that announces a dialog", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>.*New meeting<\/button>/);
    expect(html).not.toContain('role="dialog"');
  });
  test("a meeting too short for two lines shows its title and time on one line", () => {
    const html = render({ initiallyOpen: true, busy: [{ id: "e2", title: "Weekly team sync", startMs: at(11), endMs: at(11, 30) }] });
    expect(html).toMatch(/class="busy-block is-short"[^>]*title="Weekly team sync"><span class="busy-block-title">Weekly team sync<\/span><span class="busy-block-time">/);
    expect(render({ initiallyOpen: true })).not.toContain("is-short");
  });
  test("is disabled during a live meeting like the button was", () => {
    expect(render({ disabled: true })).toMatch(/<button[^>]*class="primary" disabled=""/);
  });
  test("open, it asks for a title, a day on the month grid and a time on the day timeline, with no native date or time input", () => {
    const html = render({ initiallyOpen: true });
    expect(html).toMatch(/role="dialog" aria-labelledby="[^"]+-heading"/);
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toContain(">New meeting</h2>");
    expect(html).toMatch(/Title<input[^>]*required=""[^>]*aria-required="true"/);
    expect(html).not.toMatch(/type="(date|time|datetime-local)"/);
    expect(html).not.toContain("<select");
    // The planning page's month grid, today chosen as the filled day, and a dot on the day with a meeting.
    expect(html).toMatch(/class="month-picker-day is-today selected"[^>]*><span class="cal-date-num">21<\/span><span class="busy-dot"/);
    expect(html.match(/class="cal-month-weekday"/g)).toHaveLength(7);
    // Next half hour, 30 minutes, drawn on the planning page's day timeline with that day's other meeting beside it.
    expect(html).not.toContain('role="spinbutton"');
    expect(html).toContain('class="day-timeline-track"');
    expect(html.match(/class="cal-hour-label[^"]*"/g)).toHaveLength(23);
    // Block times keep each time on one line (no-break spaces) so a narrow block wraps only after the dash.
    const nb = (ms: number) => timeText(ms).replace(/ /g, "\u00a0");
    const slot = `${timeText(at(9, 30))}–${timeText(at(10))}`;
    expect(html).toMatch(new RegExp(`class="chosen-block beside"[^>]*tabindex="0" role="group" aria-label="Meeting ${nb(at(9, 30))} to ${nb(at(10))}\\. Up and down arrows move it; with Shift they change the end\\."`));
    expect(html).toContain(`<span>${nb(at(9, 30))}–${nb(at(10))}</span><span class="resize-handle"`);
    expect(html).toMatch(/class="busy-block beside"[^>]*title="Team review"><span class="busy-block-title">Team review<\/span>/);
    expect(html).toContain('class="spine-seg is-chosen"');
    expect(html).toContain(`role="group" aria-label="Time, ${timeText(at(9, 30))} to ${timeText(at(10))}"`);
    // The now marker is on today's timeline, and keyboard moves are announced through a polite live region.
    expect(html).toMatch(/class="spine-now" role="separator"/);
    expect(html).toContain('<span class="visually-hidden" aria-live="polite"></span>');
    // Grid and timeline sit together so they can go side by side; the summary line stays.
    expect(html).toMatch(/class="new-meeting-when"><div class="new-meeting-field" role="group" aria-label="Date, [^"]+">.*class="month-picker".*class="day-timeline"/);
    expect(html).toContain(`class="new-meeting-summary"><strong>`);
    expect(html).toContain(` · ${slot}</strong>`);
    expect(html).toMatch(/role="group" aria-label="Length">.*aria-pressed="true">30 min/);
    expect(html).toContain("Overlaps “Team review”");
    expect(html).toContain("Only in this app. Add it to a calendar from its plan.");
  });
  test("Create stays in view and is disabled with the reason until there is a title", () => {
    const html = render({ initiallyOpen: true });
    expect(html).toMatch(/class="new-meeting-footer"><span id="[^"]+-reason" class="new-meeting-reason">Add a title to create the meeting.<\/span><button type="button">Cancel<\/button><button type="submit" class="primary" disabled="">Create<\/button>/);
    // The title field points at the reason so a screen reader hears why.
    expect(html).toMatch(/aria-describedby="[^"]+-reason"/);
  });
  test("it does not write to a calendar: no calendar choice, no Add to calendar", () => {
    const html = render({ initiallyOpen: true });
    expect(html).not.toContain("Add to calendar");
    expect(html).not.toContain("Calendar</span>");
  });
});

describe("Meeting created notification", () => {
  const notice = { id: "p1", text: "Meeting created: Client sync", detail: "Wed 21 Oct, 09:30 · Only in this app", actionLabel: "Open plan" };
  test("shows the title, an Open plan action and a close button, and no live role of its own", () => {
    const html = renderToStaticMarkup(createElement(ActionToast, { notice, onAction() {}, onClose() {} }));
    expect(html).toMatch(/class="toast action-toast" role="group" aria-label="Meeting created: Client sync"/);
    expect(html).toContain("<strong>Meeting created: Client sync</strong><small>Wed 21 Oct, 09:30 · Only in this app</small>");
    expect(html).toMatch(/<button type="button" class="link-button action-toast-action">Open plan<\/button>/);
    expect(html).toContain('aria-label="Dismiss notification"');
    expect(html).not.toMatch(/role="(status|alert)"/);
  });
  test("renders nothing without a notice", () => {
    expect(renderToStaticMarkup(createElement(ActionToast, { onAction() {}, onClose() {} }))).toBe("");
  });
});
