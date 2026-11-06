import { expect, test } from "vitest";
import type {
  ContextBundle,
  PersonId,
  SpeakerClusterId,
  SpeechEvent,
} from "../src/contracts";
import {
  NEUTRAL_SELF_NAME,
  namedClaimsSupported,
  supportedOwner,
  userSelfName,
} from "../src/claimAttribution";
import { groundNextSteps } from "../src/nextSteps";
import { exportSelected } from "../src/sharing";
import { buildContext, createMeetingState } from "../src/snapshots";
const event = (over: Partial<SpeechEvent>): SpeechEvent => ({
  meetingId: "m",
  segmentId: "s",
  revision: 1,
  journalSequence: 1,
  lane: "remote",
  startMs: 0,
  endMs: 1,
  language: "en",
  text: "We will send the draft tomorrow.",
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
const lisa = "lisa" as PersonId;
const cluster = "remoteSpeaker1" as SpeakerClusterId;

test("the me lane is bound to the signed-in user's own name, not Karim", () => {
  const ctx = context([mine, theirs], { selfName: "Priya Nair" });
  expect(supportedOwner("Priya Nair", ctx, ["segment:mine"])).toBe(
    "Priya Nair",
  );
  // The full name matches in any casing and resolves to the canonical name.
  expect(supportedOwner("priya nair", ctx, ["segment:mine"])).toBe(
    "Priya Nair",
  );
  // The owner label offered to the model also resolves, only on the me lane.
  expect(supportedOwner("You", ctx, ["segment:mine"])).toBe("Priya Nair");
  expect(supportedOwner("You", ctx, ["segment:theirs"])).toBeNull();
  expect(
    namedClaimsSupported("Priya Nair committed to the draft.", ctx, [
      "segment:mine",
    ]),
  ).toBe(true);
  // No hard-coded owner: Karim is just an unknown name here.
  expect(supportedOwner("Karim", ctx, ["segment:mine"])).toBeNull();
  expect(
    namedClaimsSupported("Karim committed to the draft.", ctx, [
      "segment:mine",
    ]),
  ).toBe(false);
});

test("the me binding needs a cited microphone segment, never a remote one", () => {
  const ctx = context([mine, theirs], { selfName: "Priya Nair" });
  expect(supportedOwner("Priya Nair", ctx, ["segment:theirs"])).toBeNull();
  expect(supportedOwner("Priya Nair", ctx, [])).toBeNull();
  expect(
    namedClaimsSupported("Priya Nair promised the draft.", ctx, [
      "segment:theirs",
    ]),
  ).toBe(false);
});

test("a first name never resolves to the user, so an unrostered remote namesake cannot borrow the me lane", () => {
  const ctx = context([mine, theirs], { selfName: "Priya Nair" });
  expect(supportedOwner("Priya", ctx, ["segment:mine"])).toBeNull();
  expect(
    namedClaimsSupported("Priya said we ship on Friday.", ctx, [
      "segment:mine",
      "segment:theirs",
    ]),
  ).toBe(false);
  expect(supportedOwner("Priya Nair", ctx, ["segment:mine"])).toBe(
    "Priya Nair",
  );
});

test("the neutral You addresses the other party and never vouches for a claim", () => {
  const ctx = context([mine, theirs]);
  for (const text of [
    "You agreed to send the draft.",
    "You said the contract includes SSO.",
  ])
    expect(
      namedClaimsSupported(text, ctx, ["segment:mine", "segment:theirs"]),
    ).toBe(false);
  // Neither does it when an account name is known.
  const named = context([mine, theirs], { selfName: "Priya Nair" });
  expect(
    namedClaimsSupported("You agreed to send the draft.", named, [
      "segment:mine",
    ]),
  ).toBe(false);
});

test("names with particles or four words are judged as the full name", () => {
  for (const selfName of ["Anna de Vries", "María José García López"]) {
    const ctx = context([mine, theirs], { selfName });
    const claim = `${selfName} will send the draft.`;
    expect(namedClaimsSupported(claim, ctx, ["segment:mine"])).toBe(true);
    expect(namedClaimsSupported(claim, ctx, ["segment:theirs"])).toBe(false);
    expect(supportedOwner(selfName, ctx, ["segment:mine"])).toBe(selfName);
    expect(supportedOwner(selfName, ctx, ["segment:theirs"])).toBeNull();
  }
});

test("a lowercase mention of the user's name still needs the me lane", () => {
  const ctx = context([mine, theirs], { selfName: "Priya Nair" });
  expect(
    namedClaimsSupported("priya nair will send it", ctx, ["segment:theirs"]),
  ).toBe(false);
  expect(
    namedClaimsSupported("priya nair will send it", ctx, ["segment:mine"]),
  ).toBe(true);
});

test("generic role words do not waive attribution for a remote speaker", () => {
  const talk = event({
    segmentId: "talk",
    text: "The client asked whether the vendor support covers SSO. Support is included.",
  });
  const ctx = context([talk]);
  for (const name of ["Client", "Vendor", "Customer", "Company", "Team"])
    expect(
      namedClaimsSupported(`${name} confirmed SSO is included.`, ctx, [
        "segment:talk",
      ]),
    ).toBe(false);
  // Lowercase or sentence-initial occurrences are not a written organization name.
  expect(supportedOwner("Support", ctx, ["segment:talk"])).toBeNull();
  const named = event({
    segmentId: "named",
    text: "We still need sign-off from Support and Legal.",
  });
  expect(supportedOwner("Legal", context([named]), ["segment:named"])).toBe(
    "Legal",
  );
});

test("the account name is not part of an exported meeting record", () => {
  const record = {
    id: "m",
    workspaceId: "w",
    purpose: "Synthetic",
    date: "2026-10-02",
    objectives: [],
    attendees: [],
    selfName: "Priya Nair",
    profileId: "workClient",
    profileRevision: 0,
    revision: 1,
    segments: [],
    importedSegments: [],
    attributions: [],
    translationStatus: "complete",
  } as const;
  const bundle = exportSelected(
    { workspaceIds: ["w"], meetingIds: ["m"] },
    [record as never],
    [],
  );
  expect(bundle.records).toHaveLength(1);
  expect(JSON.stringify(bundle)).not.toContain("Priya");
});

test("without an account name the owner is the neutral You", () => {
  expect(userSelfName(undefined)).toBe(NEUTRAL_SELF_NAME);
  expect(userSelfName("  ")).toBe(NEUTRAL_SELF_NAME);
  // An email address is not a display name.
  expect(userSelfName("priya@example.com")).toBe(NEUTRAL_SELF_NAME);
  expect(userSelfName("  Priya   Nair ")).toBe("Priya Nair");
  const ctx = context([mine, theirs]);
  expect(supportedOwner("You", ctx, ["segment:mine"])).toBe("You");
  expect(supportedOwner("You", ctx, ["segment:theirs"])).toBeNull();
  expect(supportedOwner("Karim", ctx, ["segment:mine"])).toBeNull();
  const steps = groundNextSteps(
    [
      {
        task: "Send the draft.",
        inferred: false,
        owner: "You",
        due: null,
        evidence: ["segment:mine@1"],
      },
    ],
    ctx,
  );
  expect(steps[0].owner).toBe("You");
});

test("the account name travels from the meeting options into the context", () => {
  const state = createMeetingState({
    id: "m",
    workspaceId: "w",
    purpose: "Call",
    objectives: [],
    attendees: [],
    selfName: "Priya Nair",
    profileId: "interview",
    profileRevision: 0,
  });
  expect(buildContext(state, []).selfName).toBe("Priya Nair");
  expect(
    buildContext({ ...state, selfName: undefined }, []).selfName,
  ).toBeUndefined();
});

test("an organization is named only when it appears in the cited evidence", () => {
  const evidence = event({
    segmentId: "org",
    text: "I think Legal Operations will review the contract before Friday.",
  });
  const ctx = context([evidence, theirs]);
  expect(supportedOwner("Legal Operations", ctx, ["segment:org"])).toBe(
    "Legal Operations",
  );
  expect(
    namedClaimsSupported("Legal Operations agreed to review it.", ctx, [
      "segment:org",
    ]),
  ).toBe(true);
  // Same organization, but the cited evidence never mentions it.
  expect(supportedOwner("Legal Operations", ctx, ["segment:theirs"])).toBeNull();
  expect(
    namedClaimsSupported("Legal Operations agreed to review it.", ctx, [
      "segment:theirs",
    ]),
  ).toBe(false);
  // The former bank-specific names are no longer free passes.
  for (const name of ["Compliance", "Business Units", "Central Compliance"]) {
    expect(supportedOwner(name, ctx, ["segment:org"])).toBeNull();
    expect(
      namedClaimsSupported(`${name} agreed to review it.`, ctx, [
        "segment:org",
      ]),
    ).toBe(false);
  }
  // They are supported when the evidence names them.
  const bank = event({
    segmentId: "bank",
    text: "The approval sits with Central Compliance, together with the Business Units.",
  });
  const bankCtx = context([bank]);
  expect(supportedOwner("Central Compliance", bankCtx, ["segment:bank"])).toBe(
    "Central Compliance",
  );
  expect(supportedOwner("Business Units", bankCtx, ["segment:bank"])).toBe(
    "Business Units",
  );
});

test("a company is recognised by its legal suffix, a bare person name never is", () => {
  const text = event({
    segmentId: "co",
    text: "Acme GmbH sent the order. Anna Meyer asked about it.",
  });
  const ctx = context([text]);
  expect(supportedOwner("Acme GmbH", ctx, ["segment:co"])).toBe("Acme GmbH");
  // Present in the evidence text is not enough for a person.
  expect(supportedOwner("Anna Meyer", ctx, ["segment:co"])).toBeNull();
  expect(
    namedClaimsSupported("Anna Meyer committed to the order.", ctx, [
      "segment:co",
    ]),
  ).toBe(false);
});

test("a remote speaker still needs an established or confirmed attribution", () => {
  const remote = event({ segmentId: "r", speakerClusterId: cluster });
  const base = {
    selfName: "Priya Nair",
    participants: [{ id: lisa, name: "Lisa" }],
  };
  const claim = "Lisa committed to sending the draft.";
  const withStatus = (
    status: "suggested" | "established" | "confirmed",
    confirmedByUser?: boolean,
  ) =>
    context([mine, remote], {
      ...base,
      attributions: [
        {
          clusterId: cluster,
          personId: lisa,
          status,
          evidence: [],
          confirmedByUser,
        },
      ],
    });
  // The user's own microphone segment never vouches for a remote person.
  expect(
    namedClaimsSupported(claim, withStatus("established"), ["segment:mine"]),
  ).toBe(false);
  expect(
    namedClaimsSupported(claim, withStatus("suggested"), ["segment:r"]),
  ).toBe(false);
  expect(
    namedClaimsSupported(claim, withStatus("confirmed", false), ["segment:r"]),
  ).toBe(false);
  expect(
    namedClaimsSupported(claim, withStatus("established"), ["segment:r"]),
  ).toBe(true);
  expect(
    namedClaimsSupported(claim, withStatus("confirmed", true), ["segment:r"]),
  ).toBe(true);
  expect(supportedOwner("Lisa", withStatus("suggested"), ["segment:r"])).toBeNull();
  expect(supportedOwner("Lisa", withStatus("established"), ["segment:r"])).toBe(
    "Lisa",
  );
});
