import { expect, test, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn(), getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/dpi", () => ({ LogicalPosition: class {} }));
import {
  applyGuidanceEvent,
  createMeetingState,
  makeClarification,
  pinTopic,
  settlePin,
  SnapshotStore,
  type LiveViewState,
  type PinOutcome,
} from "@live-interview/core";
import { ACTION_ERROR_MS, dispatchWidgetAction, settleableCardIds, visibleActionError } from "./bridge";
import { pinsNote } from "../../lib/copilot/pinsNote";

const state = createMeetingState({ id: "m", workspaceId: "w", purpose: "meeting", objectives: [], attendees: [], profileId: "workClient", profileRevision: 0 });
const store = new SnapshotStore();
store.initialise(state);
const basis = store.read(state);
const withCards = (...ids: string[]) => {
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  for (const id of ids) view = applyGuidanceEvent(view, { kind: "card", card: { ...makeClarification("contribute", basis), id, trigger: "automatic" as const, createdAtMs: Number(id) } });
  return view;
};

/** A main workspace whose settle behaves like the controller's: settlePin, then the pins note is written. */
function workspace(view: LiveViewState) {
  const notes: ReturnType<typeof pinsNote>[] = [];
  const settle = vi.fn((id: string, outcome: PinOutcome) => {
    const next = settlePin(source.view, id, outcome);
    if (next === source.view) return;
    source.view = next;
    notes.push(pinsNote("m", next.savedPins));
  });
  const source = { activeMeeting: { id: "m" } as never, view, pin: vi.fn(), dismiss: vi.fn(), expand: vi.fn(), settle };
  return { source, notes };
}
const action = (kind: string, cardId: string, requestId = crypto.randomUUID()) => ({ version: 1, requestId, ownerId: "owner", meetingId: "m", kind, cardId });

test("Answered from the widget settles the saved pin once and the pins note records the outcome", () => {
  for (const outcome of ["answered", "outdated"] as const) {
    const { source, notes } = workspace(pinTopic(withCards("1", "2"), "1"));
    const seen = { meetingId: "m", requests: new Set<string>() };
    const request = action(outcome, "1");
    expect(dispatchWidgetAction(request, source, "owner", seen, () => {})?.kind).toBe(outcome);
    // The same request arriving twice (forwarded and emitted) is applied once.
    expect(dispatchWidgetAction(request, source, "owner", seen, () => {})).toBeUndefined();
    expect(source.settle).toHaveBeenCalledTimes(1);
    expect(source.settle).toHaveBeenCalledWith("1", outcome);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("pins");
    expect(JSON.parse(notes[0].text)).toEqual([expect.objectContaining({ id: "1", pinOutcome: outcome })]);
  }
});

test("only pinned cards in the saved pins are settleable, so the widget never offers a no-op button", () => {
  const pinned = pinTopic(withCards("1", "2"), "1");
  expect(settleableCardIds(pinned)).toEqual(["1"]);
  // A card shown as pinned whose saved pin is gone cannot be settled by the main window.
  const unsaved: LiveViewState = { ...pinned, savedPins: [] };
  expect(settleableCardIds(unsaved)).toEqual([]);
  const { source } = workspace(unsaved);
  expect(dispatchWidgetAction(action("answered", "1"), source, "owner", { meetingId: "m", requests: new Set() }, () => {})).toBeUndefined();
  expect(source.settle).not.toHaveBeenCalled();
});

test("a widget action error clears after its timeout, on a new meeting, and is not shown for another meeting", () => {
  const error = { text: "Action could not reach the main workspace.", meetingId: "m1", atMs: 1_000 };
  expect(visibleActionError(error, "m1", 1_000 + ACTION_ERROR_MS - 1)).toBe(error);
  expect(visibleActionError(error, "m1", 1_000 + ACTION_ERROR_MS)).toBeUndefined();
  expect(visibleActionError(error, "m2", 1_500)).toBeUndefined();
  expect(visibleActionError(undefined, "m1", 1_500)).toBeUndefined();
});
