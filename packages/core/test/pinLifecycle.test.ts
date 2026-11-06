import { expect, test } from "vitest";
import {
  applyGuidanceEvent,
  openPins,
  pinTopic,
  reopenPin,
  resurfacePins,
  settledPins,
  settlePin,
  visibleCards,
} from "../src/pins";
import { makeClarification } from "../src/guidance/engine";
import { buildContext, SnapshotStore, createMeetingState } from "../src/snapshots";
import type { HotkeyContext, LiveViewState } from "../src/contracts";
const state = createMeetingState({
  id: "m",
  workspaceId: "w",
  purpose: "meeting",
  objectives: [],
  attendees: [],
  profileId: "workClient",
  profileRevision: 0,
});
const store = new SnapshotStore();
store.initialise(state);
const basis = store.read(state);
const card = (id: string) => ({
  ...makeClarification("contribute", basis),
  id,
  trigger: "automatic" as const,
  createdAtMs: Number(id) || 0,
});
const withCards = (...ids: string[]) => {
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  for (const id of ids) view = applyGuidanceEvent(view, { kind: "card", card: card(id) });
  return view;
};
const changed = (invalidatedSourceIds: string[]): HotkeyContext => ({
  ...basis,
  observationSequence: basis.observationSequence + 1,
  invalidatedSourceIds,
});

test("a pin marked answered leaves the active cards but stays saved with the person's decision", () => {
  let view = pinTopic(withCards("1", "2"), "1");
  view = settlePin(view, "1", "answered");
  expect(view.cards.map((c) => c.id)).toEqual(["2"]);
  expect(view.savedPins).toHaveLength(1);
  expect(view.savedPins[0]).toMatchObject({ id: "1", pinOutcome: "answered" });
  expect(openPins(view.savedPins)).toEqual([]);
  expect(settledPins(view.savedPins).map((p) => p.id)).toEqual(["1"]);
});

test("outdated is recorded the same way, and its slot is free for new guidance", () => {
  let view = withCards("1", "2", "3");
  for (const c of view.cards) view = pinTopic(view, c.id);
  view = settlePin(view, "2", "outdated");
  expect(view.savedPins.find((p) => p.id === "2")?.pinOutcome).toBe("outdated");
  view = applyGuidanceEvent(view, { kind: "card", card: card("4") });
  expect(view.cards.map((c) => c.id)).toEqual(["1", "3", "4"]);
});

test("only a saved pin can be settled; an unpinned card is unchanged", () => {
  const view = withCards("1");
  expect(settlePin(view, "1", "answered")).toEqual(view);
});

test("settling a pinned request moves it out and lets the overlay settle", () => {
  let view = withCards("1", "2", "3");
  for (const c of view.cards) view = pinTopic(view, c.id);
  view = applyGuidanceEvent(view, {
    kind: "card",
    card: { ...card("answer"), trigger: "requested" as const },
  });
  view = pinTopic(view, "answer");
  view = { ...view, detailCardId: "answer" };
  view = settlePin(view, "answer", "answered");
  expect(view.requestedCard).toBeUndefined();
  expect(view.detailCardId).toBeUndefined();
  expect(visibleCards(view).map((c) => c.id)).toEqual(["1", "2", "3"]);
});

test("reopening clears the decision; the topic is saved again but not forced back into the cards", () => {
  let view = settlePin(pinTopic(withCards("1"), "1"), "1", "answered");
  view = reopenPin(view, "1");
  expect(view.savedPins[0].pinOutcome).toBeUndefined();
  expect(view.cards).toEqual([]);
  expect(openPins(view.savedPins).map((p) => p.id)).toEqual(["1"]);
});

test("a settled pin is never resurfaced as a reminder", () => {
  const view = settlePin(pinTopic(withCards("1"), "1"), "1", "outdated");
  expect(resurfacePins(view.savedPins, [], 1000, 2000)).toEqual([]);
});

test("the app only suggests outdated when a source the pin cites changed, and never decides it", () => {
  let view = pinTopic(pinTopic(withCards("1", "2"), "1"), "2");
  const cite = <T extends { id: string }>(c: T) => (c.id === "1" ? { ...c, evidence: ["doc:a"] } : c);
  view = { ...view, cards: view.cards.map(cite), savedPins: view.savedPins.map(cite) };
  // An ordinary transcript update does not suggest anything.
  let next = applyGuidanceEvent(view, { kind: "contextChanged", basis: changed([]) });
  expect(next.savedPins.some((p) => p.outdatedSuggested)).toBe(false);
  next = applyGuidanceEvent(view, { kind: "contextChanged", basis: changed(["doc:a"]) });
  expect(next.savedPins.find((p) => p.id === "1")).toMatchObject({ outdatedSuggested: true });
  expect(next.savedPins.find((p) => p.id === "1")?.pinOutcome).toBeUndefined();
  expect(next.cards.find((c) => c.id === "1")?.outdatedSuggested).toBe(true);
  expect(next.savedPins.find((p) => p.id === "2")?.outdatedSuggested).toBeUndefined();
  // The person's decision replaces the suggestion.
  next = settlePin(next, "1", "answered");
  expect(next.savedPins.find((p) => p.id === "1")).toMatchObject({ pinOutcome: "answered" });
  expect(next.savedPins.find((p) => p.id === "1")?.outdatedSuggested).toBeUndefined();
});

test("a settled pin keeps its decision through later context changes", () => {
  let view = settlePin(pinTopic(withCards("1"), "1"), "1", "answered");
  view = applyGuidanceEvent(view, { kind: "contextChanged", basis: changed(["doc:a"]) });
  expect(view.savedPins[0]).toMatchObject({ pinOutcome: "answered" });
});

test("guidance context lists only open pinned topics", () => {
  const answered = { ...card("1"), say: "Already handled", pinned: true, pinOutcome: "answered" as const };
  const open = { ...card("2"), say: "Still open", pinned: true };
  expect(buildContext({ ...state, pins: [answered, open] }, []).pinnedTopics).toEqual(["Still open"]);
});
