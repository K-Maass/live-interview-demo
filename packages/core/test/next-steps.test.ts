import { expect, test } from "vitest";
import { groundNextSteps } from "../src/nextSteps";
const context = {
  purpose: "Meeting",
  objectives: [],
  conversation: [
    {
      meetingId: "m",
      segmentId: "s",
      revision: 1,
      journalSequence: 1,
      lane: "remote" as const,
      startMs: 0,
      endMs: 1,
      language: "en",
      text: "We have not established an owner yet.",
      kind: "final" as const,
    },
  ],
  sources: [],
  stateRevision: 0,
  indexRevision: 0,
  briefRevision: 0,
  sourceRevisions: {},
  participants: [{ id: "p" as never, name: "Lisa" }],
  attributions: [],
};
test("derived opportunities cannot masquerade as supported commitments or named owners", () => {
  const result = groundNextSteps(
    [
      {
        task: "Prepare an ownership map.",
        inferred: false,
        owner: "Lisa",
        due: "tomorrow",
        evidence: ["segment:s"],
      },
      {
        task: "Who owns launch?",
        inferred: true,
        owner: null,
        due: null,
        evidence: [],
      },
      {
        task: "Lisa will send deployment evidence.",
        inferred: false,
        owner: "Lisa",
        due: null,
        evidence: ["segment:s"],
      },
    ],
    context,
  );
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ inferred: true, owner: null, due: null });
});

const said = (segmentId: string, text: string, extra: Record<string, unknown> = {}) => ({
  ...context.conversation[0],
  segmentId,
  lane: "me" as const,
  text,
  ...extra,
});
const step = (task: string, evidence: string[]) => ({
  task,
  inferred: false,
  owner: null,
  due: null,
  evidence,
});

test("a commitment phrase about something else does not make a step a commitment", () => {
  const ctx = {
    ...context,
    conversation: [
      said("budget", "We will see if budget allows."),
      said("send", "I will send the revised pricing by Friday."),
      said("de", "Ich schicke die überarbeiteten Preise morgen.", { language: "de" }),
      said("de-en", "I will send the revised prices tomorrow.", {
        kind: "translation",
        sourceSegmentId: "de",
      }),
      said("partial", "I will send the revised pricing", { kind: "partial" }),
    ],
  };
  const [loose, real, translated, partial] = groundNextSteps(
    [
      step("Send revised pricing", ["segment:budget"]),
      step("Send revised pricing", ["segment:send"]),
      step("Send revised pricing", ["segment:de"]),
      step("Send revised pricing", ["segment:partial"]),
    ],
    ctx,
  );
  expect(loose.inferred).toBe(true);
  expect(real.inferred).toBe(false);
  // A German commitment counts through the English translation of the same revision.
  expect(translated.inferred).toBe(false);
  // Only a final segment can carry a commitment.
  expect(partial.inferred).toBe(true);
});
