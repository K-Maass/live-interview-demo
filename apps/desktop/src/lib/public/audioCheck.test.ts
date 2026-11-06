import { expect, test } from "vitest";
import { BAR_COUNT, HEARD_LEVEL, checkFailureText, emptyBars, isHeard, pushLevel, type LevelSample } from "./audioCheck";

const fill = (samples: LevelSample[]) => samples.reduce(pushLevel, emptyBars());

test("the meter keeps a fixed number of bars, newest last", () => {
  const bars = fill(Array.from({ length: BAR_COUNT + 10 }, (_, i) => ({ lane: "me" as const, level: i / 100 })));
  expect(bars).toHaveLength(BAR_COUNT);
  expect(bars.at(-1)?.level).toBeCloseTo((BAR_COUNT + 9) / 100);
});

test("levels are clamped to 0–1 and a broken value reads as silence", () => {
  const bars = fill([{ lane: "me", level: 3 }, { lane: "me", level: -1 }, { lane: "me", level: Number.NaN }]);
  expect(bars.slice(-3).map((b) => b.level)).toEqual([1, 0, 0]);
});

test("one loud bump is not enough to say it heard you; a few loud moments are", () => {
  expect(isHeard(fill([{ lane: "me", level: 0.9 }]), "me")).toBe(false);
  expect(isHeard(fill([0.5, 0.6, 0.55].map((level) => ({ lane: "me" as const, level }))), "me")).toBe(true);
});

test("room noise below the heard level never counts", () => {
  expect(isHeard(fill(Array.from({ length: BAR_COUNT }, () => ({ lane: "me" as const, level: HEARD_LEVEL - 0.05 }))), "me")).toBe(false);
});

test("each lane is judged on its own, so a loud microphone never passes the system audio check", () => {
  const loudMe = fill(Array.from({ length: 10 }, () => ({ lane: "me" as const, level: 0.8 })));
  expect(isHeard(loudMe, "me")).toBe(true);
  expect(isHeard(loudMe, "remote")).toBe(false);
});

test("failures are explained in plain words per lane", () => {
  expect(checkFailureText("me", "meetingActive")).toMatch(/after the current meeting ends/);
  expect(checkFailureText("me", "notGranted")).toMatch(/Allow the microphone first/);
  expect(checkFailureText("remote", "notGranted")).toMatch(/Allow system audio first/);
  expect(checkFailureText("me", "captureUnavailable")).toMatch(/System Settings → Sound/);
  expect(checkFailureText("remote", new Error("x"))).toMatch(/first meeting/);
});
