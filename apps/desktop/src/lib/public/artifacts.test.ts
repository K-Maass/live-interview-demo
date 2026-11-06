import { expect, test } from "vitest";
import type { PublicArtifact } from "@live-interview/core";
import { ArtifactCache, groundedEvidence } from "./artifacts";
const artifact: PublicArtifact = {
  meetingId: "A",
  kind: "synthesis",
  recordRevision: 2,
  status: "ready",
  text: "Saved summary",
  evidence: ["segment:s1"],
  humanEdited: false,
  updatedAtMs: 9,
};
test("returning to Overview reads the cached revision without regenerating", async () => {
  let reads = 0;
  let writes = 0;
  const cache = new ArtifactCache({
    getArtifact: async () => {
      reads++;
      return artifact;
    },
    saveArtifact: async (a) => {
      writes++;
      return a;
    },
  });
  expect((await cache.load("A", "synthesis", 2))?.text).toBe("Saved summary");
  await cache.load("A", "synthesis", 2);
  expect(reads).toBe(1);
  expect(writes).toBe(0);
});
test("artifact revisions are independent and human-edited text is never replaced by generated output", async () => {
  const manual = { ...artifact, humanEdited: true };
  let writes = 0;
  const cache = new ArtifactCache({
    getArtifact: async () => manual,
    saveArtifact: async (a) => {
      writes++;
      return a;
    },
  });
  await cache.load("A", "synthesis", 2);
  await expect(
    cache.saveGenerated({ ...artifact, text: "obsolete" }),
  ).rejects.toThrow("humanEdited");
  expect(writes).toBe(0);
});
test("generated evidence must resolve to the provided source or conversation evidence", () => {
  expect(groundedEvidence(["segment:s1", "unknown"], ["segment:s1"])).toEqual([
    "segment:s1",
  ]);
  expect(() => groundedEvidence(["unknown"], ["segment:s1"], true)).toThrow(
    "ungrounded",
  );
});
test("concurrent automatic and manual synthesis share one revision-keyed generation", async () => {
  let generations = 0;
  let stored: PublicArtifact | null = null;
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  const cache = new ArtifactCache({
    getArtifact: async () => stored,
    saveArtifact: async (a) => (stored = { ...a, updatedAtMs: 10 }),
  });
  const generate = async () => {
    generations++;
    await pending;
    return { text: "Grounded result", evidence: ["segment:s1"] };
  };
  const first = cache.generateCached(
    { meetingId: "A", kind: "synthesis", recordRevision: 2 },
    generate,
  );
  const second = cache.generateCached(
    { meetingId: "A", kind: "synthesis", recordRevision: 2 },
    generate,
  );
  await Promise.resolve();
  resolve();
  await Promise.all([first, second]);
  await cache.generateCached(
    { meetingId: "A", kind: "synthesis", recordRevision: 2 },
    generate,
  );
  expect(generations).toBe(1);
  expect((stored as PublicArtifact | null)?.text).toBe("Grounded result");
});
test("failed first synthesis persists honest failed status for a later retry", async () => {
  let stored: PublicArtifact | null = null;
  const cache = new ArtifactCache({
    getArtifact: async () => stored,
    saveArtifact: async (a) =>
      (stored = { ...a, updatedAtMs: (stored?.updatedAtMs ?? 0) + 1 }),
  });
  await expect(
    cache.generateCached(
      { meetingId: "A", kind: "synthesis", recordRevision: 2 },
      async () => {
        throw Error("offline");
      },
    ),
  ).rejects.toThrow("offline");
  expect((stored as PublicArtifact | null)?.status).toBe("failed");
  const retried = await cache.generateCached(
    { meetingId: "A", kind: "synthesis", recordRevision: 2 },
    async () => ({ text: "Recovered", evidence: ["segment:s1"] }),
  );
  expect(retried.status).toBe("ready");
});
test("generated typed items are saved with the artifact", async () => {
  let stored: PublicArtifact | null = null;
  const cache = new ArtifactCache({
    getArtifact: async () => stored,
    saveArtifact: async (a) => (stored = { ...a, updatedAtMs: 1 }),
  });
  const items = [
    { kind: "decision" as const, text: "Ship", evidence: ["segment:s1@1"] },
  ];
  const saved = await cache.generateCached(
    { meetingId: "A", kind: "synthesis", recordRevision: 2 },
    async () => ({
      text: "Decisions\n- Ship",
      evidence: ["segment:s1@1"],
      items,
      omitted: 1,
    }),
  );
  expect(saved.items).toEqual(items);
  expect(saved.omitted).toBe(1);
});
test("loadLatest falls back to the newest earlier revision only when the current one has none", async () => {
  const earlier = { ...artifact, kind: "actions" as const, recordRevision: 1 };
  const cache = new ArtifactCache({
    getArtifact: async (_id, _kind, revision) =>
      revision === 1 ? earlier : null,
    getLatestArtifact: async () => earlier,
    saveArtifact: async (a) => a,
  });
  expect((await cache.loadLatest("A", "actions", 1))?.recordRevision).toBe(1);
  expect((await cache.loadLatest("A", "actions", 3))?.recordRevision).toBe(1);
  const plain = new ArtifactCache({
    getArtifact: async () => null,
    saveArtifact: async (a) => a,
  });
  expect(await plain.loadLatest("A", "actions", 3)).toBeNull();
});
