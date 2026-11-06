import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import { PlanDayPanel, dayPanelActions, type DayPanelActionDeps, type DayPanelNotice } from "./PlanDayPanel";
import { INVITATION_MOVE_WARNING } from "../lib/public/calendarSave";
import { dayPanelMeetings } from "../lib/public/dayPanelMeetings";
import type { AppliedMove, PendingMove } from "../lib/public/calendarMove";

// The meeting page's day panel wired to its data (static markup and the page's handlers; no DOM in this package).
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();
const noop = () => {};
const ev = (id: string, h: number, extra: Partial<PublicCalendarEvent> = {}): PublicCalendarEvent => ({
  id, title: id, startMs: at(h), endMs: at(h, 30), accountId: "device", calendarId: "work", provider: "apple", sourceEventId: id, readOnly: false, calendarWritable: true, ...extra,
});
const plan = (id: string, extra: Partial<PublicMeetingPlan> = {}): PublicMeetingPlan => ({
  id, title: id, startMs: at(13), endMs: at(13, 30), workspaceId: "default", sourceIds: [], sharedLibraryIds: [], profileId: "workClient",
  attendees: [], objectives: [], publicResearchTopics: [], briefDraft: "", automaticPreparation: false, revision: 1, updatedAtMs: 0, status: "draft", ...extra,
} as PublicMeetingPlan);
const partner = ev("partner", 11, { invitation: true, title: "Partner briefing" });
const weekly = ev("weekly", 10, { recurring: true, title: "Weekly team sync" });
const allHands = ev("all-hands", 16, { readOnly: true, calendarWritable: false, title: "Company all-hands" });
const events = [weekly, partner, allHands];
const current = plan("p-this", { title: "Design review" });
const focus = plan("p-focus", { title: "Focus time", startMs: at(15), endMs: at(15, 30) });
const range = { startMs: at(14), endMs: at(14, 30) };

function deps(patch: Partial<DayPanelActionDeps> = {}) {
  const meetings = dayPanelMeetings({ day: at(0), events, plans: [focus], current });
  const notices: DayPanelNotice[] = [];
  const d = {
    meetings, events, current,
    setSchedule: vi.fn(), setPlanTimes: vi.fn(async () => true), setMessage: vi.fn(), openPlan: vi.fn(), selectUpcoming: vi.fn(), navigate: vi.fn(),
    onNotice: (n: DayPanelNotice) => { notices.push(n); }, setNotice: vi.fn(), setReleased: vi.fn(), setDay: vi.fn(),
    calendarMove: { pending: undefined as PendingMove | undefined, propose: vi.fn(async () => undefined as PendingMove | undefined), proposeRevert: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined as AppliedMove | undefined), clearError: vi.fn() },
    ...patch,
  };
  return { d, notices, actions: dayPanelActions(d as DayPanelActionDeps) };
}
const pendingMove = (patch: Partial<PendingMove> = {}): PendingMove => ({ proposalId: "prop-1", eventId: "partner", calendarId: "work", calendarName: "Work", title: "Partner briefing", before: { startMs: at(11, 30), endMs: at(12) }, after: range, invitation: true, warning: INVITATION_MOVE_WARNING, revert: false, ...patch });

