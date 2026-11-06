import { useEffect, useRef, useState } from "react";
import type { MeetingRecord, PublicArtifact } from "@live-interview/core";
import { synthesisEvidence } from "../../lib/public/transcript";
import { Copy } from "lucide-react";
import { dayText } from "../ui";
import {
  draftOnRecordChange,
  keptEditBase,
  humanEditedSynthesis,
  synthesisMarkdown,
  omittedNote,
  synthesisSections,
} from "../../lib/public/synthesisItems";
import { publicArtifacts, ensureSynthesis } from "../../lib/public/synthesis";

function EvidenceQuote({
  record,
  id,
}: {
  record: MeetingRecord;
  id: string;
}) {
  const segment = synthesisEvidence(record, id);
  return (
    <blockquote>
      <p>
        {segment?.text ||
          "This evidence reference does not identify a current source revision. Regenerate to ground it in the saved record."}
      </p>
      {segment?.english && (
        <p>
          <small>Linked English translation</small>
          <br />
          {segment.english.text}
        </p>
      )}
      <small>
        {segment?.language} · {id}
      </small>
    </blockquote>
  );
}
export function PublicSynthesis({
  record,
  canUseAI,
}: {
  record: MeetingRecord;
  canUseAI: boolean;
}) {
  const cache = publicArtifacts;
  const generation = useRef(0);
  const edits = useRef(0);
  const dirty = useRef(false);
  const [saved, setSaved] = useState<PublicArtifact | null>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const shownRecord = useRef<string | undefined>(undefined);
  useEffect(() => {
    const run = ++generation.current;
    // A new revision of the same record (late translation, a retry) must not wipe text the person has not saved.
    const change = draftOnRecordChange({ recordId: shownRecord.current, dirty: dirty.current }, record.id);
    shownRecord.current = record.id;
    if (change.keep) setMessage(change.message ?? "");
    else {
      setSaved(undefined);
      setDraft("");
      dirty.current = false;
    }
    setBusy(false);
    void cache
      .load(record.id, "synthesis", record.revision)
      .then((a) => {
        if (generation.current !== run) return;
        if (change.keep && dirty.current) {
          setSaved((previous) => keptEditBase(a, previous, record.revision));
          return;
        }
        setSaved(a);
        setDraft(a?.text || "");
      })
      .catch(() => {
        if (generation.current === run)
          setMessage(
            "Saved synthesis unavailable. The transcript remains available.",
          );
      });
    return () => {
      generation.current++;
    };
  }, [record.id, record.revision]);
  const generate = async () => {
    if (busy || saved?.humanEdited) return;
    const run = generation.current;
    const version = edits.current;
    setBusy(true);
    setMessage("");
    try {
      const artifact = await ensureSynthesis(record, false, !!saved);
      if (run !== generation.current || version !== edits.current) return;
      setSaved(artifact);
      setDraft(artifact.text);
      setMessage("Synthesis saved for this exact record revision");
    } catch {
      setMessage(
        "Synthesis unavailable or its saved revision changed. Your record remains saved; retry after refreshing.",
      );
    } finally {
      if (run === generation.current) setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!saved) return;
    const run = generation.current;
    const version = edits.current;
    setBusy(true);
    try {
      const latest = await cache.load(record.id, "synthesis", record.revision);
      if (latest?.humanEdited && latest.updatedAtMs !== saved.updatedAtMs)
        throw Error("humanEditConflict");
      const base = latest && !latest.humanEdited ? latest : saved;
      const result = await cache.save(humanEditedSynthesis(base, draft));
      if (run !== generation.current || version !== edits.current) return;
      dirty.current = false;
      setSaved(result);
      setMessage(
        "Your edited synthesis is saved. Generated output cannot replace it.",
      );
    } catch {
      setMessage(
        "Save conflict. Your edited text remains here; reload before overwriting any saved version.",
      );
    } finally {
      if (run === generation.current) setBusy(false);
    }
  };
  useEffect(
    () =>
      cache.subscribe(() => {
        const run = generation.current;
        const version = edits.current;
        void cache.load(record.id, "synthesis", record.revision).then((a) => {
          if (
            run === generation.current &&
            version === edits.current &&
            !dirty.current
          ) {
            setSaved(a);
            if (a) setDraft(a.text);
          }
        });
      }),
    [record.id, record.revision],
  );
  // The clipboard stays on this Mac; nothing is sent anywhere until the user pastes it.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(synthesisMarkdown(record.purpose, dayText(record.date), draft));
      setMessage("Summary copied as Markdown");
    } catch {
      setMessage("The summary could not be copied. Select the text and copy it instead.");
    }
  };
  const evidenceCurrent =
    !!saved?.evidence.length &&
    saved.evidence.every((id) => !!synthesisEvidence(record, id));
  // Typed items describe the saved generation only while the visible text is that generation.
  const typedItems =
    saved && !saved.humanEdited && saved.items?.length && draft === saved.text
      ? saved.items
      : undefined;
  const pending =
    (record.pendingSegments ?? 0) > 0 || record.translationStatus === "pending";
  return (
    <>
      <div className="synthesis-heading">
        <h2>Meeting synthesis</h2>
        <small>
          {busy
            ? "Generating / saving…"
            : saved?.humanEdited
              ? "Edited by you"
              : saved?.status === "ready"
                ? evidenceCurrent
                  ? "Saved · source grounded"
                  : "Saved · evidence needs regeneration"
                : saved?.status === "pending"
                  ? "Generation pending"
                  : saved?.status === "failed"
                    ? "Generation needs retry"
                    : saved === undefined
                      ? "Loading saved artifact…"
                      : "Not generated"}
        </small>
      </div>
      {saved === null && !draft && (
        <div className="synthesis-empty">
          <h3>The meeting record is saved.</h3>
          <p>
            Generate one coherent synthesis from the saved conversation.
            Returning to this tab reads the saved result.
          </p>
        </div>
      )}
      {draft && (
        <div className="meeting-synthesis">
          {typedItems ? (
            <>
              {synthesisSections(typedItems).map((section) => (
              <section
                key={section.kind}
                className={
                  section.inferred
                    ? "synthesis-section inferred"
                    : "synthesis-section"
                }
              >
                <h3>{section.label}</h3>
                {section.inferred && (
                  <p className="muted">
                    Inferred from the conversation. Nobody agreed to these.
                  </p>
                )}
                <ul>
                  {section.items.map((item, i) => (
                    <li key={i}>
                      <p>{item.text}</p>
                      {item.evidence.length ? (
                        <details>
                          <summary>
                            {item.evidence.length === 1
                              ? "Source"
                              : `Sources (${item.evidence.length})`}
                          </summary>
                          {item.evidence.map((id) => (
                            <EvidenceQuote key={id} record={record} id={id} />
                          ))}
                        </details>
                      ) : (
                        <small className="muted">No specific source cited</small>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              ))}
              {!!saved?.omitted && (
                <p className="muted synthesis-omitted" role="note">
                  {omittedNote(saved.omitted)}
                </p>
              )}
            </>
          ) : (
            draft
              .split("\n\n")
              .map((paragraph, i) => <p key={i}>{paragraph}</p>)
          )}
        </div>
      )}
      <div className="buttons">
        {draft && (
          <button className="primary" disabled={busy} onClick={() => void copy()}>
            <Copy size={16} aria-hidden />
            Copy summary
          </button>
        )}
        <button
          className={saved ? undefined : "primary"}
          disabled={
            busy ||
            pending ||
            !canUseAI ||
            !!saved?.humanEdited ||
            !record.segments.length ||
            saved === undefined ||
            dirty.current
          }
          onClick={() => void generate()}
        >
          {busy
            ? "Working…"
            : saved
              ? "Regenerate synthesis"
              : "Generate synthesis"}
        </button>
        {saved && (
          <details className="public-synthesis-edit">
            <summary>Edit saved synthesis</summary>
            <label>
              Your synthesis
              <textarea
                value={draft}
                onChange={(e) => {
                  edits.current++;
                  dirty.current = true;
                  setDraft(e.target.value);
                }}
              />
            </label>
            <button
              disabled={busy || !draft.trim()}
              onClick={() => void saveEdit()}
            >
              Save my edited synthesis
            </button>
            <p className="muted">
              Edited text is marked as yours and its previous AI evidence links
              are cleared.
            </p>
          </details>
        )}
      </div>
      {!typedItems && saved?.evidence.length ? (
        <details>
          <summary>Supporting conversation ({saved.evidence.length})</summary>
          {saved.evidence.map((id) => (
            <EvidenceQuote key={id} record={record} id={id} />
          ))}
        </details>
      ) : null}
      {pending && (
        <p className="muted">
          Wait for pending local processing before generating the synthesis.
        </p>
      )}
      <p role="status" className="muted">
        {message}
      </p>
    </>
  );
}
