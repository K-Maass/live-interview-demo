// Checks the committed manifest and fixtures without models, so a bad edit fails in CI rather than minutes into a run.
import assert from "node:assert/strict";
import test from "node:test";
import { clipPath, loadManifest, sha256File } from "./common.mjs";

const manifest = await loadManifest();

test("clip ids are unique and each clip has a language, a lane, a reference and a pinned checksum", () => {
  const ids = manifest.clips.map((clip) => clip.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const clip of manifest.clips) {
    assert(["de", "en"].includes(clip.language), clip.id);
    assert(["me", "remote"].includes(clip.lane), clip.id);
    assert(clip.reference?.trim(), clip.id);
    assert.match(clip.sha256 ?? "", /^[0-9a-f]{64}$/, `${clip.id} needs a pinned sha256`);
    assert(["fleurs", "meeting"].includes(clip.source), clip.id);
  }
});

test("every meaning pattern compiles and every assertion id is unique within its clip", () => {
  for (const clip of manifest.clips.filter((candidate) => candidate.meaning)) {
    assert.equal(clip.language, "de", `${clip.id}: only foreign-language clips are translated`);
    assert(clip.meaning.length, clip.id);
    assert.equal(new Set(clip.meaning.map((assertion) => assertion.id)).size, clip.meaning.length, clip.id);
    for (const assertion of clip.meaning) {
      assert(assertion.anyOf?.length, `${clip.id}/${assertion.id} needs patterns`);
      for (const pattern of assertion.anyOf) assert.doesNotThrow(() => new RegExp(pattern, "iu"), `${clip.id}/${assertion.id}: ${pattern}`);
    }
  }
});

test("known failures name an existing check, a route and an issue, without duplicates", () => {
  const checks = new Set(
    manifest.clips.flatMap((clip) => (clip.meaning ?? []).map((assertion) => `${clip.id}/${assertion.id}`)),
  );
  const seen = new Set();
  for (const entry of manifest.knownFailures) {
    assert(["apple", "medium"].includes(entry.route), entry.check);
    assert(checks.has(entry.check), `known failure ${entry.check} matches no meaning assertion`);
    assert(Number.isInteger(entry.issue), entry.check);
    assert(entry.note?.trim(), `${entry.check} needs a note saying what goes wrong`);
    const key = `${entry.route}:${entry.check}`;
    assert(!seen.has(key), `duplicate known failure ${key}`);
    seen.add(key);
  }
});

test("FLEURS archives and clips are pinned", async () => {
  for (const [language, archive] of Object.entries(manifest.fleurs.archives))
    assert.match(archive.sha256, /^[0-9a-f]{64}$/, language);
  assert.match(manifest.fleurs.revision, /^[0-9a-f]{40}$/);
  for (const clip of manifest.clips.filter((candidate) => candidate.source === "meeting"))
    assert.equal(await sha256File(clipPath(clip)), clip.sha256, `${clip.id} differs from its pinned checksum`);
});

test("WER ceilings exist for each language", () => {
  for (const language of ["de", "en"]) assert(manifest.werCeilings[language] > 0);
});
