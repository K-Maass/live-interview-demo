import { expect, test } from "vitest";
import {
  defaultShortcuts,
  validateShortcuts,
  targetCard,
  resolveShortcuts,
  isSystemReserved,
} from "./shortcuts";
test("all guidance and card/lifecycle controls have unique remappable shortcuts", () => {
  expect(validateShortcuts(defaultShortcuts)).toBe(true);
  expect(
    validateShortcuts({ ...defaultShortcuts, pin: defaultShortcuts.respond }),
  ).toBe(false);
  expect(validateShortcuts({ ...defaultShortcuts, pin: "P" })).toBe(false);
  expect(targetCard({ cards: [], savedPins: [], queued: 0 })).toBeUndefined();
});
test("the previous pause default migrates without overwriting personalized controls", () => {
  const old = {
    ...defaultShortcuts,
    pauseAssistance: "CommandOrControl+Alt+Space",
    pin: "CommandOrControl+Alt+K",
  };
  const migrated = resolveShortcuts(old);
  expect(migrated.pauseAssistance).toBe("CommandOrControl+Alt+6");
  expect(migrated.pin).toBe(old.pin);
  expect(old.pauseAssistance).toBe("CommandOrControl+Alt+Space");
  expect(validateShortcuts(migrated)).toBe(true);
});
test("migration avoids a personalized binding already using the replacement key", () => {
  const migrated = resolveShortcuts({
    ...defaultShortcuts,
    pauseAssistance: "CommandOrControl+Alt+Space",
    pin: "Command+Alt+6",
  });
  expect(migrated.pauseAssistance).toBe("CommandOrControl+Alt+7");
  expect(migrated.pin).toBe("Command+Alt+6");
});
/** What a person who never changed a key has stored from the earlier releases. */
const formerDefaults = {
  ...defaultShortcuts,
  pin: "CommandOrControl+Alt+P",
  dismiss: "CommandOrControl+Alt+Backspace",
  stop: "CommandOrControl+Alt+Escape",
};
test("the defaults avoid Force Quit, Finder's Delete Immediately and Show Path Bar", () => {
  const keys = Object.values(defaultShortcuts).map((k) => k.toLowerCase());
  for (const clash of ["commandorcontrol+alt+escape", "commandorcontrol+alt+backspace", "commandorcontrol+alt+p", "commandorcontrol+alt+8"])
    expect(keys).not.toContain(clash);
  expect(isSystemReserved(defaultShortcuts.stop)).toBe(false);
});
test("former clashing defaults move to the new defaults", () => {
  const migrated = resolveShortcuts(formerDefaults);
  expect(migrated).toEqual(defaultShortcuts);
  expect(validateShortcuts(migrated)).toBe(true);
});
test("customised bindings stay while untouched former defaults migrate", () => {
  const stored = { ...formerDefaults, pin: "CommandOrControl+Alt+L", respond: "CommandOrControl+Shift+R" };
  const migrated = resolveShortcuts(stored);
  expect(migrated.pin).toBe("CommandOrControl+Alt+L");
  expect(migrated.respond).toBe("CommandOrControl+Shift+R");
  expect(migrated.stop).toBe(defaultShortcuts.stop);
  expect(migrated.dismiss).toBe(defaultShortcuts.dismiss);
});
test("a migrated key never takes a binding the person already uses", () => {
  const migrated = resolveShortcuts({ ...formerDefaults, pauseAssistance: "CommandOrControl+Alt+9", pin: "Command+Alt+X" });
  expect(migrated.pauseAssistance).toBe("CommandOrControl+Alt+9");
  expect(migrated.stop).toBe("CommandOrControl+Alt+7");
  expect(migrated.pin).toBe("Command+Alt+X");
  expect(migrated.dismiss).toBe("CommandOrControl+Alt+Shift+X");
  expect(validateShortcuts(migrated)).toBe(true);
});
test("a custom shortcut may not take a key macOS keeps for itself", () => {
  expect(validateShortcuts({ ...defaultShortcuts, stop: "Command+Alt+Escape" })).toBe(false);
  expect(validateShortcuts({ ...defaultShortcuts, pin: "CommandOrControl+Alt+D" })).toBe(false);
  // The same key written another way is still the same key.
  expect(validateShortcuts({ ...defaultShortcuts, pin: "Command+Alt+1" })).toBe(false);
});
test("a personalized pause shortcut is preserved", () => {
  const custom = {
    ...defaultShortcuts,
    pauseAssistance: "CommandOrControl+Alt+L",
  };
  expect(resolveShortcuts(custom)).toEqual(custom);
});
test("one reserved custom key falls back alone; the other customised keys are kept", () => {
  const stored = { ...defaultShortcuts, digDeeper: "CommandOrControl+Alt+H", respond: "CommandOrControl+Alt+Y" };
  const resolved = resolveShortcuts(stored);
  expect(resolved.digDeeper).toBe(defaultShortcuts.digDeeper);
  expect(resolved.respond).toBe("CommandOrControl+Alt+Y");
  expect(validateShortcuts(resolved)).toBe(true);
});
test("a fallback avoids a key another customised control already uses", () => {
  const resolved = resolveShortcuts({ ...defaultShortcuts, digDeeper: "CommandOrControl+Shift+3", respond: defaultShortcuts.digDeeper, contribute: "CommandOrControl+Alt+Y" });
  expect(resolved.respond).toBe(defaultShortcuts.digDeeper);
  expect(resolved.digDeeper).toBe("CommandOrControl+Alt+Shift+1");
  expect(resolved.contribute).toBe("CommandOrControl+Alt+Y");
  expect(validateShortcuts(resolved)).toBe(true);
});
test("a malformed, missing or duplicated entry is repaired without touching the rest", () => {
  const { pin: _pin, ...missingPin } = { ...defaultShortcuts, respond: "CommandOrControl+Alt+Y" };
  expect(resolveShortcuts(missingPin)).toEqual({ ...defaultShortcuts, respond: "CommandOrControl+Alt+Y" });
  expect(resolveShortcuts({ ...defaultShortcuts, respond: "P", contribute: "CommandOrControl+Alt+Y" })).toEqual({ ...defaultShortcuts, contribute: "CommandOrControl+Alt+Y" });
  // Two controls on one key: the one on its own default keeps it.
  expect(resolveShortcuts({ ...defaultShortcuts, checkObjectives: defaultShortcuts.respond, contribute: "CommandOrControl+Alt+Y" })).toEqual({ ...defaultShortcuts, contribute: "CommandOrControl+Alt+Y" });
  expect(resolveShortcuts(null)).toEqual(defaultShortcuts);
});
test("screenshot, log-out and Finder search keys are reserved for macOS", () => {
  for (const key of ["Command+Shift+3", "CommandOrControl+Shift+4", "Command+Shift+5", "Command+Shift+Q", "CommandOrControl+Alt+Space"])
    expect(isSystemReserved(key)).toBe(true);
  expect(validateShortcuts({ ...defaultShortcuts, pin: "CommandOrControl+Shift+3" })).toBe(false);
});
