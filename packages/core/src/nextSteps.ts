import type { ContextBundle } from "./contracts";
import { claimSupport, namedClaimsSupported, supportedOwner } from "./claimAttribution";
import { citedEvents, segmentEvidenceId } from "./evidence";
import { assembleTranscripts } from "./transcripts";
export interface NextStep {
  task: string;
  inferred: boolean;
  owner: string | null;
  due: string | null;
  evidence: string[];
}
const commitmentPhrase =
  /(?<![\p{L}\p{N}])(?:(?:I|we) (?:will|shall|agree|commit|promise)|(?:I|we)['’]ll|(?:ich|wir) (?:werde|werden|schicke|sende|übernehme)|(?:schicke|sende|übernehme|mache) ich|(?:schicken|senden|übernehmen|machen) wir|(?:committed|agreed to|promised)(?![\p{L}\p{N}]))/giu;
const stopWords = new Set([
  "that", "this", "with", "from", "into", "about", "after", "before", "them",
  "they", "their", "then", "than", "have", "will", "shall", "would", "should",
  "could", "also", "just", "your", "ours", "what", "when", "which",
]);
/** Content words, compared on a four-letter prefix so "price" and "pricing" match. */
const stems = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length >= 4 && !stopWords.has(w))
      .map((w) => w.slice(0, 4)),
  );
// Deadline and emphasis idioms that contain a negation word but refuse
// nothing: "no later than Friday", "nicht später als Freitag".
const negationIdioms =
  /(?<![\p{L}\p{N}])(?:no(?:t)? later than|not before|no sooner than|no matter|nicht später als|nicht nach|spätestens)(?![\p{L}\p{N}])/giu;
