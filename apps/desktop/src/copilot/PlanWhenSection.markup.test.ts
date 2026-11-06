import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PublicMeetingPlan } from "@live-interview/core";
import { PlanWhenSection } from "./PlanWhenSection";
import type { PendingCalendarChange } from "../lib/public/usePublicProduct";

// Static markup (no DOM environment in this package): what the When section offers in each calendar state.
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();
const base = { id: "p1", title: "Client sync", startMs: at(14), endMs: at(14, 30), workspaceId: "default", sourceIds: [], sharedLibraryIds: [], profileId: "workClient", attendees: [], objectives: [], publicResearchTopics: [], briefDraft: "", automaticPreparation: false, revision: 1, updatedAtMs: 0, status: "draft" } as unknown as PublicMeetingPlan;
const sync = { nativeEventId: "EK-1", calendarId: "work", calendarName: "Work · iCloud", syncedTitle: "Client sync", syncedStartMs: at(14), syncedEndMs: at(14, 30) };
const mac = [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: [] }];
const writable = [{ id: "work", name: "Work", account: "iCloud" }, { id: "home", name: "Home", account: "iCloud" }];
const render = (plan: PublicMeetingPlan, options: { accounts?: unknown[]; pending?: PendingCalendarChange; error?: string } = {}) => {
  const noop = () => {};
  const controller = {
    publicProduct: { enabled: true, current: plan, plans: [], calendarEvents: [{ id: "busy", title: "Team review", startMs: at(14, 15), endMs: at(15) }], loadRange: async () => {}, accounts: options.accounts ?? mac, calendarSave: { writable, pending: options.pending, busy: false, error: options.error ?? "", refresh: async () => {}, propose: async () => {}, proposeIcs: async () => {}, confirm: async () => {}, cancel: noop } },
    setup: { setSchedule: noop },
  };
  return renderToStaticMarkup(createElement(PlanWhenSection, { controller, navigate: noop } as never));
};

// Every test runs on a fixed clock: the day before the fixture meeting, so its day is selectable and not today.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 9));
});
afterEach(() => { vi.useRealTimers(); });

