import { describe, expect, test, vi } from "vitest";
import type { PublicCalendarEvent } from "@live-interview/core";
import { CalendarMoveController, type AppliedMove } from "./calendarMove";
import { INVITATION_MOVE_WARNING, ORGANISER_MOVE_NOTE, calendarSaveErrorMessage, eventMoveInfo } from "./calendarSave";

const H = 3_600_000;
const T = new Date(2026, 9, 20, 14).getTime();
const event = (extra: Partial<PublicCalendarEvent> = {}): PublicCalendarEvent => ({
  id: "apple:list-id-1", title: "Design review", startMs: T, endMs: T + H, accountId: "apple-local", calendarId: "work",
  provider: "apple", sourceEventId: "item-1", version: "v1", readOnly: false, calendarWritable: true, recurring: false, ...extra,
});
function setup(over: { prepare?: (change: any) => Promise<any>; apply?: (id: string) => Promise<any> } = {}) {
  const calls = { prepare: [] as any[], apply: [] as string[], decline: [] as string[] };
  const onMoved = vi.fn(async (_move: AppliedMove) => {});
  const onChangedMeanwhile = vi.fn();
  const api = {
    prepareCalendarMove: vi.fn(async (change: any) => {
      calls.prepare.push(change);
      if (over.prepare) return over.prepare(change);
      return { id: "proposal-" + calls.prepare.length, targetId: "work", targetPath: "calendar:work", targetVersion: change.expectedVersion, operation: "calendarEdit", before: "{}", after: "{}", evidence: [], inferred: false, status: "proposed", calendar: { id: "work", name: "Work", account: "iCloud" } };
    }),
    applyCalendarChange: vi.fn(async (id: string) => {
      calls.apply.push(id);
      if (over.apply) return over.apply(id);
      const change = calls.prepare.at(-1);
      return {
        applied: true, moved: true, before: { startMs: change.originalStartMs, endMs: change.originalStartMs + H },
        event: { id: "native-1", calendarId: "work", title: "Design review", startMs: change.startMs, endMs: change.endMs, version: "v2" },
        publicEvent: event({ id: "apple:list-id-2", startMs: change.startMs, endMs: change.endMs, version: "v2" }),
      };
    }),
    declineCalendarChange: vi.fn(async (id: string) => { calls.decline.push(id); }),
  };
  const controller = new CalendarMoveController({ api: api as any, onMoved, onChangedMeanwhile });
  return { controller, api, calls, onMoved, onChangedMeanwhile };
}

