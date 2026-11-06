import { expect, test, vi } from "vitest";
import { defaultShortcuts, type ShortcutAction } from "./shortcuts";
import { ShortcutRegistrar, type GlobalShortcutApi } from "./shortcutRegistration";

/** A fake of the plugin: like the real one, registering a key that is already registered fails. */
function fakeApi(delayMs = 0) {
  const active = new Map<string, (event: { state: string }) => void>();
  const log: string[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  const api: GlobalShortcutApi = {
    register: vi.fn(async (key: string, handler: (event: { state: string }) => void) => {
      await wait();
      if (active.has(key)) throw Error("already registered");
      active.set(key, handler);
      log.push("+" + key);
    }),
    unregister: vi.fn(async (keys: string | string[]) => {
      await wait();
      for (const key of [keys].flat()) { active.delete(key); log.push("-" + key); }
    }),
  };
  return { api, active, log };
}

test("a change while the first registration is still running never leaves the old keys behind or reports false failures", async () => {
  vi.useFakeTimers();
  const { api, active } = fakeApi(5);
  const unavailable: string[] = [];
  const registrar = new ShortcutRegistrar(api, () => {}, (keys) => unavailable.push(...keys));
  void registrar.apply(defaultShortcuts);
  // Halfway through the first loop, the person saves a different Pin shortcut.
  await vi.advanceTimersByTimeAsync(12);
  const changed = { ...defaultShortcuts, pin: "CommandOrControl+Alt+L" };
  const done = registrar.apply(changed);
  await vi.runAllTimersAsync();
  await done;
  expect([...active.keys()].sort()).toEqual(Object.values(changed).sort());
  expect(active.has(defaultShortcuts.pin)).toBe(false);
  expect(unavailable).toEqual([]);
  vi.useRealTimers();
});

test("re-registering unregisters everything this registrar holds first", async () => {
  const { api, log } = fakeApi();
  const registrar = new ShortcutRegistrar(api, () => {}, () => {});
  await registrar.apply(defaultShortcuts);
  log.length = 0;
  await registrar.apply({ ...defaultShortcuts, stop: "CommandOrControl+Shift+Escape" });
  const firstAdd = log.findIndex((entry) => entry.startsWith("+"));
  expect(log.slice(0, firstAdd).filter((entry) => entry.startsWith("-")).length).toBe(Object.keys(defaultShortcuts).length);
});

test("clear after apply removes every key, even when apply was still running", async () => {
  vi.useFakeTimers();
  const { api, active } = fakeApi(5);
  const registrar = new ShortcutRegistrar(api, () => {}, () => {});
  void registrar.apply(defaultShortcuts);
  await vi.advanceTimersByTimeAsync(7);
  const cleared = registrar.clear();
  await vi.runAllTimersAsync();
  await cleared;
  expect(active.size).toBe(0);
  vi.useRealTimers();
});

test("a pressed key calls its action; a key that cannot register is reported by its accelerator", async () => {
  const { api, active } = fakeApi();
  const actions: ShortcutAction[] = [];
  const unavailable: string[] = [];
  vi.mocked(api.register).mockImplementationOnce(async () => { throw Error("taken by another app"); });
  const registrar = new ShortcutRegistrar(api, (action) => actions.push(action), (keys) => unavailable.push(...keys));
  await registrar.apply(defaultShortcuts);
  expect(unavailable).toEqual([defaultShortcuts.digDeeper]);
  active.get(defaultShortcuts.pin)?.({ state: "Pressed" });
  active.get(defaultShortcuts.pin)?.({ state: "Released" });
  expect(actions).toEqual(["pin"]);
});

test("each completed apply reports its unavailable keys once, and a later successful apply clears them", async () => {
  const { api } = fakeApi();
  const reports: string[][] = [];
  const applied: string[][] = [];
  vi.mocked(api.register).mockImplementationOnce(async () => { throw Error("taken"); }).mockImplementationOnce(async () => { throw Error("taken"); });
  const registrar = new ShortcutRegistrar(api, () => {}, (keys) => reports.push(keys), (keys) => applied.push(keys));
  await registrar.apply(defaultShortcuts);
  expect(reports).toEqual([[defaultShortcuts.digDeeper, defaultShortcuts.respond]]);
  expect(applied).toEqual([[defaultShortcuts.digDeeper, defaultShortcuts.respond]]);
  await registrar.apply(defaultShortcuts);
  expect(reports).toHaveLength(1);
  expect(applied.at(-1)).toEqual([]);
});

test("an overtaken apply reports nothing, so an earlier outcome cannot overwrite the newest", async () => {
  vi.useFakeTimers();
  const { api } = fakeApi(5);
  const applied: string[][] = [];
  const registrar = new ShortcutRegistrar(api, () => {}, () => {}, (keys) => applied.push(keys));
  void registrar.apply(defaultShortcuts);
  await vi.advanceTimersByTimeAsync(12);
  const done = registrar.apply({ ...defaultShortcuts, pin: "CommandOrControl+Alt+K" });
  await vi.runAllTimersAsync();
  await done;
  expect(applied).toEqual([[]]);
  vi.useRealTimers();
});

test("a key whose release fails stays tracked and is released on the next clear", async () => {
  const { api, active } = fakeApi();
  const realUnregister = api.unregister;
  let failOnce = true;
  api.unregister = vi.fn(async (keys: string | string[]) => {
    if (failOnce && [keys].flat().includes(defaultShortcuts.pin)) { failOnce = false; throw Error("unregister failed"); }
    return realUnregister(keys);
  });
  const applied: string[][] = [];
  const registrar = new ShortcutRegistrar(api, () => {}, () => {}, (keys) => applied.push(keys));
  await registrar.apply(defaultShortcuts);
  await registrar.clear();
  expect([...active.keys()]).toEqual([defaultShortcuts.pin]);
  await registrar.clear();
  expect(active.size).toBe(0);
  expect(applied.at(-1)).toEqual([]);
});

test("a failed release is retried by the next apply too", async () => {
  const { api, active } = fakeApi();
  const realUnregister = api.unregister;
  let failOnce = true;
  api.unregister = vi.fn(async (keys: string | string[]) => {
    if (failOnce) { failOnce = false; throw Error("unregister failed"); }
    return realUnregister(keys);
  });
  const registrar = new ShortcutRegistrar(api, () => {}, () => {});
  await registrar.apply(defaultShortcuts);
  await registrar.clear();
  expect(active.size).toBe(1);
  const changed = { ...defaultShortcuts, pin: "CommandOrControl+Alt+L", digDeeper: "CommandOrControl+Alt+J" };
  await registrar.apply(changed);
  await registrar.clear();
  expect(active.size).toBe(0);
});
