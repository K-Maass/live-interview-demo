import { describe, expect, test } from "vitest";
import type {
  PublicMeetingPlan,
  PublicAccountStatus,
} from "@live-interview/core";
import {
  PlanSession,
  preparationCandidates,
  acceptPreparation,
  newMeetingPlan,
  visibleCalendarRange,
} from "./state";
const plan = (id: string, revision = 1): PublicMeetingPlan => ({
  ...newMeetingPlan(id, 100),
  title: id,
  revision,
});
const premium: PublicAccountStatus = {
  configured: true,
  signedIn: true,
  plan: "premium",
  subscriptionStatus: "active",
  canUseAI: true,
  canAutoPrepare: true,
  billingAvailable: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
describe("durable meeting ownership", () => {
  test("late load cannot replace the meeting opened more recently", async () => {
    const a = deferred<PublicMeetingPlan | null>();
    const b = deferred<PublicMeetingPlan | null>();
    const session = new PlanSession({
      getPlan: (id) => (id === "A" ? a.promise : b.promise),
      savePlan: async (p) => ({ ...p, revision: p.revision + 1 }),
    });
    const first = session.open("A");
    const second = session.open("B");
    b.resolve(plan("B"));
    await second;
    a.resolve(plan("A"));
    await first;
    expect(session.current?.id).toBe("B");
  });
  test("saving an earlier edit preserves new edits and rebases the server revision", async () => {
    const pending = deferred<PublicMeetingPlan>();
    const session = new PlanSession({
      getPlan: async () => plan("A"),
      savePlan: () => pending.promise,
    });
    await session.open("A");
    session.edit({ title: "first" });
    const save = session.save();
    session.edit({ title: "latest" });
    pending.resolve({ ...plan("A", 2), title: "first" });
    await save;
    expect(session.current?.title).toBe("latest");
    expect(session.current?.revision).toBe(2);
    expect(session.dirty).toBe(true);
  });
  test("stale save rejection preserves the unsaved draft and surfaces a conflict", async () => {
    const session = new PlanSession({
      getPlan: async () => plan("A"),
      savePlan: async () => {
        throw Error("staleRevision");
      },
    });
    await session.open("A");
    session.edit({ briefDraft: "keep my draft" });
    await expect(session.save()).rejects.toThrow("staleRevision");
    expect(session.current?.briefDraft).toBe("keep my draft");
    expect(session.dirty).toBe(true);
  });
  test("persisted plans never contain capture arming", () => {
    expect(newMeetingPlan("A", 100)).not.toHaveProperty("armed");
  });
});
describe("Premium preparation bounds", () => {
  test("Standard and non-opted-in meetings never enter automatic work", () => {
    const p = { ...plan("A"), startMs: 200, automaticPreparation: true };
    expect(
      preparationCandidates(
        [p],
        { ...premium, plan: "standard", canAutoPrepare: false },
        100,
      ),
    ).toEqual([]);
    expect(
      preparationCandidates(
        [{ ...p, automaticPreparation: false }],
        premium,
        100,
      ),
    ).toEqual([]);
  });
  test("at most two eligible near-term blank drafts are selected; cached, cancelled and finalized plans are excluded", () => {
    const eligible = [1, 2, 3].map((n) => ({
      ...plan(String(n)),
      startMs: 100 + n,
      automaticPreparation: true,
    }));
    const excluded = [
      { ...eligible[0], id: "cached", briefDraft: "saved" },
      { ...eligible[0], id: "cancelled", status: "cancelled" as const },
      { ...eligible[0], id: "approved", status: "prepared" as const },
      { ...eligible[0], id: "far", startMs: 100 + 86400001 },
    ];
    expect(
      preparationCandidates([...excluded, ...eligible], premium, 100).map(
        (p) => p.id,
      ),
    ).toEqual(["1", "2"]);
  });
  test("a late result cannot overwrite human edits, finalization or another meeting", () => {
    const original = plan("A");
    expect(
      acceptPreparation(
        { ...original, briefDraft: "my edit" },
        original,
        "AI draft",
      ),
    ).toBeNull();
    expect(
      acceptPreparation(
        { ...original, status: "prepared" },
        original,
        "AI draft",
      ),
    ).toBeNull();
    expect(acceptPreparation(plan("B"), original, "AI draft")).toBeNull();
    expect(acceptPreparation(original, original, "AI draft")?.briefDraft).toBe(
      "AI draft",
    );
  });
});
test("month retrieval covers the complete six-week visible grid across a DST boundary", () => {
  const range = visibleCalendarRange(new Date(2026, 9, 25), "month");
  expect(new Date(range.startMs).getDay()).toBe(1);
  expect(new Date(range.endMs).getDay()).toBe(1);
  const end = new Date(range.startMs);
  end.setDate(end.getDate() + 42);
  expect(range.endMs).toBe(end.getTime());
});
test("context edits invalidate approval while preserving the editable draft", async () => {
  const original = {
    ...plan("A"),
    briefDraft: "Reviewed words",
    reviewedBrief: {
      text: "Reviewed words",
      revision: 1,
      objectives: [],
      evidence: ["source:old"],
    },
    status: "prepared" as const,
    draftEvidence: ["source:old"],
  };
  const session = new PlanSession({
    getPlan: async () => original,
    savePlan: async (p) => ({ ...p, revision: p.revision + 1 }),
  });
  await session.open("A");
  session.edit({ sourceSelection: "selected", sourceIds: [] });
  expect(session.current?.reviewedBrief).toBeUndefined();
  expect(session.current?.status).toBe("draft");
  expect(session.current?.briefDraft).toBe("Reviewed words");
  expect(session.current?.draftEvidence).toEqual([]);
});
test("reloading after a conflict saves edits as a separate recovery draft before loading authoritative state", async () => {
  const writes: PublicMeetingPlan[] = [];
  const session = new PlanSession({
    getPlan: async () => plan("A", 4),
    savePlan: async (p) => {
      writes.push(p);
      return { ...p, revision: 1 };
    },
  });
  session.replace({ ...plan("A", 2), briefDraft: "My unsaved work" });
  session.edit({ title: "Changed" });
  await session.reloadPreservingDraft("recovery-id");
  expect(writes[0].id).toBe("recovery-id");
  expect(writes[0].briefDraft).toBe("My unsaved work");
  expect(writes[0].revision).toBe(0);
  expect(session.current?.revision).toBe(4);
});
test("editing the current plan during a delayed load preserves that edit", async () => {
  const pending = deferred<PublicMeetingPlan | null>();
  const session = new PlanSession({
    getPlan: async (id) => (id === "A" ? plan("A") : pending.promise),
    savePlan: async (p) => ({ ...p, revision: p.revision + 1 }),
  });
  await session.open("A");
  const loading = session.open("B");
  session.edit({ briefDraft: "typed while loading" });
  pending.resolve(plan("B"));
  await loading;
  expect(session.current?.id).toBe("A");
  expect(session.current?.briefDraft).toBe("typed while loading");
});
test("new meeting audio defaults never inherit a previous meeting's retention or device", () => {
  const next = newMeetingPlan("new", 100);
  expect(next.retainAudio).toBe(false);
  expect(next.inputDevice).toBe("");
});
test("native property reordering does not invalidate an otherwise unchanged preparation", () => {
  const original = plan("A");
  const reordered = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as unknown as PublicMeetingPlan;
  expect(acceptPreparation(reordered, original, "finished")?.briefDraft).toBe(
    "finished",
  );
});

test("automatic preparation waits until the final 30 minutes before a scheduled meeting", () => {
  const candidate = {
    ...plan("A"),
    automaticPreparation: true,
    startMs: 100 + 31 * 60000,
  };
  expect(preparationCandidates([candidate], premium, 100)).toEqual([]);
  expect(
    preparationCandidates(
      [{ ...candidate, startMs: 100 + 30 * 60000 }],
      premium,
      100,
    ),
  ).toHaveLength(1);
});
test("clearing the objective editor and adding a trailing empty row still produces a valid durable plan", async () => {
  const { objectiveLines } = await import("./state");
  const session = new PlanSession({
    getPlan: async () => plan("A"),
    savePlan: async (p) => {
      if (p.objectives.some((s) => !s.trim())) throw Error("invalidObjectives");
      return { ...p, revision: p.revision + 1 };
    },
  });
  await session.open("A");
  session.edit({
    objectives: objectiveLines("  Understand approvals  \n\n  \n"),
  });
  await session.save();
  expect(session.current?.objectives).toEqual(["Understand approvals"]);
  session.edit({ objectives: objectiveLines("") });
  await session.save();
  expect(session.current?.objectives).toEqual([]);
});
