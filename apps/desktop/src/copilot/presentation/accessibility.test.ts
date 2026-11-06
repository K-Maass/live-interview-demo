import { describe, expect, test } from "vitest";
import { calendarDayLabel, calendarEventLabel, calendarOverflowLabel, cardActionLabel, pageTitle, screenKey, weekRangeLabel } from "./accessibility";

describe("page titles and screen identity", () => {
  test("each screen has its own title", () => {
    expect(pageTitle({ kind: "meetings", view: "calendar" })).toBe("Meetings · Live Interview");
    expect(pageTitle({ kind: "knowledge" })).toBe("Knowledge · Live Interview");
    expect(pageTitle({ kind: "settings", section: "speech" })).toBe("Settings, Local speech · Live Interview");
    expect(pageTitle({ kind: "meeting", id: "x", preparationOpen: false, artifact: "overview" }, "Customer discovery")).toBe("Customer discovery · Live Interview");
    expect(pageTitle({ kind: "meeting", id: "x", preparationOpen: false, artifact: "overview" }, "  ")).toBe("Meeting · Live Interview");
  });
  test("switching a view, tab or settings section is not a new screen, so focus stays put", () => {
    expect(screenKey({ kind: "meetings", view: "calendar" })).toBe(screenKey({ kind: "meetings", view: "past" }));
    expect(screenKey({ kind: "settings", section: "speech" })).toBe(screenKey({ kind: "settings", section: "sharing" }));
    expect(screenKey({ kind: "meeting", id: "a", preparationOpen: false, artifact: "overview" })).toBe(screenKey({ kind: "meeting", id: "a", preparationOpen: false, artifact: "notes" }));
    // Plan and Brief are tabs of one meeting screen, and a pending auto-start is not a new screen either.
    expect(screenKey({ kind: "meeting", id: "a", preparationOpen: false, artifact: "overview", autoStart: true })).toBe(screenKey({ kind: "meeting", id: "a", preparationOpen: false, artifact: "overview" }));
    expect(screenKey({ kind: "meeting", id: "a", preparationOpen: false, artifact: "overview" })).toBe(screenKey({ kind: "meeting", id: "a", preparationOpen: true, artifact: "overview" }));
  });
  test("a meeting that stops and becomes its saved record keeps its id but is a new screen", () => {
    const a = { kind: "meeting", id: "a", preparationOpen: false, artifact: "overview" } as const;
    expect(screenKey(a, true)).not.toBe(screenKey(a, false));
  });
  test("opening another meeting is a new screen", () => {
    const a = { kind: "meeting", id: "a", preparationOpen: false, artifact: "overview" } as const;
    expect(screenKey(a)).not.toBe(screenKey({ ...a, id: "b" }));
    expect(screenKey(a)).not.toBe(screenKey({ kind: "knowledge" }));
  });
});

