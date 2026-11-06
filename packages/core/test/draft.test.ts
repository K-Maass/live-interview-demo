import { expect, test } from "vitest";
import { DraftAccumulator, partialSay } from "../src/guidance/draft";

test("reads the say text as it arrives and ignores everything before it is started", () => {
  expect(partialSay("")).toBeUndefined();
  expect(partialSay("{")).toBeUndefined();
  expect(partialSay('{"say"')).toBeUndefined();
  expect(partialSay('{"say":')).toBeUndefined();
  expect(partialSay('{"say":"')).toBeUndefined();
  expect(partialSay('{"say":"Who')).toBe("Who");
  expect(partialSay('{"say":"Who owns the next step?","why":"x')).toBe(
    "Who owns the next step?",
  );
});

test("skips earlier top-level keys, including nested objects, arrays and quoted braces", () => {
  expect(
    partialSay(
      '{"headline":"A } tricky {","evidence":["a","b"],"meta":{"say":"nested"},"say":"Real',
    ),
  ).toBe("Real");
  expect(partialSay('{"evidence":["segment:1"')).toBeUndefined();
});

test("decodes JSON escapes and waits for incomplete ones", () => {
  expect(partialSay('{"say":"He said \\"yes\\"\\nthen')).toBe(
    'He said "yes"\nthen',
  );
  expect(partialSay('{"say":"caf\\u00e9')).toBe("café");
  expect(partialSay('{"say":"caf\\u00')).toBe("caf");
  expect(partialSay('{"say":"trailing \\')).toBe("trailing");
  expect(partialSay('{"say":"bad \\x escape')).toBe("bad");
});

test("only a top-level string say is a draft", () => {
  expect(partialSay('{"candidates":[{"say":"nested')).toBeUndefined();
  expect(partialSay('{"say":12,"why":"x"}')).toBeUndefined();
  expect(partialSay('{"say":null}')).toBeUndefined();
  expect(partialSay('["say","x"]')).toBeUndefined();
  expect(partialSay("not json")).toBeUndefined();
  expect(partialSay('{"say":"   "')).toBeUndefined();
});

test("a draft never exceeds the card limit", () => {
  expect(partialSay(`{"say":"${"a".repeat(1000)}`)).toHaveLength(350);
});

test("the accumulator joins fragments, reports changes and drops everything on reset", () => {
  const draft = new DraftAccumulator();
  expect(draft.push('{"sa')).toEqual({ text: undefined, changed: false });
  expect(draft.push('y":"Who ')).toEqual({ text: "Who", changed: true });
  expect(draft.push("owns")).toEqual({ text: "Who owns", changed: true });
  expect(draft.push('","why":"')).toEqual({ text: "Who owns", changed: false });
  expect(draft.reset()).toEqual({ text: undefined, changed: true });
  expect(draft.push('{"say":"Fast')).toEqual({ text: "Fast", changed: true });
});
