import { expect, test } from "vitest";
import type { PublicArtifact } from "@live-interview/core";
import {
  draftOnRecordChange,
  keptEditBase,
  humanEditedSynthesis,
  parseSynthesisItems,
  renderSynthesisText,
  synthesisSchema,
  synthesisSections,
  synthesisMarkdown,
} from "./synthesisItems";
const allowed = ["segment:de@2", "segment:en@1"];
test("typed items keep per-item evidence and derive the stored text", () => {
  const result = parseSynthesisItems(
    {
      items: [
        {
          kind: "commitment",
          text: "The checklist will be shared after the call.",
          evidence: ["segment:en@1", "segment:en@1"],
        },
        {
          kind: "recommendation",
          text: "Clarify final approval with both groups.",
          evidence: [],
        },
        { kind: "discussed", text: "Launch is on hold.", evidence: ["segment:de@2"] },
      ],
    },
    allowed,
  );
  expect(result.items[0].evidence).toEqual(["segment:en@1"]);
  expect(result.evidence).toEqual(["segment:en@1", "segment:de@2"]);
  expect(result.text).toBe(renderSynthesisText(result.items));
  expect(result.text).toContain("Suggested next steps (inferred, not agreed)");
});
test("one item without evidence is dropped and counted, the rest is kept", () => {
  for (const kind of ["commitment", "decision", "discussed"]) {
    const result = parseSynthesisItems(
      {
        items: [
          { kind, text: "Claim", evidence: [] },
          { kind: "discussed", text: "Other", evidence: ["segment:de@2"] },
        ],
      },
      allowed,
    );
    expect(result.items.map((item) => item.text)).toEqual(["Other"]);
    expect(result.omitted).toBe(1);
    expect(result.text).not.toContain("Claim");
    expect(result.text).toContain("1 item left out: no supporting evidence");
  }
});
test("the omitted note is pluralised and absent when nothing was dropped", () => {
  const result = parseSynthesisItems(
    {
      items: [
        { kind: "decision", text: "A", evidence: [] },
        { kind: "commitment", text: "B", evidence: [] },
        { kind: "discussed", text: "C", evidence: ["segment:de@2"] },
      ],
    },
    allowed,
  );
  expect(result.omitted).toBe(2);
  expect(result.text).toContain("2 items left out: no supporting evidence");
  const clean = parseSynthesisItems(
    { items: [{ kind: "discussed", text: "C", evidence: ["segment:de@2"] }] },
    allowed,
  );
  expect("omitted" in clean).toBe(false);
  expect(clean.text).not.toContain("left out");
});
test("an item citing an invented ID is dropped and counted, whatever its kind", () => {
  const result = parseSynthesisItems(
    {
      items: [
        { kind: "decision", text: "Invented", evidence: ["segment:de@1"] },
        {
          kind: "decision",
          text: "Half invented",
          evidence: ["segment:de@2", "segment:zz@9"],
        },
        { kind: "recommendation", text: "Also invented", evidence: ["segment:x@1"] },
        { kind: "discussed", text: "Real", evidence: ["segment:de@2"] },
      ],
    },
    allowed,
  );
  expect(result.items.map((item) => item.text)).toEqual(["Real"]);
  expect(result.evidence).toEqual(["segment:de@2"]);
  expect(result.omitted).toBe(3);
  expect(result.text).toContain("3 items left out: no supporting evidence");
});
test("when every item would be dropped the synthesis still fails", () => {
  expect(() =>
    parseSynthesisItems(
      {
        items: [
          { kind: "decision", text: "A", evidence: [] },
          { kind: "commitment", text: "B", evidence: [] },
        ],
      },
      allowed,
    ),
  ).toThrow(/^ungrounded$/);
  expect(() =>
    parseSynthesisItems(
      {
        items: [
          { kind: "decision", text: "A", evidence: ["segment:de@1"] },
          { kind: "discussed", text: "B", evidence: [] },
        ],
      },
      allowed,
    ),
  ).toThrow(/^ungroundedOutput$/);
});
test("evidence-free survivors alone still fail", () => {
  expect(() =>
    parseSynthesisItems(
      {
        items: [
          { kind: "discussed", text: "A", evidence: [] },
          { kind: "recommendation", text: "Do it", evidence: [] },
        ],
      },
      allowed,
    ),
  ).toThrow(/^ungrounded$/);
});
test("a cited recommendation survives when the factual items are dropped, with the note", () => {
  const result = parseSynthesisItems(
    {
      items: [
        { kind: "decision", text: "A", evidence: [] },
        { kind: "recommendation", text: "Check", evidence: ["segment:de@2"] },
      ],
    },
    allowed,
  );
  expect(result.items.map((item) => item.kind)).toEqual(["recommendation"]);
  expect(result.text).toContain("1 item left out: no supporting evidence");
});
test("inferred recommendations may lack evidence but cannot cite invented IDs", () => {
  const result = parseSynthesisItems(
    {
      items: [
        { kind: "recommendation", text: "Do it", evidence: [] },
        { kind: "discussed", text: "Real", evidence: ["segment:de@2"] },
      ],
    },
    allowed,
  );
  expect(result.items).toHaveLength(2);
  expect("omitted" in result).toBe(false);
  expect(() =>
    parseSynthesisItems(
      {
        items: [
          { kind: "recommendation", text: "Do it", evidence: ["segment:de@1"] },
        ],
      },
      allowed,
    ),
  ).toThrow(/^ungroundedOutput$/);
});
test("malformed output is rejected", () => {
  for (const output of [
    null,
    {},
    { items: [] },
    { items: [{ kind: "fact", text: "x", evidence: ["segment:de@2"] }] },
    { items: [{ kind: "discussed", text: "  ", evidence: ["segment:de@2"] }] },
    { items: [{ kind: "discussed", text: "x" }] },
    { items: [{ kind: "discussed", text: "x", evidence: [7] }] },
  ])
    expect(() => parseSynthesisItems(output, allowed)).toThrow();
});
test("sections group items in a fixed order and mark recommendations inferred", () => {
  const sections = synthesisSections([
    { kind: "recommendation", text: "R", evidence: [] },
    { kind: "decision", text: "D", evidence: ["segment:de@2"] },
  ]);
  expect(sections.map((s) => s.kind)).toEqual(["decision", "recommendation"]);
  expect(sections[1].inferred).toBe(true);
  expect(sections[0].inferred).toBe(false);
});
test("the schema stays within the service's output-schema limits", () => {
  expect(JSON.stringify(synthesisSchema).length).toBeLessThan(16000);
  expect(synthesisSchema.properties.items.items.properties.kind.enum).toEqual([
    "discussed",
    "decision",
    "commitment",
    "openQuestion",
    "recommendation",
  ]);
});
test("a human edit drops typed items and AI evidence but keeps identity", () => {
  const base: PublicArtifact = {
    meetingId: "A",
    kind: "synthesis",
    recordRevision: 2,
    status: "ready",
    text: "generated",
    evidence: ["segment:de@2"],
    items: [{ kind: "discussed", text: "x", evidence: ["segment:de@2"] }],
    omitted: 2,
    humanEdited: false,
    updatedAtMs: 9,
  };
  const edited = humanEditedSynthesis(base, "mine");
  expect(edited).toEqual({
    meetingId: "A",
    kind: "synthesis",
    recordRevision: 2,
    status: "ready",
    text: "mine",
    evidence: [],
    humanEdited: true,
    updatedAtMs: 9,
  });
  expect("items" in edited).toBe(false);
  expect("omitted" in edited).toBe(false);
});

