import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Plus, RefreshCw, X } from "lucide-react";
import type { PublicSource, PublicWorkspace } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";
import { publicClient } from "../../lib/public/client";
import { chatgptImportErrorMessage } from "../../lib/public/chatgptImportErrors";
import { GRANT_DECLINED_MESSAGE, isGrantDeclined, pickGrantPath } from "../../lib/public/pickTarget";
import { Section } from "../ui";
export function PublicKnowledge({
  controller: c,
}: {
  controller: CopilotController;
}) {
  const p = c.publicProduct;
  const [browse, setBrowse] = useState("");
  const [draft, setDraft] = useState<PublicWorkspace>();
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!browse && p.workspaces[0]) setBrowse(p.workspaces[0].id);
  }, [p.workspaces]);
  useEffect(() => {
    const selected = p.workspaces.find((w) => w.id === browse);
    setDraft(selected ? structuredClone(selected) : undefined);
    let active = true;
    setSources([]);
    if (selected)
      void publicClient
        .sources(selected.id)
        .then((rows) => {
          if (active) setSources(rows);
        })
        .catch(() =>
          setError("Source index unavailable. Refresh this workspace."),
        );
    return () => {
      active = false;
    };
  }, [browse, p.workspaces]);
  const operation = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      // Cancelling the native confirmation sheet is a choice, not a failure.
      if (isGrantDeclined(error)) p.setMessage(GRANT_DECLINED_MESSAGE);
      else
        setError(
          "Workspace change could not be saved. Your configuration remains in this editor.",
        );
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    operation(async () => {
      const root = await pickGrantPath("workspaceFolder", p.setMessage);
      if (typeof root !== "string") return;
      const saved = await p.saveWorkspace({
        id: crypto.randomUUID(),
        name: root.split("/").at(-1) || "Workspace",
        root,
        roots: [root],
        sharedLibraryIds: [],
        appendTargets: [],
        revision: 0,
      });
      setBrowse(saved.id);
      p.setMessage("Workspace registered. Local files are read-only context.");
    });
  const pickRoot = async () => {
    const root = await pickGrantPath("workspaceFolder", p.setMessage);
    if (typeof root === "string" && draft)
      setDraft({ ...draft, roots: [...new Set([...draft.roots, root])] });
  };
  const pickOutput = async () => {
    const root = await pickGrantPath("outputFolder", p.setMessage);
    if (typeof root === "string" && draft)
      setDraft({ ...draft, outputRoot: root });
  };
  const grantAppend = async () => {
    const target = await pickGrantPath("appendNote", p.setMessage);
    if (typeof target === "string" && draft)
      setDraft({
        ...draft,
        appendTargets: [...new Set([...draft.appendTargets, target])],
      });
  };
  const reindex = () =>
    operation(async () => {
      if (!draft) return;
      await publicClient.refreshWorkspace(draft.id, draft.sharedLibraryIds);
      setSources(await publicClient.sources(draft.id));
      p.setMessage("Workspace index refreshed");
    });
  return (
    <div className="knowledge-layout public-knowledge">
      <nav className="knowledge-navigation" aria-label="Browse workspaces">
        <h2>Workspaces</h2>
        {p.workspaces.map((w) => (
          <button
            key={w.id}
            className={browse === w.id ? "selected" : ""}
            aria-pressed={browse === w.id}
            onClick={() => setBrowse(w.id)}
          >
            <Folder size={18} />
            {w.name}
          </button>
        ))}
        <button disabled={busy} onClick={() => void create()}>
          <Plus size={18} />
          New workspace
        </button>
        <p className="muted">
          Browsing here does not change the workspace assigned to a meeting.
        </p>
      </nav>
      <div className="knowledge-detail">
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {draft ? (
          <>
            <div className="section-heading">
              <div>
                <h2>{draft.name}</h2>
                <p className="muted">
                  {sources.length} indexed sources · revision {draft.revision}
                </p>
              </div>
              <button disabled={busy} onClick={() => void reindex()}>
                <RefreshCw size={16} />
                Refresh index
              </button>
            </div>
            <Section title="Workspace configuration">
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <h3>Local folders</h3>
              {draft.roots.map((root) => (
                <div className="public-path-row" key={root}>
                  <span>{root}</span>
                  <button
                    className="icon-button"
                    aria-label={"Remove folder " + root}
                    disabled={draft.roots.length === 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        roots: draft.roots.filter((r) => r !== root),
                        root: draft.roots.find((r) => r !== root)!,
                      })
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <button disabled={busy} onClick={() => void pickRoot()}>
                Add folder…
              </button>
              <p className="muted">
                Readable local files and locally available sync files can be
                indexed. Online-only placeholders may remain unavailable.
              </p>
              <h3>Shared knowledge library</h3>
              <p className="muted">
                Allow these separate workspaces as optional shared context. Each
                meeting chooses which permitted libraries to include.
              </p>
              {p.workspaces
                .filter((w) => w.id !== draft.id)
                .map((w) => (
                  <label className="checkbox" key={w.id}>
                    <input
                      type="checkbox"
                      checked={draft.sharedLibraryIds.includes(w.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          sharedLibraryIds: e.target.checked
                            ? [...draft.sharedLibraryIds, w.id]
                            : draft.sharedLibraryIds.filter(
                                (id) => id !== w.id,
                              ),
                        })
                      }
                    />
                    {w.name}
                  </label>
                ))}
              {p.workspaces.length < 2 && (
                <p className="muted">
                  Create another workspace to offer it as a shared library.
                </p>
              )}
            </Section>
            <Section title="Automatic note destinations">
              <p className="muted">
                New meeting files can save to your selected output folder.
                Appends are additive and limited to the exact existing files
                enabled below. Rewrites and moves always require review.
              </p>
              <div className="public-path-row">
                <span>
                  {draft.outputRoot || "App-owned meeting storage only"}
                </span>
                <button disabled={busy} onClick={() => void pickOutput()}>
                  Choose output folder…
                </button>
                {draft.outputRoot && (
                  <button
                    onClick={() =>
                      setDraft({ ...draft, outputRoot: undefined })
                    }
                  >
                    Clear
                  </button>
                )}
              </div>
              <h3>Enabled automatic append files</h3>
              {draft.appendTargets.map((path) => (
                <div className="public-path-row" key={path}>
                  <span>{path}</span>
                  <button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        appendTargets: draft.appendTargets.filter(
                          (x) => x !== path,
                        ),
                      })
                    }
                  >
                    Revoke grant
                  </button>
                </div>
              ))}
              {!draft.appendTargets.length && (
                <p className="muted">
                  No existing file is enabled for automatic appends.
                </p>
              )}
              <button disabled={busy} onClick={() => void grantAppend()}>
                Enable append to an existing file…
              </button>
              <div className="buttons public-save-row">
                <button
                  className="primary"
                  disabled={busy || !draft.name.trim()}
                  onClick={() =>
                    void operation(async () => {
                      const saved = await p.saveWorkspace({
                        ...draft,
                        root: draft.roots[0],
                      });
                      setDraft(saved);
                      p.setMessage(
                        "Workspace configuration and exact note grants saved",
                      );
                    })
                  }
                >
                  {busy ? "Saving…" : "Save workspace & grants"}
                </button>
              </div>
            </Section>
            <Section title="Source browser">
              {sources.length ? (
                <div className="public-source-list">
                  {sources.map((s) => (
                    <div key={s.sourceId}>
                      <strong>{s.title}</strong>
                      <small>{s.path}</small>
                      <small>
                        Revision {s.revision}
                        {s.status ? " · " + s.status : ""}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  No indexed sources are available. Refresh the index to check
                  readable content.
                </p>
              )}
            </Section>
            <Section title="ChatGPT history import">
              <p className="muted">
                Import selected exported history into this workspace, preserving
                branch evidence.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    const path = await pickGrantPath("chatgptExport", p.setMessage);
                    if (typeof path !== "string") return;
                    let r: { imported: number; skipped: number };
                    try {
                      r = await invoke<{
                        imported: number;
                        skipped: number;
                      }>("import_chatgpt_export", {
                        workspaceId: draft.id,
                        path,
                      });
                    } catch (error) {
                      p.setMessage(chatgptImportErrorMessage(error));
                      return;
                    }
                    setSources(await publicClient.sources(draft.id));
                    p.setMessage(
                      `Imported ${r.imported} messages · ${r.skipped} skipped/duplicates`,
                    );
                  })
                }
              >
                Import export…
              </button>
            </Section>
          </>
        ) : (
          <Section title="Connect your knowledge">
            <p>
              Keep each project in its own workspace, with optional shared
              libraries and explicit note destinations.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              Choose a local folder…
            </button>
          </Section>
        )}
      </div>
    </div>
  );
}
