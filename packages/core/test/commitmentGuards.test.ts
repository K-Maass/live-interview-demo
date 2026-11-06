import { describe, expect, test } from "vitest";
import { groundNextSteps } from "../src/nextSteps";
import type { ContextBundle, SpeechEvent } from "../src/contracts";

const event = (over: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "me",
  startMs: 0,
  endMs: 1,
  language: "en",
  text: "",
  kind: "final",
  ...over,
});
const context = (conversation: SpeechEvent[]): ContextBundle => ({
  purpose: "Meeting",
  objectives: [],
  conversation,
  sources: [],
  stateRevision: 0,
  indexRevision: 0,
  briefRevision: 0,
  sourceRevisions: {},
  participants: [],
  attributions: [],
});
/** Whether a step the model calls explicit stays explicit after grounding against one spoken turn. */
const explicit = (text: string, task: string, language = "en") => {
  const [step] = groundNextSteps(
    [{ task, inferred: false, owner: null, due: null, evidence: ["segment:s"] }],
    context([event({ text, language })]),
  );
  return !step.inferred;
};

describe("a hedge, condition or refusal never makes a step a commitment", () => {
  test.each([
    // English: hedges and conditions
    ["We will see if the budget allows it.", "Confirm the budget allows the pilot"],
    ["We will see whether the budget allows the pilot.", "Confirm the budget allows the pilot"],
    ["I will maybe send the contract next week.", "Send the contract"],
    ["I will probably send the contract on Friday.", "Send the contract"],
    ["We will send the contract if legal approves it.", "Send the contract"],
    ["If legal approves, we will send the contract.", "Send the contract"],
    ["Maybe I will send the contract tomorrow.", "Send the contract"],
    ["I will try to send the contract, but no promises.", "Send the contract"],
    ["I will send the contract unless finance objects.", "Send the contract"],
    // English: refusals and negations
    ["I will not send the contract this week.", "Send the contract"],
    ["We will never send the contract without a signature.", "Send the contract"],
    ["We have not agreed to the revised pricing.", "Agree to the revised pricing"],
    ["We never agreed to the revised pricing.", "Agree to the revised pricing"],
    ["We will not commit to the rollout date.", "Commit to the rollout date"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(false));

  test.each([
    // German: hedges and conditions
    ["Wir werden sehen, ob das Budget den Pilot erlaubt.", "Confirm the budget allows the pilot"],
    ["Ich schicke den Vertrag vielleicht morgen.", "Send the contract (Vertrag)"],
    ["Ich schicke den Vertrag eventuell nächste Woche.", "Send the contract (Vertrag)"],
    ["Ich werde den Vertrag schicken, wenn die Rechtsabteilung zustimmt.", "Send the contract (Vertrag)"],
    ["Falls das Budget reicht, schicke ich den Vertrag.", "Send the contract (Vertrag)"],
    ["Mal sehen, ich schicke den Vertrag dann.", "Send the contract (Vertrag)"],
    ["Ich werde den Vertrag wahrscheinlich morgen schicken.", "Send the contract (Vertrag)"],
    // German: refusals and negations
    ["Ich schicke den Vertrag nicht diese Woche.", "Send the contract (Vertrag)"],
    ["Wir werden keinen Vertrag schicken.", "Send the contract (Vertrag)"],
    ["Ich werde den Vertrag nie ohne Unterschrift schicken.", "Send the contract (Vertrag)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(false));
});

describe("plain commitments stay explicit", () => {
  test.each([
    ["I will send the revised pricing by Friday.", "Send revised pricing"],
    ["We will send the contract on Monday.", "Send the contract"],
    ["I promise to send the contract today.", "Send the contract"],
    ["We agreed to the revised pricing.", "Agree to the revised pricing"],
    // A negation or condition in another sentence does not touch this one.
    ["I don't know the budget yet. I will send the contract today.", "Send the contract"],
    ["If you have questions, ask Lisa. I will send the contract today.", "Send the contract"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(true));

  test.each([
    ["Ich schicke die überarbeiteten Preise morgen.", "Send revised pricing (Preise)"],
    ["Ich werde den Vertrag am Montag schicken.", "Send the contract (Vertrag)"],
    ["Wir werden den Vertrag heute schicken.", "Send the contract (Vertrag)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(true));
});

test("a hedge in the source language wins over a confident translation", () => {
  const ctx = context([
    event({ segmentId: "de", language: "de", text: "Ich schicke den Vertrag vielleicht morgen." }),
    // A lossy translation dropped "vielleicht".
    event({ segmentId: "de-en", kind: "translation", sourceSegmentId: "de", text: "I will send the contract tomorrow." }),
  ]);
  const [step] = groundNextSteps(
    [{ task: "Send the contract", inferred: false, owner: null, due: null, evidence: ["segment:de"] }],
    ctx,
  );
  expect(step.inferred).toBe(true);
});

describe("deadline idioms and later clauses are not refusals", () => {
  test.each([
    ["I will send the report no later than Friday.", "Send the report"],
    ["I will send the report not later than Friday.", "Send the report"],
    ["I will send the report with no delay.", "Send the report"],
    ["I will send the report and I won't forget.", "Send the report"],
    ["We will send the report not before Monday.", "Send the report"],
    ["I will send the report no matter what.", "Send the report"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(true));

  test.each([
    ["Ich schicke den Bericht nicht später als Freitag.", "Send the report (Bericht)"],
    ["Ich schicke den Bericht spätestens Freitag.", "Send the report (Bericht)"],
    ["Ich werde den Bericht nicht später als Freitag schicken.", "Send the report (Bericht)"],
    ["Ich schicke den Bericht und vergesse es nicht.", "Send the report (Bericht)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(true));
});

describe("a refusal tied to the commitment verb still blocks it", () => {
  test.each([
    ["I will not send the report.", "Send the report"],
    ["I won't send the report.", "Send the report"],
    ["We shall not send the report.", "Send the report"],
    ["I will never send the report.", "Send the report"],
    ["I will send no report this week.", "Send the report"],
    ["I promise not to send the report.", "Send the report"],
    ["I'll not send the report.", "Send the report"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(false));

  test.each([
    ["Ich werde den Bericht nicht schicken.", "Send the report (Bericht)"],
    ["Ich werde nicht den Bericht schicken.", "Send the report (Bericht)"],
    ["Ich schicke keinen Bericht.", "Send the report (Bericht)"],
    ["Den Bericht schicke ich nicht.", "Send the report (Bericht)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(false));
});

describe("more conditions and hedges keep a step inferred", () => {
  test.each([
    ["Once the data is in, I will send the report.", "Send the report"],
    ["I will send the report subject to approval.", "Send the report"],
    ["I will send the report pending approval.", "Send the report"],
    ["I will send the report whenever you like.", "Send the report"],
    ["I will send the report, provided legal signs off.", "Send the report"],
    ["Assuming the numbers hold, I will send the report.", "Send the report"],
    ["Should legal approve, I will send the report.", "Send the report"],
    ["I think I will send the report tomorrow.", "Send the report"],
    ["I'll send the report if the budget allows.", "Send the report"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(false));

  test.each([
    ["Sobald die Daten da sind, schicke ich den Bericht.", "Send the report (Bericht)"],
    ["Ich schicke den Bericht vorbehaltlich der Freigabe.", "Send the report (Bericht)"],
    ["Ich sollte den Bericht morgen schicken, ich werde den Bericht schicken.", "Send the report (Bericht)"],
    ["Es hängt davon ab, aber ich schicke den Bericht.", "Send the report (Bericht)"],
    ["Ich denke, ich schicke den Bericht morgen.", "Send the report (Bericht)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(false));
});

describe("times, ellipses and contracted or verb-second commitments", () => {
  test.each([
    ["I will send the report at 3.30 pm tomorrow.", "Send the report"],
    ["Well... I will send the report today.", "Send the report"],
    ["I'll send the report today.", "Send the report"],
    ["We’ll send the report today.", "Send the report"],
    ["We'll send the report at 3.30 pm. If you need more, ask.", "Send the report"],
  ])("en: %s", (text, task) => expect(explicit(text, task)).toBe(true));

  test.each([
    ["Morgen schicke ich den Bericht.", "Send the report (Bericht)"],
    ["Den Bericht schicke ich um 15.30 Uhr.", "Send the report (Bericht)"],
    ["Das machen wir, den Bericht machen wir morgen.", "Prepare the report (Bericht)"],
    ["Den Bericht übernehme ich.", "Take over the report (Bericht)"],
  ])("de: %s", (text, task) => expect(explicit(text, task, "de")).toBe(true));

  test("a hedge across a time with a dot still counts", () => {
    expect(explicit("If legal agrees by 3.30 pm, I will send the report.", "Send the report")).toBe(false);
    expect(explicit("Maybe... I will send the report.", "Send the report")).toBe(false);
  });
});

test("a step attributed to an unmentioned named source stays inferred but is kept", () => {
  const steps = groundNextSteps(
    [{ task: "According to Salesforce, send the report", inferred: false, owner: null, due: null, evidence: ["segment:s"] }],
    context([event({ text: "I will send the report today." })]),
  );
  expect(steps).toHaveLength(1);
  expect(steps[0].inferred).toBe(true);
});
