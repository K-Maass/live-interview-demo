import { useEffect, useState } from "react";
import { ModifierHold } from "../lib/copilot/hotkeyGestures";
import { shortcutLabels, shortcutText, type ShortcutAction, type Shortcuts } from "../lib/copilot/shortcuts";

export type CheatSheetRow = { label: string; keys: string };
/** The rows of the key list, in the order of the Settings › Keyboard list, as the keys a Mac user sees. */
export const cheatSheetRows = (shortcuts: Shortcuts): CheatSheetRow[] =>
  (Object.keys(shortcutLabels) as ShortcutAction[]).map((action) => ({ label: shortcutLabels[action], keys: shortcutText(shortcuts[action]) }));

/**
 * True while ⌘⌥ has been held on its own for CHEAT_SHEET_HOLD_MS in this window, and only while `active`. Key events
 * reach a window only when it is in front, so the list appears in whichever Live Interview window has focus; while
 * Teams is in front the global keys still work but nothing is shown.
 */
export function useModifierHold(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    const detector = new ModifierHold(setVisible);
    const down = (event: KeyboardEvent) => detector.keydown(event);
    const up = (event: KeyboardEvent) => detector.keyup(event);
    const cancel = () => detector.cancel();
    const hidden = () => { if (document.hidden) detector.cancel(); };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
      detector.cancel();
    };
  }, [active]);
  return visible;
}

/**
 * The key list shown while ⌘⌥ is held. It never takes focus and is not a dialog: it is a passive note that leaves when
 * the keys are released. It is hidden from the accessibility tree because it lasts only while keys are held; the same
 * keys are listed in Settings › Keyboard and in each button's title.
 */
export function ShortcutCheatSheet({ rows, visible, className = "" }: { rows: readonly CheatSheetRow[]; visible: boolean; className?: string }) {
  if (!visible) return null;
  return <div className={"shortcut-cheat-sheet " + className} aria-hidden="true" data-cheat-sheet>
    <p className="shortcut-cheat-sheet-title">Meeting shortcuts</p>
    <dl>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd><kbd>{row.keys}</kbd></dd></div>)}</dl>
  </div>;
}
