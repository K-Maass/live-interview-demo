// Speech and translation benchmark: runs the production recognition and translation helpers over the fixed
// bilingual clip set and reports WER, translation meaning checks, latency and peak memory.
//
//   npm run speech:benchmark                  Apple translation route: the supported route (macOS 26+, de->en assets installed)
//   npm run speech:benchmark -- --route medium    forced local Whisper medium route: experimental, off by default in the app (#29)
//   --clips a,b          run only clips whose id contains one of the fragments (never compared or baselined)
//   --binary PATH        helper binary (default apps/desktop/src-tauri/bin/local-speech)
//   --models DIR         model folder (default .speech-preview/models)
//   --request-timeout-ms N / --load-timeout-ms N   per-request limit (default 120000) / limit for model loads (default 900000)
//   --update-baseline    rewrite docs/acceptance/speech-benchmark-baseline-<route>.json from this run
//
// Both helpers run with network denied. The Apple route also uses the OS Translation service, which is not
// firewalled and whose memory is not counted in the helper figures.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { clipPath, loadManifest, sha256File } from "./common.mjs";
import { ensureFleurs } from "./fetch-fleurs.mjs";
import {
  checkMeaning,
  chrF,
  compare,
  corpusWer,
  parseTimeL,
  realTimeFactor,
  summariseLatency,
  wavDurationMs,
  wordErrors,
} from "./score.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  assert(argv[index + 1] !== undefined && !argv[index + 1].startsWith("--"), `${name} needs a value`);
  return argv[index + 1];
};
const route = option("--route", "apple");
assert(["apple", "medium"].includes(route), "--route must be apple or medium");
const binary = resolve(option("--binary", "apps/desktop/src-tauri/bin/local-speech"));
const models = option("--models", resolve(".speech-preview/models"));
const filters = option("--clips", "")
  .split(",")
  .filter(Boolean);
const partial = filters.length > 0;
const baselinePath = `docs/acceptance/speech-benchmark-baseline-${route}.json`;
const requestTimeoutMs = Number(option("--request-timeout-ms", 120000));
// A cold CoreML compile took 452 s on the reference Mac (#58), so model loads get their own, longer limit.
const loadTimeoutMs = Number(option("--load-timeout-ms", 900000));
const round = (value) => Math.round(value);

