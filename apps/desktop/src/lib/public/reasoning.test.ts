import { expect, test } from "vitest";
import { parseGroundedText, sourceScope } from "./reasoning";
test("whole briefs keep more than a live card's spoken-word limit", () => {
  const text = Array.from({ length: 80 }, (_, i) => "word" + i).join(" ");
  expect(
    parseGroundedText({ text, evidence: ["source:a"] }, ["source:a"], false)
      .text,
  ).toBe(text);
});
test("synthesis rejects invented and missing evidence", () => {
  expect(() =>
    parseGroundedText(
      { text: "A decision", evidence: ["segment:invented"] },
      ["segment:known"],
      true,
    ),
  ).toThrow("ungrounded");
  expect(() =>
    parseGroundedText(
      { text: "A decision", evidence: [] },
      ["segment:known"],
      true,
    ),
  ).toThrow("ungrounded");
});
test("workspace default scope differs from an intentional empty subset", () => {
  expect(sourceScope({ sourceIds: [] })).toBeUndefined();
  expect(sourceScope({ sourceSelection: "selected", sourceIds: [] })).toEqual(
    [],
  );
  expect(
    sourceScope({ sourceSelection: "selected", sourceIds: ["a"] }),
  ).toEqual(["a"]);
});
test("native JSON key ordering does not reject an identical immutable basis", async () => {
  const { sameWireValue } = await import("./reasoning");
  expect(
    sameWireValue(
      {
        meetingId: "A",
        delta: { segments: [{ text: "hello", revision: 1 }] },
        optional: undefined,
      },
      { delta: { segments: [{ revision: 1, text: "hello" }] }, meetingId: "A" },
    ),
  ).toBe(true);
  expect(sameWireValue({ revision: 1 }, { revision: 2 })).toBe(false);
});
