import { expect, test } from "vitest";
import { PreparationRequests } from "./preparationRequests";
test("changing a preparation identity unlocks the editor and protects newer edits from delayed output", async () => {
  const gate = new PreparationRequests();
  let editor = "draft A";
  const request = gate.begin(
    JSON.stringify({
      purpose: "A",
      objectives: ["old"],
      draft: editor,
      topics: ["FINMA"],
    }),
  );
  let resolve: (text: string) => void = () => {};
  const result = new Promise<string>((r) => (resolve = r)).then((text) => {
    if (gate.accepts(request)) editor = text;
    gate.finish(request);
  });
  editor = "new manual edit";
  gate.update(
    JSON.stringify({
      purpose: "B",
      objectives: ["new"],
      draft: editor,
      topics: ["DORA"],
    }),
  );
  expect(gate.busy).toBe(false);
  resolve("obsolete output");
  await result;
  expect(editor).toBe("new manual edit");
  const next = gate.begin("new revision");
  expect(gate.busy).toBe(true);
  gate.finish(next);
  expect(gate.busy).toBe(false);
});
