import { invoke } from "@tauri-apps/api/core";

export const pickFailedMessage = "Could not open the file picker. Try again.";

/**
 * Opens the native picker that records the chosen target for the action executor. Null when the person cancels
 * the picker; when the picker itself fails (pickFailed, invalidPickedTarget) it says so through `onStatus` and also
 * returns null, so no caller is left with an unhandled rejection.
 */
export async function pickActionTarget(
  args: { kind: "recordFolder" | "appendNote" | "icsFile"; defaultName?: string },
  onStatus: (status: string) => void,
): Promise<string | null> {
  try {
    const picked = await invoke<string | null>("pick_action_target", args);
    return typeof picked === "string" ? picked : null;
  } catch {
    onStatus(pickFailedMessage);
    return null;
  }
}

export type GrantPickKind = "workspaceFolder" | "outputFolder" | "appendNote" | "chatgptExport";

/**
 * Opens the native picker for a path about to be granted (a folder to index, the output folder, an append note, a
 * ChatGPT export). The native side records the choice, so the save that follows does not show the confirmation
 * sheet again for it. Typed or pasted paths still work; they are confirmed in a native sheet when saved.
 */
export async function pickGrantPath(kind: GrantPickKind, onStatus: (status: string) => void): Promise<string | null> {
  try {
    const picked = await invoke<string | null>("pick_grant_path", { kind });
    return typeof picked === "string" ? picked : null;
  } catch {
    onStatus(pickFailedMessage);
    return null;
  }
}

/** The person cancelled a native confirmation sheet. Nothing was granted or written; this is not a failure. */
export function isGrantDeclined(error: unknown): boolean {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return code === "grantDeclined";
}
export const GRANT_DECLINED_MESSAGE = "Nothing was granted. Your changes are still in the editor.";
