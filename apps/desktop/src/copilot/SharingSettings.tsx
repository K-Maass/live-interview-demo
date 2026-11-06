import { dayText } from "./ui";
import { processingClass, processingLabel, processingState } from "./presentation/processing";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  exportSelected,
  type MeetingRecord,
  type ImportReport,
  type SourceHit,
} from "@live-interview/core";
// Shows the saved bundle in Finder. capabilities/default.json grants opener:default, which allows revealing an item but
// not opening a path, so revealItemInDir is the permitted call. A failure is reported instead of being dropped: the
// bundle is saved either way, and the status keeps its path.
export async function showExportedBundle(
  path: string,
  onStatus: (s: string) => void,
  reveal: (path: string) => Promise<unknown> = revealItemInDir,
) {
  onStatus(`Portable text bundle saved in the app outbox: ${path}`);
  try {
    await reveal(path);
  } catch {
    onStatus(`Portable text bundle saved in the app outbox, but Finder could not show it: ${path}`);
  }
}
/** The archive lists summaries without transcripts; an export needs each selected meeting in full. */
export function fullRecords(
  records: MeetingRecord[],
  load: (id: string) => Promise<MeetingRecord> = (id) => invoke<MeetingRecord>("load_meeting_record", { id }),
): Promise<MeetingRecord[]> {
  return Promise.all(records.map((r) => (r.summary ? load(r.id) : Promise.resolve(r))));
}
export function SharingSettings({
  records,
  onStatus,
  onRefresh,
}: {
  records: MeetingRecord[];
  onStatus: (s: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<ImportReport>();
  const [candidates, setCandidates] = useState<SourceHit[]>([]);
  const [sourceSelections, setSourceSelections] = useState<string[]>([]);
  const sourceKey = (s: SourceHit) => s.sourceId + "#" + s.locator;
  return (
    <section>
      <h2>Data &amp; sharing</h2>
      <p className="muted">
        Choose text records to share. The bundle excludes audio and provider
        credentials. Foreign original paths remain references; imports create
        app-owned records and preserve conflicting versions.
      </p>
      <div className="sharing-layout"><div><h3>Selected text records</h3>
      <div className="share-record-list"><div className="share-record-heading" aria-hidden="true"><span /><span>Meeting</span><span>Date</span><span>Processing</span></div>
      {records.map((r) => (
        <label className="checkbox" key={r.id}>
          <input
            type="checkbox"
            aria-label={r.purpose}
            checked={selected.includes(r.id)}
            onChange={(e) =>
              setSelected((old) =>
                e.target.checked
                  ? old.concat(r.id)
                  : old.filter((id) => id !== r.id),
              )
            }
          />
          <span>{r.purpose}</span><small>{dayText(r.date)}</small><small className={processingClass[processingState(r)]}>{processingLabel[processingState(r)]}</small>
        </label>
      ))}
      </div>
      <button
        disabled={!selected.length}
        onClick={() => {
          const workspaceIds = [
            ...new Set(
              records
                .filter((r) => selected.includes(r.id))
                .map((r) => r.workspaceId),
            ),
          ];
          void invoke<SourceHit[]>("list_sharing_sources", { workspaceIds })
            .then(setCandidates)
            .catch(() => onStatus("Source excerpts unavailable"));
        }}
      >
        Choose additional context excerpts…
      </button>
      {!!candidates.length && (
        <details open>
          <summary>
            Review optional source excerpts (none selected automatically)
          </summary>
          {candidates.map((s) => (
            <label key={sourceKey(s)} className="checkbox">
              <input
                type="checkbox"
                checked={sourceSelections.includes(sourceKey(s))}
                onChange={(e) =>
                  setSourceSelections((old) =>
                    e.target.checked
                      ? [...old, sourceKey(s)]
                      : old.filter((id) => id !== sourceKey(s)),
                  )
                }
              />
              <span>
                {s.title} · {s.locator}
                <blockquote>{s.text}</blockquote>
              </span>
            </label>
          ))}
        </details>
      )}
      <div className="buttons">
        <button
          className="primary"
          disabled={!selected.length}
          onClick={() => {
            const workspaceIds = [
              ...new Set(
                records
                  .filter((r) => selected.includes(r.id))
                  .map((r) => r.workspaceId),
              ),
            ];
            void fullRecords(records.filter((r) => selected.includes(r.id)))
              .then((full) => exportSelected(
                { workspaceIds, meetingIds: selected },
                full,
                candidates.filter((s) => sourceSelections.includes(sourceKey(s))),
              ))
              .then((bundle) => invoke<{ path: string }>("export_workspace_bundle", { bundle }))
              .then(
                (result) => showExportedBundle(result.path, onStatus),
                () => onStatus("Sharing export needs attention"),
              );
          }}
        >
          Export selected text records
        </button>
        <button
          onClick={() => {
            void open({
              multiple: false,
              filters: [
                { name: "Live Interview bundle", extensions: ["json"] },
              ],
            }).then((path) => {
              if (typeof path === "string")
                void invoke<ImportReport>("import_workspace_bundle", { path })
                  .then((r) => {
                    setReport(r);
                    onRefresh();
                  })
                  .catch(() => onStatus("Invalid/private bundle rejected"));
            });
          }}
        >
          Import a portable bundle…
        </button>
      </div>
      {report && (
        <p className="notice success" role="status">
          Imported {report.imported} · duplicates {report.skipped} · conflicts
          retained {report.conflicts} · unresolved origin references{" "}
          {report.unresolved.length}
        </p>
      )}
      </div></div>
    </section>
  );
}
