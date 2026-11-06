import { expect, test } from "vitest";
import {
  selectCandidate,
  makeClarification,
  createGuidanceJob,
  guidancePrompt,
  focusBlock,
  parseCard,
  evidenceIdPattern,
} from "../src/guidance/engine";
import { effectiveContext } from "../src/snapshots";
// @ts-expect-error -- the service module is untyped JavaScript; the test checks it at runtime.
import { validateSchema } from "../../../apps/service/src/validation.mjs";
import { createMeetingState, SnapshotStore } from "../src/snapshots";
import type { GuidanceCard } from "../src/contracts";
import { productEvidenceSources, productSegmentIds } from "./fixtures/evidenceIds";
const state = createMeetingState({
  id: "m",
  workspaceId: "w",
  purpose: "approval interview",
  objectives: ["Who approves?"],
  attendees: [],
  profileId: "interview",
  profileRevision: 0,
});
const store = new SnapshotStore();
store.initialise(state);
const basis = store.read(state);
const card = (
  id: string,
  score: number,
  novelty: number = 0,
): GuidanceCard => ({
  id,
  intent: "contribute",
  say: id,
  why: "Connects decision authority to required evidence",
  evidence: [],
  createdAtMs: 0,
  basis,
  pinned: false,
  stale: false,
  usefulness: score,
  relevance: score,
  novelty,
  answerQuality: score,
  uncertain: true,
});
test("requested always best available; automatic rejects weak or repeated suggestions", () => {
  const low = card("low", 0.3);
  expect(selectCandidate([low], basis, "requested", [])).toEqual(low);
  expect(selectCandidate([low], basis, "automatic", [])).toBeUndefined();
  expect(
    selectCandidate(
      [card("repeat", 0.99)],
      { ...basis, profileId: "workClient" },
      "automatic",
      ["repeat"],
    ),
  ).toBeUndefined();
  expect(makeClarification("respond", basis).say.length).toBeGreaterThan(10);
});
test("contribute favors useful non-obvious connections; respond favors best answer irrespective of novelty", () => {
  const generic = card("generic", 0.9, 0),
    insight = card("insight", 0.85, 1);
  expect(selectCandidate([generic, insight], basis, "requested", [])?.id).toBe(
    "insight",
  );
  generic.intent = "respond";
  insight.intent = "respond";
  expect(selectCandidate([generic, insight], basis, "requested", [])?.id).toBe(
    "generic",
  );
});
test("profile filters automatic intents but leaves requested intent available", () => {
  const response = { ...card("answer", 0.95), intent: "respond" as const };
  expect(selectCandidate([response], basis, "automatic", [])).toBeUndefined();
  expect(
    selectCandidate(
      [response],
      { ...basis, profileId: "presentationAnswering" },
      "automatic",
      [],
    )?.id,
  ).toBe("answer");
  expect(selectCandidate([response], basis, "requested", [])?.id).toBe(
    "answer",
  );
});
import { requestGuidance } from "../src/guidance/engine";
test("requested guidance cannot hang behind a stalled provider; returns contextual fallback", async () => {
  const iterator = requestGuidance(
    "respond",
    basis,
    "requested",
    { run: () => new Promise(() => {}) },
    [],
    20,
  )[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value?.kind).toBe("failure");
  const second = await iterator.next();
  expect(second.value?.kind).toBe("card");
  if (second.value?.kind === "card")
    expect(second.value.card.uncertain).toBe(true);
  await iterator.return?.();
});
test("native JSON key ordering preserves the same basis and job correlation", async () => {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sorted(x)]),
      );
    return v;
  }
  const events = [];
  for await (const event of requestGuidance("respond", basis, "requested", {
    run: async (job) => ({
      jobId: job.id,
      provider: "ibmLuna",
      model: "luna",
      outcome: "complete",
      basis: sorted(JSON.parse(JSON.stringify(job.basis))) as typeof basis,
      output: {
        headline: "Decision and evidence",
        say: "A useful grounded answer.",
        why: "Relevant to the decision.",
        evidence: [],
        usefulness: 0.9,
        relevance: 0.9,
        novelty: 0,
        answerQuality: 0.9,
        uncertain: true,
      },
    }),
  }))
    events.push(event);
  expect(
    events.some(
      (e) => e.kind === "card" && e.card.say === "A useful grounded answer.",
    ),
  ).toBe(true);
});
test("the schema cites by a stable pattern, and only the available evidence IDs survive parsing", async () => {
  const evidenceBasis = structuredClone(basis);
  evidenceBasis.snapshot.context.conversation = [
    {
      meetingId: "m",
      segmentId: "actual",
      revision: 1,
      journalSequence: 1,
      lane: "remote",
      startMs: 0,
      endMs: 1000,
      kind: "final",
      language: "en",
      text: "An observation",
    },
  ];
  let schema: any;
  for await (const _event of requestGuidance(
    "respond",
    evidenceBasis,
    "requested",
    {
      run: async (job) => {
        schema = job.outputSchema;
        return {
          jobId: job.id,
          provider: "ibmLuna",
          model: "luna",
          basis: job.basis,
          outcome: "failure",
          output: null,
        };
      },
    },
  )) {
    /* drain */
  }
  // No per-segment enum: the schema is the same for every transcript segment (prompt caching).
  expect(schema.properties.evidence.items).toEqual({ type: "string", pattern: evidenceIdPattern });
  expect(() => validateSchema(schema)).not.toThrow();
  const job = createGuidanceJob("respond", evidenceBasis, "requested");
  const output = (evidence: string[]) => ({
    headline: "Answer it",
    say: "An answer.",
    why: "Grounded.",
    evidence,
    usefulness: 0.9,
    relevance: 0.9,
    novelty: 0.5,
    answerQuality: 0.9,
    uncertain: true,
  });
  expect(parseCard(output(["segment:actual"]), job)?.evidence).toEqual(["segment:actual"]);
  expect(parseCard(output(["actual"]), job)?.evidence).toEqual(["segment:actual"]);
  // An unknown ID is dropped, and the card is then an inference.
  expect(parseCard(output(["segment:invented"]), job)).toMatchObject({ evidence: [], uncertain: true });
  // The service accepts this pattern and no other (a client-chosen pattern would be a ReDoS surface).
  const other = structuredClone(schema);
  other.properties.evidence.items.pattern = "^(a+)+$";
  expect(() => validateSchema(other)).toThrow();
});
test("late model result refines the immediate clarification on the exact dispatched basis", async () => {
  const events = [];
  let dispatched: import("../src/contracts").ModelJob | undefined;
  for await (const event of requestGuidance(
    "respond",
    basis,
    "requested",
    {
      run: async (job) => {
        dispatched = job;
        await new Promise((r) => setTimeout(r, 30));
        return {
          jobId: job.id,
          provider: "ibmLuna",
          model: "luna",
          outcome: "complete",
          basis: job.basis,
          output: {
            headline: "Decision and evidence",
            say: "Approval and evidence ownership may be different decisions.",
            why: "Clarify the distinction before assigning authority.",
            evidence: [],
            usefulness: 0.9,
            relevance: 0.9,
            novelty: 0.5,
            answerQuality: 0.9,
            uncertain: true,
          },
        };
      },
    },
    [],
    5,
  ))
    events.push(event);
  const initial = events.find((e) => e.kind === "card");
  const refined = events.find((e) => e.kind === "refinement");
  expect(refined).toBeDefined();
  if (refined?.kind === "refinement" && initial?.kind === "card") {
    expect(refined.refinesCardId).toBe(initial.card.id);
    expect(refined.card.basis).toEqual(dispatched?.basis);
  }
});
test("an unusable late answer settles the provisional clarification", async () => {
  const events = [];
  for await (const event of requestGuidance(
    "respond",
    basis,
    "requested",
    {
      run: async (job) => {
        await new Promise((r) => setTimeout(r, 15));
        return {
          jobId: job.id,
          provider: "ibmLuna",
          model: "luna",
          outcome: "complete",
          basis: job.basis,
          output: { say: "Malformed" },
        };
      },
    },
    [],
    1,
  ))
    events.push(event);
  const initial = events.find((e) => e.kind === "card");
  const final = events.find((e) => e.kind === "refinement");
  expect(final).toBeDefined();
  if (initial?.kind === "card" && final?.kind === "refinement") {
    expect(final.refinesCardId).toBe(initial.card.id);
    expect(final.card.provisional).toBe(false);
    expect(final.card.origin).toBe("clarification");
  }
});