function startHelper(name, extraArgs, cache) {
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1) (allow default) (deny network*)", "/usr/bin/time", "-l", binary, models, cache, ...extraArgs],
    // Own process group: sandbox-exec execs into time, which forks the helper, so killing only the child would orphan it.
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: homedir() }, detached: true },
  );
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  let broken;
  const fatal = (message) => (broken = Object.assign(Error(message), { fatal: true }));
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let current;
  const closed = new Promise((done) => child.on("close", done));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!current) return;
    if (message.kind === "speech") current.events.push(message.event);
    if (["ready", "decoded", "translatedUtterance", "translatedText", "failure"].includes(message.kind)) {
      const pending = current;
      current = undefined;
      clearTimeout(pending.timer);
      // A reply for another segment means the pipe is out of step; scoring on it would attribute text to the wrong clip.
      if (pending.segmentId && message.segmentId && message.segmentId !== pending.segmentId) {
        pending.reject(fatal(`${name} answered ${message.segmentId} while ${pending.segmentId} was pending`));
        killGroup();
      } else if (message.kind === "failure") pending.reject(Object.assign(Error(message.code), { code: message.code }));
      else pending.resolve({ events: pending.events, terminal: message });
    }
  });
  child.on("exit", () => current?.reject(fatal(`${name} helper exited unexpectedly`)));
  return {
    request(body, timeoutMs = requestTimeoutMs) {
      if (broken) return Promise.reject(broken);
      assert(!current, "the helper handles one request at a time");
      return new Promise((resolveRequest, reject) => {
        current = {
          events: [],
          segmentId: body.segmentId ?? body.source?.segmentId,
          resolve: resolveRequest,
          reject,
          timer: setTimeout(() => {
            current = undefined;
            killGroup();
            reject(
              fatal(
                `local-worker-timeout: ${name} ${body.kind} after ${timeoutMs} ms; stderr tail: ${stderr.slice(-400).replace(/\s+/g, " ")}`,
              ),
            );
          }, timeoutMs),
        };
        child.stdin.write(JSON.stringify(body) + "\n");
      });
    },
    /** Shuts the helper down and returns the peak memory that `time -l` printed when it exited. */
    async finish() {
      child.stdin.write('{"kind":"shutdown"}\n');
      child.stdin.end();
      const timer = setTimeout(killGroup, 15000);
      await closed;
      clearTimeout(timer);
      return parseTimeL(stderr);
    },
  };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function environment() {
  const sysctl = (key) => execFileSync("/usr/sbin/sysctl", ["-n", key], { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  return {
    commit,
    // Baseline files record results, they do not change them, so they do not make a run "dirty".
    dirty: git("status", "--porcelain", "--", ".", ":!docs/acceptance/speech-benchmark-baseline-*.json").length > 0,
    macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    chip: sysctl("machdep.cpu.brand_string"),
    architecture: arch(),
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    // One-minute load average when the run finished; high load inflates latency, so read latency with it.
    loadAverage1m: Number(loadavg()[0].toFixed(1)),
  };
}

const manifest = await loadManifest();
await ensureFleurs(manifest);
const selected = manifest.clips.filter((clip) => !partial || filters.some((fragment) => clip.id.includes(fragment)));
assert(selected.length, "no clips match --clips");
for (const clip of selected) {
  const digest = await sha256File(clipPath(clip));
  assert.equal(digest, clip.sha256, `${clip.id} does not match its pinned checksum`);
}
const binaryDigest = await sha256File(binary);

const cache = await mkdtemp(join(tmpdir(), "speech-benchmark-"));
const recognition = startHelper("recognition", [], cache);
const translation = startHelper("translation", route === "medium" ? ["--force-medium-translation"] : [], cache);
let finished = false;
const finishBoth = async () => {
  finished = true;
  return { recognition: await recognition.finish(), translation: await translation.finish() };
};

try {
  const audio = new Map();
  for (const clip of selected) {
    const path = join(cache, `${clip.id}.wav`);
    await copyFile(clipPath(clip), path);
    audio.set(clip.id, { path, durationMs: wavDurationMs(await readFile(path)) });
  }

  if (route === "apple") {
    try {
      await recognition.request({ kind: "translateText", source: "de", target: "en", text: "Guten Morgen." });
    } catch (error) {
      throw Error(
        `Apple de->en translation is not available (${error.message}). Install the language assets or run with --route medium.`,
      );
    }
  }

  const decode = (clip, sequence, timeoutMs) =>
    recognition.request(
      {
        kind: "decode",
        meetingId: "benchmark",
        segmentId: clip.id,
        lane: clip.lane,
        audioPath: audio.get(clip.id).path,
        startMs: 0,
        sequence,
        mode: "transcribe",
        sourceOnly: true,
        revision: 1,
      },
      timeoutMs,
    );
  const translate = (source, clip, timeoutMs) =>
    translation.request(
      {
        kind: "translateUtterance",
        meetingId: source.meetingId,
        segmentId: source.segmentId,
        lane: source.lane,
        revision: source.revision,
        source,
        audioPath: audio.get(clip.id).path,
      },
      timeoutMs,
    );

  // Model load and first-use specialisation are reported separately and excluded from the per-clip figures.
  let started = performance.now();
  await recognition.request({ kind: "warm" }, loadTimeoutMs);
  const warm = { recognitionMs: round(performance.now() - started) };
  const warmClip = selected.find((clip) => clip.language === "de") ?? selected[0];
  started = performance.now();
  const warmSource = await decode(warmClip, 0, loadTimeoutMs);
  warm.firstDecodeMs = round(performance.now() - started);
  if (warmClip.language === "de" && warmSource.events[0]) {
    started = performance.now();
    await translate(warmSource.events[0], warmClip, loadTimeoutMs).catch(() => undefined);
    warm.firstTranslationMs = round(performance.now() - started);
  }

  const results = [];
  for (const [index, clip] of selected.entries()) {
    const { durationMs } = audio.get(clip.id);
    /** @type {Record<string, any>} */
    const row = { id: clip.id, source: clip.source, language: clip.language, lane: clip.lane, durationMs: round(durationMs) };
    started = performance.now();
    let source;
    try {
      source = (await decode(clip, index + 1)).events[0];
      row.sourceMs = round(performance.now() - started);
    } catch (error) {
      if (error.fatal) throw error;
      row.sourceMs = round(performance.now() - started);
      row.sourceFailure = error.message;
    }
    row.sourceText = source?.text ?? "";
    row.detectedLanguage = source?.language ?? null;
    row.realTimeFactor = Number(realTimeFactor(row.sourceMs, durationMs).toFixed(3));
    row.wer = wordErrors(clip.reference, row.sourceText);
    if (clip.meaning) {
      row.translationText = "";
      if (source && source.language === clip.language) {
        started = performance.now();
        try {
          const event = (await translate(source, clip)).events[0];
          row.translationMs = round(performance.now() - started);
          row.translationText = event?.text ?? "";
        } catch (error) {
          if (error.fatal) throw error;
          row.translationMs = round(performance.now() - started);
          row.translationFailure = error.message;
        }
      } else row.translationFailure = source ? `detected ${source.language}` : "no source";
      if (clip.englishReference) row.translationChrF = Number(chrF(clip.englishReference, row.translationText).toFixed(3));
      row.meaning = checkMeaning(clip.meaning, row.translationText);
    }
    results.push(row);
    const verdict = row.meaning ? ` meaning ${row.meaning.filter((m) => m.passed).length}/${row.meaning.length}` : "";
    console.log(
      `${clip.id.padEnd(16)} src ${String(row.sourceMs).padStart(5)} ms  wer ${(row.wer.errors / Math.max(row.wer.refWords, 1)).toFixed(2)}${
        row.translationMs !== undefined ? `  tr ${String(row.translationMs).padStart(5)} ms` : ""
      }${verdict}${row.sourceFailure ? `  SOURCE FAILED ${row.sourceFailure}` : ""}${row.translationFailure ? `  TRANSLATION FAILED ${row.translationFailure}` : ""}`,
    );
  }

  const peak = await finishBoth();
  const wer = {};
  const werByCategory = {};
  for (const language of ["de", "en"]) {
    const rows = results.filter((row) => row.language === language);
    if (rows.length) wer[language] = Number(corpusWer(rows.map((row) => row.wer)).toFixed(4));
    for (const category of ["fleurs", "meeting"]) {
      const part = rows.filter((row) => row.source === category);
      if (part.length) werByCategory[`${category}-${language}`] = Number(corpusWer(part.map((row) => row.wer)).toFixed(4));
    }
  }
  // Failed requests are counted, not timed: a fast failure would otherwise pull the latency percentiles down.
  const decoded = results.filter((row) => !row.sourceFailure);
  const translated = results.filter((row) => row.translationMs !== undefined && !row.translationFailure);
  const scored = results.filter((row) => row.translationChrF !== undefined);
  const meaning = Object.fromEntries(
    results.flatMap((row) => (row.meaning ?? []).map((check) => [`${row.id}/${check.id}`, check.passed])),
  );
  const summary = {
    route,
    wer,
    werByCategory,
    meaning,
    failures: {
      source: results.filter((row) => row.sourceFailure).length,
      translation: results.filter((row) => row.translationFailure).length,
    },
    languageDetection: {
      correct: results.filter((row) => row.detectedLanguage === row.language).length,
      total: results.length,
    },
    translationChrF: scored.length
      ? Number((scored.reduce((sum, row) => sum + row.translationChrF, 0) / scored.length).toFixed(3))
      : null,
    latency: {
      warmMs: warm.recognitionMs,
      firstDecodeMs: warm.firstDecodeMs,
      firstTranslationMs: warm.firstTranslationMs,
      sourceMs: summariseLatency(decoded.map((row) => row.sourceMs)),
      translationMs: summariseLatency(translated.map((row) => row.translationMs)),
      realTimeFactor: summariseLatency(decoded.map((row) => row.realTimeFactor)),
    },
    memory: {
      recognitionPeakFootprintBytes: peak.recognition.peakFootprintBytes,
      recognitionMaxResidentBytes: peak.recognition.maxResidentBytes,
      translationPeakFootprintBytes: peak.translation.peakFootprintBytes,
      translationMaxResidentBytes: peak.translation.maxResidentBytes,
    },
  };

  const env = environment();
  const report = {
    kind: "speech-benchmark",
    date: new Date().toISOString(),
    partial,
    ...summary,
    environment: { ...env, helperSha256: binaryDigest, network: "helpers run with network denied; the Apple Translation service is not firewalled and its memory is not counted" },
    corpus: {
      fleurs: manifest.fleurs.attribution,
      meeting: "Fictional scripted lines synthesised with macOS say (Anna de_DE, Samantha en_US).",
      scope:
        "Read speech and synthetic voices on one Mac only. Not live Teams audio, not accented or overlapping speech, not code-switching. Memory is the helper processes only (peak footprint via time -l), measured with recognition and translation run one after the other rather than concurrently as in the app; on the Apple route the translation helper only calls the OS Translation service, whose memory is not included. Latency is per clip with warmed models.",
    },
    clips: results,
  };

  const outDir = resolve("artifacts/speech-benchmark");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${env.commit.slice(0, 10)}${env.dirty ? "-dirty" : ""}-${route}${partial ? "-partial" : ""}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");

  const baseline = await readFile(baselinePath, "utf8").then(JSON.parse, () => undefined);
  const verdict = partial ? undefined : compare(summary, baseline, manifest);
  const mb = (bytes) => (bytes === null ? "n/a" : `${round(bytes / 2 ** 20)} MiB`);
  console.log(
    [
      "",
      `route ${route}  commit ${env.commit.slice(0, 10)}${env.dirty ? " (dirty)" : ""}  ${env.chip}, ${env.memoryGiB} GiB, macOS ${env.macOS}, load ${env.loadAverage1m}`,
      `WER   de ${wer.de ?? "-"}  en ${wer.en ?? "-"}   by category ${JSON.stringify(werByCategory)}`,
      `lang  detected correctly ${summary.languageDetection.correct}/${summary.languageDetection.total}   translation chrF ${summary.translationChrF}`,
      `src   p50 ${summary.latency.sourceMs.p50} ms  p95 ${summary.latency.sourceMs.p95} ms  RTF p50 ${summary.latency.realTimeFactor.p50}`,
      `tr    p50 ${summary.latency.translationMs.p50} ms  p95 ${summary.latency.translationMs.p95} ms`,
      `mem   recognition ${mb(summary.memory.recognitionPeakFootprintBytes)}  translation ${mb(summary.memory.translationPeakFootprintBytes)} (peak footprint)`,
      `meaning ${Object.values(meaning).filter(Boolean).length}/${Object.keys(meaning).length} checks passed`,
      `wrote ${outPath}`,
    ].join("\n"),
  );

  if (partial) console.log("partial run: no baseline comparison");
  else {
    if (!baseline) console.log(`no baseline at ${baselinePath}; only manifest ceilings and known failures were applied`);
    for (const known of verdict.knownFailures) console.log(`known failure: ${known.check} (#${known.issue})`);
    for (const item of verdict.regressions) console.log(`REGRESSION: ${item}`);
    for (const item of verdict.unexpectedPasses) console.log(`UNEXPECTED PASS (remove from knownFailures): ${item}`);
    for (const item of verdict.informational) console.log(`info: ${item.metric} ${item.baseline} -> ${item.current}`);
    if (argv.includes("--update-baseline")) {
      if (!verdict.ok || env.dirty || summary.failures.source || summary.failures.translation)
        console.log("baseline NOT updated: it needs a clean tree and a run with no regressions, unexpected passes or helper failures");
      else {
        const { clips: _clips, ...recorded } = report;
        await writeFile(baselinePath, JSON.stringify(recorded, null, 2) + "\n");
        console.log(`baseline written to ${baselinePath}`);
      }
    }
    process.exitCode = verdict.ok ? 0 : 1;
  }
} catch (error) {
  console.error("speech benchmark failed:", error.message);
  process.exitCode = 1;
} finally {
  if (!finished) await finishBoth().catch(() => undefined);
  await rm(cache, { recursive: true, force: true });
}
