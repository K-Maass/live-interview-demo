import { expect, test } from "vitest";
import type {
  ContextBundle,
  PersonId,
  SpeakerClusterId,
  SpeechEvent,
} from "../src/contracts";
import { namedClaimsSupported } from "../src/claimAttribution";

const event = (over: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  startMs: 0,
  endMs: 1,
  language: "en",
  text: "We have 60 licences in use.",
  kind: "final",
  ...over,
});
const context = (
  conversation: SpeechEvent[],
  over: Partial<ContextBundle> = {},
): ContextBundle => ({
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
  ...over,
});
const mine = event({ segmentId: "mine", lane: "me" });
const theirs = event({ segmentId: "theirs", lane: "remote" });
const both = ["segment:mine", "segment:theirs"];

test("pronouns, determiners and quantifiers are not named claim subjects", () => {
  const ctx = context([mine, theirs]);
  for (const text of [
    "They said 60 licences are in use, yet the invoice shows 90.",
    "He confirmed the date. She decided to wait.",
    "It owns the whole rollout.",
    "This stated objective is addressed.",
    "That promised discount is not in the contract.",
    "These said nothing about SSO. Those agreed.",
    "Both stated objectives are addressed. Both agreed on the numbers.",
    "Everyone agreed. Everybody confirmed. Nobody committed. Someone said so. Somebody stated it.",
    "All decided to wait. Each confirmed. Neither agreed. Either said so. Others believes it.",
    "Participants agreed on the numbers. Attendees confirmed the date.",
    "Sie said 60. Er confirmed. Es owns it.",
    "Beide agreed. Alle stated the same. Jemand said so. Niemand committed.",
  ])
    expect(namedClaimsSupported(text, ctx, both), text).toBe(true);
  // "We" can stand for the user's own side, so it stays a claim that needs a binding.
  expect(namedClaimsSupported("We agreed on the numbers.", ctx, both)).toBe(false);
  expect(namedClaimsSupported("Wir agreed on the numbers.", ctx, both)).toBe(false);
  // Only the capitalised form is a pronoun. All-caps tokens are acronyms or teams and stay claims.
  expect(namedClaimsSupported("IT confirmed the date.", ctx, both)).toBe(false);
  expect(namedClaimsSupported("ALL agreed.", ctx, both)).toBe(false);
  expect(namedClaimsSupported("ES decided.", ctx, both)).toBe(false);
  expect(namedClaimsSupported("THEY said 60.", ctx, both)).toBe(false);
});

test("the observed false positives from the recorded eval now pass", () => {
  const ctx = context([theirs]);
  expect(
    namedClaimsSupported(
      "They said 60 licences are in use; the invoice shows 90.",
      ctx,
      ["segment:theirs"],
    ),
  ).toBe(true);
  expect(
    namedClaimsSupported(
      "Check whether both match. Both stated objectives are addressed.",
      ctx,
      ["segment:theirs"],
    ),
  ).toBe(true);
  expect(
    namedClaimsSupported("The two stated objectives are addressed", ctx, [
      "segment:theirs",
    ]),
  ).toBe(true);
});

test("a stop word does not shield a name that follows or accompanies it", () => {
  const ctx = context([theirs]);
  // The whole capitalised phrase is judged, so a name after a stop word is a name.
  expect(
    namedClaimsSupported("Both Maria said so.", ctx, ["segment:theirs"]),
  ).toBe(false);
  expect(
    namedClaimsSupported("They said so. Maria said 60 are in use.", ctx, [
      "segment:theirs",
    ]),
  ).toBe(false);
});

test("unrostered names are still rejected", () => {
  const ctx = context([theirs]);
  for (const text of [
    "Maria said 60 licences are in use.",
    "Maria Keller promised the draft.",
    "Hans-Peter committed to Friday.",
    "Dr Meier confirmed the date.",
  ])
    expect(namedClaimsSupported(text, ctx, ["segment:theirs"]), text).toBe(
      false,
    );
});

test("roster names still need an established or confirmed cluster binding", () => {
  const lisa = "lisa" as PersonId;
  const cluster = "remoteSpeaker1" as SpeakerClusterId;
  const remote = event({ segmentId: "lisa-says", speakerClusterId: cluster });
  const roster = { participants: [{ id: lisa, name: "Lisa" }] };
  const withStatus = (status: "suggested" | "established") =>
    context([remote], {
      ...roster,
      attributions: [
        { clusterId: cluster, personId: lisa, status, evidence: [] },
      ],
    });
  const cited = ["segment:lisa-says"];
  expect(
    namedClaimsSupported("Lisa said 60 are in use.", context([remote], roster), cited),
  ).toBe(false);
  expect(
    namedClaimsSupported("Lisa said 60 are in use.", withStatus("suggested"), cited),
  ).toBe(false);
  expect(
    namedClaimsSupported("Lisa said 60 are in use.", withStatus("established"), cited),
  ).toBe(true);
  // Lowercase roster spelling is still caught.
  expect(
    namedClaimsSupported("lisa said 60 are in use.", context([remote], roster), cited),
  ).toBe(false);
});