test.each(["failure", "malformed", "slow"])(
  "%s refinement preserves useful existing guidance",
  async (outcome) => {
    const events = [];
    for await (const event of requestGuidance(
      "respond",
      basis,
      "requested",
      {
        run: async (job) => {
          if (outcome === "slow") await new Promise((r) => setTimeout(r, 20));
          return {
            jobId: job.id,
            provider: "ibmLuna",
            model: "luna",
            basis: job.basis,
            outcome: outcome === "failure" ? "failure" : "complete",
            output:
              outcome === "malformed"
                ? {}
                : {
                    headline: "Decision and evidence",
                    say: "A fresh grounded answer.",
                    why: "Current evidence.",
                    evidence: [],
                    usefulness: 0.8,
                    relevance: 0.8,
                    novelty: 0.4,
                    answerQuality: 0.9,
                    uncertain: true,
                  },
          };
        },
      },
      [],
      1,
      { refinesCardId: "useful-prepared", preserveExisting: true },
    ))
      events.push(event);
    expect(
      events.filter(
        (e) =>
          (e.kind === "card" || e.kind === "refinement") &&
          e.card.origin === "clarification",
      ),
    ).toEqual([]);
    if (outcome === "slow")
      expect(events.find((e) => e.kind === "refinement")).toMatchObject({
        refinesCardId: "useful-prepared",
        card: { say: "A fresh grounded answer." },
      });
  },
);

