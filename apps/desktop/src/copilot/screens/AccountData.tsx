import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { CopilotController } from "../useCopilotController";
import { publicClient as api } from "../../lib/public/client";
import {
  DELETE_EFFECTS,
  LOCAL_DATA_NOTE,
  LOCAL_DELETE_STEPS,
  SERVICE_DATA_NOTE,
  deleteErrorMessage,
  deletedMessage,
  exportErrorMessage,
  exportedMessage,
} from "../../lib/public/accountData";
import { Section } from "../ui";

/** Export and delete the service account. Everything on this Mac is outside both actions. */
export function AccountDataSettings({ controller: c }: { controller: CopilotController }) {
  const account = c.publicProduct.account;
  const signedIn = !!account?.configured && account.signedIn;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [exportedPath, setExportedPath] = useState("");
  const exportData = async () => {
    setBusy(true);
    setMessage("");
    setExportedPath("");
    try {
      const result = await api.exportAccount();
      setExportedPath(result.path);
      setMessage(exportedMessage(result));
    } catch (error) {
      setMessage(exportErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const deleteAccount = async () => {
    setBusy(true);
    setMessage("");
    setExportedPath("");
    try {
      const result = await api.deleteAccount();
      setConfirming(false);
      setMessage(deletedMessage(result));
    } catch (error) {
      setMessage(deleteErrorMessage(error));
    } finally {
      setBusy(false);
      void c.publicProduct.refreshAccount();
    }
  };
  return (
    <Section title="Your data">
      <p>{LOCAL_DATA_NOTE}</p>
      <p className="muted">{SERVICE_DATA_NOTE}</p>
      <div className="buttons">
        <button disabled={busy || !signedIn} onClick={() => void exportData()}>
          Export account data…
        </button>
        {exportedPath && (
          <button onClick={() => void revealItemInDir(exportedPath)}>Show in Finder</button>
        )}
      </div>
      <p className="muted">
        The export is a JSON file in your Downloads folder with everything the service stores about this account.
      </p>
      {confirming ? (
        <div className="notice error" role="alertdialog" aria-labelledby="delete-account-title">
          <strong id="delete-account-title">Delete your account permanently?</strong>
          <ul>
            {DELETE_EFFECTS.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <div className="buttons">
            <button disabled={busy} onClick={() => void deleteAccount()}>
              {busy ? "Deleting…" : "Permanently delete my account"}
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)}>
              Keep my account
            </button>
          </div>
        </div>
      ) : (
        <button disabled={busy || !signedIn} onClick={() => setConfirming(true)}>
          Delete account…
        </button>
      )}
      <p role="status" className="muted">
        {message}
      </p>
      <details>
        <summary>How to delete the data stored on this Mac</summary>
        <ol>
          {LOCAL_DELETE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>
    </Section>
  );
}
