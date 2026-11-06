import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MeetingRecord, PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import { MeetingDetails } from "./MeetingDetails";

// Static markup (no DOM environment in this package): the panel shows only what is saved, with plain-text status.
const event = { id: "e1", title: "Customer discovery", startMs: new Date(2026, 9, 17, 14).getTime(), endMs: new Date(2026, 9, 17, 15).getTime() };
const plan = { id: "p1", eventId: "e1", title: "Customer discovery", workspaceId: "w1", sourceIds: [], sharedLibraryIds: [], profileId: "discovery", attendees: [{ id: "a1", name: "Alex Morgan" }], objectives: ["Understand approval handoffs", " "], publicResearchTopics: [], briefDraft: "Ask who signs off.", automaticPreparation: false, revision: 1, updatedAtMs: 0, status: "prepared" } as unknown as PublicMeetingPlan;
const records = [{ attendees: [{ id: "a1", name: "Alex Morgan" }] }, { attendees: [{ id: "a2", name: "Alex Morgan" }] }] as unknown as MeetingRecord[];
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(MeetingDetails, { event, records, onOpen() {}, ...props } as never));

describe("meeting details panel", () => {
  test("reads objectives, people and brief from the saved plan, counting meetings by exact identity", () => {
    const html = render({ plan, workspaceName: "product-research" });
    expect(html).toContain("Understand approval handoffs");
    expect(html).not.toContain("<li> </li>");
    expect(html).toContain("1 meeting<");
    expect(html).toContain("Ask who signs off.");
    expect(html).toContain("product-research");
    expect(html).toContain('class="brief-text ready">Brief ready');
    expect(html).not.toMatch(/pill|badge/);
  });
  test("with a plan, calendar invitees not on the plan are still listed, marked as from the calendar", () => {
    const calendarEvent = { attendees: [{ name: "Alex Morgan" }, { name: "Riley Chen" }, { name: "Sam Okafor" }] } as unknown as PublicCalendarEvent;
    const html = render({ plan, calendarEvent });
    expect(html.match(/Alex Morgan/g)).toHaveLength(1);
    expect(html).toMatch(/Riley Chen<\/span><small>From calendar<\/small>/);
    expect(html).toMatch(/Sam Okafor<\/span><small>From calendar<\/small>/);
  });
  test("falls back to the calendar's attendees and says there is no brief yet", () => {
    const calendarEvent = { attendees: [{ name: "Riley Chen" }] } as unknown as PublicCalendarEvent;
    const html = render({ calendarEvent });
    expect(html).toContain("Riley Chen");
    expect(html).toContain("From calendar");
    expect(html).toContain("No brief yet.");
    expect(html).toContain("Conversation only");
  });
  test("an all-day event reads 'All day' with its days, the last day inclusive; timed events keep their format", () => {
    const at = (d: number, h = 0) => new Date(2026, 9, d, h).getTime();
    const one = render({ event: { id: "h", title: "Holiday", startMs: at(17), endMs: at(18), isAllDay: true, startDay: "2026-10-17", endDay: "2026-10-18" } });
    expect(one).toMatch(/All day · \w+ 17 Oct/);
    expect(one).not.toMatch(/12:00 AM/);
    const span = render({ event: { id: "h", title: "Offsite", startMs: at(16), endMs: at(19), isAllDay: true, startDay: "2026-10-16", endDay: "2026-10-19" } });
    expect(span).toMatch(/All day · \w+ 16 – \w+ 18 Oct/);
    const months = render({ event: { id: "h", title: "Trip", startMs: at(30), endMs: new Date(2026, 10, 3).getTime(), isAllDay: true, startDay: "2026-10-30", endDay: "2026-11-03" } });
    expect(months).toMatch(/All day · \w+ 30 Oct – \w+ 2 Nov/);
    expect(render({})).toMatch(/·\s*02:00 PM – 03:00 PM/);
    expect(render({})).not.toContain("All day");
  });
});