test("the guidance prompt addresses the user generically and carries no personal-edition names", () => {
  for (const intent of ["digDeeper", "respond", "contribute", "checkConversation", "checkObjectives"] as const) {
    const prompt = guidancePrompt(createGuidanceJob(intent, basis, "requested"));
    expect(prompt, intent).toContain("You assist the user in a professional meeting.");
    expect(prompt, intent).not.toMatch(/\b(?:karim|jev|ibm|codex|luna)\b/i);
  }
});

const speech = (segmentId: string, lane: "me" | "remote", text: string, startMs: number, extra: Record<string, unknown> = {}) => ({
  meetingId: "m", segmentId, revision: 0, journalSequence: startMs, lane, startMs, endMs: startMs + 1, language: "en", text, kind: "final" as const, ...extra,
});
const withTurns = {
  ...basis,
  snapshot: { ...basis.snapshot, context: { ...basis.snapshot.context, conversation: [
    speech("t1", "me", "How long does approval take?", 1),
    speech("t2", "remote", "Usually about a day.", 2),
    speech("t3", "remote", "Two invoices waited a week?", 3),
  ] } },
  // Arrives after the snapshot, in German with its English translation, plus a partial that is not final.
  transcriptDeltas: [
    speech("t4", "remote", "Die meisten liegen über dem Limit.", 4, { language: "de" }),
    speech("t4-en", "remote", "Most are above the limit.", 4, { kind: "translation", sourceSegmentId: "t4" }),
    speech("t5", "remote", "Also", 5, { kind: "partial" }),
  ],
};

