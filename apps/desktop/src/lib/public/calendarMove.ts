import type { PublicCalendarEvent } from "@live-interview/core";
import type { publicClient } from "./client";
import { calendarSaveErrorMessage, eventMoveInfo, INVITATION_MOVE_WARNING, ORGANISER_MOVE_NOTE } from "./calendarSave";

/**
 * Moving an existing calendar event through the reviewed path: `propose` prepares the exact move (nothing is written),
 * `confirm` approves and applies it through the app-owned action executor, `cancel` declines it. The native side edits
 * the same event in place and verifies it by reading the calendar again; only then does `onMoved` run, so a refused,
 * reverted or unverified move leaves the plan untouched. Undo is `proposeRevert`: the reverse move, reviewed again.
 */
export interface MoveRange { startMs: number; endMs: number }
export interface PendingMove {
  proposalId: string;
  /** The calendar list's id of the event being moved (it may change after the move). */
  eventId: string;
  planId?: string;
  calendarId: string;
  calendarName: string;
  title: string;
  before: MoveRange;
  after: MoveRange;
  invitation: boolean;
  /** The text for the review card: the invitation warning, or the note that guests may be updated. */
  warning?: string;
  /** True when this is the Undo of the last move. */
  revert: boolean;
}
export interface AppliedMove {
  /** The event's id in the calendar list after the move, and before it (macOS ids follow the start time). */
  eventId: string;
  previousEventId: string;
  planId?: string;
  calendarId: string;
  calendarName: string;
  title: string;
  before: MoveRange;
  after: MoveRange;
  /** The event as the calendar list will show it now. */
  event: PublicCalendarEvent;
  /** The native snapshot read back after the move (version, native ids). */
  native: { id: string; startMs: number; endMs: number; version?: string };
  revert: boolean;
}
export interface CalendarMoveState { pending?: PendingMove; busy: boolean; error: string; errorCode?: string; lastMove?: AppliedMove }
export interface CalendarMoveDeps {
  api: Pick<typeof publicClient, "prepareCalendarMove" | "applyCalendarChange" | "declineCalendarChange">;
  /** A readable calendar name for an id, when the proposal does not carry one. */
  calendarName?: (calendarId: string) => string | undefined;
  /** Runs after a verified move: update the plan's times and the shown events. A failure here is reported, not thrown. */
  onMoved: (move: AppliedMove) => Promise<void>;
  /** The calendar changed since the person saw it: reload so the event snaps to its current time. */
  onChangedMeanwhile?: (eventId: string) => void;
}
const errorCode = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "");