describe("direct changes (only in this app)", () => {
  test("this meeting is saved through setSchedule, with an instant Undo", async () => {
    const { d, notices, actions } = deps();
    await actions.propose("plan:p-this", range);
    expect(d.setSchedule).toHaveBeenCalledWith(range);
    expect(d.calendarMove.propose).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ text: "Moved “Design review”", actionLabel: "Undo" });
    notices[0].action();
    expect(d.setSchedule).toHaveBeenLastCalledWith({ startMs: at(13), endMs: at(13, 30) });
  });
  test("Undo after another meeting was opened puts back the moved plan's times, not the open one's", async () => {
    let open = "p-this";
    const { d, notices, actions } = deps({ openPlanId: () => open });
    await actions.propose("plan:p-this", range);
    open = "p-focus";
    notices[0].action();
    expect(d.setSchedule).toHaveBeenCalledTimes(1);
    expect(d.setPlanTimes).toHaveBeenCalledWith("p-this", { startMs: at(13), endMs: at(13, 30) });
  });
  test("another plan is saved as a plan, and Undo puts its times back", async () => {
    const { d, notices, actions } = deps();
    await actions.propose("plan:p-focus", range);
    expect(d.setPlanTimes).toHaveBeenCalledWith("p-focus", range);
    expect(d.setSchedule).not.toHaveBeenCalled();
    notices[0].action();
    expect(d.setPlanTimes).toHaveBeenLastCalledWith("p-focus", { startMs: at(15), endMs: at(15, 30) });
  });
  test("a failed save says so and offers no Undo", async () => {
    const { d, notices, actions } = deps({ setPlanTimes: vi.fn(async () => false) });
    await actions.propose("plan:p-focus", range);
    expect(d.setNotice).toHaveBeenLastCalledWith("The meeting could not be saved. Nothing was changed.");
    expect(notices).toHaveLength(0);
  });
  test("drawing a first time for an untimed meeting sets it without a toast", async () => {
    const untimed = plan("p-new", { startMs: undefined, endMs: undefined });
    const { d, notices, actions } = deps({ current: untimed, untimedMeetingId: "plan:p-new", meetings: [] });
    await actions.propose("plan:p-new", range);
    expect(d.setSchedule).toHaveBeenCalledWith(range);
    expect(notices).toHaveLength(0);
  });
});

describe("calendar changes (reviewed)", () => {
  test("a calendar event goes to calendarMove.propose, never to a plan save", async () => {
    const pending = pendingMove();
    const { d, actions } = deps({ calendarMove: { ...deps().d.calendarMove, propose: vi.fn(async () => pending) } });
    await actions.propose("partner", range);
    expect(d.calendarMove.propose).toHaveBeenCalledWith(partner, range);
    expect(d.setSchedule).not.toHaveBeenCalled();
    expect(d.setPlanTimes).not.toHaveBeenCalled();
    expect(d.setReleased).not.toHaveBeenCalled();
  });
  test("a move that cannot be prepared releases the panel's own review card", async () => {
    const { d, actions } = deps();
    await actions.propose("partner", range);
    expect(d.setReleased).toHaveBeenCalledWith({ meetingId: "partner", ...range });
  });
  test("a locked meeting is refused with its reason", async () => {
    const { d, actions } = deps();
    await actions.propose("weekly", range);
    expect(d.calendarMove.propose).not.toHaveBeenCalled();
    expect(d.setNotice).toHaveBeenLastCalledWith("Repeating meeting. Change it in Calendar.");
  });
  test("confirm applies, toasts “Moved in Work calendar” and Undo reopens the review with the reverse move", async () => {
    const done = { eventId: "partner-2", previousEventId: "partner", calendarId: "work", calendarName: "Work", title: "Partner briefing", before: { startMs: at(11, 30), endMs: at(12) }, after: range, event: { ...partner, id: "partner-2", ...range }, native: { id: "n", ...range }, revert: false } as AppliedMove;
    const { d, notices, actions } = deps({ calendarMove: { ...deps().d.calendarMove, pending: pendingMove(), confirm: vi.fn(async () => done) } });
    await actions.confirm();
    expect(d.calendarMove.confirm).toHaveBeenCalled();
    expect(d.setMessage).toHaveBeenCalledWith("");
    expect(notices[0]).toMatchObject({ text: "Moved in Work calendar", actionLabel: "Undo" });
    notices[0].action();
    expect(d.calendarMove.proposeRevert).toHaveBeenCalledWith(done);
    expect(d.setDay).toHaveBeenCalledWith(at(0));
  });
  test("a refused or changed-meanwhile confirm shows no toast (the panel shows the error)", async () => {
    const { notices, actions } = deps({ calendarMove: { ...deps().d.calendarMove, pending: pendingMove() } });
    await actions.confirm();
    expect(notices).toHaveLength(0);
  });
});

