import { expect, test, vi } from "vitest";
import { CHEAT_SHEET_HOLD_MS, ModifierHold, StopConfirmation } from "./hotkeyGestures";
import { STOP_CONFIRM_MS } from "./shortcuts";

test("Stop & save needs a second press within the window", () => {
  const stop = new StopConfirmation();
  expect(stop.press(0)).toBe("armed");
  expect(stop.press(STOP_CONFIRM_MS - 1)).toBe("confirmed");
  // Confirming disarms: a third press starts over.
  expect(stop.press(STOP_CONFIRM_MS)).toBe("armed");
});
test("a second press after the window only arms again", () => {
  const stop = new StopConfirmation();
  expect(stop.press(0)).toBe("armed");
  expect(stop.press(STOP_CONFIRM_MS + 1)).toBe("armed");
  expect(stop.press(STOP_CONFIRM_MS + 2)).toBe("confirmed");
  stop.press(10_000);
  stop.reset();
  expect(stop.press(10_001)).toBe("armed");
});

const key = (key: string, meta = true, alt = true) => ({ key, metaKey: meta, altKey: alt, ctrlKey: false, shiftKey: false, repeat: false });
test("holding ⌘⌥ alone shows the list after the hold time; releasing hides it", () => {
  vi.useFakeTimers();
  const changes: boolean[] = [];
  const hold = new ModifierHold((v) => changes.push(v));
  hold.keydown(key("Meta", true, false));
  hold.keydown(key("Alt"));
  vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS - 1);
  expect(changes).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(changes).toEqual([true]);
  hold.keydown({ ...key("Alt"), repeat: true });
  hold.keyup(key("Alt", true, false));
  expect(changes).toEqual([true, false]);
  vi.useRealTimers();
});
test("a real shortcut or another modifier cancels the list", () => {
  vi.useFakeTimers();
  const changes: boolean[] = [];
  const hold = new ModifierHold((v) => changes.push(v));
  hold.keydown(key("Alt"));
  hold.keydown(key("1"));
  vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS * 2);
  expect(changes).toEqual([]);
  hold.keydown({ ...key("Shift"), shiftKey: true });
  vi.advanceTimersByTime(CHEAT_SHEET_HOLD_MS * 2);
  expect(changes).toEqual([]);
  vi.useRealTimers();
});
