import { describe, expect, test } from "vitest";
import type { SpeechEvent } from "./contracts";
import { assembleTranscripts } from "./transcripts";

/** The implementation before translations were indexed: kept here as the reference the new one must match exactly. */
function referenceAssemble(events: SpeechEvent[]) {
  const sources = new Map<string, SpeechEvent>(),
    translations = new Map<string, SpeechEvent>();
  for (const event of events) {
    const map = event.kind === "translation" ? translations : sources;
    const old = map.get(event.segmentId);
    if (!old || event.revision > old.revision || (event.revision === old.revision && event.journalSequence >= old.journalSequence)) map.set(event.segmentId, event);
  }
  const source = [...sources.values()].filter((e) => e.kind === "final").sort((a, b) => a.startMs - b.startMs);
  const english = source.flatMap((e) => {
    if (e.language === "en") return [e];
    const t = [...translations.values()].find((t) => t.sourceSegmentId === e.segmentId && t.revision === e.revision && t.lane === e.lane && t.language === "en");
    return t ? [t] : [];
  });
  return { source, english, status: english.length === source.length ? ("complete" as const) : ("pending" as const) };
}

/** Small deterministic PRNG (mulberry32), so a failing case is reproducible from its seed. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A messy bilingual meeting: partials, finals, revisions, out-of-order and duplicate journal entries, translations of
 * older revisions, translations on the wrong lane or into German, several translation ids for one line, and orphans.
 */
function generate(seed: number, lines: number): SpeechEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const events: SpeechEvent[] = [];
  let journal = 0;
  for (let i = 0; i < lines; i++) {
    const segmentId = "s" + Math.floor(r() * lines * 0.9); // collisions: the same segment spoken about again
    const lane = pick(["me", "remote"] as const);
    const language = pick(["en", "de", "de", "fr"]);
    const startMs = Math.floor(r() * lines * 3000); // ties and disorder on purpose
    const revisions = 1 + Math.floor(r() * 3);
    for (let revision = 0; revision < revisions; revision++) {
      if (r() < 0.5) events.push({ meetingId: "m", segmentId, revision, journalSequence: journal++, lane, startMs, endMs: startMs + 900, language, text: `partial ${i}.${revision}`, kind: "partial" });
      const final: SpeechEvent = { meetingId: "m", segmentId, revision, journalSequence: r() < 0.1 ? journal - 1 : journal++, lane, startMs, endMs: startMs + 1500, language, text: `final ${i}.${revision}`, kind: "final" };
      events.push(final);
      if (r() < 0.05) events.push({ ...final, text: final.text + " replayed" });
      const translations = r() < 0.15 ? 0 : 1 + Math.floor(r() * 2);
      for (let t = 0; t < translations; t++)
        events.push({ meetingId: "m", segmentId: `t-${segmentId}-${t}-${Math.floor(r() * 2)}`, sourceSegmentId: segmentId, revision: r() < 0.85 ? revision : revision + 1, journalSequence: journal++, lane: r() < 0.9 ? lane : lane === "me" ? "remote" : "me", startMs, endMs: startMs + 1500, language: r() < 0.85 ? "en" : "de", text: `translation ${i}.${revision}.${t}`, kind: "translation" });
    }
    if (r() < 0.02) events.push({ meetingId: "m", segmentId: "orphan" + i, sourceSegmentId: "missing" + i, revision: 0, journalSequence: journal++, lane, startMs, endMs: startMs, language: "en", text: "orphan", kind: "translation" });
  }
  // Late arrivals: some events reach the journal out of order.
  for (let i = events.length - 1; i > 0; i--) if (r() < 0.1) { const j = Math.max(0, i - Math.floor(r() * 5)); [events[i], events[j]] = [events[j], events[i]]; }
  return events;
}

/** A realistic 90-minute bilingual meeting: one source line about every 3.6 s, German lines translated to English. */
function ninetyMinuteMeeting(lines = 1500): SpeechEvent[] {
  const events: SpeechEvent[] = [];
  let journal = 0;
  for (let i = 0; i < lines; i++) {
    const lane = i % 2 ? "remote" : "me";
    const language = i % 3 === 0 ? "en" : "de";
    const startMs = i * 3600;
    events.push({ meetingId: "m", segmentId: "s" + i, revision: 0, journalSequence: journal++, lane, startMs, endMs: startMs + 3000, language, text: "line " + i, kind: "final" });
    if (language !== "en") events.push({ meetingId: "m", segmentId: "t" + i, sourceSegmentId: "s" + i, revision: 0, journalSequence: journal++, lane, startMs, endMs: startMs + 3000, language: "en", text: "translated " + i, kind: "translation" });
  }
  return events;
}

/** Counts every property read on the translation events: the work done matching translations to lines. */
function countingReads(events: SpeechEvent[]) {
  const counter = { reads: 0 };
  const wrapped = events.map((event) => event.kind !== "translation" ? event : new Proxy(event, { get(target, key, receiver) { counter.reads++; return Reflect.get(target, key, receiver); } }));
  return { wrapped, counter };
}

describe("assembleTranscripts with indexed translations", () => {
  test("matches the previous implementation exactly on 300 generated meetings (revisions, EN/DE/FR, disorder)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const events = generate(seed, 5 + (seed % 60));
      const actual = assembleTranscripts(events), expected = referenceAssemble(events);
      expect(actual.status, `seed ${seed}`).toBe(expected.status);
      // Same objects in the same order: identity, not just equal text.
      expect(actual.source.length, `seed ${seed}`).toBe(expected.source.length);
      actual.source.forEach((e, i) => expect(e, `seed ${seed} source ${i}`).toBe(expected.source[i]));
      expect(actual.english.length, `seed ${seed}`).toBe(expected.english.length);
      actual.english.forEach((e, i) => expect(e, `seed ${seed} english ${i}`).toBe(expected.english[i]));
    }
  });
  test("matches on a long meeting too", () => {
    const events = generate(4242, 1500);
    expect(assembleTranscripts(events)).toEqual(referenceAssemble(events));
  });
  test("work grows linearly with the meeting (property reads on translations), where it used to grow quadratically", () => {
    const reads = (impl: typeof assembleTranscripts, lines: number) => { const { wrapped, counter } = countingReads(ninetyMinuteMeeting(lines)); impl(wrapped); return counter.reads; };
    const now = [375, 750, 1500].map((n) => reads(assembleTranscripts, n));
    const before = [375, 750, 1500].map((n) => reads(referenceAssemble, n));
    // Doubling the meeting doubles the work now (allow slack for constant terms)...
    expect(now[2] / now[1]).toBeLessThan(2.2);
    expect(now[1] / now[0]).toBeLessThan(2.2);
    // ...where the previous implementation roughly quadrupled it.
    expect(before[2] / before[1]).toBeGreaterThan(3.5);
    // A 90-minute meeting (1,500 lines, 1,000 translations) does a small multiple of its size in reads.
    expect(now[2]).toBeLessThan(20 * 1500);
    console.info(`[transcript-perf] translation property reads for 375/750/1500 lines: before ${before.join("/")}, now ${now.join("/")}`);
  });
});
