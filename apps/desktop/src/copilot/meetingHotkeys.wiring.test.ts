// @vitest-environment happy-dom
// The real hooks in a DOM under StrictMode, with a fake of the global-shortcut plugin: keys are held only while a
// meeting is live, Stop & save needs two presses, and the held-⌘⌥ list shows and hides with the keys.
import { StrictMode, act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultShortcuts, STOP_CONFIRM_MS, type ShortcutAction } from "../lib/copilot/shortcuts";
import { CHEAT_SHEET_HOLD_MS } from "../lib/copilot/hotkeyGestures";
import type { GlobalShortcutApi } from "../lib/copilot/shortcutRegistration";
import { useMeetingShortcuts } from "./useMeetingShortcuts";
import { useStopConfirmation } from "./useStopConfirmation";
import { ShortcutCheatSheet, cheatSheetRows, useModifierHold } from "./ShortcutCheatSheet";
import { stopPromptLine } from "../lib/copilot/status";
import { hideAfterStopPrompt, useStopReveal, type RevealableWindow } from "./widget/stopReveal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Like the real plugin: a key registered twice fails, and keys persist until unregistered. */
function fakePlugin(taken: string[] = []) {
  const active = new Map<string, (event: { state: string }) => void>();
  const api: GlobalShortcutApi = {
    register: vi.fn(async (key: string, handler: (event: { state: string }) => void) => {
      if (active.has(key) || taken.includes(key)) throw Error("already registered");
      active.set(key, handler);
    }),
    unregister: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) active.delete(key); }),
  };
  return { api, active, press: (key: string) => active.get(key)?.({ state: "Pressed" }) };
}
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const render = (node: ReactNode) => act(async () => root.render(createElement(StrictMode, null, node)));

describe("global shortcuts are held only during a meeting", () => {
  function Harness({ api, live, onAction = () => {}, unavailable = () => {}, applied = () => {} }: { api: GlobalShortcutApi; live: boolean; onAction?: (a: ShortcutAction) => void; unavailable?: (keys: string[]) => void; applied?: (keys: string[]) => void }) {
    useMeetingShortcuts({ api, enabled: true, live, shortcuts: defaultShortcuts, onAction, onUnavailable: unavailable, onApplied: applied });
    return null;
  }
  test("nothing is registered at launch; start registers every key; stop releases them all", async () => {
    const plugin = fakePlugin();
    await render(createElement(Harness, { api: plugin.api, live: false }));
    await flush();
    expect(plugin.api.register).not.toHaveBeenCalled();
    expect(plugin.active.size).toBe(0);
    await render(createElement(Harness, { api: plugin.api, live: true }));
    await flush();
    expect([...plugin.active.keys()].sort()).toEqual(Object.values(defaultShortcuts).sort());
    await render(createElement(Harness, { api: plugin.api, live: false }));
    await flush();
    expect(plugin.active.size).toBe(0);
  });
  test("a window that opens into a recovered live meeting registers once, despite StrictMode's double effects", async () => {
    const plugin = fakePlugin();
    const unavailable: string[] = [];
    await render(createElement(Harness, { api: plugin.api, live: true, unavailable: (keys) => unavailable.push(...keys) }));
    await flush();
    expect(plugin.active.size).toBe(Object.keys(defaultShortcuts).length);
    expect(unavailable).toEqual([]);
  });
  test("unmount and page hide release every key", async () => {
    const plugin = fakePlugin();
    await render(createElement(Harness, { api: plugin.api, live: true }));
    await flush();
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(plugin.active.size).toBe(0);
    await render(createElement(Harness, { api: plugin.api, live: false }));
    await render(createElement(Harness, { api: plugin.api, live: true }));
    await flush();
    expect(plugin.active.size).toBeGreaterThan(0);
    await act(async () => root.unmount());
    await flush();
    expect(plugin.active.size).toBe(0);
    root = createRoot(host);
  });
  test("a key another app holds is still reported, and pressed keys reach their action", async () => {
    const plugin = fakePlugin([defaultShortcuts.pin]);
    const unavailable: string[] = [];
    const actions: ShortcutAction[] = [];
    await render(createElement(Harness, { api: plugin.api, live: true, onAction: (a) => actions.push(a), unavailable: (keys) => unavailable.push(...keys) }));
    await flush();
    expect(unavailable).toEqual([defaultShortcuts.pin]);
    plugin.press(defaultShortcuts.respond);
    expect(actions).toEqual(["respond"]);
  });
});