test("digDeeper sees the newest final turns in English and only the user's own earlier questions", () => {
  const block = focusBlock(effectiveContext(withTurns));
  const newest = JSON.parse(block.match(/Newest turns, oldest first: (\[.*?\])\./)![1]);
  expect(newest).toEqual(["remote: Usually about a day.", "remote: Two invoices waited a week?", "remote: Most are above the limit."]);
  const asked = JSON.parse(block.match(/already asked: (\[.*?\])\./)![1]);
  // A remote question is not something the user asked.
  expect(asked).toEqual(["me: How long does approval take?"]);
});

test("the digDeeper rules reach the digDeeper prompt, for the hotkey and for preparation", () => {
  for (const preparation of [false, true]) {
    const prompt = guidancePrompt(createGuidanceJob("digDeeper", withTurns, "requested", { preparation }));
    expect(prompt).toContain("First write gap: the single unresolved tension");
    expect(prompt).toContain("Newest turns, oldest first");
    expect(prompt).toContain("Background lens, not a checklist");
    expect(prompt).not.toContain("causal measurement");
  }
  for (const intent of ["respond", "contribute", "checkConversation", "checkObjectives"] as const) {
    const prompt = guidancePrompt(createGuidanceJob(intent, withTurns, "requested"));
    expect(prompt, intent).toContain("Relevant procedure, a background lens");
    expect(prompt, intent).not.toContain("Newest turns");
  }
});

test("only digDeeper asks for the gap, first, and the service accepts both of its schemas", () => {
  const hotkey = createGuidanceJob("digDeeper", basis, "requested").outputSchema as { properties: Record<string, unknown>; required: string[] };
  expect(Object.keys(hotkey.properties)[0]).toBe("gap");
  expect(hotkey.required).toContain("gap");
  const prepared = createGuidanceJob("digDeeper", basis, "requested", { preparation: true }).outputSchema as { properties: { candidates: { items: { properties: Record<string, unknown> } } } };
  expect(Object.keys(prepared.properties.candidates.items.properties)[0]).toBe("gap");
  for (const intent of ["respond", "contribute", "checkConversation", "checkObjectives"] as const)
    expect((createGuidanceJob(intent, basis, "requested").outputSchema as { properties: object }).properties, intent).not.toHaveProperty("gap");
  for (const schema of [hotkey, prepared]) expect(() => validateSchema(schema)).not.toThrow();
});

test("the gap is a thinking step, never part of the card", () => {
  const job = createGuidanceJob("digDeeper", basis, "requested");
  const parsed = parseCard({ gap: "a day vs a week", headline: "Test the delay", say: "Which invoices took a week?", why: "Tests the gap.", evidence: [], usefulness: 0.8, relevance: 0.8, novelty: 0.8, answerQuality: 0.8, uncertain: false }, job);
  expect(parsed?.say).toBe("Which invoices took a week?");
  expect(parsed).not.toHaveProperty("gap");
});

test("digDeeper ignores a translation of an older revision of a corrected turn", () => {
  const corrected = {
    ...withTurns,
    transcriptDeltas: [
      speech("t4", "remote", "Die meisten liegen unter dem Limit.", 4, { language: "de", revision: 2 }),
      // Still translates revision 1, which said the opposite.
      speech("t4-en", "remote", "Most are above the limit.", 4, { kind: "translation", sourceSegmentId: "t4", revision: 1 }),
    ],
  };
  const block = focusBlock(effectiveContext(corrected));
  const newest = JSON.parse(block.match(/Newest turns, oldest first: (\[.*?\])\./)![1]);
  expect(newest.at(-1)).toBe("remote: Die meisten liegen unter dem Limit.");
  const fresh = structuredClone(corrected);
  fresh.transcriptDeltas[1] = speech("t4-en", "remote", "Most are below the limit.", 4, { kind: "translation", sourceSegmentId: "t4", revision: 2 });
  const updated = JSON.parse(focusBlock(effectiveContext(fresh)).match(/Newest turns, oldest first: (\[.*?\])\./)![1]);
  expect(updated.at(-1)).toBe("remote: Most are below the limit.");
});

