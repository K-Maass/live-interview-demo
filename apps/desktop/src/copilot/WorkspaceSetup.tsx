import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, MessageSquare, Upload } from "lucide-react";
import { StubPanel } from "./ui";
import { native } from "../lib/localVoice";
import { chatgptImportErrorMessage } from "../lib/public/chatgptImportErrors";
import { isGrantDeclined, pickGrantPath } from "../lib/public/pickTarget";
export function WorkspaceSetup({
  value,
  onChange,
  onStatus,
  onWorkspaces,
  presentation,
}: {
  presentation?: "knowledge";
  value: string;
  onChange: (id: string) => void;
  onStatus: (status: string) => void;
  onWorkspaces?: (workspaces: { id: string; root: string }[]) => void;
}) {
  const [workspaces, setWorkspaces] = useState<{ id: string; root: string }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (native())
      void invoke<typeof workspaces>("list_workspaces").then((items) => { setWorkspaces(items); onWorkspaces?.(items); });
  }, []);
  async function connect() {
    const root = await pickGrantPath("workspaceFolder", onStatus);
    if (typeof root !== "string") return;
    setBusy(true);
    const id = crypto.randomUUID();
    try {
      const result = await invoke<{
        sourceCount: number;
        unsupported: string[];
      }>("connect_workspace", { id, root });
      const nextWorkspaces = workspaces.concat({ id, root });
      setWorkspaces(nextWorkspaces);
      onWorkspaces?.(nextWorkspaces);
      onChange(id);
      onStatus(
        `Indexed ${result.sourceCount} sources · ${result.unsupported.length} unsupported/unreadable. Existing files were not changed.`,
      );
    } catch (error) {
      onStatus(
        isGrantDeclined(error)
          ? "Folder not connected. Nothing was granted."
          : "Workspace indexing needs attention",
      );
    } finally {
      setBusy(false);
    }
  }
  const importButton = (
<button
          disabled={!native() || busy || value === "default"}
          onClick={() => {
            void pickGrantPath("chatgptExport", onStatus).then((path) => {
              if (typeof path === "string") {
                setBusy(true);
                void invoke<{ imported: number; skipped: number }>(
                  "import_chatgpt_export",
                  { workspaceId: value, path },
                )
                  .then((r) =>
                    onStatus(
                      `Imported ${r.imported} text messages across all branches · ${r.skipped} skipped/duplicates`,
                    ),
                  )
                  .catch((error) => onStatus(chatgptImportErrorMessage(error)))
                  .finally(() => setBusy(false));
              }
            });
          }}
        >
          Import ChatGPT export…
        </button>
  );
  const selected = workspaces.find((w) => w.id === value);
  if (presentation === "knowledge") return <div className="knowledge-layout"><nav aria-label="Workspaces" className="knowledge-navigation"><h2>Workspaces</h2>{workspaces.map((w) => <button key={w.id} aria-pressed={value === w.id} className={value === w.id ? "selected" : ""} onClick={() => onChange(w.id)}><Folder size={19} />{w.root.split("/").at(-1)}</button>)}<button aria-pressed={value === "default"} className={value === "default" ? "selected" : ""} onClick={() => onChange("default")}><MessageSquare size={19} />Conversation only</button></nav><div className="knowledge-detail"><div className="section-heading"><div><h2>{selected?.root.split("/").at(-1) ?? "Conversation only"}</h2><p className="muted">{selected ? "Connected workspace · read-only context" : "No folder selected for this meeting"}</p></div><button className="primary" disabled={!native() || busy} onClick={() => void connect()}><Folder size={17} />{busy ? "Indexing…" : "Connect folder"}</button></div><section><h3>Connected folder</h3>{selected ? <p className="connected-folder"><Folder size={20} />{selected.root}</p> : <p className="muted">Select or connect a workspace to use its context.</p>}<p className="muted">Unsupported or unreadable files are reported during indexing. A stored folder alone does not establish current index completeness.</p></section><section><h3><Upload size={19} />ChatGPT history import</h3><p className="muted">Import a JSON or ZIP export into the selected workspace.</p>{importButton}</section><StubPanel title="Source browser" description="Rich source browsing and per-meeting source selection are not implemented." /><p className="muted">Connected files remain read only. Existing note changes require an approved proposal.</p></div></div>;
  return (
    <section>
      <div className="section-heading">
        <h2>Workspace context</h2>
        {importButton}
        <button disabled={!native() || busy} onClick={() => void connect()}>
          {busy ? "Indexing…" : "Connect folder"}
        </button>
      </div>
      <label>
        Meeting workspace
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="default">Conversation only</option>
          {workspaces.map((w) => (
            <option value={w.id} key={w.id}>
              {w.root.split("/").at(-1)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Folders provide read-only context. Appending to or changing your
        existing files always requires an approved proposal.
      </p>
    </section>
  );
}