test("ending a meeting clears the keys it could not register, so Settings and the next meeting do not show them", async () => {
  const plugin = fakePlugin([defaultShortcuts.pin]);
  let shown: string[] = [];
  function Harness({ live }: { live: boolean }) {
    useMeetingShortcuts({ api: plugin.api, enabled: true, live, shortcuts: defaultShortcuts, onAction() {}, onUnavailable() {}, onApplied: (keys) => { shown = keys; } });
    return null;
  }
  await render(createElement(Harness, { live: true }));
  await flush();
  expect(shown).toEqual([defaultShortcuts.pin]);
  await render(createElement(Harness, { live: false }));
  await flush();
  expect(shown).toEqual([]);
});

describe("the first Stop & save press brings up a hidden widget for the prompt", () => {
  let revealed = false;
  function Harness({ pending, widget }: { pending: boolean; widget: RevealableWindow | null }) {
    revealed = useStopReveal(pending, async () => widget).revealed;
    return null;
  }
  const fakeWidget = (visible: boolean) => {
    const w = { visible, isVisible: vi.fn(async () => w.visible), show: vi.fn(async () => { w.visible = true; }) };
    return w;
  };
  test("a hidden widget is shown, then told to hide once the prompt has gone", async () => {
    const widget = fakeWidget(false);
    // What the widget would decide from each published state: the prompt while pending, then hide.
    const hides: boolean[] = [];
    function Watch({ pending }: { pending: boolean }) {
      const shown = useStopReveal(pending, async () => widget).revealed;
      hides.push(hideAfterStopPrompt({ stopPrompt: pending ? "Press ⌘⌥9 again to stop and save." : undefined, hideWithStopPrompt: shown }));
      revealed = shown;
      return null;
    }
    await render(createElement(Watch, { pending: true }));
    await flush();
    expect(widget.show).toHaveBeenCalledTimes(1);
    expect(revealed).toBe(true);
    expect(hides.every((hide) => !hide)).toBe(true);
    await render(createElement(Watch, { pending: false }));
    await flush();
    expect(hides).toContain(true);
    // The flag clears after that one state, so a widget the person opens later stays open.
    expect(revealed).toBe(false);
    expect(hides.at(-1)).toBe(false);
  });
  test("a widget already on screen, or none, is left alone", async () => {
    const widget = fakeWidget(true);
    await render(createElement(Harness, { pending: true, widget }));
    await flush();
    expect(widget.show).not.toHaveBeenCalled();
    expect(revealed).toBe(false);
    await render(createElement(Harness, { pending: false, widget: null }));
    await render(createElement(Harness, { pending: true, widget: null }));
    await flush();
    expect(revealed).toBe(false);
  });
});

