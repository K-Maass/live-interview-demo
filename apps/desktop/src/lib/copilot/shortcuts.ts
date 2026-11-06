import type { LiveViewState } from "@live-interview/core";
/**
 * Defaults, all ⌘⌥ (no other modifier set is free of system and VoiceOver use: ⌃⌥ is the VoiceOver key). They are
 * registered only while a meeting is live, but a meeting is exactly when the person is in Teams or Finder, so each key
 * must also leave those alone. Reviewed against macOS and common apps:
 * - Stop & save was ⌘⌥⎋, which is macOS Force Quit: the app took the Force Quit window away system-wide. Now ⌘⌥9, at
 *   the end of the number row next to Pause recording, and it needs a second press within STOP_CONFIRM_MS.
 * - Dismiss was ⌘⌥⌫, Finder's Delete Immediately (skips the Bin). Now ⌘⌥X.
 * - Pin was ⌘⌥P, Finder's Show Path Bar and a print/preview key in several apps. Now ⌘⌥K ("keep").
 * - The number row ⌘⌥1–6 and ⌘⌥0 is unused by macOS, Finder and Teams. ⌘⌥8 is avoided: it toggles Zoom when the
 *   accessibility zoom shortcuts are on. ⌘⌥↩ has no system or Finder meaning and stays for Expand.
 * The modifiers alone (⌘⌥ held) show the key list, so every default keeps ⌘⌥.
 */
export const defaultShortcuts = {
  digDeeper: "CommandOrControl+Alt+1",
  respond: "CommandOrControl+Alt+2",
  contribute: "CommandOrControl+Alt+3",
  checkConversation: "CommandOrControl+Alt+4",
  checkObjectives: "CommandOrControl+Alt+5",
  pin: "CommandOrControl+Alt+K",
  dismiss: "CommandOrControl+Alt+X",
  expand: "CommandOrControl+Alt+Enter",
  pauseAssistance: "CommandOrControl+Alt+6",
  pauseRecording: "CommandOrControl+Alt+0",
  stop: "CommandOrControl+Alt+9",
};
export type ShortcutAction = keyof typeof defaultShortcuts;
export type Shortcuts = Record<ShortcutAction, string>;
/** A second Stop & save press within this window stops the meeting; the first only asks for it. */
export const STOP_CONFIRM_MS = 1500;
export const shortcutLabels: Record<ShortcutAction, string> = {
  digDeeper: "Dig deeper",
  respond: "Help me respond",
  contribute: "Help me contribute",
  checkConversation: "Check conversation",
  checkObjectives: "Check objectives",
  pin: "Pin suggestion",
  dismiss: "Dismiss suggestion",
  expand: "Expand evidence",
  pauseAssistance: "Pause assistance",
  pauseRecording: "Pause recording",
  stop: "Stop & save (press twice)",
};
/** One accelerator in a comparable form: "CommandOrControl+Alt+K" and "Alt+Command+k" are the same key. */
const normalize = (key: string) =>
  key
    .toLowerCase()
    .replace("commandorcontrol", "command")
    .split("+")
    .sort()
    .join("+");
/**
 * Keys macOS itself owns while any app is in front; registering one takes it away from the whole system. Custom
 * shortcuts may not use them. App-level keys (Finder, Teams) are avoided by the defaults but remain a person's choice.
 */
const systemReserved = new Set(
  [
    "Command+Alt+Escape", // Force Quit Applications
    "Command+Alt+Shift+Escape", // force quit the front app (held)
    "Command+Alt+D", // show or hide the Dock
    "Command+Alt+H", // hide other apps
    "Command+Alt+M", // minimise all windows of the front app
    "Command+Alt+8", // Zoom on/off (accessibility)
    "Command+Alt+Space", // Finder search window
    "Command+Shift+3", // screenshot of the screen
    "Command+Shift+4", // screenshot of a selection
    "Command+Shift+5", // screenshot and recording controls
    "Command+Shift+Q", // log out
    // ⌘Space (Spotlight) and ⌘Tab (app switcher) need no entry: a custom key must include ⌥ or ⇧.
  ].map(normalize),
);
export const isSystemReserved = (accelerator: string) => systemReserved.has(normalize(accelerator));
/**
 * Former defaults that clashed with the system, Finder or another control, newest replacement first. A stored value
 * that still equals the former default was never customised, so it moves; any other value is the person's and stays.
 */