describe("opening another meeting", () => {
  test("a plan opens its plan; an event without one opens through the calendar path; this one does nothing", () => {
    const { d, actions } = deps();
    const meetings = d.meetings;
    actions.open(meetings.find((m) => m.id === "plan:p-focus")!);
    expect(d.openPlan).toHaveBeenCalledWith("p-focus");
    expect(d.navigate).toHaveBeenLastCalledWith({ kind: "meeting", id: "p-focus", preparationOpen: false, artifact: "overview" });
    actions.open(meetings.find((m) => m.id === "partner")!);
    expect(d.selectUpcoming).toHaveBeenCalledWith(partner);
    expect(d.navigate).toHaveBeenLastCalledWith({ kind: "meeting", id: "partner", preparationOpen: false, artifact: "overview" });
    vi.mocked(d.navigate).mockClear();
    actions.open(meetings.find((m) => m.isThis)!);
    expect(d.navigate).not.toHaveBeenCalled();
  });
});

describe("markup", () => {
  // The fixtures are on 21 Oct 2026; render as if it were the day before, so they are not in the (locked) past.
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 20, 9)); });
  afterAll(() => { vi.useRealTimers(); });
  const controller = ({ p = current, pending, error = "", evts = events }: { p?: PublicMeetingPlan; pending?: PendingMove; error?: string; evts?: PublicCalendarEvent[] } = {}) => ({
    calendarRange: undefined, selectUpcoming: noop, setup: { setSchedule: noop },
    publicProduct: {
      enabled: true, current: p, plans: [focus], calendarEvents: evts, accounts: [{ id: "device", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: ["work"] }], accountsLoaded: true,
      coverage: [{ accountId: "device", calendarId: "work", startMs: at(0) - 86_400_000, endMs: at(0) + 2 * 86_400_000, status: "ready" }], range: { startMs: at(0) - 86_400_000, endMs: at(0) + 2 * 86_400_000 },
      loadRange: async () => {}, openPlan: async () => {}, setPlanTimes: async () => true, setMessage: noop,
      calendarSave: { writable: [{ id: "work", name: "Work", account: "" }], pending: undefined, busy: false, error: "", refresh: async () => {}, propose: async () => {}, proposeIcs: async () => {}, confirm: async () => {}, cancel: noop },
      calendarMove: { pending, busy: false, error, propose: async () => undefined, proposeRevert: async () => undefined, confirm: async () => undefined, cancel: noop, clearError: noop },
    },
  });
  const render = (c: ReturnType<typeof controller>) => renderToStaticMarkup(createElement(PlanDayPanel, { controller: c as never, navigate: noop }));
  test("every meeting of the day: movable ones draggable, locked ones with their lock; length chips for a movable meeting", () => {
    const html = render(controller());
    for (const title of ["Weekly team sync", "Partner briefing", "Focus time", "Company all-hands", "Design review"]) expect(html).toContain(title);
    expect(html.match(/class="dp-meeting[^"]*is-locked/g)).toHaveLength(2);
    expect(html).toMatch(/class="dp-meeting is-this is-movable/);
    expect(html).toContain('class="length-choices segmented-control"');
    expect(html).not.toContain("From your calendar");
  });
  test("a meeting from a repeating event: locked, no length chips", () => {
    const fromCalendar = plan("p-weekly", { eventId: "weekly", startMs: at(10), endMs: at(10, 30) });
    const html = render(controller({ p: fromCalendar }));
    expect(html).toMatch(/class="dp-meeting is-this is-locked/);
    expect(html).not.toContain('class="length-choices segmented-control"');
    expect(html).not.toContain("From your calendar");
  });
  test("an invitation under review shows the Mac calendar warning, not the default copy", () => {
    const html = render(controller({ pending: pendingMove() }));
    expect(html).toContain("Move in Work calendar?");
    expect(html).toContain(INVITATION_MOVE_WARNING.replace(/'/g, "&#x27;"));
  });
  test("a refused or changed move is said in plain words on the panel", () => {
    expect(render(controller({ error: "The event changed in your calendar. Nothing was changed." }))).toContain('class="dp-notice">The event changed in your calendar. Nothing was changed.');
  });
  test("an undated in-app meeting is drawn on the timeline", () => {
    expect(render(controller({ p: plan("p-new", { startMs: undefined, endMs: undefined }) }))).toContain("Drag on the timeline to give this meeting a time.");
  });
});
