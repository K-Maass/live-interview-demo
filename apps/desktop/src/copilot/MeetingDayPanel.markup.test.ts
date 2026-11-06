import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MeetingDayPanel, type MeetingDayPanelProps } from "./MeetingDayPanel";
import { movability, type DayPanelMeeting } from "../lib/public/dayEdit";

// Static markup (no DOM environment in this package): what the panel shows for a given set of props.
const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
const work = { appOnly: false, provider: "apple" as const, calendarName: "Work" };
const meetings: DayPanelMeeting[] = [
  { id: "this", title: "Design review", startMs: at(14, 30), endMs: at(15, 30), isThis: true, movability: movability({ ...work, appCreated: true }) },
  { id: "team", title: "Team review", startMs: at(14), endMs: at(15), isThis: false, movability: movability(work) },
  { id: "standup", title: "Team standup", startMs: at(9), endMs: at(9, 15), isThis: false, movability: movability({ ...work, recurring: true }) },
  { id: "riley", title: "1:1 with Riley", startMs: at(10), endMs: at(10, 30), isThis: false, movability: movability({ ...work, invitation: true }) },
  { id: "focus", title: "Focus", startMs: at(11), endMs: at(12), isThis: false, movability: movability({ appOnly: true }) },
  { id: "offsite", title: "Company offsite", startMs: at(0), endMs: at(0, 0, 22), allDay: true, isThis: false, movability: movability({ ...work, allDay: true }) },
];
const noop = () => {};
const render = (props: Partial<MeetingDayPanelProps> = {}) => renderToStaticMarkup(createElement(MeetingDayPanel, {
  day: at(0), meetings, coverage: "loaded", onDayChange: noop, onPropose: noop, onConfirm: noop, onCancel: noop, onOpen: noop, ...props,
}));
const block = (html: string, title: string) => html.match(new RegExp(`<div class="dp-meeting[^"]*"[^>]*aria-label="${title}[^"]*"[^>]*>.*?</div>`))?.[0] ?? "";

