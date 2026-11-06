// Fetches the pinned FLEURS dev clips (CC-BY-4.0, no account needed) into the shared cache outside the repository.
// Archives are checked against the pinned LFS checksum and every clip against its pinned sha256; a mismatch is a
// hard failure, never a silent substitution. `--pin` records the clip checksums after the first extraction.
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cacheRoot, clipPath, loadManifest, saveManifest, sha256File } from "./common.mjs";

const exists = (path) => access(path).then(() => true, () => false);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw Error(`${command} ${args[0]} failed: ${result.stderr || result.status}`);
  return result.stdout;
}

async function downloadArchive(manifest, language) {
  const { dataset, revision, archives } = manifest.fleurs;
  const archive = join(cacheRoot, "archives", `${language}-dev.tar.gz`);
  await mkdir(dirname(archive), { recursive: true });
  const url = `https://huggingface.co/datasets/${dataset}/resolve/${revision}/data/${language}/audio/dev.tar.gz`;
  console.log(`downloading ${url}`);
  run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--output", archive, url], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const digest = await sha256File(archive);
  if (digest !== archives[language].sha256) {
    await rm(archive, { force: true });
    throw Error(`FLEURS ${language} archive checksum mismatch: ${digest}`);
  }
  return archive;
}

export async function ensureFleurs(manifest, { pin = false } = {}) {
  const wanted = manifest.clips.filter((clip) => clip.source === "fleurs");
  for (const language of [...new Set(wanted.map((clip) => clip.fleursLanguage))]) {
    const clips = wanted.filter((clip) => clip.fleursLanguage === language);
    const missing = [];
    for (const clip of clips) {
      const path = clipPath(clip);
      if (!(await exists(path)) || (clip.sha256 && (await sha256File(path)) !== clip.sha256)) missing.push(clip);
    }
    if (missing.length) {
      const archive = await downloadArchive(manifest, language);
      const members = new Map(
        run("/usr/bin/tar", ["-tzf", archive]).split("\n").filter(Boolean).map((member) => [basename(member), member]),
      );
      const scratch = await mkdtemp(join(cacheRoot, "extract-"));
      try {
        const wantedMembers = missing.map((clip) => {
          const member = members.get(clip.file);
          if (!member) throw Error(`FLEURS ${language} archive has no ${clip.file} (${clip.id})`);
          return member;
        });
        run("/usr/bin/tar", ["-xzf", archive, "-C", scratch, ...wantedMembers]);
        for (const [index, clip] of missing.entries()) {
          await mkdir(dirname(clipPath(clip)), { recursive: true });
          await rename(join(scratch, wantedMembers[index]), clipPath(clip));
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
        await rm(archive, { force: true });
      }
    }
    for (const clip of clips) {
      const digest = await sha256File(clipPath(clip));
      if (!clip.sha256 && !pin) throw Error(`${clip.id} has no pinned checksum; run fetch-fleurs.mjs --pin`);
      if (clip.sha256 && clip.sha256 !== digest) throw Error(`${clip.id} checksum mismatch: ${digest}`);
      if (pin) clip.sha256 = digest;
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pin = process.argv.includes("--pin");
  const manifest = await ensureFleurs(await loadManifest(), { pin });
  if (pin) await saveManifest(manifest);
  console.log(`FLEURS clips ready in ${cacheRoot}`);
}