describe("calendar labels", () => {
  const start = new Date(2026, 9, 14, 14, 0).getTime();
  const end = new Date(2026, 9, 14, 15, 0).getTime();
  test("an event button names the day, not just the time", () => {
    const event = { title: "Customer discovery", startMs: start, endMs: end };
    const label = calendarEventLabel(event);
    expect(label).toMatch(/Wednesday/);
    expect(label).toMatch(/14/);
    // The button shows "<start> – <end>" then the title (week view) or "<start> · <title>" (month view); the name begins with those words.
    const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(label.startsWith(`${clock(start)} – ${clock(end)} Customer discovery`)).toBe(true);
    expect(calendarEventLabel(event, "start").startsWith(`${clock(start)} · Customer discovery`)).toBe(true);
  });
  test("a day says how many meetings it has and when the calendar is not loaded", () => {
    const day = new Date(2026, 9, 14);
    expect(calendarDayLabel(day, { loaded: true, meetings: 1 })).toMatch(/, 1 meeting$/);
    expect(calendarDayLabel(day, { loaded: true, meetings: 3 })).toMatch(/, 3 meetings$/);
    expect(calendarDayLabel(day, { loaded: false, meetings: 0 })).toMatch(/0 meetings, calendar not loaded for this date$/);
  });
  test("extras are read after the visible text and the day", () => {
    const event = { title: "Customer discovery", startMs: start, endMs: end };
    const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const label = calendarEventLabel(event, "range", { readiness: "Brief ready", recurring: true, people: ["Alex Morgan", "Sam Lee", "Jo Park"] });
    expect(label.startsWith(`${clock(start)} – ${clock(end)} Customer discovery`)).toBe(true);
    expect(label).toMatch(/, Wednesday.*, Brief ready, repeats, with Alex Morgan and 2 others$/);
    expect(calendarEventLabel(event, "start", { people: ["Alex Morgan"] })).toMatch(/, with Alex Morgan$/);
    expect(calendarEventLabel(event, "start", { people: ["Alex Morgan", "Sam Lee"] })).toMatch(/, with Alex Morgan and Sam Lee$/);
    // Absent or empty extras change nothing.
    expect(calendarEventLabel(event, "range", { people: [], recurring: false })).toBe(calendarEventLabel(event));
  });
  test("an all-day label starts with the title and says it is all day", () => {
    const event = { title: "Conference", startMs: new Date(2026, 9, 14).getTime(), endMs: new Date(2026, 9, 16).getTime() };
    expect(calendarEventLabel(event, "title", { allDay: true })).toMatch(/^Conference, .*Wednesday.*, all day$/);
    const spanning = calendarEventLabel(event, "title", { allDay: { startDay: "2026-10-14", endDay: "2026-10-16" }, readiness: "No brief" });
    expect(spanning).toMatch(/^Conference, .*, all day, until .*Thursday.*15.*, No brief$/);
    expect(calendarEventLabel(event, "title", { allDay: { startDay: "2026-10-14", endDay: "2026-10-15" } })).not.toMatch(/until/);
  });
  test("the overflow item names how many, when and which day", () => {
    const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const label = calendarOverflowLabel({ count: 3, startMs: new Date(2026, 9, 13, 11, 0).getTime(), endMs: new Date(2026, 9, 13, 12, 30).getTime() }, new Date(2026, 9, 13));
    expect(label.startsWith(`3 more meetings, ${clock(new Date(2026, 9, 13, 11, 0).getTime())} to ${clock(new Date(2026, 9, 13, 12, 30).getTime())}, `)).toBe(true);
    expect(label).toMatch(/Tuesday.*13/);
    expect(calendarOverflowLabel({ count: 1, startMs: 0, endMs: 1 }, new Date(2026, 9, 13))).toMatch(/^1 more meeting,/);
  });
  test("coverage is spoken, so shading is never the only signal", () => {
    const day = new Date(2026, 9, 14);
    expect(calendarDayLabel(day, { coverage: "loaded", meetings: 2 })).toMatch(/2 meetings$/);
    expect(calendarDayLabel(day, { coverage: "missing", meetings: 0 })).toMatch(/0 meetings, calendar not loaded for this date$/);
    expect(calendarDayLabel(day, { coverage: "partial", meetings: 1 })).toMatch(/1 meeting, calendar partly loaded$/);
    expect(calendarDayLabel(day, { coverage: "loading", meetings: 0 })).toMatch(/0 meetings, loading$/);
    expect(calendarDayLabel(day, { loaded: false, meetings: 0 })).toBe(calendarDayLabel(day, { coverage: "missing", meetings: 0 }));
    expect(calendarDayLabel(day, { loaded: true, meetings: 0 })).toBe(calendarDayLabel(day, { coverage: "loaded", meetings: 0 }));
  });
  test("the period label is a readable range, not 'October 12, 2026 - 18'", () => {
    const label = weekRangeLabel(new Date(2026, 9, 12), new Date(2026, 9, 18));
    expect(label).toMatch(/^.*12.*2026 to .*18.*2026$/);
    expect(label).not.toMatch(/ – /);
    expect(weekRangeLabel(new Date(2026, 9, 26), new Date(2026, 10, 1))).toMatch(/^.*October.* to .*November.*$/);
  });
});

describe("card action labels", () => {
  test("repeated buttons say which suggestion they act on and still start with the visible word", () => {
    expect(cardActionLabel("pin", "Clarify approval")).toBe("Pin suggestion: Clarify approval");
    expect(cardActionLabel("dismiss", "Clarify approval")).toBe("Dismiss suggestion: Clarify approval");
    expect(cardActionLabel("why", "Clarify approval").startsWith("Why")).toBe(true);
  });
});
