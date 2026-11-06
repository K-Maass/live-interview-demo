import { describe, expect, test } from "vitest";
import { INVITATION_WARNING, IDLE, READ_ONLY_REASONS, movability, nudge, overlapNote, pastFloor, placeRange, rangeText, reduceEdit, reviewHeading, shownRange, type EditState, type Movability } from "./dayEdit";

const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m).getTime();
const range = (s: [number, number?], e: [number, number?]) => ({ startMs: at(s[0], s[1]), endMs: at(e[0], e[1]) });
const mac = { appOnly: false, provider: "apple" as const, calendarName: "Work" };

describe("movability", () => {
  test("a plan only in this app is saved directly", () => {
    expect(movability({ appOnly: true })).toEqual({ kind: "direct" });
  });
  test("an app-created event in a Mac calendar is reviewed, as the organiser", () => {
    expect(movability({ ...mac, appCreated: true })).toEqual({ kind: "review", calendarName: "Work" });
    // The app made it, so it is never treated as someone else's invitation.
    expect(movability({ ...mac, appCreated: true, invitation: true })).toEqual({ kind: "review", calendarName: "Work" });
  });
  test("a macOS event the person organised in a writable calendar is reviewed", () => {
    expect(movability(mac)).toEqual({ kind: "review", calendarName: "Work" });
    expect(movability({ ...mac, invitation: false })).toEqual({ kind: "review", calendarName: "Work" });
  });
  test("an invitation in a writable macOS calendar is reviewed with the invitation flag", () => {
    expect(movability({ ...mac, invitation: true })).toEqual({ kind: "review", calendarName: "Work", invitation: true });
    expect(INVITATION_WARNING).toBe("You're not the organiser. This moves it in your calendar only; the organiser and other guests keep their time.");
  });
  test("a calendar without a name still reads as a sentence", () => {
    expect(movability({ ...mac, calendarName: "  " })).toEqual({ kind: "review", calendarName: "your calendar" });
  });
  test("Google and Microsoft direct connections are read-only, whatever else is true", () => {
    expect(movability({ ...mac, provider: "google" })).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.google });
    expect(movability({ ...mac, provider: "microsoft", recurring: true })).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.microsoft });
    expect(READ_ONLY_REASONS.google).toMatch(/Change it in Google Calendar\.$/);
  });
  test("a calendar that does not allow changes is read-only", () => {
    expect(movability({ ...mac, readOnly: true })).toEqual({ kind: "readOnly", reason: "This calendar doesn't allow changes." });
  });
  test("repeating meetings are read-only", () => {
    expect(movability({ ...mac, recurring: true })).toEqual({ kind: "readOnly", reason: "Repeating meeting. Change it in Calendar." });
    expect(movability({ ...mac, appCreated: true, recurring: true }).kind).toBe("readOnly");
  });
  test("all-day events are read-only", () => {
    expect(movability({ ...mac, allDay: true })).toEqual({ kind: "readOnly", reason: "All-day event. Change it in Calendar." });
  });
  test("the first blocking rule gives the reason: connection, calendar, repeating, all-day", () => {
    expect(movability({ ...mac, readOnly: true, recurring: true, allDay: true })).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.calendar });
    expect(movability({ ...mac, recurring: true, allDay: true })).toEqual({ kind: "readOnly", reason: READ_ONLY_REASONS.recurring });
  });
});