describe("When section", () => {
  test("the day is picked on a month grid and the time shown on that day's timeline", () => {
    const html = render(base);
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('type="time"');
    expect(html).toContain("October 2026");
    expect(html).toMatch(/class="month-picker-day selected"[^>]*><span class="cal-date-num">21<\/span>/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Wednesday, October 21/);
    expect(html).toContain('class="chosen-block beside"');
    expect(html).toContain("14:00–14:30");
    expect(html).toContain("Team review");
    expect(html).toContain("Overlaps “Team review”");
    expect(html).toContain('aria-pressed="true">30 min');
  });
  test("the picker uses the Calendar's month header, date numbers, hour labels and spine", () => {
    const html = render(base);
    // Month view weekday header (Intl names, Monday first) and date numbers; the chosen day is aria-pressed.
    expect(html.match(/class="cal-month-weekday"/g)).toHaveLength(7);
    expect(html).toMatch(/aria-pressed="true"[^>]*class="month-picker-day selected"/);
    // Month navigation uses the outline icon buttons the Calendar toolbar uses.
    expect(html).toMatch(/class="icon-button "[^>]*aria-label="Previous month"/);
    expect(html).toMatch(/class="icon-button "[^>]*aria-label="Next month"/);
    // Week grid hour labels 01:00 to 23:00 and Today spine segments for the other meeting and the one being drawn.
    expect(html.match(/class="cal-hour-label[^"]*"/g)).toHaveLength(23);
    expect(html).toContain(">01:00</span>");
    expect(html).toContain(">23:00</span>");
    expect(html.match(/class="spine-seg"/g)).toHaveLength(1);
    expect(html).toContain('class="spine-seg is-chosen"');
    expect(html).toMatch(/class="busy-block-title">Team review<\/span><span class="busy-block-time">14:15–15:00/);
    expect(html).not.toContain("slot-line");
    expect(html).not.toContain("round-nav");
  });
  describe("today and the now marker", () => {
    test("on the meeting's day the orange now marker sits on the spine and the nearby hour label hides", () => {
      vi.setSystemTime(new Date(2026, 9, 21, 9, 52));
      const html = render(base);
      expect(html).toMatch(/class="spine-now" role="separator" aria-label="Now, 09:52"/);
      expect(html).toContain('class="spine-now-time">09:52');
      expect(html).toMatch(/class="cal-hour-label is-near-now"[^>]*>10:00/);
      expect(html).toMatch(/aria-current="date"[^>]*aria-label="Wednesday, October 21, today/);
      expect(html).toMatch(/class="month-picker-day is-today selected"/);
    });
    test("on another day there is no now marker, and earlier days cannot be chosen", () => {
      vi.setSystemTime(new Date(2026, 9, 19, 9, 0));
      const html = render(base);
      expect(html).not.toContain("spine-now");
      expect(html).not.toContain("is-near-now");
      expect(html).toMatch(/class="month-picker-day is-today"/);
      expect(html).toMatch(/disabled=""[^>]*aria-label="Sunday, October 18"/);
    });
  });
  test("a dated meeting only in the app offers Add to calendar with a calendar choice", () => {
    const html = render(base);
    expect(html).toContain('class="calendar-status">Only in this app');
    expect(html).toContain("Work · iCloud");
    expect(html).toContain("Add to calendar");
    expect(html).toContain("Clear date");
    expect(html).not.toMatch(/pill|badge/);
  });
  test("once saved it says which calendar, as plain text, and offers no second add", () => {
    const html = render({ ...base, eventId: "apple:1", calendarSync: sync });
    expect(html).toContain('class="calendar-status saved">In Work · iCloud');
    expect(html).not.toContain("Add to calendar");
    expect(html).not.toContain("Update calendar event");
  });
  test("a changed time says the calendar is behind and offers the update", () => {
    const html = render({ ...base, endMs: at(15), eventId: "apple:1", calendarSync: sync });
    expect(html).toContain("Calendar not updated");
    expect(html).toContain("Update calendar event");
  });
  test("without a calendar on this Mac, Add to calendar is still offered", () => {
    const html = render(base, { accounts: [] });
    expect(html).toContain("Add to calendar");
    expect(html).not.toContain("Work · iCloud");
  });
  test("a meeting opened from someone else's calendar shows its time without editing it", () => {
    const html = render({ ...base, eventId: "google:1" });
    expect(html).toContain("From your calendar");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain("Add to calendar");
  });
  test("an undated draft asks for a day first and offers nothing to add yet", () => {
    const html = render({ ...base, startMs: undefined, endMs: undefined });
    expect(html).toContain("No date yet");
    expect(html).toContain("Choose a day");
    expect(html).not.toContain("Add to calendar");
  });
  test("the confirmation is a dialog in plain words, never raw JSON", () => {
    const pending = { kind: "calendar", planId: "p1", calendar: writable[0], after: { title: "Client sync", startMs: at(14), endMs: at(14, 30) }, proposal: { id: "x", after: '{"calendarId":"work"}', before: '{"newEvent":true}' } } as unknown as PendingCalendarChange;
    const html = render(base, { pending });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Add “Client sync” to Work · iCloud");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("calendarId");
    expect(html).not.toContain("newEvent");
  });
  test("an error says nothing was changed", () => {
    expect(render(base, { error: "The calendar did not accept the change. Nothing was changed." })).toContain('role="alert"');
  });
});
describe("Date & time section heading and title", () => {
  test("the section is called Date & time", () => {
    const html = render({ ...base, title: "Client sync" } as PublicMeetingPlan);
    expect(html).toContain(">Date &amp; time<");
    expect(html).not.toContain(">When<");
  });
  test("an untitled meeting still offers Add to calendar, which asks for a title before anything is prepared", () => {
    const html = render({ ...base, title: "Untitled meeting" } as PublicMeetingPlan);
    expect(html).toContain("Add to calendar");
    expect(html).not.toContain("Give the meeting a title first");
  });
});
