import { expect, test } from "vitest";
import { applyGuidanceEvent, pinTopic, resurfacePins } from "../src/pins";
import { makeClarification } from "../src/guidance/engine";
import { SnapshotStore, createMeetingState } from "../src/snapshots";
import type { LiveViewState } from "../src/contracts";
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
  createdAtMs: Number(id),
});
test("three slots replace oldest unpinned; pinned refinements do not silently rewrite pins", () => {
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  for (const id of ["1", "2", "3"])
    view = applyGuidanceEvent(view, { kind: "card", card: card(id) });
  view = pinTopic(view, "1");
  view = applyGuidanceEvent(view, { kind: "card", card: card("4") });
  expect(view.cards.map((c) => c.id)).toEqual(["1", "3", "4"]);
  view = applyGuidanceEvent(view, {
    kind: "refinement",
    card: card("5"),
    refinesCardId: "1",
  });
  expect(view.cards.find((c) => c.id === "1")?.pinned).toBe(true);
  for (const c of view.cards) view = pinTopic(view, c.id);
  const next = applyGuidanceEvent(view, { kind: "card", card: card("6") });
  expect(next.cards).toEqual(view.cards);
  expect(next.queued).toBeGreaterThan(0);
});
test("unknown end time does not invent near-end reminder; topic reminders cite saved pins", () => {
  const pin = card("1");
  expect(resurfacePins([pin], [], Date.now(), undefined)).toEqual([]);
  expect(resurfacePins([pin], [], 1000, 2000)).toHaveLength(1);
});
import { visibleCards } from "../src/pins";
test("an explicit request is shown even when all slots are pinned, without losing a pin", () => {
  const view = {
    cards: [card("1"), card("2"), card("3")].map((c) => ({
      ...c,
      pinned: true,
    })),
    savedPins: [],
    queued: 0,
  };
  const requested = { ...card("answer"), trigger: "requested" as const };
  const next = applyGuidanceEvent(view, { kind: "card", card: requested });
  expect(visibleCards(next).some((c) => c.id === "answer")).toBe(true);
  expect(visibleCards(next)).toHaveLength(3);
  expect(next.cards.map((c) => c.id)).toEqual(["1", "2", "3"]);
});
import { dismissCard } from "../src/pins";
test("late refinements cannot resurrect a dismissed provisional or requested slot", () => {
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  view = applyGuidanceEvent(view, { kind: "card", card: card("1") });
  view = dismissCard(view, "1");
  view = applyGuidanceEvent(view, {
    kind: "refinement",
    card: card("2"),
    refinesCardId: "1",
  });
  expect(visibleCards(view)).toEqual([]);
  const pinned = [card("1"), card("2"), card("3")].map((c) => ({
    ...c,
    pinned: true,
  }));
  view = applyGuidanceEvent(
    { cards: pinned, savedPins: [], queued: 0 },
    { kind: "card", card: { ...card("4"), trigger: "requested" } },
  );
  view = dismissCard(view, "4");
  view = applyGuidanceEvent(view, {
    kind: "refinement",
    card: { ...card("5"), trigger: "requested" },
    refinesCardId: "4",
  });
  expect(visibleCards(view).map((c) => c.id)).toEqual(["1", "2", "3"]);
});

test("dismissing a pin frees a slot for the requested card, so later cards are never hidden", () => {
  const pinned = [card("a"), card("b"), card("c")].map((c) => ({
    ...c,
    pinned: true,
  }));
  let view: LiveViewState = applyGuidanceEvent(
    { cards: pinned, savedPins: [], queued: 0 },
    { kind: "card", card: { ...card("r"), trigger: "requested" } },
  );
  view = dismissCard(view, "a");
  expect(view.requestedCard).toBeUndefined();
  expect(visibleCards(view).map((c) => c.id)).toEqual(["b", "c", "r"]);
  view = applyGuidanceEvent(view, { kind: "card", card: card("d") });
  // Every accepted card is visible: what the state holds is what is shown.
  expect(visibleCards(view).map((c) => c.id)).toEqual(
    view.cards.map((c) => c.id),
  );
  expect(visibleCards(view).some((c) => c.id === "d")).toBe(true);
});