test("a roster name that is also a stop word is still checked as a roster name", () => {
  const ctx = context([theirs], {
    participants: [{ id: "x" as PersonId, name: "Alle" }],
  });
  expect(
    namedClaimsSupported("Alle said 60 are in use.", ctx, ["segment:theirs"]),
  ).toBe(false);
  expect(
    namedClaimsSupported("They said 60 are in use.", ctx, ["segment:theirs"]),
  ).toBe(true);
});

test("the user's own name is a claim that needs a me-lane citation", () => {
  const ctx = context([mine, theirs], { selfName: "Priya Nair" });
  expect(
    namedClaimsSupported("Priya Nair agreed to send it.", ctx, [
      "segment:theirs",
    ]),
  ).toBe(false);
  expect(
    namedClaimsSupported("Priya Nair agreed to send it.", ctx, ["segment:mine"]),
  ).toBe(true);
  // A pronoun next to it does not launder the name.
  expect(
    namedClaimsSupported("They said Priya Nair agreed.", ctx, ["segment:theirs"]),
  ).toBe(false);
  // A stop word as the account name is still the user's name.
  const odd = context([mine, theirs], { selfName: "Both" });
  expect(
    namedClaimsSupported("Both agreed to send it.", odd, ["segment:theirs"]),
  ).toBe(false);
});

test("an organization absent from the cited evidence is still rejected", () => {
  const talk = event({
    segmentId: "talk",
    text: "We still need sign-off from Acme GmbH and Central Compliance.",
  });
  const ctx = context([talk, theirs]);
  expect(
    namedClaimsSupported("Acme GmbH confirmed the date.", ctx, ["segment:talk"]),
  ).toBe(true);
  expect(
    namedClaimsSupported("Globex GmbH confirmed the date.", ctx, ["segment:talk"]),
  ).toBe(false);
  expect(
    namedClaimsSupported("Acme GmbH confirmed the date.", ctx, ["segment:theirs"]),
  ).toBe(false);
  expect(
    namedClaimsSupported("Central Compliance decided to wait.", ctx, [
      "segment:theirs",
    ]),
  ).toBe(false);
  // Function and team nouns are deliberately not on the stop-list.
  expect(
    namedClaimsSupported("Management agreed.", ctx, ["segment:theirs"]),
  ).toBe(false);
});

test("You never vouches for a claim, with or without cited remote speech", () => {
  const ctx = context([mine, theirs]);
  for (const text of [
    "You said 60 licences are in use.",
    "You stated the contract includes SSO.",
    "You agreed to send the draft.",
  ]) {
    expect(namedClaimsSupported(text, ctx, ["segment:theirs"]), text).toBe(
      false,
    );
    expect(namedClaimsSupported(text, ctx, both), text).toBe(false);
  }
  // The neutral phrasing the digDeeper prompt now teaches is accepted.
  expect(
    namedClaimsSupported(
      "Earlier you mentioned renewals are flat, yet support tickets doubled.",
      ctx,
      ["segment:theirs"],
    ),
  ).toBe(true);
});

test("names that start with a non-ASCII capital are still claims", () => {
  const ctx = context([theirs]);
  for (const text of [
    "Élodie committed to the date.",
    "Ömer agreed.",
    "Łukasz promised the draft.",
    "Åsa confirmed the numbers.",
    "Jürgen Müller said 60 are in use.",
    "Özge decided to wait.",
    "Anna committed to the date.",
  ])
    expect(namedClaimsSupported(text, ctx, ["segment:theirs"]), text).toBe(
      false,
    );
});

test("a non-ASCII roster name in any casing still needs a binding", () => {
  const elodie = "elodie" as PersonId;
  const cluster = "remoteSpeaker1" as SpeakerClusterId;
  const remote = event({ segmentId: "elodie-says", speakerClusterId: cluster });
  const roster = { participants: [{ id: elodie, name: "Élodie" }] };
  const cited = ["segment:elodie-says"];
  expect(
    namedClaimsSupported("élodie committed to the date.", context([remote], roster), cited),
  ).toBe(false);
  expect(
    namedClaimsSupported(
      "Élodie committed to the date.",
      context([remote], {
        ...roster,
        attributions: [
          { clusterId: cluster, personId: elodie, status: "established", evidence: [] },
        ],
      }),
      cited,
    ),
  ).toBe(true);
  // A letter glued to the name is a different word, so it is no roster match.
  expect(
    namedClaimsSupported("xélodie committed to the date.", context([remote], roster), cited),
  ).toBe(true);
});