test("the checkObjectives fallback names the first objective not yet covered", () => {
  const captured = structuredClone(basis);
  captured.snapshot.context.objectives = ["Who approves?", "What is the budget?"];
  captured.snapshot.context.coveredObjectives = ["Who approves?"];
  expect(makeClarification("checkObjectives", captured).say).toBe(
    "We still need to establish: What is the budget?.",
  );
  captured.snapshot.context.coveredObjectives = ["Who approves?", "What is the budget?"];
  expect(makeClarification("checkObjectives", captured).say).toBe(
    "Which objective remains unanswered, and what would count as a useful answer?",
  );
});

const webBasis = () => {
  const b = structuredClone(basis);
  b.snapshot.context.conversation = [
    { meetingId: "m", segmentId: "actual", revision: 1, journalSequence: 1, lane: "remote", startMs: 0, endMs: 1000, kind: "final", language: "en", text: "Approval needs a SOC 2 report." },
  ];
  b.snapshot.context.sources = [
    { sourceId: `web:w:https://example.org/${"standards/".repeat(150)}soc2`, workspaceId: "w", kind: "web", title: "SOC 2", text: "A SOC 2 report covers controls.", locator: "https://example.org", revision: 1, derived: false },
  ];
  return b;
};
const cardOutput = (evidence: unknown[]) => ({
  headline: "Ask for the report",
  say: "Could you share the SOC 2 report?",
  why: "Approval needs it.",
  evidence,
  usefulness: 0.9,
  relevance: 0.9,
  novelty: 0.5,
  answerQuality: 0.9,
  uncertain: false,
});

test("a long public-research source ID (web:workspace:url) fits the evidence pattern on both sides", () => {
  const b = webBasis();
  const id = b.snapshot.context.sources[0].sourceId;
  expect(id.length).toBeGreaterThan(1000);
  const job = createGuidanceJob("respond", b, "requested");
  expect(new RegExp(evidenceIdPattern, "u").test(id)).toBe(true);
  const validate = validateSchema(job.outputSchema);
  expect(validate(cardOutput([id, "segment:actual"]))).toBe(true);
  expect(parseCard(cardOutput([id, "segment:actual"]), job)?.evidence).toEqual([id, "segment:actual"]);
  expect(new RegExp(evidenceIdPattern, "u").test("x".repeat(2049))).toBe(false);
});

test("unknown evidence IDs are dropped and the card becomes an inference; named claims still need support", () => {
  const job = createGuidanceJob("respond", webBasis(), "requested");
  const partly = parseCard(cardOutput(["segment:actual", "segment:invented", 42]), job);
  expect(partly?.evidence).toEqual(["segment:actual"]);
  expect(partly?.uncertain).toBe(true);
  const none = parseCard(cardOutput(["segment:invented"]), job);
  expect(none?.evidence).toEqual([]);
  expect(none?.uncertain).toBe(true);
  // All IDs known: the card keeps its own (verified) flag.
  expect(parseCard(cardOutput(["segment:actual"]), job)?.uncertain).toBe(false);
  // A claim about what a named person said is still rejected when no remaining evidence supports it.
  expect(
    parseCard({ ...cardOutput(["segment:invented"]), say: "Dana confirmed the SOC 2 report is ready." }, job),
  ).toBeUndefined();
});

const productBasis = () => {
  const b = structuredClone(basis);
  b.snapshot.context.conversation = productSegmentIds.map((segmentId, n) => ({
    meetingId: "m", segmentId, revision: 1, journalSequence: n + 1, lane: "remote" as const,
    startMs: n * 1000, endMs: n * 1000 + 900, kind: n ? "translation" as const : "final" as const,
    language: n ? "en" : "de", text: n ? "Approval needs a SOC 2 report." : "Die Freigabe braucht einen SOC-2-Bericht.",
  }));
  b.snapshot.context.sources = productEvidenceSources.map((sourceId) => ({
    sourceId, workspaceId: "workspace-1", kind: sourceId.startsWith("web:") ? "web" : "workspace",
    title: "SOC 2", text: "A SOC 2 report covers controls.", locator: "plan.md", revision: 1, derived: false,
  }));
  return b;
};