test("the copied summary keeps inferred next steps under their own labelled heading", () => {
  const markdown = synthesisMarkdown(
    "Project kickoff",
    "October 16, 2026",
    renderSynthesisText([
      { kind: "commitment", text: "Alex sends the checklist.", evidence: ["s1"] },
      { kind: "recommendation", text: "Clarify final approval.", evidence: [] },
    ]),
  );
  expect(markdown).toBe(
    "# Project kickoff\nOctober 16, 2026\n\n## Commitments\n- Alex sends the checklist.\n\n## Suggested next steps (inferred, not agreed)\n- Clarify final approval.\n",
  );
});
test("an update to the same record keeps unsaved synthesis edits and says so; another record starts clean", () => {
  expect(draftOnRecordChange({ recordId: "A", dirty: true }, "A")).toEqual({ keep: true, message: "Record updated; your edits are kept" });
  expect(draftOnRecordChange({ recordId: "A", dirty: false }, "A")).toEqual({ keep: false });
  expect(draftOnRecordChange({ recordId: "A", dirty: true }, "B")).toEqual({ keep: false });
});
test("a kept edit saves against the updated revision, not the one it was started on", () => {
  const old: PublicArtifact = { meetingId: "A", kind: "synthesis", recordRevision: 2, status: "ready", text: "generated", evidence: ["segment:de@2"], humanEdited: false, updatedAtMs: 9 };
  expect(keptEditBase(null, old, 3)).toMatchObject({ recordRevision: 3, text: "generated" });
  const fresh = { ...old, recordRevision: 3, text: "new generation" };
  expect(keptEditBase(fresh, old, 3)).toBe(fresh);
  expect(keptEditBase(null, undefined, 3)).toBeNull();
});