describe("Stop & save needs a double press", () => {
  let stops = 0;
  let pending = false;
  let refused = false;
  let accept = true;
  let press = () => {};
  function Harness({ meetingId }: { meetingId?: string }) {
    const stop = useStopConfirmation(meetingId, () => { if (!accept) return false; stops++; return true; });
    pending = stop.stopPending;
    refused = stop.stopRefused;
    press = stop.press;
    return null;
  }
  beforeEach(() => { stops = 0; pending = false; refused = false; accept = true; vi.useFakeTimers(); });
  test("a confirming press that Stop refuses (a start still running) keeps the request and says so", async () => {
    await render(createElement(Harness, { meetingId: "m1" }));
    accept = false;
    await act(async () => press());
    await act(async () => press());
    expect(stops).toBe(0);
    expect(pending).toBe(true);
    expect(refused).toBe(true);
    expect(stopPromptLine(defaultShortcuts.stop, { stopPending: pending, stopRefused: refused })).toBe("Not ready to stop yet. Press ⌘⌥9 again in a moment.");
    // The arm was kept, so one more press within the window stops once Stop accepts.
    accept = true;
    await act(async () => { vi.advanceTimersByTime(STOP_CONFIRM_MS - 100); });
    await act(async () => press());
    expect(stops).toBe(1);
    expect(pending).toBe(false);
    expect(refused).toBe(false);
  });
  test("the first press asks; a second within the window stops", async () => {
    await render(createElement(Harness, { meetingId: "m1" }));
    await act(async () => press());
    expect(pending).toBe(true);
    expect(stops).toBe(0);
    await act(async () => { vi.advanceTimersByTime(STOP_CONFIRM_MS - 200); });
    await act(async () => press());
    expect(stops).toBe(1);
    expect(pending).toBe(false);
  });
  test("the request lapses after the window, and a late press only asks again", async () => {
    await render(createElement(Harness, { meetingId: "m1" }));
    await act(async () => press());
    await act(async () => { vi.advanceTimersByTime(STOP_CONFIRM_MS + 10); });
    expect(pending).toBe(false);
    await act(async () => press());
    expect(stops).toBe(0);
    expect(pending).toBe(true);
  });
  test("a new meeting starts without an armed stop", async () => {
    await render(createElement(Harness, { meetingId: "m1" }));
    await act(async () => press());
    await render(createElement(Harness, { meetingId: "m2" }));
    expect(pending).toBe(false);
    await act(async () => press());
    expect(stops).toBe(0);
  });
});

describe("the held-⌘⌥ key list", () => {
  function Harness({ live }: { live: boolean }) {
    const visible = useModifierHold(live);
    return createElement(ShortcutCheatSheet, { rows: cheatSheetRows(defaultShortcuts), visible });
  }
  const key = (type: "keydown" | "keyup", key: string, mods: { metaKey?: boolean; altKey?: boolean } = { metaKey: true, altKey: true }) =>
    act(async () => { window.dispatchEvent(new KeyboardEvent(type, { key, ...mods })); });
  const sheet = () => host.querySelector("[data-cheat-sheet]");
  beforeEach(() => vi.useFakeTimers());
  test("appears after holding ⌘⌥ and leaves on release, without taking focus", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    await render(createElement(Harness, { live: true }));
    await key("keydown", "Meta", { metaKey: true });
    await key("keydown", "Alt");
    expect(sheet()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS); });
    expect(sheet()).not.toBeNull();
    expect(sheet()!.textContent).toContain("Stop & save");
    expect(sheet()!.textContent).toContain("⌘⌥9");
    expect(sheet()!.getAttribute("aria-hidden")).toBe("true");
    expect(sheet()!.querySelector("[tabindex], button, a")).toBeNull();
    expect(document.activeElement).toBe(button);
    await key("keyup", "Alt", { metaKey: true });
    expect(sheet()).toBeNull();
    button.remove();
  });
  test("a shortcut pressed before the hold time, or the window losing focus, keeps it away", async () => {
    await render(createElement(Harness, { live: true }));
    await key("keydown", "Alt");
    await key("keydown", "1");
    await act(async () => { vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS * 2); });
    expect(sheet()).toBeNull();
    await key("keyup", "1");
    await key("keydown", "Alt");
    await act(async () => { vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS); });
    expect(sheet()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(sheet()).toBeNull();
  });
  test("outside a meeting holding ⌘⌥ shows nothing", async () => {
    await render(createElement(Harness, { live: false }));
    await key("keydown", "Alt");
    await act(async () => { vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS * 2); });
    expect(sheet()).toBeNull();
  });
});