describe("where a drag lands", () => {
  const r = { start: 600, end: 660 }; // 10:00–11:00
  test("moves snap to 15 minutes and keep the length", () => {
    expect(placeRange("move", r, 667, 0)).toEqual({ start: 660, end: 720 });
    expect(placeRange("move", r, 652, 0)).toEqual({ start: 645, end: 705 });
  });
  test("a move never crosses midnight", () => {
    expect(placeRange("move", r, 1430, 0)).toEqual({ start: 1380, end: 1440 });
    expect(placeRange("move", r, -40, 0)).toEqual({ start: 0, end: 60 });
  });
  test("either edge changes the length, keeping at least 15 minutes", () => {
    expect(placeRange("start", r, 540, 0)).toEqual({ start: 540, end: 660 });
    expect(placeRange("start", r, 700, 0)).toEqual({ start: 645, end: 660 });
    expect(placeRange("end", r, 728, 0)).toEqual({ start: 600, end: 735 });
    expect(placeRange("end", r, 560, 0)).toEqual({ start: 600, end: 615 });
    expect(placeRange("end", r, 1500, 0)).toEqual({ start: 600, end: 1440 });
  });
  test("nothing lands in the past: a future meeting stops at the next quarter hour", () => {
    expect(placeRange("move", r, 480, 570)).toEqual({ start: 570, end: 630 });
    expect(placeRange("start", r, 480, 570)).toEqual({ start: 570, end: 660 });
  });
  test("a meeting that already started stays put until the drag passes now, and its end can still change", () => {
    const started = { start: 540, end: 600 }; // 09:00–10:00, now 09:30
    expect(placeRange("move", started, 555, 570)).toEqual(started);
    expect(placeRange("move", started, 600, 570)).toEqual({ start: 600, end: 660 });
    expect(placeRange("start", started, 525, 570)).toEqual(started);
    expect(placeRange("end", started, 630, 570)).toEqual({ start: 540, end: 630 });
    expect(placeRange("end", started, 555, 570)).toEqual({ start: 540, end: 570 });
  });
  test("on a past day nothing moves", () => {
    const floor = pastFloor(at(0, 0, 20), at(9, 10));
    expect(placeRange("move", r, 900, floor)).toEqual(r);
    expect(placeRange("end", r, 900, floor)).toEqual(r);
    expect(placeRange("new", r, 900, floor, 840)).toEqual(r);
  });
  test("a new time is drawn from where the drag began, at least 15 minutes, not in the past", () => {
    expect(placeRange("new", r, 935, 0, 840)).toEqual({ start: 840, end: 930 });
    expect(placeRange("new", r, 800, 0, 840)).toEqual({ start: 795, end: 840 });
    expect(placeRange("new", r, 842, 0, 840)).toEqual({ start: 840, end: 855 });
    expect(placeRange("new", r, 400, 570, 500)).toEqual({ start: 570, end: 585 });
  });
  test("the floor is the next quarter hour today, 0 later, past the day earlier", () => {
    expect(pastFloor(at(0), at(9, 10))).toBe(555);
    expect(pastFloor(at(0), at(9, 15))).toBe(555);
    expect(pastFloor(at(0, 0, 22), at(9, 10))).toBe(0);
    expect(pastFloor(at(0, 0, 20), at(9, 10))).toBeGreaterThan(1440);
  });
});

describe("keyboard", () => {
  const r = { start: 600, end: 660 };
  test("↑/↓ move 15 minutes, Shift changes the end, Option changes the start", () => {
    expect(nudge(r, "ArrowDown", {}, 0)).toEqual({ mode: "move", range: { start: 615, end: 675 } });
    expect(nudge(r, "ArrowUp", {}, 0)).toEqual({ mode: "move", range: { start: 585, end: 645 } });
    expect(nudge(r, "ArrowDown", { shiftKey: true }, 0)).toEqual({ mode: "end", range: { start: 600, end: 675 } });
    expect(nudge(r, "ArrowUp", { shiftKey: true }, 0)).toEqual({ mode: "end", range: { start: 600, end: 645 } });
    expect(nudge(r, "ArrowUp", { altKey: true }, 0)).toEqual({ mode: "start", range: { start: 585, end: 660 } });
    expect(nudge(r, "ArrowDown", { altKey: true }, 0)).toEqual({ mode: "start", range: { start: 615, end: 660 } });
  });
  test("Option+←/→ step a day; other keys do nothing", () => {
    expect(nudge(r, "ArrowLeft", { altKey: true }, 0)).toEqual({ day: -1 });
    expect(nudge(r, "ArrowRight", { altKey: true }, 0)).toEqual({ day: 1 });
    expect(nudge(r, "ArrowRight", {}, 0)).toBeUndefined();
    expect(nudge(r, "Enter", {}, 0)).toBeUndefined();
  });
  test("keys respect midnight and the past", () => {
    expect(nudge({ start: 1380, end: 1440 }, "ArrowDown", {}, 0)).toEqual({ mode: "move", range: { start: 1380, end: 1440 } });
    expect(nudge({ start: 570, end: 600 }, "ArrowUp", {}, 570)).toEqual({ mode: "move", range: { start: 570, end: 600 } });
  });
});

