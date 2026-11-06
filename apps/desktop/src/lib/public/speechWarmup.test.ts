import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { firstLoadSlowAfterMs, loadSlowAfterMs, loadingStatus, retryLocalSpeech, slowAfterMs, slowStatus, speechStatusText, warmLocalSpeech, warmPendingStatus, warmStatus, warmupNotice, watchSlowWarmup } from "./speechWarmup";

const oneTime = "Preparing local speech (one-time, a few minutes) · recording continues";

function run(state: () => Promise<{ status: string }>, warm: () => Promise<unknown>) {
  const shown: string[] = [];
  const done = warmLocalSpeech({ state, warm, setStatus: (s) => shown.push(s) });
  return { shown, done };
}

test("the one-time message is on screen while the first load runs, then it clears", async () => {
  let finish!: () => void;
  const { shown, done } = run(
    async () => ({ status: oneTime }),
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(shown).toEqual([oneTime]);
  finish();
  await done;
  expect(shown).toEqual([oneTime, warmStatus]);
});

test("a failed warm-up says recording is still available and does not throw", async () => {
  const { shown, done } = run(async () => ({ status: oneTime }), () => Promise.reject("warmFailed"));
  await done;
  expect(shown).toEqual([oneTime, warmPendingStatus]);
  expect(warmPendingStatus).toContain("recording");
});

test("an unreadable warm-up state still starts the load, with the plain message", async () => {
  let warmed = false;
  const { shown, done } = run(() => Promise.reject(new Error("unavailable")), async () => { warmed = true; });
  await done;
  expect(warmed).toBe(true);
  expect(shown).toEqual([loadingStatus, warmStatus]);
});

test("the notice shows only while the load is running or pending, and says recording continues", () => {
  expect(warmupNotice(oneTime)?.title).toContain("one-time");
  expect(warmupNotice(loadingStatus)?.title).toBe("Preparing local speech");
  expect(warmupNotice(loadingStatus)?.detail).toMatch(/Recording continues/);
  expect(warmupNotice(warmPendingStatus)?.detail).toMatch(/Recording is still available/);
  for (const settled of ["Local", warmStatus, "Warming local model…", "unavailable"]) expect(warmupNotice(settled)).toBeUndefined();
});

// #58 follow-up: the notice must never be an endless spinner. A load past its usual time says so and offers Retry.
function fakeTimers() {
  const pending: { run: () => void; ms: number; cleared: boolean }[] = [];
  return {
    pending,
    timers: { set: (run: () => void, ms: number) => { const t = { run, ms, cleared: false }; pending.push(t); return t; }, clear: (t: unknown) => { (t as { cleared: boolean }).cleared = true; } },
  };
}

test("a load that runs past its usual time turns into the slow notice with Retry and no spinner", () => {
  const { pending, timers } = fakeTimers();
  let current = oneTime;
  watchSlowWarmup(oneTime, (update) => { current = update(current); }, timers);
  expect(pending[0].ms).toBe(firstLoadSlowAfterMs);
  pending[0].run();
  expect(current).toBe(slowStatus);
  const notice = warmupNotice(current)!;
  expect(notice).toMatchObject({ busy: false, retry: true });
  expect(notice.title).toBe("Local speech is taking longer than usual");
  expect(notice.detail).toMatch(/Recording continues/);
});

test("a later load is called slow sooner than a first load, and settled statuses start no timer", () => {
  expect(slowAfterMs(loadingStatus)).toBe(loadSlowAfterMs);
  expect(loadSlowAfterMs).toBeLessThan(firstLoadSlowAfterMs);
  // Below the native side's 900 s limit, so the slow notice always appears before the load is stopped.
  expect(firstLoadSlowAfterMs).toBeLessThan(900_000);
  const { pending, timers } = fakeTimers();
  for (const settled of [warmStatus, warmPendingStatus, slowStatus, "Local", "Local speech running"]) watchSlowWarmup(settled, () => {}, timers);
  expect(pending).toHaveLength(0);
});

test("a load that finishes in time is never relabelled as slow", () => {
  const { pending, timers } = fakeTimers();
  let current = loadingStatus;
  const cleanup = watchSlowWarmup(loadingStatus, (update) => { current = update(current); }, timers);
  current = warmStatus;
  cleanup();
  expect(pending[0].cleared).toBe(true);
  pending[0].run(); // even a timer that fires late leaves a newer status alone
  expect(current).toBe(warmStatus);
});

test("only a load that is running shows the spinner; pending and slow offer Retry", () => {
  expect(warmupNotice(oneTime)).toMatchObject({ busy: true, retry: false });
  expect(warmupNotice(loadingStatus)).toMatchObject({ busy: true, retry: false });
  expect(warmupNotice(warmPendingStatus)).toMatchObject({ busy: false, retry: true });
});

test("Retry restarts the helper, loads again, and a superseded load cannot overwrite the new status", async () => {
  const shown: string[] = [];
  let attempt = 1;
  let failOld!: () => void;
  const old = warmLocalSpeech({ state: async () => ({ status: oneTime }), warm: () => new Promise<void>((_, reject) => (failOld = () => reject("warmRestarted"))), setStatus: (s) => shown.push(s), isCurrent: () => attempt === 1 });
  await Promise.resolve(); await Promise.resolve();
  attempt = 2;
  let restarted = false;
  const retried = retryLocalSpeech(async () => { restarted = true; failOld(); }, { state: async () => ({ status: loadingStatus }), warm: async () => undefined, setStatus: (s) => shown.push(s), isCurrent: () => attempt === 2 });
  await Promise.all([old, retried]);
  expect(restarted).toBe(true);
  expect(shown).toEqual([oneTime, loadingStatus, warmStatus]);
});

test("Retry still loads when the restart call itself fails", async () => {
  const shown: string[] = [];
  await retryLocalSpeech(() => Promise.reject("unavailable"), { state: async () => ({ status: loadingStatus }), warm: async () => undefined, setStatus: (s) => shown.push(s) });
  expect(shown).toEqual([loadingStatus, warmStatus]);
});

// Every status the native side emits on `speech-health` has plain words; a raw code never reaches the screen.
test("every native speech-health code has plain words", () => {
  const rust = readFileSync(join(__dirname, "../../../src-tauri/src/commands.rs"), "utf8");
  const sites = [...rust.matchAll(/"speech-health",\s*json!\(\{"meetingId":id,"code":([^}]*)\}/g)].map((m) => m[1].trim());
  expect(sites.length).toBe(rust.split('"speech-health"').length - 1);
  const codes = new Set<string>();
  for (const site of sites) {
    const literal = /^"([^"]+)"$/.exec(site);
    if (literal) codes.add(literal[1]);
    else if (site === "status") [oneTime, loadingStatus].forEach((c) => codes.add(c));
    else if (site === "crate::local_speech::warmup::READY_STATUS") codes.add(warmStatus);
    else throw Error(`unrecognised speech-health emit site: ${site}`);
  }
  for (const code of ["decodePending", "workerUnavailable", "translationPending", "Local speech running"]) expect(codes).toContain(code);
  const generic = speechStatusText("someFutureCode");
  for (const code of codes) expect(speechStatusText(code), code).not.toBe(generic);
  for (const code of ["decodePending", "workerUnavailable", "translationPending"]) expect(speechStatusText(code)).not.toContain(code);
  expect(speechStatusText("decodePending")).toBe("Transcription is waiting. Recording continues.");
  expect(warmupNotice("decodePending")?.retry).toBe(true);
  expect(warmupNotice("workerUnavailable")?.retry).toBe(true);
  expect(warmupNotice("translationPending")?.title).toBe("Translation is waiting");
  expect(generic).toBe("Local speech needs attention. Recording continues.");
});
