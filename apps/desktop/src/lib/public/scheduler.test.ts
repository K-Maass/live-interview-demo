import { expect, test } from "vitest";
import type { PublicAccountStatus } from "@live-interview/core";
import { newMeetingPlan } from "./state";
import { PremiumPreparationScheduler } from "./scheduler";
const premium: PublicAccountStatus = {
  configured: true,
  signedIn: true,
  plan: "premium",
  subscriptionStatus: "active",
  canUseAI: true,
  canAutoPrepare: true,
  billingAvailable: true,
};
const plans = ["A", "B", "C"].map((id, i) => ({
  ...newMeetingPlan(id, 100),
  revision: 1,
  startMs: 200 + i,
  automaticPreparation: true,
}));
test("automatic preparation never overlaps and each unchanged failed plan is attempted once", async () => {
  const scheduler = new PremiumPreparationScheduler();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const jobs: string[] = [];
  const first = scheduler.tick(plans, premium, 100, async (p) => {
    jobs.push(p.id);
    await hold;
    throw Error("offline");
  });
  await scheduler.tick(plans, premium, 100, async (p) => {
    jobs.push(p.id);
  });
  release();
  await expect(first).rejects.toThrow("offline");
  await scheduler.tick(plans, premium, 100, async (p) => {
    jobs.push(p.id);
  });
  await scheduler.tick(plans, premium, 100, async (p) => {
    jobs.push(p.id);
  });
  await scheduler.tick(plans, premium, 100, async (p) => {
    jobs.push(p.id);
  });
  expect(jobs).toEqual(["A", "B", "C"]);
});
test("missing or stale calendar confirmation cannot dispatch automatic reasoning", async () => {
  const scheduler = new PremiumPreparationScheduler();
  let jobs = 0;
  await scheduler.tick(
    plans,
    premium,
    100,
    async () => {
      jobs++;
    },
    async () => false,
  );
  expect(jobs).toBe(0);
  await scheduler.tick(
    plans,
    premium,
    100,
    async () => {
      jobs++;
    },
    async () => true,
  );
  expect(jobs).toBe(1);
});
