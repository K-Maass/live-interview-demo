import type { ContextBundle } from "./contracts";
import { citedEvents } from "./evidence";
// Word boundaries are Unicode-aware lookarounds: `\b` and `[A-Z]` are ASCII-only
// even with the `u` flag, so names such as "Élodie" or "Ömer" would slip past.
const capitalisedName = "\\p{Lu}[\\p{L}'-]+(?:\\s+\\p{Lu}[\\p{L}'-]+){0,2}";
const claimVerbs =
  "committed|promised|agreed|said|stated|confirmed|will send|will provide|is responsible|owns|decided|believes";
// "Dana's team", "Dana’s office": the claim is still about Dana.
const possessive =
  "(?:['’]s?(?:\\s+(?:team|office|side|group|department|company|manager|assistant|colleagues?|people|lawyers?))?)?";
// Up to two adverbs or auxiliaries between the name and the verb: "Marco
// already agreed", "Priya has confirmed". Passive forms (was, been) are left
// out on purpose: "The price was agreed" names nobody.
const adverbs =
  "(?:\\s+(?:already|also|just|now|then|finally|explicitly|previously|earlier|again|clearly|personally|has|have|had)){0,2}";
const claimAround = (name: string) =>
  `(?<![\\p{L}\\p{N}])(${name})${possessive}${adverbs}\\s+(?:${claimVerbs})(?![\\p{L}\\p{N}])`;
const claimPattern = new RegExp(claimAround(capitalisedName), "gu");
// "According to Priya", "laut Priya", "Priya zufolge": attribution without a verb.
const accordingAround = (name: string) =>
  `(?<![\\p{L}\\p{N}])(?:[Aa]ccording to|[Ll]aut)\\s+(${name})(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])(${name})\\s+zufolge(?![\\p{L}\\p{N}])`;