describe("Meeting day panel", () => {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(at(8, 10, 20)); }); // the day before, so nothing shown is past
  afterAll(() => vi.useRealTimers());

  test("the header steps through days and the date opens the month picker", () => {
    const html = render();
    expect(html).toContain('aria-label="Previous day"');
    expect(html).toContain('aria-label="Next day"');
    expect(html).toMatch(/<button type="button" id="[^"]+-day" class="dp-date" aria-haspopup="dialog" aria-expanded="false" aria-label="Wednesday, October 21\. Choose another day">Wed, Oct 21<\/button>/);
    expect(html).toMatch(/<button type="button" class="dp-today">Today<\/button>/);
    expect(render({ day: at(0, 0, 20) })).toMatch(/class="dp-today" disabled="">Today/);
  });
  test("every meeting is drawn; movable ones have both grips, read-only ones a lock and the reason", () => {
    const html = render();
    const own = block(html, "Design review");
    expect(own).toMatch(/class="dp-meeting is-this is-movable"/);
    expect(own).toContain("this meeting.");
    expect(own).toContain('class="dp-grip dp-grip-start"');
    expect(own).toContain('class="dp-grip dp-grip-end"');
    expect(own).not.toContain("Enter opens its plan");
    for (const title of ["Team review", "1:1 with Riley", "Focus"]) {
      const b = block(html, title);
      expect(b).toMatch(/class="dp-meeting is-movable( is-short)?"/);
      expect(b).toContain("Up and down arrows move it; with Shift they change the end, with Option the start. Enter opens its plan.");
      expect(b).toContain("dp-grip-start");
    }
    const locked = block(html, "Team standup");
    expect(locked).toMatch(/class="dp-meeting is-locked is-short"/);
    expect(locked).toContain('title="Repeating meeting. Change it in Calendar."');
    expect(locked).toMatch(/aria-describedby="[^"]+"/);
    expect(locked).toContain('class="lucide lucide-lock');
    expect(locked).not.toContain("dp-grip");
    expect(html).toMatch(/<span id="[^"]+standup" hidden="">Repeating meeting\. Change it in Calendar\.<\/span>/);
  });
  test("overlapping meetings sit side by side and the overlap is said in plain text", () => {
    const html = render();
    expect(block(html, "Design review")).toMatch(/left:calc\(50% \+ 2px\);width:calc\(50% - 2px\)/);
    expect(block(html, "Team review")).toMatch(/left:calc\(0% \+ 0px\);width:calc\(50% - 0px\)/);
    expect(html).toContain('<p class="dp-overlap">Overlaps “Team review”</p>');
  });
  test("all-day events sit in a strip above the hours", () => {
    expect(render()).toMatch(/class="dp-allday" role="group" aria-label="All day">.*class="dp-allday-item" tabindex="0" role="button" title="All-day event\. Change it in Calendar\."[^>]*>.*Company offsite/);
  });
  test("a pending calendar change shows the review card and the old place dashed", () => {
    const html = render({ pending: { meetingId: "team", startMs: at(16), endMs: at(17) } });
    expect(html).toMatch(/class="dp-review" role="group" aria-labelledby="[^"]+"><h3 id="[^"]+">Move in Work calendar\?<\/h3>/);
    expect(html).toMatch(/<span>Wed, Oct 21<\/span> <span class="dp-review-from">2:00\s*–\s*3:00\sPM<\/span> <span aria-hidden="true">→<\/span><span class="visually-hidden">to<\/span> <strong>4:00\s*–\s*5:00\sPM<\/strong>/);
    expect(html).toContain('<p class="dp-review-note">People invited may get an update from your calendar.</p>');
    expect(html).toMatch(/<button type="button">Cancel<\/button><button type="button" class="primary">Move event<\/button>/);
    expect(html).toContain('class="dp-ghost"');
    expect(block(html, "Team review")).toContain("is-pending");
    // The overlap note follows the meeting being changed: at 4 PM it no longer overlaps anything.
    expect(html).not.toContain("dp-overlap");
  });
  test("an invitation's review card carries the warning, which the page can word", () => {
    const pending = { meetingId: "riley", startMs: at(10, 30), endMs: at(11) };
    expect(render({ pending })).toContain(`<p class="dp-review-note is-warn">You&#x27;re not the organiser. This moves it in your calendar only; the organiser and other guests keep their time.</p>`);
    expect(render({ pending, invitationWarning: "Only your copy moves." })).toContain('<p class="dp-review-note is-warn">Only your copy moves.</p>');
    expect(render({ pending, confirming: true })).toContain('class="primary" disabled="">Moving…</button>');
  });
  test("nothing pending, no review card; a page notice is plain text", () => {
    const html = render({ notice: "The event changed in your calendar. Nothing was changed." });
    expect(html).not.toContain("dp-review");
    expect(html).toContain('<p class="dp-notice">The event changed in your calendar. Nothing was changed.</p>');
  });
  test("unloaded, partly loaded and unconnected calendars say so", () => {
    expect(render({ coverage: "missing", onRetry: noop })).toMatch(/<p class="dp-note is-warn">Calendar not loaded for this day\. Other meetings may be missing\. <button type="button" class="link-button">Retry<\/button><\/p>/);
    expect(render({ coverage: "loading", onRetry: noop })).toMatch(/<p class="dp-note is-warn">Calendar not loaded for this day\. Other meetings may be missing\.<\/p>/);
    expect(render({ coverage: "partial", partialAccounts: ["Work · Exchange"] })).toContain("This date is only partly loaded (Work · Exchange), so some meetings may be missing.");
    expect(render({ coverage: "none", onConnectCalendar: noop })).toContain('<button type="button" class="link-button">Connect a calendar to see the rest of your day →</button>');
  });
  test("a meeting without a time asks to draw one on a timeline that allows it", () => {
    const html = render({ meetings: meetings.filter((m) => !m.isThis), untimedMeetingId: "this" });
    expect(html).toContain('<p class="dp-note is-hint">Drag on the timeline to give this meeting a time.</p>');
    expect(html).toContain('class="day-timeline-track dp-track can-draw"');
    expect(render()).not.toContain("can-draw");
  });
  test("the footer slot holds the page's time summary and calendar row", () => {
    expect(renderToStaticMarkup(createElement(MeetingDayPanel, { day: at(0), meetings, coverage: "loaded", onDayChange: noop, onPropose: noop, onConfirm: noop, onCancel: noop, onOpen: noop }, createElement("span", null, "2:30–3:30 PM · 1 h"))))
      .toContain('<footer class="dp-footer"><span>2:30–3:30 PM · 1 h</span></footer>');
  });
});

describe("Meeting day panel on today and past days", () => {
  afterAll(() => vi.useRealTimers());
  test("today shades the past and shows the now line", () => {
    vi.useFakeTimers(); vi.setSystemTime(at(12, 0));
    const html = render();
    expect(html).toMatch(/class="dp-past" style="height:576px"/);
    expect(html).toMatch(/class="spine-now" role="separator"/);
    // Past meetings are drawn as past but can still be moved later today.
    expect(block(html, "Team standup")).toContain("is-past");
    expect(block(html, "Focus")).toContain("dp-grip");
  });
  test("an earlier day is all past: nothing can be dragged there", () => {
    vi.useFakeTimers(); vi.setSystemTime(at(9, 0, 23));
    const html = render();
    expect(html).toMatch(/class="dp-past" style="height:1152px"/);
    expect(html).not.toContain("dp-grip");
    expect(block(html, "Focus")).toContain('title="This day has passed."');
  });
});
