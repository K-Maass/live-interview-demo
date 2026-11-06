export const skillForProfile = {
  interview: "research-interview",
  discovery: "client-discovery",
  workClient: "professional-meeting",
  presentationAnswering: "professional-meeting",
} as const;

/** Public concepts only. Private participants, paths, email addresses and opaque keys stay local. */
export function safePublicQuery(
  query: unknown,
  participantNames: string[],
): string | undefined {
  if (typeof query !== "string") return;
  const value = query.trim().replace(/\s+/g, " ");
  if (
    value.length < 8 ||
    value.length > 180 ||
    /[@/\\]|[A-Za-z0-9_-]{32,}|\b(?:password|api.?key|confidential|internal-only|secret)\b/i.test(
      value,
    )
  )
    return;
  const words: string[] = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (
    participantNames.some((name) =>
      name
        .toLowerCase()
        .split(/\s+/)
        .some((n) => n.length > 2 && words.includes(n)),
    )
  )
    return;
  return value;
}
const publicSubjects = [
  "FINMA",
  "Basel III",
  "EU AI Act",
  "GDPR",
  "DORA",
  "PCI DSS",
  "ISO 27001",
  "ISO 42001",
  "Microsoft Teams",
  "Microsoft Copilot",
  "GitHub Copilot",
  "ETH Zurich",
  "AI coding agents",
  "customer discovery",
  "process mining",
  "settlement reconciliation",
  "Open Banking",
  "PSD2",
];
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whole words only, so "DORA" is not found in "adorable". An acronym written in
 * capitals matches only in capitals: "Dora" is more likely a person than the
 * regulation, and a participant name must never leave for web search.
 */
const subjectPattern = (subject: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(subject)}(?![\\p{L}\\p{N}])`,
    subject === subject.toUpperCase() ? "u" : "iu",
  );
/** Only generic public concepts, or topics the user explicitly designates, leave for web search. */
export function publicResearchQueries(
  contextText: string,
  approvedTopics: string[] = [],
): string[] {
  const topics = [
    ...new Set([
      ...approvedTopics,
      ...publicSubjects.filter((t) => subjectPattern(t).test(contextText)),
    ]),
  ].filter(
    (t) => typeof t === "string" && t.trim().length > 1 && t.length <= 80,
  );
  return topics
    .flatMap((t) => [
      `${t.trim()} official documentation`,
      `${t.trim()} governance requirements`,
      `${t.trim()} practical implementation evidence`,
    ])
    .filter((q) => safePublicQuery(q, []) !== undefined)
    .slice(0, 45);
}