test("every evidence-ID form the context builder emits passes the schema pattern and parseCard", () => {
  const b = productBasis();
  const ids = [...productEvidenceSources, ...productSegmentIds.map((s) => `segment:${s}`)];
  for (const id of ids) expect(new RegExp(evidenceIdPattern, "u").test(id), id).toBe(true);
  for (const intent of ["respond", "digDeeper", "checkConversation"] as const) {
    const job = createGuidanceJob(intent, b, "requested");
    const validate = validateSchema(job.outputSchema);
    const output = { ...cardOutput(ids), ...(intent === "digDeeper" ? { gap: "Report owner." } : {}) };
    expect(validate(output), `${intent}: ${JSON.stringify(validate.errors)}`).toBe(true);
    expect(parseCard(output, job)?.evidence).toEqual(ids);
  }
});

test("the context builder drops a source ID over the cap, so the job still validates", async () => {
  const { buildContext, maxSourceIdLength } = await import("../src/snapshots");
  // @ts-expect-error -- untyped JavaScript, checked at runtime.
  const { validateContext } = await import("../../../apps/service/src/validation.mjs");
  const prefix = "web:workspace-1:https://example.com/?u=";
  const hit = (sourceId: string) => ({
    sourceId, workspaceId: "workspace-1", kind: "web", title: "t", text: "x", locator: "https://example.com/", revision: 1, derived: false,
  });
  const atCap = prefix + "a".repeat(maxSourceIdLength - prefix.length);
  const over = atCap + "a";
  const context = buildContext(state, [hit(atCap), hit(over)]);
  expect(context.sources.map((s) => s.sourceId)).toEqual([atCap]);
  expect(Object.keys(context.sourceRevisions)).toEqual([atCap]);
  expect(() => validateContext(JSON.parse(JSON.stringify(context)))).not.toThrow();
  expect(() => validateContext({ ...context, sources: [hit(over)] })).toThrow();
  expect(new RegExp(evidenceIdPattern, "u").test(atCap)).toBe(true);
});

import { guidanceLane } from "../src/guidance/engine";
test("a requested digDeeper is deep except on Standard, where it is fast; reviews stay deep", () => {
  expect(guidanceLane("digDeeper", "requested")).toBe("deep");
  expect(guidanceLane("digDeeper", "requested", "premium")).toBe("deep");
  expect(guidanceLane("digDeeper", "requested", "standard")).toBe("fast");
  expect(guidanceLane("digDeeper", "automatic", "premium")).toBe("fast");
  expect(guidanceLane("checkConversation", "requested", "standard")).toBe("deep");
  expect(guidanceLane("respond", "requested", "premium")).toBe("fast");
});
test("a fast-lane digDeeper asks for the fast lane and waits only the fast soft budget", async () => {
  const lanes: string[] = [];
  let resolveRun: (() => void) | undefined;
  const started = Date.now();
  const events = [];
  for await (const event of requestGuidance(
    "digDeeper",
    basis,
    "requested",
    {
      run: (job) => {
        lanes.push(job.lane);
        // Slower than the fast soft budget, faster than the deep one.
        return new Promise((resolve) => {
          resolveRun = () => resolve({ jobId: job.id, basis: job.basis, outcome: "failed", provider: "managedFast", model: "m" } as never);
          setTimeout(resolveRun, 2600);
        });
      },
    },
    [],
    undefined,
    undefined,
    undefined,
    "fast",
  )) {
    events.push({ event, at: Date.now() - started });
    if (events.length === 1) break;
  }
  expect(lanes).toEqual(["fast"]);
  // The provisional clarification arrives at the fast budget (1.8 s), not after the deep 4.5 s.
  expect(events[0].event.kind).toBe("failure");
  expect(events[0].at).toBeLessThan(2500);
}, 10000);
