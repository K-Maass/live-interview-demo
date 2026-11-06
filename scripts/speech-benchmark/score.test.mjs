import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMeaning,
  chrF,
  compare,
  corpusWer,
  normalise,
  parseTimeL,
  realTimeFactor,
  summariseLatency,
  wavDurationMs,
  wordErrors,
} from "./score.mjs";

test("normalise folds case, punctuation and width but keeps German letters", () => {
  assert.equal(
    normalise("Die Fachabteilung entscheidet, ob wir „live“ gehen!"),
    "die fachabteilung entscheidet ob wir live gehen",
  );
  assert.equal(normalise("Straße  ÄÖÜ"), "straße äöü");
  assert.equal(normalise("It’s 3.5 percent — really?"), "it's 3.5 percent really");
  assert.equal(normalise("ＡＢＣ　ｄｅｆ"), "abc def");
});

test("normalise keeps decimal numbers and thousands separators intact", () => {
  assert.equal(normalise("Es kostet 1.200,50 Euro."), "es kostet 1.200,50 euro");
});

test("wordErrors counts substitutions, deletions and insertions", () => {
  const exact = wordErrors("the cat sat", "the cat sat");
  assert.deepEqual(exact, { substitutions: 0, deletions: 0, insertions: 0, errors: 0, refWords: 3 });
  assert.deepEqual(wordErrors("the cat sat", "the dog sat"), {
    substitutions: 1,
    deletions: 0,
    insertions: 0,
    errors: 1,
    refWords: 3,
  });
  assert.deepEqual(wordErrors("the cat sat down", "the cat"), {
    substitutions: 0,
    deletions: 2,
    insertions: 0,
    errors: 2,
    refWords: 4,
  });
  assert.deepEqual(wordErrors("the cat", "the big cat sat"), {
    substitutions: 0,
    deletions: 0,
    insertions: 2,
    errors: 2,
    refWords: 2,
  });
});

test("wordErrors ignores case and punctuation differences", () => {
  assert.equal(wordErrors("Compliance entscheidet.", "compliance entscheidet").errors, 0);
});

test("wordErrors treats a transcript that dropped everything as all deletions", () => {
  assert.deepEqual(wordErrors("one two three", ""), {
    substitutions: 0,
    deletions: 3,
    insertions: 0,
    errors: 3,
    refWords: 3,
  });
});

test("corpusWer weights by reference length instead of averaging per clip", () => {
  const short = wordErrors("a b", "x y");
  const long = wordErrors("a b c d e f g h i j", "a b c d e f g h i j");
  assert.equal(corpusWer([short, long]), 2 / 12);
  assert.equal(corpusWer([]), 0);
});

test("chrF is 1 for identical text, 0 for disjoint text and rewards partial overlap", () => {
  assert.equal(chrF("The department decides.", "the department decides"), 1);
  assert.equal(chrF("abc", "xyz"), 0);
  const partial = chrF("the department decides whether we go live", "the department decides");
  assert(partial > 0.3 && partial < 1, `partial=${partial}`);
  assert.equal(chrF("", ""), 1);
  assert.equal(chrF("something", ""), 0);
});

test("checkMeaning passes an assertion when any pattern matches and reports each by id", () => {
  const assertions = [
    { id: "launch-decision", anyOf: ["decid", "choos"] },
    { id: "evidence-retention", anyOf: ["keep", "retain"] },
  ];
  assert.deepEqual(
    checkMeaning(assertions, "The department decides whether we go live."),
    [
      { id: "launch-decision", passed: true },
      { id: "evidence-retention", passed: false },
    ],
  );
});

test("checkMeaning matches case-insensitively and an empty transcript fails everything", () => {
  assert.equal(checkMeaning([{ id: "a", anyOf: ["COMPLIANCE"] }], "compliance is here")[0].passed, true);
  assert.equal(checkMeaning([{ id: "a", anyOf: ["x"] }], "")[0].passed, false);
});

test("checkMeaning rejects assertions without patterns instead of silently passing", () => {
  assert.throws(() => checkMeaning([{ id: "a", anyOf: [] }], "text"), /anyOf/);
});

test("summariseLatency reports nearest-rank percentiles", () => {
  const summary = summariseLatency([100, 200, 300, 400, 1000]);
  assert.deepEqual(summary, { count: 5, mean: 400, p50: 300, p95: 1000, max: 1000 });
  assert.deepEqual(summariseLatency([]), { count: 0, mean: 0, p50: 0, p95: 0, max: 0 });
});

test("realTimeFactor divides processing time by audio duration", () => {
  assert.equal(realTimeFactor(2500, 5000), 0.5);
  assert.throws(() => realTimeFactor(100, 0), /duration/);
});

