import { expect, test } from "vitest";
import {
  offerUnpreparedCall,
  offerAmbiguousCalls,
  shouldStartPreparedCall,
} from "../src/session";
test("calendar timing alone never starts recording; confirmed matched prepared call may start", () => {
  const plan = { title: "Synthetic interview", armed: true, expiresAt: 10000 };
  expect(
    shouldStartPreparedCall(
      plan,
      { verified: false, title: plan.title, observedAt: 5000 },
      5000,
    ),
  ).toBe(false);
  expect(
    shouldStartPreparedCall(
      plan,
      { verified: true, title: plan.title, observedAt: 5000 },
      5000,
    ),
  ).toBe(true);
  expect(
    shouldStartPreparedCall(
      plan,
      { verified: true, title: "Different call", observedAt: 5000 },
      5000,
    ),
  ).toBe(false);
  expect(
    shouldStartPreparedCall(
      plan,
      { verified: true, title: plan.title, observedAt: 5000 },
      20000,
    ),
  ).toBe(false);
});
test("multiple control-qualified calls offer explicit choices but never start automatically", () => {
  const hint = {
    verified: false,
    title: "",
    observedAt: 5000,
    code: "ambiguousCalls",
    candidates: [
      { title: "Synthetic interview", source: "teams-accessibility-controls" },
      { title: "Synthetic discovery", source: "teams-accessibility-controls" },
    ],
  };
  const offers = offerAmbiguousCalls(hint, 5000);
  expect(offers.map((x) => x.title)).toEqual([
    "Synthetic interview",
    "Synthetic discovery",
  ]);
  expect(offers.every((x) => !x.recordingStarted)).toBe(true);
  expect(
    shouldStartPreparedCall(
      { title: "Synthetic interview", armed: true, expiresAt: 10000 },
      hint,
      5000,
    ),
  ).toBe(false);
  expect(offerAmbiguousCalls({ ...hint, ended: true }, 5000)).toEqual([]);
  expect(offerAmbiguousCalls(hint, 30000)).toEqual([]);
  expect(
    offerAmbiguousCalls({ ...hint, code: "noVerifiedCall" }, 5000),
  ).toEqual([]);
  expect(
    offerAmbiguousCalls(
      {
        ...hint,
        candidates: hint.candidates.map((x) => ({ ...x, source: "calendar" })),
      },
      5000,
    ),
  ).toEqual([]);
});
test("unprepared offer is a choice, not implicit recording permission; expired offers are rejected", () => {
  const offer = offerUnpreparedCall(
    { verified: true, title: "Synthetic call", observedAt: 5000 },
    5000,
  );
  expect(offer?.recordingStarted).toBe(false);
  expect(
    offerUnpreparedCall(
      { verified: true, title: "Synthetic", observedAt: 1 },
      100000,
    ),
  ).toBeUndefined();
});
