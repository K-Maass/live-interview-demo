import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PinnedTopic { id: string; text: string; outcome: "Answered" | "Outdated" | "Still open" }

/**
 * Reads the meeting's saved "pins" note. Older or damaged records may have no note, invalid JSON or partial entries:
 * those yield no topics or skip the entry, never an error. The text is kept as saved, in its source language.
 */
export function parsePinnedTopics(text: unknown): PinnedTopic[] {
  if (typeof text !== "string" || !text.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item, index): PinnedTopic[] => {
    if (!item || typeof item !== "object") return [];
    const card = item as { id?: unknown; say?: unknown; pinOutcome?: unknown };
    if (typeof card.say !== "string" || !card.say.trim()) return [];
    const id = typeof card.id === "string" && card.id ? card.id : "pin-" + index;
    if (seen.has(id)) return [];
    seen.add(id);
    const outcome = card.pinOutcome === "answered" ? "Answered" : card.pinOutcome === "outdated" ? "Outdated" : "Still open";
    return [{ id, text: card.say, outcome }];
  });
}

/** Read-only list of the meeting's pinned topics and the outcome a person gave each. Nothing renders without topics. */
export function PinnedTopicsList({ topics }: { topics: PinnedTopic[] }) {
  if (!topics.length) return null;
  return <section className="pinned-topics-review" aria-labelledby="pinned-topics-heading">
    <h3 id="pinned-topics-heading">Pinned topics</h3>
    <ul>{topics.map((t) => <li key={t.id}><span>{t.text}</span><span className="muted"> · {t.outcome}</span></li>)}</ul>
  </section>;
}

export function PinnedTopicsReview({ meetingId }: { meetingId: string }) {
  const [topics, setTopics] = useState<PinnedTopic[]>([]);
  useEffect(() => {
    let current = true;
    setTopics([]);
    invoke<{ text: string }>("read_internal_note", { meetingId, kind: "pins" })
      .then((note) => { if (current) setTopics(parsePinnedTopics(note?.text)); })
      .catch(() => {});
    return () => { current = false; };
  }, [meetingId]);
  return <PinnedTopicsList topics={topics} />;
}