const migrations: { action: ShortcutAction; from: string; to: string[] }[] = [
  { action: "pauseAssistance", from: "CommandOrControl+Alt+Space", to: ["6", "7", "9", "A"].map((k) => `CommandOrControl+Alt+${k}`) },
  { action: "stop", from: "CommandOrControl+Alt+Escape", to: [defaultShortcuts.stop, "CommandOrControl+Alt+7", "CommandOrControl+Alt+Shift+9"] },
  { action: "dismiss", from: "CommandOrControl+Alt+Backspace", to: [defaultShortcuts.dismiss, "CommandOrControl+Alt+Shift+X"] },
  { action: "pin", from: "CommandOrControl+Alt+P", to: [defaultShortcuts.pin, "CommandOrControl+Alt+Shift+K"] },
];
const hasShape = (value: unknown): value is Shortcuts =>
  !!value &&
  typeof value === "object" &&
  Object.keys(value).length === Object.keys(defaultShortcuts).length &&
  Object.keys(defaultShortcuts).every((k) => typeof (value as Shortcuts)[k as ShortcutAction] === "string");
const acceleratorShape = /^(CommandOrControl|Command|Control)\+(Alt|Shift)(\+(Alt|Shift))?\+(?:[A-Z0-9]|Space|Backspace|Enter|Escape)$/i;
/** One key a person may use: the accepted shape and not owned by macOS. Uniqueness is checked across the set. */
const usableKey = (key: unknown): key is string => typeof key === "string" && acceleratorShape.test(key) && !isSystemReserved(key);
/**
 * Stored shortcuts, with former clashing defaults upgraded and every valid customised control kept. Only an entry that
 * is missing, malformed, system-reserved or a duplicate falls back: to its migration replacement, then its default,
 * then its default with ⇧, whichever no other control holds. A whole reset happens only when nothing fits.
 */
export function resolveShortcuts(value: unknown): Shortcuts {
  if (!value || typeof value !== "object") return { ...defaultShortcuts };
  const stored = value as Partial<Record<ShortcutAction, unknown>>;
  const actions = Object.keys(defaultShortcuts) as ShortcutAction[];
  const next = {} as Shortcuts;
  for (const action of actions) next[action] = typeof stored[action] === "string" ? (stored[action] as string) : "";
  const replacements = new Map<ShortcutAction, string[]>();
  for (const { action, from, to } of migrations) {
    if (next[action] && normalize(next[action]) === normalize(from)) replacements.set(action, to);
  }
  // Keep every usable key that is not a former default being migrated. On a duplicate, the control already on its
  // own default keeps it; otherwise the first control in order does.
  const kept = new Map<string, ShortcutAction>();
  const ordered = [...actions].sort((a, b) => Number(normalize(next[b]) === normalize(defaultShortcuts[b])) - Number(normalize(next[a]) === normalize(defaultShortcuts[a])));
  const offending: ShortcutAction[] = [];
  for (const action of ordered) {
    const key = normalize(next[action]);
    if (replacements.has(action) || !usableKey(next[action]) || kept.has(key)) offending.push(action);
    else kept.set(key, action);
  }
  for (const action of actions.filter((a) => offending.includes(a))) {
    const shifted = defaultShortcuts[action].replace("CommandOrControl+Alt+", "CommandOrControl+Alt+Shift+");
    const candidates = [...(replacements.get(action) ?? []), defaultShortcuts[action], shifted];
    const replacement = candidates.find((key) => usableKey(key) && !kept.has(normalize(key)));
    if (!replacement) return { ...defaultShortcuts };
    next[action] = replacement;
    kept.set(normalize(replacement), action);
  }
  return validateShortcuts(next) ? next : { ...defaultShortcuts };
}
export function validateShortcuts(value: unknown): value is Shortcuts {
  if (!hasShape(value)) return false;
  const values = Object.values(value);
  return values.every(usableKey) && new Set(values.map(normalize)).size === values.length;
}
const keySymbols: Record<string, string> = { escape: "⎋", backspace: "⌫", enter: "↩" };
/** "CommandOrControl+Alt+Escape" as the keys a Mac user sees: "⌘⌥⎋". Never show the raw accelerator to a person. */
export const shortcutText = (accelerator: string) =>
  accelerator
    .split("+")
    .map((part) => {
      const key = part.toLowerCase();
      if (key === "commandorcontrol" || key === "command" || key === "cmd") return "⌘";
      if (key === "alt" || key === "option") return "⌥";
      if (key === "shift") return "⇧";
      if (key === "control" || key === "ctrl") return "⌃";
      return keySymbols[key] ?? part;
    })
    .join("");
export function targetCard(view: LiveViewState) {
  return (
    [view.requestedCard, ...view.cards].find(
      (c) => c?.id === view.detailCardId,
    ) ??
    view.requestedCard ??
    view.cards.at(-1)
  );
}
