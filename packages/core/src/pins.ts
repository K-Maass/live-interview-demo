import type {
  GuidanceCard,
  GuidanceEvent,
  LiveViewState,
  PinOutcome,
} from "./contracts";
import { guidanceBasisKey } from "./guidance/engine";
export function applyGuidanceEvent(
  view: LiveViewState,
  event: GuidanceEvent,
): LiveViewState {
  if (event.kind === "draft") {
    // Held beside the cards, never among them: a draft can't be pinned, noted or cited.
    const { draft: _previous, ...rest } = view;
    return event.text
      ? { ...rest, draft: { intent: event.intent, text: event.text } }
      : rest;
  }
  if (event.kind === "contextChanged") {
    const key = guidanceBasisKey(event.basis);
    const changedSources = new Set(event.basis.invalidatedSourceIds);
    // Only a changed source the pin cites suggests "outdated"; an ordinary transcript update does not.
    const suggest = (card: GuidanceCard) =>
      card.pinned &&
      !card.pinOutcome &&
      !card.outdatedSuggested &&
      card.evidence.some((id) => changedSources.has(id))
        ? { ...card, outdatedSuggested: true }
        : card;
    const markHistorical = (card: GuidanceCard) =>
      suggest(
        card.stale || guidanceBasisKey(card.basis) === key
          ? card
          : { ...card, stale: true },
      );
    // A draft written against older evidence is withheld like an older card.
    const { draft: _stale, ...rest } = view;
    return {
      ...rest,
      cards: view.cards.map(markHistorical),
      savedPins: view.savedPins.map(markHistorical),
      requestedCard: view.requestedCard
        ? markHistorical(view.requestedCard)
        : undefined,
    };
  }
  if (event.kind !== "card" && event.kind !== "refinement") return view;
  const next = settleRequested(structuredClone(view)),
    card = structuredClone(event.card);
  // The validated answer to the request replaces its draft; the "reasoning
  // pending" placeholder does not, because the draft is the better placeholder.
  const answered = card.trigger === "requested" && !card.provisional;
  if (answered) delete next.draft;
  const replaced = event.kind === "refinement" ? event.refinesCardId : card.id;
  if (
    event.kind === "refinement" &&
    !next.cards.some((c) => c.id === replaced) &&
    next.requestedCard?.id !== replaced
  )
    // Even a refinement with nowhere to land ends the draft it answers.
    return answered && view.draft ? next : view;
  if (next.requestedCard && next.requestedCard.id === replaced) {
    if (next.requestedCard.pinned) {
      next.queued++;
      return next;
    }
    next.requestedCard = card;
    return next;
  }
  const existing = next.cards.find((c) => c.id === replaced);
  if (existing) {
    if (existing.pinned) {
      next.queued++;
      return next;
    }
    next.cards = next.cards.map((c) => (c.id === replaced ? card : c));
    return next;
  }
  if (next.cards.length < 3) {
    next.cards.push(card);
    return next;
  }
  const oldest = next.cards
    .filter((c) => !c.pinned)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
  if (!oldest) {
    if (card.trigger === "requested") next.requestedCard = card;
    else next.queued++;
    return next;
  }
  next.cards = next.cards.filter((c) => c.id !== oldest.id).concat(card);
  return next;
}
export function pinTopic(view: LiveViewState, id: string): LiveViewState {
  const next = structuredClone(view);
  const card =
    next.cards.find((c) => c.id === id) ??
    (next.requestedCard?.id === id ? next.requestedCard : undefined);
  if (!card) return next;
  card.pinned = true;
  if (!next.savedPins.some((c) => c.id === id))
    next.savedPins.push(structuredClone(card));
  return next;
}
/**
 * The requested card is an overlay only while all three slots are taken.
 * Once a slot frees up it moves into `cards`, so `visibleCards` never hides a
 * card the state has accepted.
 */
function settleRequested(view: LiveViewState): LiveViewState {
  if (!view.requestedCard || view.cards.length >= 3) return view;
  const { requestedCard, ...rest } = view;
  return { ...rest, cards: [...view.cards, requestedCard] };
}
export function dismissCard(view: LiveViewState, id: string): LiveViewState {
  return settleRequested({
    ...view,
    cards: view.cards.filter((c) => c.id !== id),
    requestedCard:
      view.requestedCard?.id === id ? undefined : view.requestedCard,
    detailCardId: view.detailCardId === id ? undefined : view.detailCardId,
  });
}
/**
 * Records a person's decision on a saved pin. The card leaves the active cards (freeing its slot) but stays in
 * `savedPins` with its outcome, so it remains reviewable after the meeting. A card that is not a saved pin is unchanged.
 */
export function settlePin(
  view: LiveViewState,
  id: string,
  outcome: PinOutcome,
): LiveViewState {
  if (!view.savedPins.some((p) => p.id === id)) return view;
  const savedPins = view.savedPins.map((p) => {
    if (p.id !== id) return p;
    const { outdatedSuggested: _suggestion, ...rest } = p;
    return { ...rest, pinOutcome: outcome };
  });
  return dismissCard({ ...view, savedPins }, id);
}
/** Undoes a decision: the topic is an open saved pin again, without being forced back into the cards. */
export function reopenPin(view: LiveViewState, id: string): LiveViewState {
  return {
    ...view,
    savedPins: view.savedPins.map((p) => {
      if (p.id !== id) return p;
      const { pinOutcome: _outcome, ...rest } = p;
      return rest;
    }),
  };
}
export const openPins = (pins: GuidanceCard[]) =>
  pins.filter((p) => !p.pinOutcome);
export const settledPins = (pins: GuidanceCard[]) =>
  pins.filter((p) => !!p.pinOutcome);
export function resurfacePins(
  pins: GuidanceCard[],
  coveredIds: string[],
  now: number,
  scheduledEndMs?: number,
  currentText = "",
) {
  const nearEnd =
    scheduledEndMs !== undefined &&
    scheduledEndMs - now <= 300000 &&
    scheduledEndMs > now;
  return openPins(pins)
    .filter(
      (p) =>
        !coveredIds.includes(p.id) &&
        (nearEnd ||
          (currentText &&
            p.say
              .toLowerCase()
              .split(/\W+/)
              .filter((w) => w.length > 5)
              .some((w) => currentText.toLowerCase().includes(w)))),
    )
    .map((p) => ({
      cardId: p.id,
      text: p.say,
      reason: nearEnd ? "nearEnd" : "relevantTopic",
    }));
}

export function visibleCards(view: LiveViewState): GuidanceCard[] {
  return view.requestedCard
    ? [...view.cards.slice(0, 2), view.requestedCard]
    : view.cards;
}
