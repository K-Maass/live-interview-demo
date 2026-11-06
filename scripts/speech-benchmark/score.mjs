// Pure scoring helpers for the speech and translation benchmark. No I/O, so CI can test them without models.

const WER_TOLERANCE = 0.02;

/** Fold width, case and punctuation; keep letters (umlauts, ß), digits, decimal/thousands separators and inner apostrophes. */
export function normalise(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[^\p{L}\p{N}\s'.,]/gu, " ")
    .replace(/(?<!\p{N})[.,]|[.,](?!\p{N})/gu, " ")
    .replace(/(?<!\p{L})'|'(?!\p{L})/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const words = (text) => (normalise(text) ? normalise(text).split(" ") : []);

export function wordErrors(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  const cost = Array.from({ length: ref.length + 1 }, (_, i) => {
    const row = new Array(hyp.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= hyp.length; j++) cost[0][j] = j;
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++)
      cost[i][j] = Math.min(
        cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
        cost[i - 1][j] + 1,
        cost[i][j - 1] + 1,
      );
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (let i = ref.length, j = hyp.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) substitutions++;
      i--;
      j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  return {
    substitutions,
    deletions,
    insertions,
    errors: substitutions + deletions + insertions,
    refWords: ref.length,
  };
}

/** Total errors over total reference words, so long clips weigh more than short ones. */
export function corpusWer(items) {
  const refWords = items.reduce((sum, item) => sum + item.refWords, 0);
  return refWords ? items.reduce((sum, item) => sum + item.errors, 0) / refWords : 0;
}

function ngrams(text, n) {
  const counts = new Map();
  for (let i = 0; i + n <= text.length; i++) {
    const gram = text.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Character n-gram F-score (chrF, n up to 6, beta 2). Reported as a similarity signal, never gated. */
export function chrF(reference, hypothesis, maxN = 6, beta = 2) {
  const ref = normalise(reference).replace(/ /gu, "");
  const hyp = normalise(hypothesis).replace(/ /gu, "");
  if (!ref && !hyp) return 1;
  let precision = 0;
  let recall = 0;
  let orders = 0;
  for (let n = 1; n <= maxN; n++) {
    const refGrams = ngrams(ref, n);
    const hypGrams = ngrams(hyp, n);
    const refTotal = [...refGrams.values()].reduce((a, b) => a + b, 0);
    const hypTotal = [...hypGrams.values()].reduce((a, b) => a + b, 0);
    if (!refTotal && !hypTotal) continue;
    orders++;
    let overlap = 0;
    for (const [gram, count] of hypGrams) overlap += Math.min(count, refGrams.get(gram) ?? 0);
    precision += hypTotal ? overlap / hypTotal : 0;
    recall += refTotal ? overlap / refTotal : 0;
  }
  if (!orders) return 0;
  precision /= orders;
  recall /= orders;
  if (!precision && !recall) return 0;
  return ((1 + beta ** 2) * precision * recall) / (beta ** 2 * precision + recall);
}

/** An assertion passes when any of its patterns occurs; it names a clause or fact the translation must keep. */
export function checkMeaning(assertions, text) {
  return assertions.map(({ id, anyOf }) => {
    if (!Array.isArray(anyOf) || !anyOf.length) throw Error(`meaning assertion ${id} needs a non-empty anyOf list`);
    return { id, passed: anyOf.some((pattern) => new RegExp(pattern, "iu").test(text)) };
  });
}

export function summariseLatency(values) {
  if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q) => sorted[Math.ceil(q * sorted.length) - 1];
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1),
  };
}

export function realTimeFactor(processingMs, audioMs) {
  if (!(audioMs > 0)) throw Error("audio duration must be positive");
  return processingMs / audioMs;
}

/** Duration of a PCM or float WAV file, found by walking its chunks so extra metadata chunks are skipped. */
export function wavDurationMs(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    throw Error("not a WAV file");
  let bytesPerSecond = 0;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") bytesPerSecond = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!bytesPerSecond) throw Error("WAV data chunk precedes fmt chunk");
      return (Math.min(size, buffer.length - offset - 8) / bytesPerSecond) * 1000;
    }
    offset += 8 + size + (size % 2);
  }
  throw Error("WAV file has no data chunk");
}

/** Parses `/usr/bin/time -l` output from macOS, where sizes are in bytes. */
export function parseTimeL(stderr) {
  const read = (label) => {
    const match = stderr.match(new RegExp(`^\\s*(\\d+)\\s+${label}`, "m"));
    return match ? Number(match[1]) : null;
  };
  return {
    maxResidentBytes: read("maximum resident set size"),
    peakFootprintBytes: read("peak memory footprint"),
  };
}

function leaves(value, path = "") {
  if (typeof value === "number") return [[path, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}

/**
 * Gates WER (ceiling and baseline tolerance) and meaning checks. Known failures are listed per route and
 * must be removed when they start passing. Latency and memory depend on hardware, so they are only reported.
 */
export function compare(result, baseline, manifest) {
  const regressions = [];
  const unexpectedPasses = [];
  const knownFailures = [];
  const known = (manifest.knownFailures ?? []).filter((entry) => entry.route === result.route);
  for (const [language, wer] of Object.entries(result.wer ?? {})) {
    const ceiling = manifest.werCeilings?.[language];
    if (ceiling !== undefined && wer > ceiling)
      regressions.push(`wer:${language} ${wer.toFixed(3)} exceeds ceiling ${ceiling}`);
    const previous = baseline?.wer?.[language];
    if (previous !== undefined && wer > previous + WER_TOLERANCE)
      regressions.push(`wer:${language} ${wer.toFixed(3)} regressed from baseline ${previous.toFixed(3)}`);
  }
  for (const [check, passed] of Object.entries(result.meaning ?? {})) {
    const entry = known.find((candidate) => candidate.check === check);
    if (!passed && entry) knownFailures.push({ check, issue: entry.issue });
    else if (!passed) regressions.push(`meaning:${check} failed`);
    else if (entry) unexpectedPasses.push(check);
  }
  const informational = [];
  for (const section of ["latency", "memory"]) {
    const before = new Map(leaves(baseline?.[section], section));
    for (const [metric, current] of leaves(result[section], section))
      if (before.has(metric)) informational.push({ metric, baseline: before.get(metric), current });
  }
  return {
    ok: !regressions.length && !unexpectedPasses.length,
    regressions,
    unexpectedPasses,
    knownFailures,
    informational,
  };
}
