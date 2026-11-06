import { useState } from "react";
import {
  defaultShortcuts,
  shortcutLabels,
  shortcutText,
  validateShortcuts,
  type Shortcuts,
} from "../lib/copilot/shortcuts";
/**
 * Settings › Keyboard. `unavailable` holds the accelerators the last registration could not claim (another app holds
 * them); the affected actions say so in plain words until a later save registers every key.
 */
export function ShortcutSettings({
  value,
  onChange,
  expanded = false,
  unavailable = [],
}: {
  value: Shortcuts;
  onChange: (s: Shortcuts) => void;
  expanded?: boolean;
  unavailable?: readonly string[];
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  return (
    <section>
      <details open={expanded}>
        <summary hidden={expanded}>Keyboard shortcuts</summary>
        <p className="muted">
          Shortcuts work system-wide during a meeting, also while Teams is in
          front, and are released when it ends. Hold ⌘⌥ in the app to see them.
          Stop &amp; save needs two presses. Pin, dismiss and expand act on the
          opened card, or the newest card. Recording pause and assistance pause
          are separate.
        </p>
        {Object.entries(draft).map(([action, key]) => {
          const saved = value[action as keyof Shortcuts];
          const blocked = unavailable.includes(saved);
          const note = `shortcut-${action}-unavailable`;
          return (
            <label key={action}>
              {shortcutLabels[action as keyof Shortcuts] ?? action}
              <input
                value={key}
                aria-describedby={blocked ? note : undefined}
                onChange={(e) => setDraft({ ...draft, [action]: e.target.value })}
              />
              {blocked && (
                <small className="shortcut-unavailable" id={note}>
                  {shortcutText(saved)} is unavailable, probably used by another app. The button still works; choose another shortcut and save.
                </small>
              )}
            </label>
          );
        })}
        <button
          onClick={() => {
            if (validateShortcuts(draft)) {
              onChange(draft);
              setError("");
            } else
              setError(
                "Each shortcut needs ⌘ with ⌥ or ⇧, then a letter, number, Space, ⌫, ↩ or ⎋, must differ from the others, and cannot be a key macOS keeps for itself, such as ⌘⌥⎋ (Force Quit).",
              );
          }}
        >
          Save shortcuts
        </button>
        <button
          onClick={() => {
            setDraft(defaultShortcuts);
            onChange(defaultShortcuts);
          }}
        >
          Restore defaults
        </button>
        <p role="alert">{error}</p>
      </details>
    </section>
  );
}
