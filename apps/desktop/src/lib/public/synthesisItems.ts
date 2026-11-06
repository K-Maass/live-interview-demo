import type {
  PublicArtifact,
  SynthesisItem,
  SynthesisItemKind,
} from "@live-interview/core";
export const synthesisKinds: SynthesisItemKind[] = [
  "discussed",
  "decision",
  "commitment",
  "openQuestion",
  "recommendation",
];
export const synthesisSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: synthesisKinds },
          text: { type: "string", minLength: 1, maxLength: 2000 },
          evidence: { type: "array", maxItems: 20, items: { type: "string" } },
        },
        required: ["kind", "text", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};
// Display order puts what was agreed before what is only suggested.
const sectionOrder: SynthesisItemKind[] = [
  "decision",
  "commitment",
  "discussed",
  "openQuestion",
  "recommendation",
];
const labels: Record<SynthesisItemKind, string> = {
  decision: "Decisions",
  commitment: "Commitments",
  discussed: "Discussed",
  openQuestion: "Open questions",
  recommendation: "Suggested next steps (inferred, not agreed)",
};
// Only these kinds claim something happened in the conversation, so they must cite it.
const needsEvidence = new Set<SynthesisItemKind>([
  "decision",
  "commitment",
  "discussed",
]);
export function synthesisSections(items: SynthesisItem[]) {
  return sectionOrder
    .map((kind) => ({
      kind,
      label: labels[kind],
      inferred: kind === "recommendation",
      items: items.filter((item) => item.kind === kind),
    }))
    .filter((section) => section.items.length);
}
export function omittedNote(omitted: number) {
  return `${omitted} ${omitted === 1 ? "item" : "items"} left out: no supporting evidence`;
}
export function renderSynthesisText(items: SynthesisItem[], omitted = 0) {
  const sections = synthesisSections(items).map(
    (section) =>
      `${section.label}\n${section.items.map((item) => `- ${item.text}`).join("\n")}`,
  );
  return (omitted ? [...sections, omittedNote(omitted)] : sections).join(
    "\n\n",
  );
}
// Structurally malformed output fails the whole synthesis. An item that is well-formed but
// lacks valid evidence (none where required, or an ID outside the transcript) is dropped and
// counted so the reader is told; only when nothing survives does generation fail.
export function parseSynthesisItems(output: unknown, allowed: string[]) {
  const raw = (output as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || !raw.length || raw.length > 40)
    throw Error("ungroundedOutput");
  const items: SynthesisItem[] = [];
  let omitted = 0;
  let invented = false;
  for (const entry of raw) {
    const item = entry as Partial<SynthesisItem> | null;
    if (
      !item ||
      !synthesisKinds.includes(item.kind as SynthesisItemKind) ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > 2000 ||
      !Array.isArray(item.evidence) ||
      item.evidence.length > 20 ||
      item.evidence.some((id) => typeof id !== "string")
    )
      throw Error("ungroundedOutput");
    const evidence = [...new Set(item.evidence)];
    if (evidence.some((id) => !allowed.includes(id))) {
      invented = true;
      omitted++;
    } else if (
      needsEvidence.has(item.kind as SynthesisItemKind) &&
      !evidence.length
    )
      omitted++;
    else items.push({ kind: item.kind as SynthesisItemKind, text: item.text, evidence });
  }
  const evidence = [...new Set(items.flatMap((item) => item.evidence))];
  if (!evidence.length) throw Error(invented ? "ungroundedOutput" : "ungrounded");
  return {
    items,
    text: renderSynthesisText(items, omitted),
    evidence,
    ...(omitted ? { omitted } : {}),
  };
}
// A human edit makes the text authoritative: typed items and AI evidence links no longer describe it.
export function humanEditedSynthesis(
  base: PublicArtifact,
  text: string,
): PublicArtifact {
  const { items: _items, omitted: _omitted, ...rest } = base;
  return { ...rest, text, humanEdited: true, evidence: [] };
}
/**
 * What a record change does to the synthesis editor. The same record at a new revision (late translation, a retry)
 * keeps the person's unsaved edits and says so; a different record, or an editor with nothing unsaved, starts clean.
 */
export function draftOnRecordChange(previous: { recordId?: string; dirty: boolean }, recordId: string): { keep: boolean; message?: string } {
  return previous.dirty && previous.recordId === recordId ? { keep: true, message: "Record updated; your edits are kept" } : { keep: false };
}
/**
 * The artifact a kept edit is saved against: the new revision's synthesis when there is one, otherwise the one the
 * edit was started on, moved to the new revision (saving it as human-edited clears its old evidence links anyway).
 */
export function keptEditBase(latest: PublicArtifact | null, previous: PublicArtifact | null | undefined, revision: number): PublicArtifact | null {
  if (latest) return latest;
  return previous ? { ...previous, recordRevision: revision } : null;
}
// The saved synthesis as Markdown for pasting into notes, chat or email. Section labels become headings, so the
// inferred "Suggested next steps (inferred, not agreed)" stays visibly separate from decisions and commitments.
export function synthesisMarkdown(title: string, date: string, text: string) {
  const headings = new Set(Object.values(labels));
  const body = text
    .trim()
    .split("\n")
    .map((line) => (headings.has(line.trim()) ? "## " + line.trim() : line))
    .join("\n");
  return `# ${title.trim() || "Meeting"}\n${date}\n\n${body}\n`;
}
