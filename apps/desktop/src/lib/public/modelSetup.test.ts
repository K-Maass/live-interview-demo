import { expect, test } from "vitest";
import {
  applyModelSetupEvent,
  describeModelSetup,
  describeSetupFailure,
  downloadSpeed,
  idleModelSetup,
  failModelSetup,
  formatBytes,
  requestModelSetupCancel,
  startModelSetup,
  type ModelSetupProgressEvent,
} from "./modelSetup";

const progress = (completedBytes: number, extra: Partial<ModelSetupProgressEvent> = {}): ModelSetupProgressEvent => ({
  kind: "setupProgress", stage: "downloading", asset: "recognition", completedBytes, totalBytes: 3_200_000_000, resumedBytes: 0, attempt: 1, ...extra,
});

test("bytes are shown in plain decimal units", () => {
  expect(formatBytes(3_195_000_000)).toBe("3.2 GB");
  expect(formatBytes(1_530_000_000)).toBe("1.5 GB");
  expect(formatBytes(48_000_000)).toBe("48 MB");
});

test("no time estimate is quoted until there is enough history to measure a speed", () => {
  let state = applyModelSetupEvent(startModelSetup(), progress(100_000_000), 0);
  state = applyModelSetupEvent(state, progress(120_000_000), 1_000);
  const early = describeModelSetup(state);
  expect(early.detail).toContain("120 MB of 3.2 GB");
  expect(early.detail).toContain("estimating time left…");
  expect(early.detail).not.toContain("/s");
  state = applyModelSetupEvent(state, progress(220_000_000), 11_000);
  const later = describeModelSetup(state);
  expect(later.detail).toContain("11 MB/s");
  expect(later.detail).toContain("about 5 min left");
  expect(later.fraction).toBeCloseTo(220 / 3200, 5);
});

test("a stalled download shows no speed or estimate instead of an infinite wait", () => {
  let state = applyModelSetupEvent(startModelSetup(), progress(500_000_000), 0);
  state = applyModelSetupEvent(state, progress(500_000_000), 10_000);
  expect(downloadSpeed(state.samples)).toBeUndefined();
  expect(describeModelSetup(state).detail).not.toMatch(/\/s|min left/);
});

test("speed uses only the recent window so a fast start does not hide a slowdown", () => {
  let state = startModelSetup();
  state = applyModelSetupEvent(state, progress(0), 0);
  state = applyModelSetupEvent(state, progress(1_000_000_000), 10_000);
  state = applyModelSetupEvent(state, progress(1_010_000_000), 50_000);
  state = applyModelSetupEvent(state, progress(1_020_000_000), 60_000);
  expect(downloadSpeed(state.samples)).toBe(1_000_000);
});

test("a resumed download says what it already had and the unknown total stays indeterminate", () => {
  const resumed = describeModelSetup(applyModelSetupEvent(startModelSetup(), progress(1_000_000_000, { resumedBytes: 1_000_000_000 }), 0));
  expect(resumed.detail).toContain("continuing from 1.0 GB already downloaded");
  const checking = describeModelSetup(applyModelSetupEvent(startModelSetup(), progress(0, { stage: "checking", totalBytes: 0 }), 0));
  expect(checking.fraction).toBeUndefined();
  expect(checking.headline).toBe("Checking what to download…");
});

test("progress never exceeds 100 percent", () => {
  expect(describeModelSetup(applyModelSetupEvent(startModelSetup(), progress(9_000_000_000), 0)).fraction).toBe(1);
});

test("the experimental translation model and a retry are named honestly", () => {
  expect(describeModelSetup(applyModelSetupEvent(startModelSetup(), progress(1, { asset: "translation" }), 0)).headline).toContain("experimental translation model");
  expect(describeModelSetup(applyModelSetupEvent(startModelSetup(), progress(1, { stage: "retrying", attempt: 2 }), 0)).headline).toBe("Connection interrupted; retrying (attempt 2 of 3)…");
});

test("a full disk keeps the helper's numbers when the command then rejects with only the code", () => {
  let state = applyModelSetupEvent(startModelSetup(), { kind: "setupFailed", code: "diskFull", details: { neededBytes: 4_300_000_000, availableBytes: 900_000_000 } }, 0);
  state = failModelSetup(state, "diskFull");
  expect(state.phase).toBe("failed");
  const text = describeSetupFailure(state.failure!);
  expect(text.message).toContain("about 4.3 GB free; 900 MB is available");
  expect(text.recovery).toContain("Retry");
  expect(text.recovery).toContain("Recording is not affected");
});

test("every failure tells the person what to do next and that downloaded files are kept", () => {
  for (const code of ["network", "assetSetupFailed", "diskFull", "cancelled", "unknown"]) {
    const text = describeSetupFailure({ code });
    expect(text.recovery).toContain("Retry");
    expect(text.recovery).toContain("already downloaded are kept");
  }
  expect(describeSetupFailure({ code: "network" }).message).toContain("connection");
});

test("cancelling keeps showing the download until it stops, then offers Retry that keeps the files", () => {
  const running = applyModelSetupEvent(startModelSetup(), progress(500), 0);
  const cancelling = requestModelSetupCancel(running);
  expect(cancelling).toMatchObject({ phase: "running", cancelling: true, completedBytes: 500 });
  // Progress that was already on its way must not re-enable the Cancel button.
  expect(applyModelSetupEvent(cancelling, progress(600), 1_000).cancelling).toBe(true);
  const cancelled = failModelSetup(cancelling, "cancelled");
  expect(cancelled).toMatchObject({ phase: "failed", cancelling: false });
  const text = describeSetupFailure(cancelled.failure!);
  expect(text.message).toContain("cancelled");
  expect(text.recovery).toContain("Retry");
  expect(text.recovery).toContain("already downloaded are kept");
  expect(text.recovery).toContain("Recording is not affected");
  expect(applyModelSetupEvent(cancelled, progress(900), 1).phase).toBe("failed");
});

test("cancel does nothing when no download is running", () => {
  expect(requestModelSetupCancel(idleModelSetup)).toBe(idleModelSetup);
  const failed = failModelSetup(startModelSetup(), "network");
  expect(requestModelSetupCancel(failed)).toBe(failed);
});

test("a late progress line after a failure does not turn the failure back into a running download", () => {
  const failed = failModelSetup(startModelSetup(), "network");
  expect(applyModelSetupEvent(failed, progress(5), 0).phase).toBe("failed");
});

test("a progress line that arrives after the run ended is ignored", () => {
  expect(applyModelSetupEvent(idleModelSetup, progress(5), 0).phase).toBe("idle");
});
