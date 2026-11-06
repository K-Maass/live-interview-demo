import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const fixtureRoot = resolve("tests/fixtures/speech-benchmark");
export const manifestPath = join(fixtureRoot, "manifest.json");
export const cacheRoot =
  process.env.SPEECH_BENCHMARK_CACHE ?? resolve(".speech-preview/cache");

export async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function saveManifest(manifest) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** Committed fictional clips live beside the manifest; FLEURS clips live in the shared cache. */
export function clipPath(clip) {
  return clip.source === "fleurs" ? join(cacheRoot, "fleurs", clip.fleursLanguage, clip.file) : join(fixtureRoot, clip.file);
}