const accordingPattern = new RegExp(accordingAround(capitalisedName), "gu");
const withoutPossessive = (name: string) => name.replace(/['’]s?$/u, "");
/**
 * Capitalised words that start a sentence or clause but name nobody: personal
 * pronouns, demonstratives, quantifiers and generic groups (English and
 * German). Because a pronoun or quantifier carries no identity, "They said" or
 * "Both stated" cannot attribute a statement to a specific person or
 * organization, so it is not a claim that needs a binding. Deliberately
 * excluded: "We" and "Wir" (they could vouch for a commitment by the user's side without any lane check), "You" (inside a claim it addresses the other party and is rejected
 * on purpose), roster and user names (checked separately below, whatever their
 * spelling), organization or team nouns ("Management", "Legal", "Team"), which
 * stay subject to `organizationCited`, and words that are also given names
 * ("Man", "Will", "Mark").
 */
const nonNameSubjects = new Set([
  // English pronouns and demonstratives
  "they", "he", "she", "it", "this", "that", "these", "those",
  // English quantifiers and indefinites
  "both", "all", "each", "either", "neither", "none", "some", "many", "most",
  "few", "several", "others", "everyone", "everybody", "nobody", "someone",
  "somebody", "anyone", "anybody",
  // English generic groups
  "participants", "attendees",
  // German
  "sie", "er", "es", "ich", "beide", "alle", "jeder", "jemand",
  "niemand", "keiner", "einige", "viele", "andere", "teilnehmer",
]);
// Only the sentence-initial form ("They", "Both") counts. An all-caps token such as "IT" or "ALL" is an acronym or
// a team name, so it stays a claim that needs a binding. "Ich" is listed for the same reason as English "I", which
// the two-character minimum in `claimPattern` never matched.
const isNonNameSubject = (name: string) =>
  name === name[0] + name.slice(1).toLowerCase() &&
  nonNameSubjects.has(name.toLowerCase());
const rosterVerbs =
  "committed|promised|agreed|said|stated|confirmed|will|owns|responsible|decided|believes";
/** Neutral owner label when the app has no display name for the user. */
export const NEUTRAL_SELF_NAME = "You";
/**
 * The name the `me` lane is bound to. It comes from the app (the signed-in
 * account's display name), never from diarization or from a transcript, and
 * falls back to a neutral label so no personal name is ever hard-coded.
 */
export function userSelfName(selfName?: string | null): string {
  const value =
    typeof selfName === "string" ? selfName.replace(/\s+/g, " ").trim() : "";
  return value && value.length <= 80 && !value.includes("@")
    ? value
    : NEUTRAL_SELF_NAME;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/**
 * True when `name` is the user's own full name. The neutral "You" is accepted
 * only as an owner label: inside a claim it addresses the other party, so it
 * can never vouch for an assertion. Partial names (a first name) never match,
 * because an unrostered remote speaker may share them.
 */
function isSelf(
  name: string,
  context: ContextBundle,
  asOwner: boolean,
): boolean {
  const self = userSelfName(context.selfName);
  if (same(name, self)) return self !== NEUTRAL_SELF_NAME || asOwner;
  return asOwner && same(name, NEUTRAL_SELF_NAME);
}
/**
 * Generic organizational function nouns. They never name a person, and a
 * single one only counts when the evidence writes it as a proper name in
 * mid-sentence (see `organizationCited`).
 */
const organizationNouns = new Set([
  "department", "departments", "division", "unit", "units", "committee",
  "regulator", "agency", "council", "corporation", "business",
  "management", "leadership", "compliance", "legal", "finance",
  "procurement", "security", "audit", "risk", "operations", "engineering",
  "sales", "marketing", "support",
]);
const legalSuffixes = new Set([
  "GmbH", "AG", "SE", "SA", "BV", "NV", "Inc", "Ltd", "LLC", "PLC", "Plc", "Corp", "Co",
]);
const trimPunctuation = (name: string) =>
  name.trim().replace(/[.,;:]+$/, "").replace(/^the\s+/i, "");
/**
 * An organization is a phrase ending in an organizational noun ("Central
 * Compliance", "Business Units") or a legal-entity suffix ("Acme GmbH"). A bare
 * proper name could be a person, so it is never treated as an organization.
 */
function organizationKind(name: string): "legal" | "function" | undefined {
  const tokens = trimPunctuation(name).split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (legalSuffixes.has(last) && tokens.length > 1) return "legal";
  return organizationNouns.has(last.toLowerCase()) ? "function" : undefined;
}
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * An organization is supported only when its name appears in the cited
 * evidence exactly as written. Function names ("Compliance") must be written
 * capitalised and not as the first word of a sentence, so ordinary words such
 * as "support" or "Support the rollout" do not qualify.
 */
function organizationCited(
  name: string,
  context: ContextBundle,
  evidence: string[],
): boolean {
  const kind = organizationKind(name);
  if (!kind) return false;
  const phrase = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(trimPunctuation(name))}(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const written = (text: string) =>
    [...text.matchAll(phrase)].some(
      (m) =>
        kind === "legal" ||
        (m.index > 0 &&
          !/(^|[.!?…\n])\s*$/.test(text.slice(0, m.index))),
    );
  return (
    citedEvents(context.conversation, evidence).some((e) => written(e.text)) ||
    context.sources.some(
      (s) => evidence.includes(s.sourceId) && written(s.text),
    )
  );
}
/**
 * Name parts that are also everyday words or particles. A participant's first
 * or last name alone otherwise stands for that participant, but "Will Baker"
 * must not turn "Will" into a claim, nor "Ann Price" "Price".
 */
const commonNameParts = new Set([
  "will", "may", "mark", "can", "bill", "grant", "frank", "hope", "rich",
  "june", "april", "august", "summer", "rose", "price", "long", "young",
  "love", "page", "case", "chase", "field", "king", "wolf", "klein", "lang",
  "kurz", "weiss", "schwarz", "braun", "fuchs", "vogel", "bauer",
  "van", "von", "der", "den", "del", "ten",
]);
/** Parts of a participant's name that stand for them alone: at least three letters and not a common word. */
const nameParts = (name: string) =>
  name
    .split(/\s+/u)
    .filter(
      (part) =>
        part.length >= 3 &&
        !commonNameParts.has(part.toLowerCase()) &&
        !nonNameSubjects.has(part.toLowerCase()),
    );
/**
 * The participant a claimed name refers to: the full name in any casing, or a
 * single name part ("Marco" for "Marco Rossi") that belongs to exactly one
 * participant. A part two participants share names neither of them.
 */
function participantNamed(name: string, context: ContextBundle) {
  const people = context.participants ?? [];
  const full = people.find((p) => same(p.name, name));
  if (full) return full;
  const partly = people.filter((p) =>
    nameParts(p.name).some((part) => same(part, name)),
  );
  return partly.length === 1 ? partly[0] : undefined;
}
/** "Monday's agenda" → "Monday", "Dem Protokoll" → "Protokoll". */
const sourceName = (name: string) =>
  withoutPossessive(name).replace(/^(?:the|der|die|das|dem|den|des)\s+/iu, "");
/**
 * True when a cited turn or a cited workspace document (never the derived
 * summary) mentions the named source of a statement, in any casing: "ACME"
 * for "Acme", "slack" for "Slack".
 */
function sourceMentioned(
  name: string,
  context: ContextBundle,
  evidence: string[],
): boolean {
  const phrase = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(sourceName(name))}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return (
    citedEvents(context.conversation, evidence).some((e) =>
      phrase.test(e.text),
    ) ||
    context.sources.some(
      (s) =>
        evidence.includes(s.sourceId) &&
        !s.derived &&
        !s.sourceId.startsWith("summary:") &&
        (phrase.test(s.text) || phrase.test(s.title)),
    )
  );
}
export type ClaimSupport = "supported" | "uncertain" | "rejected";
/** A named live-speaker assertion must have an actual supported binding, never a roster guess. */
export function namedClaimsSupported(
  text: string,
  context: ContextBundle,
  evidence: string[],
): boolean {
  return claimSupport(text, context, evidence) !== "rejected";
}
/**
 * How far the text's named attributions are supported. A claim about a
 * participant or the user ("Marco agreed", "according to Marco") needs a
 * binding, and any other named subject of a claim verb ("Priya confirmed") is
 * rejected without one. "According to X", "laut X" and "X zufolge" with an X
 * that is neither a participant nor the user names a source such as
 * Salesforce or Monday's agenda: it never rejects the text, but it is
 * "uncertain" unless a cited turn or document mentions X.
 */
export function claimSupport(
  text: string,
  context: ContextBundle,
  evidence: string[],
): ClaimSupport {
  const original = text;
  const claims: string[] = [];
  // Names introduced by "according to", "laut" or "zufolge". A cited workspace
  // document that names them may vouch for these, unless they are people in
  // the meeting.
  const according = new Set<string>();
  // The user's full name is matched explicitly and removed before the generic
  // capital-word scan, so particles or four-word names ("Anna de Vries") are
  // judged as the user rather than as a fragment such as "Vries".
  const self = userSelfName(context.selfName);
  if (self !== NEUTRAL_SELF_NAME) {
    const escapedSelf = escapeRegExp(self);
    if (
      new RegExp(`${escapedSelf}.{0,24}\\b(?:${rosterVerbs})\\b`, "iu").test(
        text,
      ) ||
      new RegExp(accordingAround(escapedSelf), "iu").test(text)
    )
      claims.push(self);
    text = text.replace(new RegExp(escapedSelf, "giu"), " ");
  }
  claims.push(
    ...[...text.matchAll(claimPattern)]
      .map((m) => withoutPossessive(m[1]))
      .filter((name) => !isNonNameSubject(name)),
  );
  for (const m of text.matchAll(accordingPattern)) {
    const name = withoutPossessive(m[1] ?? m[2]);
    if (isNonNameSubject(name)) continue;
    claims.push(name);
    according.add(name);
  }
  // A roster name in any casing cannot sneak past the general capital-name scanner.
  for (const person of context.participants ?? []) {
    const escaped = escapeRegExp(person.name);
    if (
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}]).{0,24}(?<![\\p{L}\\p{N}])(?:${rosterVerbs})(?![\\p{L}\\p{N}])`,
        "iu",
      ).test(
        original,
      ) ||
      new RegExp(accordingAround(escaped), "iu").test(original)
    )
      claims.push(person.name);
    // A single name part as the roster writes it: "Marco agreed" for "Marco
    // Rossi". Case-sensitive, so a name part that is also a word stays a word.
    for (const part of nameParts(person.name)) {
      const escapedPart = escapeRegExp(part);
      if (
        new RegExp(claimAround(escapedPart), "u").test(original) ||
        new RegExp(accordingAround(escapedPart), "u").test(original)
      )
        claims.push(part);
    }
  }
  // Names that only appear after "according to" and are no person in the
  // meeting are sources, judged separately below.
  const isPerson = (name: string) =>
    isSelf(name, context, true) ||
    !!participantNamed(name, context) ||
    (context.participants ?? []).some((p) =>
      nameParts(p.name).some((part) => same(part, name)),
    );
  const verbClaims = new Set(
    claims.filter((name) => !according.has(name) || isPerson(name)),
  );
  // A name in both forms ("According to Priya, ... Priya confirmed") stays a claim.
  for (const m of text.matchAll(claimPattern))
    verbClaims.add(withoutPossessive(m[1]));
  const cited = citedEvents(context.conversation, evidence);
  const supported = [...verbClaims]
    .filter((name) => claims.includes(name))
    .every((name) => {
      // The microphone is the user: a lane binding, never inferred from speech.
      if (isSelf(name, context, false) && cited.some((e) => e.lane === "me"))
        return true;
      if (organizationCited(name, context, evidence)) return true;
      const person = participantNamed(name, context);
      if (!person) return false;
      return cited.some(
        (e) =>
          e.speakerClusterId &&
          context.attributions?.some(
            (a) =>
              a.clusterId === e.speakerClusterId &&
              a.personId === person.id &&
              (a.status === "established" ||
                (a.status === "confirmed" && a.confirmedByUser)),
          ),
      );
    });
  if (!supported) return "rejected";
  const sources = [...according].filter((name) => !verbClaims.has(name));
  return sources.every(
    (name) =>
      organizationCited(name, context, evidence) ||
      sourceMentioned(name, context, evidence),
  )
    ? "supported"
    : "uncertain";
}
export function supportedOwner(
  owner: string | null,
  context: ContextBundle,
  evidence: string[],
): string | null {
  if (!owner || typeof owner !== "string") return null;
  const person = participantNamed(owner, context);
  if (person)
    return namedClaimsSupported(`${person.name} committed`, context, evidence)
      ? person.name
      : null;
  if (isSelf(owner, context, true))
    return citedEvents(context.conversation, evidence).some(
      (e) => e.lane === "me",
    )
      ? userSelfName(context.selfName)
      : null;
  return organizationCited(owner, context, evidence) ? owner : null;
}
