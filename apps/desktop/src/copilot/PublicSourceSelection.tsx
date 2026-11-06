import type { CopilotController } from "./useCopilotController";
export function PublicSourceSelection({
  controller: c,
}: {
  controller: CopilotController;
}) {
  const p = c.publicProduct;
  const plan = p.current;
  const workspace = p.workspaces.find((w) => w.id === plan?.workspaceId);
  if (!plan) return null;
  return (
    <div className="public-source-selection">
      <label>
        Source scope
        <select
          aria-label="Source scope"
          value={plan.sourceSelection || "workspace"}
          onChange={(e) =>
            p.edit({
              sourceSelection: e.target.value as "workspace" | "selected",
            })
          }
        >
          <option value="workspace">All sources in assigned workspace</option>
          <option value="selected">Only selected sources</option>
        </select>
      </label>
      {plan.sourceSelection === "selected" && (
        <>
          <p className="muted">
            No checks means no local source context. The live conversation
            remains available.
          </p>
          {p.sources
            .filter(
              (s) =>
                s.workspaceId === plan.workspaceId ||
                plan.sharedLibraryIds.includes(s.workspaceId),
            )
            .map((s) => (
              <label
                className="checkbox public-source-checkbox"
                key={s.sourceId}
              >
                <input
                  type="checkbox"
                  checked={plan.sourceIds.includes(s.sourceId)}
                  onChange={(e) =>
                    p.edit({
                      sourceIds: e.target.checked
                        ? [...plan.sourceIds, s.sourceId]
                        : plan.sourceIds.filter((id) => id !== s.sourceId),
                    })
                  }
                />
                <span>
                  {s.title}
                  {s.workspaceId !== plan.workspaceId && (
                    <small>
                      Shared ·{" "}
                      {p.workspaces.find((w) => w.id === s.workspaceId)?.name}
                    </small>
                  )}
                  <small>{s.path}</small>
                </span>
              </label>
            ))}
          {!p.sources.length && (
            <p className="muted">
              No indexed sources available in this workspace.
            </p>
          )}
        </>
      )}
      <h3>Permitted shared libraries</h3>
      {workspace?.sharedLibraryIds.length ? (
        workspace.sharedLibraryIds.map((id) => (
          <label className="checkbox" key={id}>
            <input
              type="checkbox"
              checked={plan.sharedLibraryIds.includes(id)}
              onChange={(e) =>
                p.edit({
                  sharedLibraryIds: e.target.checked
                    ? [...plan.sharedLibraryIds, id]
                    : plan.sharedLibraryIds.filter((x) => x !== id),
                })
              }
            />
            {p.workspaces.find((w) => w.id === id)?.name || id}
          </label>
        ))
      ) : (
        <p className="muted">
          No shared libraries permitted by this workspace. Enable them in
          Knowledge.
        </p>
      )}
    </div>
  );
}
