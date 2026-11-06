import type { ContextBundle } from "../contracts";
import { parseSegmentEvidence } from "../evidence";

/**
 * The history summary is written by a model. It helps the model keep track of
 * a long meeting but verifies nothing, so it never grounds a card.
 */
export const isDerivedEvidence = (id: string, context: ContextBundle) =>
  id.startsWith("summary:") ||
  !!context.sources.find((s) => s.sourceId === id)?.derived;

// Digits with optional thousands or decimal separators: 1,500 / 1.500 / 2,5 /
// 12'000 / 1 500 (with a no-break or thin space) / 14.03.2027.
const figure = /\d+(?:[.,'’  ]\d+)*/gu;
const separators = /[.,'’  ]/u;
/** A decimal string without leading zeros or trailing fractional zeros: "03" → "3", "2.50" → "2.5". */
const canonical = (whole: string, fraction = "") => {
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
};
type Convention = "en" | "de" | "either";
/**
 * The values a written figure can stand for. English writes 1,500.5 and German
 * 1.500,5; a thousands separator must be followed by exactly three digits, so
 * "2,5" is two and a half in either. "en" and "de" take that convention's
 * reading when it is valid and the other one otherwise; "either" keeps both,
 * so "1,500" is fifteen hundred or one and a half. Undefined when the figure is
 * not a single number, such as the date 14.03.2027.
 */
function readings(token: string, convention: Convention): string[] | undefined {
  if (/^\d+$/.test(token)) return [canonical(token)];
  const out: string[] = [];
  for (const decimal of convention === "de" ? [",", "."] : [".", ","]) {
    const parts = token.split(decimal);
    if (parts.length > 2) continue;
    const [whole, fraction] = parts;
    const groups = whole.split(separators);
    if (
      groups.length > 1 &&
      (groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))
    )
      continue;
    if (fraction !== undefined && !/^\d+$/.test(fraction)) continue;
    // "12,000" in a document of unknown convention is twelve thousand; nobody
    // writes twelve as 12.000, so that reading would only ground a misquote.
    if (convention === "either" && fraction !== undefined && /^0{3}$/.test(fraction))
      continue;
    out.push(canonical(groups.join(""), fraction));
    if (convention !== "either") break;
  }
  return out.length ? [...new Set(out)] : undefined;
}
/**
 * A day.month.year date such as 14.03.2027 or 1.4.27, with the day and month
 * in range. Only such a date stands for its parts: "1,500", "12.000" or "2.5"
 * are single figures, so "500", "12" or "5" never match them.
 */
function isDate(token: string): boolean {
  const m = /^(\d{1,2})([./])(\d{1,2})\2(\d{2}|\d{4})$/u.exec(token);
  if (!m) return false;
  const day = Number(m[1]),
    month = Number(m[3]);
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}
/** A figure that is neither one number nor a date, such as the version 2.3.1, matches only as written. */
const literal = (token: string) => `literal:${token.replace(/[.,'’  ]/gu, ".")}`;
/** Adds every number written in the text: each reading of a figure, and the day, month and year of a date. */
function addValues(text: string, convention: Convention, into: Set<string>) {
  for (const [token] of text.matchAll(figure)) {
    const values = readings(token, convention);
    for (const v of values ?? []) into.add(v);
    if (isDate(token))
      for (const part of token.split(separators)) into.add(canonical(part));
    else if (!values) into.add(literal(token));
  }
}
const conventionOf = (language: string): Convention =>
  language.startsWith("de") ? "de" : language.startsWith("en") ? "en" : "either";
/** Numbers the cited evidence contains: cited turns with their translations or originals, and cited documents. */
function citedValues(context: ContextBundle, evidence: string[]): Set<string> {
  const ids = new Set(
    evidence.flatMap((id) => parseSegmentEvidence(id)?.segmentId ?? []),
  );
  for (const e of context.conversation)
    if (ids.has(e.segmentId) && e.sourceSegmentId) ids.add(e.sourceSegmentId);
  const values = new Set<string>();
  for (const e of context.conversation)
    if (
      e.kind !== "partial" &&
      (ids.has(e.segmentId) ||
        (e.sourceSegmentId !== undefined && ids.has(e.sourceSegmentId)))
    )
      addValues(
        e.text,
        e.kind === "translation" ? "en" : conventionOf(e.language),
        values,
      );
  for (const s of context.sources)
    if (evidence.includes(s.sourceId) && !isDerivedEvidence(s.sourceId, context))
      addValues(`${s.title}\n${s.text}`, "either", values);
  return values;
}
/**
 * True when the card stands on verified evidence: it cites something other
 * than the derived summary, and every number, date, percentage or amount it
 * writes appears in that cited evidence. Anything else is an inference.
 */
export function cardGrounded(
  text: string,
  context: ContextBundle,
  evidence: string[],
): boolean {
  if (!evidence.some((id) => !isDerivedEvidence(id, context))) return false;
  const available = citedValues(context, evidence);
  // Cards are written in English, so their figures read the English way first.
  return [...text.matchAll(figure)].every(([token]) => {
    const whole = readings(token, "en");
    if (whole) return whole.some((v) => available.has(v));
    if (available.has(literal(token))) return true;
    return (
      isDate(token) &&
      token.split(separators).every((part) => available.has(canonical(part)))
    );
  });
}

/** Markers that cannot occur in escaped content, because "<" is written as < inside it. */
export const fence = (label: string, value: unknown) => {
  const body = JSON.stringify(value).replace(/</g, "\\u003c");
  return `<<<BEGIN UNTRUSTED ${label}>>>\n${body}\n<<<END UNTRUSTED ${label}>>>`;
};
/**
 * The prompt's evidence section. Meeting settings stay plain JSON; every
 * workspace source and the transcript are fenced by their own begin and end
 * markers so the model can tell supplied data from instructions, and any
 * marker-like text inside them is escaped so it cannot close a fence early.
 */
export function fencedEvidence(context: ContextBundle): string {
  // Stable first and volatile last, so consecutive prompts in a meeting share a long prefix (provider
  // prompt caching): settings that hold for the meeting, the sources in ID order (a new hit then
  // changes the text only from its own place, not by re-ranking), the transcript (new turns append),
  // and last the state that moves during the meeting. The revision counters are bookkeeping and are
  // left out: each source carries its own revision.
  const {
    sources,
    conversation,
    coveredObjectives,
    pinnedTopics,
    attributions,
    stateRevision: _state,
    indexRevision: _index,
    sourceRevisions: _revisions,
    ...settings
  } = context;
  return [
    JSON.stringify(settings),
    ...[...sources]
      .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
      .map((s) => fence(`SOURCE ${s.sourceId.replace(/[<>\s]/g, "_")}`, s)),
    fence("TRANSCRIPT", conversation),
    JSON.stringify({ coveredObjectives, pinnedTopics, attributions }),
  ].join("\n");
}