export class CalendarMoveController {
  state: CalendarMoveState = { busy: false, error: "" };
  constructor(private deps: CalendarMoveDeps, private onChange: () => void = () => {}) {}
  private set(patch: Partial<CalendarMoveState>) {
    this.state = { ...this.state, ...patch };
    this.onChange();
  }
  private fail(error: unknown, eventId?: string) {
    const code = errorCode(error);
    this.set({ pending: undefined, busy: false, error: calendarSaveErrorMessage(code), errorCode: code || undefined });
    if (code === "eventChanged" && eventId) this.deps.onChangedMeanwhile?.(eventId);
  }
  /**
   * Prepares moving `event` to `range`. Refuses up front (with the plain reason) what the native side would refuse:
   * Google/Microsoft events, repeating, all-day, read-only calendars. Any earlier pending move is declined first.
   */
  async propose(event: PublicCalendarEvent, range: MoveRange, options: { planId?: string; revert?: boolean; nativeEventId?: string } = {}): Promise<PendingMove | undefined> {
    if (this.state.busy) return;
    const info = eventMoveInfo(event);
    if (!info.movable) {
      this.set({ error: info.reason, errorCode: info.code });
      return;
    }
    if (!(range.endMs > range.startMs)) {
      this.set({ error: calendarSaveErrorMessage("invalidDate"), errorCode: "invalidDate" });
      return;
    }
    if (this.state.pending) this.cancel();
    this.set({ busy: true, error: "", errorCode: undefined });
    try {
      const proposal = await this.deps.api.prepareCalendarMove({
        calendarId: event.calendarId,
        move: true,
        stableId: event.sourceEventId,
        // The native id is the fallback identity when the list's event has no stable id.
        ...(options.nativeEventId ? { eventId: options.nativeEventId } : {}),
        originalStartMs: event.startMs,
        startMs: range.startMs,
        endMs: range.endMs,
        expectedVersion: event.version,
        inferred: false,
      });
      // The native read decides whether it is an invitation; the list's flag is only the first guess.
      const invitation = proposal.invitation ?? info.invitation;
      const named = proposal.calendar?.name;
      const pending: PendingMove = {
        proposalId: proposal.id,
        eventId: event.id,
        planId: options.planId,
        calendarId: event.calendarId,
        calendarName: named || this.deps.calendarName?.(event.calendarId) || "your calendar",
        title: event.title,
        before: { startMs: event.startMs, endMs: event.endMs },
        after: { startMs: range.startMs, endMs: range.endMs },
        invitation,
        warning: invitation ? INVITATION_MOVE_WARNING : (event.attendees?.length ?? 0) > 0 ? ORGANISER_MOVE_NOTE : undefined,
        revert: !!options.revert,
      };
      this.set({ pending, busy: false });
      return pending;
    } catch (error) {
      this.fail(error, event.id);
    }
  }
  /** Undo: the reverse of the last move, as a new reviewed proposal. */
  async proposeRevert(move: AppliedMove | undefined = this.state.lastMove): Promise<PendingMove | undefined> {
    if (!move) return;
    return this.propose(move.event, move.before, { planId: move.planId, revert: true, nativeEventId: move.native.id });
  }
  /** Approves and applies the pending move. Resolves to the verified move, or undefined when nothing changed. */
  async confirm(): Promise<AppliedMove | undefined> {
    const pending = this.state.pending;
    if (!pending || this.state.busy) return;
    this.set({ busy: true, error: "", errorCode: undefined });
    let result;
    try {
      result = await this.deps.api.applyCalendarChange(pending.proposalId);
    } catch (error) {
      this.fail(error, pending.eventId);
      return;
    }
    // An earlier click already applied this move or is applying it; that click reports the result.
    if (!result) {
      this.set({ busy: false });
      return;
    }
    if (!result.moved || result.event.startMs !== pending.after.startMs || result.event.endMs !== pending.after.endMs) {
      this.fail("moveNotVerified");
      return;
    }
    const event: PublicCalendarEvent = result.publicEvent ?? {
      id: pending.eventId, title: pending.title, startMs: result.event.startMs, endMs: result.event.endMs, accountId: "apple-local",
      calendarId: pending.calendarId, provider: "apple", sourceEventId: result.event.stableId ?? "", version: result.event.version,
      // The calendar just accepted this move, so it is a writable single event.
      readOnly: false, calendarWritable: true,
    };
    const move: AppliedMove = {
      eventId: event.id,
      previousEventId: pending.eventId,
      planId: pending.planId,
      calendarId: pending.calendarId,
      calendarName: pending.calendarName,
      title: pending.title,
      before: pending.before,
      after: { startMs: result.event.startMs, endMs: result.event.endMs },
      event,
      native: { id: result.event.id, startMs: result.event.startMs, endMs: result.event.endMs, version: result.event.version },
      revert: pending.revert,
    };
    this.set({ pending: undefined, lastMove: pending.revert ? undefined : move });
    try {
      await this.deps.onMoved(move);
      this.set({ busy: false });
    } catch {
      // The calendar has the new time; only the plan could not be saved. Say so; the next calendar load shows the event right.
      this.set({ busy: false, error: "Moved in your calendar, but the meeting plan could not be saved. Reload the plan.", errorCode: "planSaveFailed" });
    }
    return move;
  }
  /** Declines the pending move; nothing is written. */
  cancel() {
    const pending = this.state.pending;
    if (!pending) return;
    this.set({ pending: undefined, error: "", errorCode: undefined });
    void this.deps.api.declineCalendarChange(pending.proposalId).catch(() => {});
  }
  /** Reports a move refused before reaching the calendar (for example, the event is not loaded). */
  refuse(code: string, message: string) {
    this.set({ error: message, errorCode: code });
  }
  clearError() {
    if (this.state.error) this.set({ error: "", errorCode: undefined });
  }
}