function wav({ rate, channels, bytesPerSample, frames, extraChunk = false }) {
  const data = Buffer.alloc(frames * channels * bytesPerSample);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(bytesPerSample === 4 ? 3 : 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bytesPerSample, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(bytesPerSample * 8, 22);
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
  const dataHeader = Buffer.concat([Buffer.from("data"), Buffer.alloc(4)]);
  dataHeader.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, ...(extraChunk ? [list] : []), dataHeader, data]);
  const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4)]);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test("wavDurationMs reads sample rate, width and data size, skipping unrelated chunks", () => {
  assert.equal(wavDurationMs(wav({ rate: 16000, channels: 1, bytesPerSample: 2, frames: 80000 })), 5000);
  assert.equal(wavDurationMs(wav({ rate: 16000, channels: 1, bytesPerSample: 4, frames: 8000, extraChunk: true })), 500);
  assert.equal(wavDurationMs(wav({ rate: 48000, channels: 2, bytesPerSample: 2, frames: 24000 })), 500);
  assert.throws(() => wavDurationMs(Buffer.from("not a wav file at all")), /WAV/);
});

test("parseTimeL extracts peak resident size and peak footprint in bytes", () => {
  const stderr = [
    "        3.21 real         1.00 user         0.50 sys",
    "           123456789  maximum resident set size",
    "                   0  average shared memory size",
    "           234567890  peak memory footprint",
  ].join("\n");
  assert.deepEqual(parseTimeL(stderr), {
    maxResidentBytes: 123456789,
    peakFootprintBytes: 234567890,
  });
  assert.deepEqual(parseTimeL("nothing useful"), { maxResidentBytes: null, peakFootprintBytes: null });
});

const manifest = {
  werCeilings: { de: 0.3, en: 0.2 },
  knownFailures: [
    { route: "medium", check: "utterance-1/compliance-evidence", issue: 29 },
  ],
};
const baseline = {
  wer: { de: 0.1, en: 0.05 },
  latency: { sourceMs: { p50: 1000 } },
  memory: { recognitionPeakFootprintBytes: 1_000_000_000 },
};
const passing = {
  route: "medium",
  wer: { de: 0.1, en: 0.05 },
  meaning: { "utterance-1/compliance-evidence": false, "utterance-0/owner": true },
  latency: { sourceMs: { p50: 1200 } },
  memory: { recognitionPeakFootprintBytes: 1_100_000_000 },
};

test("compare reports a clean run with known failures listed", () => {
  const report = compare(passing, baseline, manifest);
  assert.deepEqual(report.regressions, []);
  assert.deepEqual(report.unexpectedPasses, []);
  assert.deepEqual(report.knownFailures, [{ check: "utterance-1/compliance-evidence", issue: 29 }]);
  assert.equal(report.ok, true);
});

test("compare flags WER above the baseline tolerance but ignores noise within it", () => {
  const within = compare({ ...passing, wer: { de: 0.115, en: 0.05 } }, baseline, manifest);
  assert.equal(within.ok, true);
  const worse = compare({ ...passing, wer: { de: 0.13, en: 0.05 } }, baseline, manifest);
  assert.equal(worse.ok, false);
  assert.match(worse.regressions[0], /wer:de/);
});

test("compare flags WER above the manifest ceiling even without a baseline", () => {
  const report = compare({ ...passing, wer: { de: 0.35, en: 0.05 } }, undefined, manifest);
  assert.equal(report.ok, false);
  assert.match(report.regressions.join("\n"), /wer:de.*ceiling/);
});

test("compare treats an unlisted failing meaning check as a regression", () => {
  const report = compare(
    { ...passing, meaning: { ...passing.meaning, "utterance-0/owner": false } },
    baseline,
    manifest,
  );
  assert.equal(report.ok, false);
  assert.match(report.regressions[0], /utterance-0\/owner/);
});

test("compare fails on a known failure that now passes so the list stays honest", () => {
  const report = compare(
    { ...passing, meaning: { ...passing.meaning, "utterance-1/compliance-evidence": true } },
    baseline,
    manifest,
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.unexpectedPasses, ["utterance-1/compliance-evidence"]);
});

test("compare applies known failures only to their own route", () => {
  const report = compare({ ...passing, route: "apple" }, baseline, manifest);
  assert.equal(report.ok, false);
  assert.match(report.regressions[0], /utterance-1\/compliance-evidence/);
});

test("compare reports latency and memory deltas without gating on them", () => {
  const report = compare(
    { ...passing, latency: { sourceMs: { p50: 5000 } }, memory: { recognitionPeakFootprintBytes: 4_000_000_000 } },
    baseline,
    manifest,
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.informational, [
    { metric: "latency.sourceMs.p50", baseline: 1000, current: 5000 },
    { metric: "memory.recognitionPeakFootprintBytes", baseline: 1_000_000_000, current: 4_000_000_000 },
  ]);
});
