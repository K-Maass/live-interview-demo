import { describe, expect, test } from "vitest";
import type {
  ContextBundle,
  PersonId,
  SpeakerClusterId,
  SpeechEvent,
} from "../src/contracts";
import { claimSupport, namedClaimsSupported, supportedOwner } from "../src/claimAttribution";

const marco = "marco" as PersonId;
const cluster = "remoteSpeaker1" as SpeakerClusterId;
const remote: SpeechEvent = {
  meetingId: "m",
  segmentId: "r",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  speakerClusterId: cluster,
  startMs: 0,
  endMs: 1,
  language: "en",
  text: "We can accept the price.",
  kind: "final",
};
const context = (over: Partial<ContextBundle> = {}): ContextBundle => ({
  purpose: "Meeting",
  objectives: [],
  conversation: [remote],
  sources: [],
  stateRevision: 0,
  indexRevision: 0,
  briefRevision: 0,
  sourceRevisions: {},
  participants: [],
  attributions: [],
  ...over,
});
const rostered = (status?: "established" | "suggested") =>
  context({
    participants: [{ id: marco, name: "Marco Rossi" }],
    attributions: status
      ? [{ clusterId: cluster, personId: marco, status, evidence: [] }]
      : [],
  });
const cited = ["segment:r"];

describe("attribution forms the claim scanner used to miss now need a binding", () => {
  test.each([
    // An adverb or auxiliary between the name and the verb
    "Marco already agreed to the price.",
    "Priya has confirmed the date.",
    "Priya has already confirmed the date.",
    "Dana also said the pilot is funded.",
    // Possessives
    "Dana's team will send the draft.",
    "Dana’s office confirmed the date.",
  ])("%s", (text) =>
    expect(namedClaimsSupported(text, context(), cited)).toBe(false),
  );

  // "According to X" with an unlisted X names a source, not a meeting
  // participant: the card is kept but marked uncertain when no cited evidence
  // mentions X.
  test.each([
    "According to Priya, the pilot starts in May.",
    "according to Priya the pilot starts in May.",
    "Laut Priya startet der Pilot im Mai.",
    "Der Pilot startet, laut Priya, im Mai.",
    "Priya zufolge startet der Pilot im Mai.",
  ])("uncertain: %s", (text) =>
    expect(claimSupport(text, context(), cited)).toBe("uncertain"),
  );
});

describe("pronouns and quantifiers in the new forms are still not names", () => {
  test.each([
    "They have already agreed to the price.",
    "She has confirmed the date.",
    "According to them, the pilot starts in May.",
    "According to the contract, the pilot starts in May.",
    "Everyone has agreed.",
    "The price has already been agreed.",
  ])("%s", (text) =>
    expect(namedClaimsSupported(text, context(), cited)).toBe(true),
  );
});

describe("a listed participant's first or last name is the participant", () => {
  test.each([
    "Marco agreed to the price.",
    "Marco already agreed to the price.",
    "Rossi has confirmed the price.",
    "According to Marco, the price is acceptable.",
    "Laut Marco passt der Preis.",
    "Marco's team will send the draft.",
  ])("%s", (text) => {
    expect(namedClaimsSupported(text, rostered(), cited), "no binding").toBe(false);
    expect(namedClaimsSupported(text, rostered("suggested"), cited), "suggested").toBe(false);
    expect(namedClaimsSupported(text, rostered("established"), cited), "established").toBe(true);
  });

  test("a first name shared by two participants stays ambiguous and unsupported", () => {
    const ctx = context({
      participants: [
        { id: marco, name: "Marco Rossi" },
        { id: "m2" as PersonId, name: "Marco Bianchi" },
      ],
      attributions: [
        { clusterId: cluster, personId: marco, status: "established", evidence: [] },
      ],
    });
    expect(namedClaimsSupported("Marco agreed to the price.", ctx, cited)).toBe(false);
    expect(namedClaimsSupported("Marco Rossi agreed to the price.", ctx, cited)).toBe(true);
  });

  test("an owner given by first name resolves to the bound participant", () => {
    expect(supportedOwner("Marco", rostered("established"), cited)).toBe("Marco Rossi");
    expect(supportedOwner("Marco", rostered(), cited)).toBeNull();
  });

  test("name parts that are common words do not create claims", () => {
    const ctx = context({
      participants: [
        { id: "w" as PersonId, name: "Will Baker" },
        { id: "a" as PersonId, name: "Ann Price" },
        { id: "j" as PersonId, name: "Jo Li" },
      ],
    });
    for (const text of [
      "We will confirm the date on Monday.",
      "The price agreed in March still applies.",
      "Prices have already been agreed.",
      "Ask whether li stated anything.",
    ])
      expect(namedClaimsSupported(text, ctx, cited), text).toBe(true);
  });
});

