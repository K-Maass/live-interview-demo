import { expect, test } from "vitest";
import { NoteWriteQueue } from "./noteWrites";
test("app-owned derived notes serialize saves and skip superseded queued results", async () => {
  const queue = new NoteWriteQueue();
  const writes: string[] = [];
  let finish: () => void = () => {};
  let generation = 1;
  let started: () => void = () => {};
  const entered = new Promise<void>((r) => (started = r));
  const first = queue.save(
    "m",
    () => true,
    async () => {
      await new Promise<void>((r) => {
        finish = r;
        started();
      });
      writes.push("old");
    },
  );
  await entered;
  generation = 2;
  const skipped = queue.save(
    "m",
    () => generation === 2,
    async () => {
      writes.push("superseded");
    },
  );
  generation = 3;
  const latest = queue.save(
    "m",
    () => generation === 3,
    async () => {
      writes.push("latest");
    },
  );
  finish();
  await Promise.all([first, skipped, latest]);
  expect(writes).toEqual(["old", "latest"]);
});