describe("drag → pending → confirmed/cancelled", () => {
  const review: Movability = { kind: "review", calendarName: "Work" };
  const direct: Movability = { kind: "direct" };
  const locked: Movability = { kind: "readOnly", reason: READ_ONLY_REASONS.recurring };
  const original = range([14], [15]);
  const later = range([15], [16]);
  const begin = (movability: Movability, meetingId = "m1") => reduceEdit(IDLE, { type: "begin", meetingId, mode: "move", original, movability });

  test("a read-only meeting never starts a drag or a change", () => {
    expect(begin(locked)).toBe(IDLE);
    expect(reduceEdit(IDLE, { type: "propose", meetingId: "m1", original, range: later, movability: locked })).toBe(IDLE);
  });
  test("a calendar meeting dropped somewhere new waits for review; confirm, then settle", () => {
    let s: EditState = begin(review);
    expect(s).toMatchObject({ phase: "dragging", meetingId: "m1", range: original, review: true });
    s = reduceEdit(s, { type: "drag", range: later });
    expect(shownRange(s, "m1")).toEqual(later);
    expect(shownRange(s, "other")).toBeUndefined();
    s = reduceEdit(s, { type: "drop" });
    expect(s).toEqual({ phase: "pending", meetingId: "m1", original, range: later });
    s = reduceEdit(s, { type: "confirm" });
    expect(s.phase).toBe("confirmed");
    expect(reduceEdit(s, { type: "settle" })).toBe(IDLE);
  });
  test("an app-only plan is confirmed on drop, with no review", () => {
    const s = reduceEdit(reduceEdit(begin(direct), { type: "drag", range: later }), { type: "drop" });
    expect(s).toEqual({ phase: "confirmed", meetingId: "m1", original, range: later });
  });
  test("Escape cancels a drag or a pending change and puts it back", () => {
    const dragging = reduceEdit(begin(review), { type: "drag", range: later });
    expect(reduceEdit(dragging, { type: "cancel" })).toEqual({ phase: "cancelled", meetingId: "m1", original, range: original });
    const pending = reduceEdit(dragging, { type: "drop" });
    const cancelled = reduceEdit(pending, { type: "cancel" });
    expect(cancelled).toEqual({ phase: "cancelled", meetingId: "m1", original, range: original });
    expect(reduceEdit(cancelled, { type: "settle" })).toBe(IDLE);
  });
  test("dropping where it was changes nothing", () => {
    expect(reduceEdit(begin(review), { type: "drop" })).toMatchObject({ phase: "cancelled", range: original });
  });
  test("a pending meeting can be dragged again and keeps its first original time", () => {
    const pending = reduceEdit(reduceEdit(begin(review), { type: "drag", range: later }), { type: "drop" });
    const again = reduceEdit(pending, { type: "begin", meetingId: "m1", mode: "end", original: later, movability: review });
    expect(again).toMatchObject({ phase: "dragging", original, range: later, mode: "end" });
    const longer = range([15], [16, 30]);
    expect(reduceEdit(reduceEdit(again, { type: "drag", range: longer }), { type: "drop" })).toEqual({ phase: "pending", meetingId: "m1", original, range: longer });
  });
  test("while one change is pending another meeting cannot start one", () => {
    const pending = reduceEdit(reduceEdit(begin(review), { type: "drag", range: later }), { type: "drop" });
    expect(reduceEdit(pending, { type: "begin", meetingId: "m2", mode: "move", original, movability: review })).toBe(pending);
    expect(reduceEdit(pending, { type: "propose", meetingId: "m2", original, range: later, movability: direct })).toBe(pending);
  });
  test("a key press proposes a whole change: reviewed ones pend, direct ones confirm, back to the start cancels", () => {
    const pending = reduceEdit(IDLE, { type: "propose", meetingId: "m1", original, range: later, movability: review });
    expect(pending).toEqual({ phase: "pending", meetingId: "m1", original, range: later });
    const further = range([15, 15], [16, 15]);
    expect(reduceEdit(pending, { type: "propose", meetingId: "m1", original: later, range: further, movability: review })).toEqual({ phase: "pending", meetingId: "m1", original, range: further });
    expect(reduceEdit(pending, { type: "propose", meetingId: "m1", original: later, range: original, movability: review })).toMatchObject({ phase: "cancelled", range: original });
    expect(reduceEdit(IDLE, { type: "propose", meetingId: "m1", original, range: later, movability: direct })).toMatchObject({ phase: "confirmed", range: later });
    expect(reduceEdit(IDLE, { type: "propose", meetingId: "m1", original, range: original, movability: direct })).toBe(IDLE);
  });
  test("events that do not apply leave the state alone", () => {
    expect(reduceEdit(IDLE, { type: "drag", range: later })).toBe(IDLE);
    expect(reduceEdit(IDLE, { type: "drop" })).toBe(IDLE);
    expect(reduceEdit(IDLE, { type: "confirm" })).toBe(IDLE);
    expect(reduceEdit(IDLE, { type: "cancel" })).toBe(IDLE);
    const dragging = begin(review);
    expect(reduceEdit(dragging, { type: "confirm" })).toBe(dragging);
    expect(reduceEdit(dragging, { type: "settle" })).toBe(dragging);
    expect(reduceEdit(dragging, { type: "begin", meetingId: "m2", mode: "move", original, movability: review })).toBe(dragging);
  });
});