test("according to a document is supported when a cited workspace source names it", () => {
  const ctx = context({
    sources: [
      {
        sourceId: "report",
        workspaceId: "w",
        kind: "markdown",
        title: "Market report",
        text: "Gartner expects adoption to stay flat.",
        locator: "report.md",
        revision: 1,
        derived: false,
      },
    ],
  });
  const text = "According to Gartner, adoption stays flat.";
  expect(claimSupport(text, ctx, ["report"])).toBe("supported");
  expect(claimSupport(text, ctx, cited)).toBe("uncertain");
  // A participant is never vouched for by a document that mentions them.
  const named = context({
    ...ctx,
    participants: [{ id: marco, name: "Marco Rossi" }],
    sources: [{ ...ctx.sources[0], text: "Marco expects adoption to stay flat." }],
  });
  expect(namedClaimsSupported("According to Marco, adoption stays flat.", named, ["report"])).toBe(false);
});

describe("according to a non-person source", () => {
  const segment = (text: string, language = "en"): SpeechEvent => ({ ...remote, text, language });
  test.each([
    // [card text, cited turn, expected]
    ["According to Salesforce, the renewal is in May.", "Salesforce shows the renewal in May.", "supported"],
    ["According to Salesforce, the renewal is in May.", "The renewal is in May.", "uncertain"],
    ["According to Slack, the launch moved.", "I saw in slack that the launch moved.", "supported"],
    ["According to Teams, the call is at 3.", "The call is at 3.", "uncertain"],
    ["According to Monday's agenda, pricing comes first.", "On monday's agenda pricing comes first.", "supported"],
    ["According to ACME, the pilot is funded.", "Acme told us the pilot is funded.", "supported"],
    ["Laut Salesforce ist die Verlängerung im Mai.", "In Salesforce steht die Verlängerung im Mai.", "supported"],
    ["Laut Salesforce ist die Verlängerung im Mai.", "Die Verlängerung ist im Mai.", "uncertain"],
    ["Dem Protokoll zufolge kommt der Preis zuerst.", "Der Preis kommt zuerst.", "uncertain"],
    ["Dem Protokoll zufolge kommt der Preis zuerst.", "Im Protokoll steht, der Preis kommt zuerst.", "supported"],
    ["Salesforce zufolge ist die Verlängerung im Mai.", "Die Verlängerung ist im Mai.", "uncertain"],
  ])("%s / %s", (text, turn, expected) =>
    expect(claimSupport(text, context({ conversation: [segment(turn)] }), cited)).toBe(expected),
  );

  test("a participant or the user named by according to stays a person claim", () => {
    const turn = segment("Marco Rossi thinks the price is fine.");
    const ctx = context({ conversation: [turn], participants: [{ id: marco, name: "Marco Rossi" }] });
    expect(claimSupport("According to Marco, the price is fine.", ctx, cited)).toBe("rejected");
    expect(claimSupport("Laut Rossi passt der Preis.", ctx, cited)).toBe("rejected");
    const self = context({ conversation: [turn], selfName: "Karin Weber" });
    expect(claimSupport("According to Karin Weber, the price is fine.", self, cited)).toBe("rejected");
  });

  test("an unsupported verb claim by an unlisted name is still rejected", () => {
    const ctx = context({ conversation: [segment("Salesforce shows the renewal in May.")] });
    expect(claimSupport("Priya confirmed the renewal.", ctx, cited)).toBe("rejected");
    expect(claimSupport("According to Salesforce, Priya confirmed the renewal.", ctx, cited)).toBe("rejected");
  });
});