describe("moving a calendar event", () => {
  test("propose sends the event's identity, the start it was seen at and its version; nothing is applied", async () => {
    const { controller, calls, api } = setup();
    const pending = await controller.propose(event({ attendees: [{ name: "Alex" }] }), { startMs: T + H, endMs: T + 2 * H }, { planId: "plan-1" });
    expect(calls.prepare).toEqual([{ calendarId: "work", move: true, stableId: "item-1", originalStartMs: T, startMs: T + H, endMs: T + 2 * H, expectedVersion: "v1", inferred: false }]);
    expect(api.applyCalendarChange).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ planId: "plan-1", calendarName: "Work", before: { startMs: T, endMs: T + H }, after: { startMs: T + H, endMs: T + 2 * H }, invitation: false, warning: ORGANISER_MOVE_NOTE, revert: false });
    expect(controller.state.pending).toBe(pending);
  });

  test("confirm applies the reviewed move and hands the verified times to the app", async () => {
    const { controller, onMoved } = setup();
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H }, { planId: "plan-1" });
    const move = await controller.confirm();
    expect(move).toMatchObject({ eventId: "apple:list-id-2", previousEventId: "apple:list-id-1", planId: "plan-1", before: { startMs: T, endMs: T + H }, after: { startMs: T + H, endMs: T + 2 * H }, native: { id: "native-1", version: "v2" }, revert: false });
    expect(onMoved).toHaveBeenCalledWith(move);
    expect(controller.state).toMatchObject({ pending: undefined, busy: false, error: "", lastMove: move });
  });

  test("confirm is a quiet no-op when an earlier click already applied the move", async () => {
    const { controller, onMoved } = setup({ apply: async () => undefined });
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    expect(await controller.confirm()).toBeUndefined();
    expect(onMoved).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({ busy: false, error: "" });
  });

  test("cancel declines the proposal and writes nothing", async () => {
    const { controller, calls, api, onMoved } = setup();
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    controller.cancel();
    expect(calls.decline).toEqual(["proposal-1"]);
    expect(api.applyCalendarChange).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    expect(controller.state.pending).toBeUndefined();
    // A new proposal replaces (and declines) a pending one.
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    await controller.propose(event(), { startMs: T + 2 * H, endMs: T + 3 * H });
    expect(calls.decline).toEqual(["proposal-1", "proposal-2"]);
  });

  test("an event changed meanwhile is refused at review or at apply, with the specific message and a reload", async () => {
    const atReview = setup({ prepare: async () => { throw "eventChanged"; } });
    await atReview.controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    expect(atReview.controller.state.error).toBe("The event changed in your calendar. Nothing was changed.");
    expect(atReview.controller.state.errorCode).toBe("eventChanged");
    expect(atReview.onChangedMeanwhile).toHaveBeenCalledWith("apple:list-id-1");
    expect(atReview.controller.state.pending).toBeUndefined();

    const atApply = setup({ apply: async () => { throw "eventChanged"; } });
    await atApply.controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    expect(await atApply.controller.confirm()).toBeUndefined();
    expect(atApply.controller.state.error).toBe("The event changed in your calendar. Nothing was changed.");
    expect(atApply.onMoved).not.toHaveBeenCalled();
    expect(atApply.onChangedMeanwhile).toHaveBeenCalled();
  });

  test("refused, reverted or unverified moves leave the plan alone", async () => {
    for (const code of ["eventNotModifiable", "moveReverted", "moveNotVerified", "recurringUnsupported"]) {
      const { controller, onMoved } = setup({ apply: async () => { throw code; } });
      await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
      await controller.confirm();
      expect(onMoved).not.toHaveBeenCalled();
      expect(controller.state.error).toBe(calendarSaveErrorMessage(code));
    }
    // A result that is not a verified move at the proposed time is not trusted either.
    const wrong = setup({ apply: async () => ({ applied: true, event: { id: "n", calendarId: "work", title: "x", startMs: T, endMs: T + H }, publicEvent: null }) });
    await wrong.controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    await wrong.controller.confirm();
    expect(wrong.onMoved).not.toHaveBeenCalled();
    expect(wrong.controller.state.errorCode).toBe("moveNotVerified");
  });

  test("Undo proposes the reverse move for review, and applying it does not offer another Undo", async () => {
    const { controller, calls, onMoved } = setup();
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H }, { planId: "plan-1" });
    const move = await controller.confirm();
    const back = await controller.proposeRevert();
    expect(calls.prepare.at(-1)).toMatchObject({ stableId: "item-1", originalStartMs: T + H, startMs: T, endMs: T + H, expectedVersion: "v2" });
    expect(back).toMatchObject({ revert: true, planId: "plan-1", eventId: move!.eventId, before: { startMs: T + H, endMs: T + 2 * H }, after: { startMs: T, endMs: T + H } });
    expect(calls.apply).toHaveLength(1);
    const reverted = await controller.confirm();
    expect(reverted).toMatchObject({ revert: true, after: { startMs: T, endMs: T + H } });
    expect(onMoved).toHaveBeenCalledTimes(2);
    expect(controller.state.lastMove).toBeUndefined();
  });

  test("Undo still names the event when the move returned no calendar-list event", async () => {
    const { controller, calls } = setup({
      apply: async () => {
        const change = calls.prepare.at(-1);
        return {
          applied: true, moved: true,
          event: { id: "native-1", stableId: "item-1", calendarId: "work", title: "Design review", startMs: change.startMs, endMs: change.endMs, version: "v2" },
          publicEvent: null,
        };
      },
    });
    await controller.propose(event(), { startMs: T + H, endMs: T + 2 * H });
    await controller.confirm();
    await controller.proposeRevert();
    expect(calls.prepare.at(-1)).toMatchObject({ stableId: "item-1", eventId: "native-1", originalStartMs: T + H, startMs: T, endMs: T + H, expectedVersion: "v2" });
  });

  test("an invitation is proposed with the honest warning", async () => {
    const { controller } = setup({ prepare: async () => ({ id: "p", invitation: true, calendar: { id: "work", name: "Work" } }) });
    const pending = await controller.propose(event({ invitation: true, organiserIsCurrentUser: false }), { startMs: T + H, endMs: T + 2 * H });
    expect(pending).toMatchObject({ invitation: true, warning: INVITATION_MOVE_WARNING });
  });

  test("events that cannot move are refused before anything reaches the calendar", async () => {
    for (const [extra, reason] of [
      [{ recurring: true }, "Repeating meeting. Change it in Calendar."],
      [{ isAllDay: true }, "All-day event. Change it in Calendar."],
      [{ readOnly: true, calendarWritable: false }, "This calendar doesn't allow changes. Change it in Calendar."],
      [{ provider: "google" as const, readOnly: true }, "From Google Calendar, read-only here. Change it in Google Calendar."],
    ] as const) {
      const { controller, api } = setup();
      expect(await controller.propose(event(extra), { startMs: T + H, endMs: T + 2 * H })).toBeUndefined();
      expect(api.prepareCalendarMove).not.toHaveBeenCalled();
      expect(controller.state.error).toBe(reason);
    }
  });
});

describe("eventMoveInfo", () => {
  test("only writable, single, timed macOS events move; invitations move with the warning", () => {
    expect(eventMoveInfo(event())).toEqual({ movable: true, invitation: false });
    expect(eventMoveInfo(event({ attendees: [{ name: "Alex" }] }))).toEqual({ movable: true, invitation: false, note: ORGANISER_MOVE_NOTE });
    expect(eventMoveInfo(event({ invitation: true }))).toEqual({ movable: true, invitation: true, note: INVITATION_MOVE_WARNING });
    expect(eventMoveInfo(event({ provider: "microsoft" }))).toMatchObject({ movable: false, code: "notMacCalendar" });
    expect(eventMoveInfo(event({ recurring: true, invitation: true }))).toMatchObject({ movable: false, code: "recurring" });
    expect(eventMoveInfo(event({ isAllDay: true }))).toMatchObject({ movable: false, code: "allDay" });
    // Rows cached before writability was reported carry no readOnly:false and stay locked.
    expect(eventMoveInfo(event({ readOnly: undefined, calendarWritable: undefined }))).toMatchObject({ movable: false, code: "readOnly" });
    expect(eventMoveInfo(event({ cancelled: true }))).toMatchObject({ movable: false, code: "cancelled" });
  });
});
