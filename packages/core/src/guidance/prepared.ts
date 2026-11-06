import type {
  AssistanceIntent,
  GuidanceCard,
  HotkeyContext,
  ModelJob,
  ModelResult,
  SpeechEvent,
} from "../contracts";
import { basisCompatibility } from "../snapshots";
import { cardsFromResult, selectCandidate } from "./engine";

/**
 * Local and bounded: candidates are never embedded in their own ready snapshots. One entry per intent
 * (the newest preparation wins). A hotkey may use an entry whose basis is append-only compatible with
 * the current read (see `basisCompatibility`): the card keeps the basis it was written against, and
 * `asOfMs` marks when that was if newer turns have arrived since.
 */
export class PreparedGuidanceCache {
  private entries: {
    cards: GuidanceCard[];
    intent: AssistanceIntent;
    lane: ModelJob["lane"];
    expiresAtMs: number;
  }[] = [];
  constructor(
    private ttlMs = 120_000,
    private capacity = 5,
  ) {}

  store(
    job: ModelJob,
    result: ModelResult,
    startedAtMs: number,
    now = Date.now(),
  ): boolean {
    const cards = cardsFromResult(result, job);
    if (!cards.length) return false;
    for (const card of cards)
      card.preparedFrom = {
        jobId: job.id,
        provider: result.provider,
        model: result.model,
        startedAtMs,
        preparedAtMs: now,
        snapshotId: job.basis.snapshot.snapshotId,
        snapshotCreatedAtMs: job.basis.snapshot.createdAtMs,
        observationSequence: job.basis.observationSequence,
        stateRevision: job.basis.stateRevision,
        profileId: job.basis.profileId,
        profileRevision: job.basis.profileRevision,
        indexRevision: job.basis.snapshot.context.indexRevision,
        briefRevision: job.basis.snapshot.context.briefRevision,
        sourceRevisions: structuredClone(
          job.basis.snapshot.context.sourceRevisions,
        ),
      };
    this.entries = this.entries.filter(
      (entry) => entry.expiresAtMs > now && entry.intent !== job.intent,
    );
    this.entries.push({
      cards,
      intent: job.intent,
      lane: job.lane,
      expiresAtMs: now + this.ttlMs,
    });
    this.entries = this.entries.slice(-this.capacity);
    return true;
  }

  /** The lane the stored card for `intent` was prepared on, if there is one. */
  laneOf(intent: AssistanceIntent): ModelJob["lane"] | undefined {
    return this.entries.find((e) => e.intent === intent)?.lane;
  }

  select(
    intent: AssistanceIntent,
    basis: HotkeyContext,
    trigger: "requested" | "automatic",
    recent: string[] = [],
    now = Date.now(),
    /** The meeting's full transcript, so a revised cited turn outside the window still counts. */
    segments?: readonly SpeechEvent[],
  ): GuidanceCard | undefined {
    this.entries = this.entries.filter((entry) => entry.expiresAtMs > now);
    const entry = this.entries.find((e) => e.intent === intent);
    if (!entry) return;
    const fits = entry.cards
      .map((card) => ({
        card,
        fit: basisCompatibility(card.basis, basis, card.evidence, segments),
      }))
      .filter(({ fit }) => fit.compatible);
    // Ranked as if written now (selectCandidate compares revisions with the hotkey's basis), then
    // returned with the basis it was really written against, so its evidence still resolves.
    const ranked: GuidanceCard[] = fits.map(({ card }) => ({
      ...structuredClone(card),
      basis: structuredClone(basis),
      trigger,
      origin: "cache" as const,
    }));
    const selected = selectCandidate(ranked, basis, trigger, recent);
    if (!selected) return;
    const { card, fit } = fits[ranked.indexOf(selected)];
    return {
      ...selected,
      basis: structuredClone(card.basis),
      ...(fit.appended.length && card.preparedFrom
        ? { asOfMs: card.preparedFrom.startedAtMs }
        : {}),
      id: crypto.randomUUID(),
      createdAtMs: now,
    };
  }

  clear() {
    this.entries = [];
  }
}
