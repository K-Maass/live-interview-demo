import { expect, test } from "vitest";
import type { PublicAccountStatus } from "@live-interview/core";
import { keepIfUnchanged } from "./accountRefresh";

const base: PublicAccountStatus = {
  configured: true,
  signedIn: true,
  user: { id: "u" },
  plan: "standard",
  subscriptionStatus: "active",
  canUseAI: true,
  canAutoPrepare: false,
  billingAvailable: true,
  usageResetsAtMs: 1_800_000_000_000,
};
test("an unchanged account keeps the same object", () => {
  expect(keepIfUnchanged(base, structuredClone(base))).toBe(base);
});
test("plan, payment grace and reset changes reach the app on the minute re-read", () => {
  for (const patch of [
    { plan: "premium" as const },
    { subscriptionStatus: "past_due", paymentGraceEndsAtMs: 1_799_000_000_000 },
    { usageResetsAtMs: 1_802_000_000_000 },
  ]) {
    const next: PublicAccountStatus = { ...base, ...patch };
    expect(keepIfUnchanged<PublicAccountStatus>(base, next)).toBe(next);
  }
  // The grace ending (the service stops sending its date) is a change too.
  const grace: PublicAccountStatus = { ...base, subscriptionStatus: "past_due", paymentGraceEndsAtMs: 1 };
  const ended: PublicAccountStatus = { ...base, subscriptionStatus: "past_due", plan: "none", canUseAI: false };
  expect(keepIfUnchanged<PublicAccountStatus>(grace, ended)).toBe(ended);
});