describe("overlap note", () => {
  const active = { id: "me", ...range([14], [15]) };
  test("names what overlaps in plain words, ignoring all-day events and itself", () => {
    expect(overlapNote(active, [{ id: "a", title: "Team review", ...range([14, 30], [15, 30]) }])).toBe("Overlaps “Team review”");
    expect(overlapNote(active, [{ id: "a", title: "A", ...range([13], [14, 15]) }, { id: "b", title: "B", ...range([14, 45], [16]) }])).toBe("Overlaps “A” and “B”");
    expect(overlapNote(active, [{ id: "a", title: "A", ...range([14], [15]) }, { id: "b", title: "B", ...range([14], [15]) }, { id: "c", title: "C", ...range([14], [15]) }])).toBe("Overlaps “A” and 2 others");
    expect(overlapNote(active, [{ id: "me", title: "Me", ...range([14], [15]) }, { id: "d", title: "Holiday", allDay: true, ...range([0], [23]) }, { id: "e", title: "Back to back", ...range([15], [16]) }])).toBeUndefined();
  });
});

describe("review card words", () => {
  test("the heading names the calendar without doubling the word", () => {
    expect(reviewHeading("Work")).toBe("Move in Work calendar?");
    expect(reviewHeading("Calendar")).toBe("Move in Calendar?");
    expect(reviewHeading("your calendar")).toBe("Move in your calendar?");
  });
  test("a range reads as the Mac formats it", () => {
    expect(rangeText({ startMs: at(14), endMs: at(15) }, "en-US")).toMatch(/^2:00\s*–\s*3:00\sPM$/);
    expect(rangeText({ startMs: at(14), endMs: at(15) }, "en-GB")).toMatch(/^14:00\s*–\s*15:00$/);
  });
});
