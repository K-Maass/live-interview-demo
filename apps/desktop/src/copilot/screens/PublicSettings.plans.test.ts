import { expect, test } from "vitest";
import { isCurrentPlan } from "./PublicSettings";

test("the plan the account already has is marked current instead of offered again", () => {
  expect(isCurrentPlan({ signedIn: true, plan: "standard" }, "standard")).toBe(true);
  expect(isCurrentPlan({ signedIn: true, plan: "standard" }, "premium")).toBe(false);
  expect(isCurrentPlan({ signedIn: true, plan: "none" }, "standard")).toBe(false);
  expect(isCurrentPlan({ signedIn: false, plan: "premium" }, "premium")).toBe(false);
  expect(isCurrentPlan(undefined, "premium")).toBe(false);
});
import { paymentGraceNotice, usageResetText } from "./PublicSettings";
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
test("a failed renewal inside its grace gets one calm plain-text line with the date AI continues until", () => {
  const until = Date.UTC(2026, 10, 7, 12);
  expect(paymentGraceNotice({ signedIn: true, subscriptionStatus: "past_due", paymentGraceEndsAtMs: until })).toBe(
    `Your last payment didn't go through. AI assistance continues until ${day(until)}; update your payment method in the billing portal.`,
  );
  expect(paymentGraceNotice({ signedIn: true, subscriptionStatus: "active" })).toBeUndefined();
  // Past the grace the service sends no date: nothing claims AI still works.
  expect(paymentGraceNotice({ signedIn: true, subscriptionStatus: "past_due" })).toBeUndefined();
  expect(paymentGraceNotice({ signedIn: false, subscriptionStatus: "past_due", paymentGraceEndsAtMs: until })).toBeUndefined();
});
test("the usage section says when the counters reset", () => {
  const at = Date.UTC(2026, 10, 20, 9);
  expect(usageResetText(at)).toBe(`Resets ${day(at)}`);
  expect(usageResetText(undefined)).toBeUndefined();
});