const withoutIdioms = (text: string) => text.replace(negationIdioms, " ");
// Negations that refuse wherever they sit in the commitment's own clause:
// "we never agreed to", "Ich schicke den Vertrag nicht", "wir werden keinen".
// German puts "nicht" late, so it is checked across the clause.
const strongNegation =
  /(?<![\p{L}\p{N}])(?:never|cannot|nicht|nie|niemals|kein\p{L}*)(?![\p{L}\p{N}])|n['’]t(?![\p{L}\p{N}])/iu;
// "no" and "not" refuse only next to the commitment verb ("I will not send",
// "we have not agreed to", "I will send no report"); elsewhere they are
// ordinary words ("with no delay").
const nearNegation = /(?<![\p{L}\p{N}])(?:not|no|nothing)(?![\p{L}\p{N}])/iu;
/** Any negation in a whole utterance, idioms aside. */
const negated = (text: string) => {
  const plain = withoutIdioms(text);
  return strongNegation.test(plain) || nearNegation.test(plain);
};
// A hedge or condition anywhere in the commitment's sentence: "if legal
// approves, we will send", "we will see if the budget allows",
// "ich schicke ihn vielleicht", "once the data is in". A conditional phrase
// usually precedes the main clause after a comma, so it is checked over the
// whole sentence. "should" and "sollte" are always a hedge here: when in doubt
// the step stays inferred.
const hedge =
  /(?<![\p{L}\p{N}])(?:if|whether|unless|once|whenever|provided|assuming|subject to|pending|should|maybe|might|perhaps|probably|possibly|hopefully|try to|see if|depends|depending|I think|I guess|I believe|ob|wenn|falls|sofern|sobald|vorbehaltlich|sollte|sollten|hängt davon ab|abhängig|ich denke|ich glaube|vielleicht|eventuell|wahrscheinlich|möglicherweise|vermutlich|versuchen|versuche|mal sehen)(?![\p{L}\p{N}])/iu;
// Sentence ends: "!", "?", ";", a line break, or a single full stop before a
// capital letter or the end. "3.30 pm" and "..." do not end a sentence.
const sentenceEnd = /[!?;\n]|(?<!\.)\.(?!\.)(?=\s+\p{Lu}|\s*$)/gu;
const boundaries = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
// Clause ends inside a sentence: commas and colons, and a coordinating
// conjunction that starts a new clause ("and I won't forget").
const clauseEnd = /[,:]|(?<![\p{L}\p{N}])(?:and|but|und|aber|sondern)(?![\p{L}\p{N}])/giu;
type Commitment = "commits" | "guarded" | "none";
/**
 * Whether the text commits to this task: a commitment phrase whose own
 * clause shares content words with the task. A phrase about something else
 * ("we will see if budget allows") leaves the step an inference, and so does
 * a matching phrase that is negated, conditional or hedged ("guarded"). When
 * in doubt the step stays inferred.
 */
function commitsTo(text: string, task: string): Commitment {
  const wanted = stems(task);
  const ends = boundaries(text, sentenceEnd);
  let result: Commitment = "none";
  for (const m of text.matchAll(commitmentPhrase)) {
    const start = m.index,
      end = start + m[0].length;
    const sentenceStart = Math.max(
      0,
      ...ends.filter((b) => b.end <= start).map((b) => b.end),
    );
    const sentenceStop =
      ends.find((b) => b.start >= end)?.start ?? text.length;
    const sentence = text.slice(sentenceStart, sentenceStop);
    const clauses = boundaries(sentence, clauseEnd).map((b) => ({
      start: b.start + sentenceStart,
      end: b.end + sentenceStart,
    }));
    const clauseStart = Math.max(
      sentenceStart,
      ...clauses.filter((b) => b.end <= start).map((b) => b.end),
    );
    const clauseStop =
      clauses.find((b) => b.start >= end)?.start ?? sentenceStop;
    // The task's words may precede a verb-second phrase ("Den Bericht schicke
    // ich"), so the whole clause is compared, through to the sentence end.
    if (![...stems(text.slice(clauseStart, sentenceStop))].some((w) => wanted.has(w)))
      continue;
    const before = withoutIdioms(text.slice(clauseStart, start));
    const rest = withoutIdioms(text.slice(end, clauseStop));
    const nextWords = rest.trim().split(/\s+/u).slice(0, 2).join(" ");
    const refused =
      strongNegation.test(before + " " + m[0] + " " + rest) ||
      nearNegation.test(before) ||
      nearNegation.test(nextWords);
    if (refused || hedge.test(sentence)) result = "guarded";
    else if (result === "none") result = "commits";
  }
  return result;
}
const translationsOf = (
  e: ContextBundle["conversation"][number],
  context: ContextBundle,
) =>
  context.conversation.filter(
    (t) =>
      t.kind === "translation" &&
      t.sourceSegmentId === e.segmentId &&
      t.revision === e.revision &&
      t.lane === e.lane,
  );
/**
 * `currentOnly` is for newly generated steps: they may cite only the current
 * revision of a segment. Without it (re-reading saved steps) any recorded
 * revision is accepted, and legacy bare `segment:ID` references keep working.
 */
export function groundNextSteps(
  output: unknown,
  context: ContextBundle,
  options: { currentOnly?: boolean } = {},
): NextStep[] {
  if (!Array.isArray(output)) return [];
  const ids = new Set([
    ...(options.currentOnly
      ? assembleTranscripts(context.conversation).source.map(segmentEvidenceId)
      : context.conversation.flatMap((e) => [
          `segment:${e.segmentId}`,
          segmentEvidenceId(e),
        ])),
    ...context.sources.map((s) => s.sourceId),
  ]);
  return output
    .filter(
      (s): s is NextStep =>
        !!s &&
        typeof s.task === "string" &&
        s.task.length < 1200 &&
        !s.task.trim().endsWith("?") &&
        typeof s.inferred === "boolean" &&
        (s.owner === null || typeof s.owner === "string") &&
        (s.due === null || typeof s.due === "string") &&
        Array.isArray(s.evidence) &&
        s.evidence.every(
          (id: unknown) => typeof id === "string" && ids.has(id),
        ) &&
        namedClaimsSupported(s.task, context, s.evidence),
    )
    .map((s) => {
      const cited = citedEvents(context.conversation, s.evidence);
      // The source language is authoritative: a hedge in the original or in
      // any translation of it keeps the step an inference. The task is
      // usually English, so when only a translation matches it, any hedge or
      // negation in the original utterance is enough to doubt the translation.
      const commitment = cited.some((e) => {
        if (e.kind !== "final") return false;
        const own = commitsTo(e.text, s.task);
        const translated = translationsOf(e, context).map((t) =>
          commitsTo(t.text, s.task),
        );
        if (own === "guarded" || translated.includes("guarded")) return false;
        return (
          own === "commits" ||
          (translated.includes("commits") &&
            !hedge.test(e.text) &&
            !negated(e.text))
        );
      });
      return {
        ...s,
        // A source named by "according to" that no cited evidence mentions
        // leaves the step an inference.
        inferred:
          s.inferred ||
          !commitment ||
          claimSupport(s.task, context, s.evidence) === "uncertain",
        owner: supportedOwner(s.owner, context, s.evidence),
        due: s.due && cited.some((e) => e.text.includes(s.due!)) ? s.due : null,
      };
    });
}