test("semantic invalidation marks every visible and saved card historical without replacing its content", () => {
  const automatic = { ...card("1"), origin: "cache" as const };
  const requested = {
    ...card("2"),
    origin: "cache" as const,
    trigger: "requested" as const,
  };
  const view: LiveViewState = {
    cards: [{ ...automatic, pinned: true }],
    savedPins: [{ ...automatic, pinned: true }],
    requestedCard: requested,
    queued: 0,
  };
  const changed = structuredClone(basis);
  changed.snapshot.context.purpose = "Different decision";
  const next = applyGuidanceEvent(view, {
    kind: "contextChanged",
    basis: changed,
  });
  expect(next.cards[0]).toMatchObject({
    id: "1",
    say: automatic.say,
    stale: true,
    pinned: true,
  });
  expect(next.requestedCard).toMatchObject({
    id: "2",
    say: requested.say,
    stale: true,
  });
  expect(next.savedPins[0].stale).toBe(true);
  const dismissed = dismissCard(next, "2");
  expect(
    applyGuidanceEvent(dismissed, { kind: "contextChanged", basis: changed })
      .requestedCard,
  ).toBeUndefined();
});

test("an equivalent snapshot or pause-only revision leaves useful cards current", () => {
  const view: LiveViewState = { cards: [card("1")], savedPins: [], queued: 0 };
  const current = structuredClone(basis);
  current.stateRevision++;
  current.snapshot.snapshotId = "later-publication";
  current.snapshot.createdAtMs++;
  expect(
    applyGuidanceEvent(view, { kind: "contextChanged", basis: current })
      .cards[0].stale,
  ).toBe(false);
});

test("a draft sits beside the cards, is replaced by the validated answer and withheld on new evidence", () => {
  let view: LiveViewState = { cards: [], savedPins: [], queued: 0 };
  view = applyGuidanceEvent(view, {
    kind: "draft",
    intent: "respond",
    text: "Who owns",
  });
  expect(view.draft).toEqual({ intent: "respond", text: "Who owns" });
  expect(view.cards).toEqual([]);
  expect(view.requestedCard).toBeUndefined();
  expect(view.savedPins).toEqual([]);
  view = applyGuidanceEvent(view, {
    kind: "draft",
    intent: "respond",
    text: "Who owns the next step?",
  });
  expect(view.draft?.text).toBe("Who owns the next step?");
  // The "reasoning pending" placeholder does not displace the draft.
  view = applyGuidanceEvent(view, {
    kind: "card",
    card: { ...card("1"), trigger: "requested", provisional: true },
  });
  expect(view.draft?.text).toBe("Who owns the next step?");
  // An automatic card is unrelated to the request.
  view = applyGuidanceEvent(view, { kind: "card", card: card("2") });
  expect(view.draft).toBeDefined();
  view = applyGuidanceEvent(view, {
    kind: "refinement",
    card: { ...card("3"), trigger: "requested" },
    refinesCardId: "1",
  });
  expect(view.draft).toBeUndefined();

  view = applyGuidanceEvent(view, {
    kind: "draft",
    intent: "respond",
    text: "Again",
  });
  expect(
    applyGuidanceEvent(view, { kind: "draft", intent: "respond" }).draft,
  ).toBeUndefined();
  // A validated refinement whose placeholder card is gone still ends the draft.
  const orphan = applyGuidanceEvent(view, {
    kind: "refinement",
    card: { ...card("9"), trigger: "requested" },
    refinesCardId: "missing",
  });
  expect(orphan.draft).toBeUndefined();
  expect(orphan.cards).toEqual(view.cards);
  const changed = structuredClone(basis);
  changed.snapshot.context.indexRevision++;
  expect(
    applyGuidanceEvent(view, { kind: "contextChanged", basis: changed }).draft,
  ).toBeUndefined();
});
