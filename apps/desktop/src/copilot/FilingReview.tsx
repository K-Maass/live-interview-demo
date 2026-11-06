import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pickActionTarget } from "../lib/public/pickTarget";
import { approveAndApply, fileApplyFailure } from "../lib/public/applyFlow";
import type { ActionProposal, MeetingRecord } from "@live-interview/core";
export function FilingReview({
  record,
  onStatus,
}: {
  record: MeetingRecord;
  onStatus: (s: string) => void;
}) {
  const [proposal, setProposal] = useState<ActionProposal>();
  // The last apply of this proposal failed; it is back in review and can be applied again.
  const [applyFailed, setApplyFailed] = useState(false);
  async function prepare() {
    // The native picker records the chosen folder; only then does the executor accept a link there.
    const folder = await pickActionTarget({ kind: "recordFolder" }, onStatus);
    if (folder === null) return;
    const targetPath = folder + `/meeting-${record.id}.md`;
    try {
      setApplyFailed(false);
      setProposal(
        await invoke<ActionProposal>("propose_action", {
          targetPath,
          operation: "linkRecord",
          content: record.canonicalEnglishPath,
        }),
      );
    } catch {
      onStatus(
        "Could not prepare filing link; canonical record remains in the app inbox",
      );
    }
  }
  return (
    <section>
      <div className="section-heading">
        <h2>File this record</h2>
        <button onClick={() => void prepare()}>
          Propose a link in a client/project transcript folder…
        </button>
      </div>
      <p className="muted">
        One canonical app-owned record. Adding a link to an existing folder is a
        reviewed change and never moves your original files.
      </p>
      {proposal && (
        <div className="review">
          <p>New link: {proposal.targetPath}</p>
          <p>Canonical record: {proposal.after}</p>
          <div className="buttons">
            <button
              className="primary"
              onClick={() => {
                void approveAndApply(invoke, proposal.id, "apply_action")
                  .then((result) => {
                    // Undefined: an earlier click created the link (or is creating it) and reports it.
                    if (result !== undefined) onStatus("Approved record link created");
                    setProposal(undefined);
                    setApplyFailed(false);
                  })
                  .catch((error) => {
                    // Nothing was written. Only a proposal back in review stays here to apply again.
                    const failure = fileApplyFailure(error);
                    onStatus(failure.message);
                    setApplyFailed(failure.retry);
                    if (!failure.retry) setProposal(undefined);
                  });
              }}
            >
              {applyFailed ? "Apply again" : "Approve filing link"}
            </button>
            <button
              onClick={() => {
                void invoke("decline_action", { proposalId: proposal.id });
                setProposal(undefined);
              }}
            >
              Decline
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
