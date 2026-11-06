import { invoke } from "@tauri-apps/api/core";
import type {
  PublicMeetingPlan,
  PublicWorkspace,
  SourceHit,
} from "@live-interview/core";
import { publicClient } from "./client";
import { wireSignature } from "./value";
const epochs = new Map<string, number>();
const planEpochs = new Map<string, number>();
const jobs = new Map<string, { scopes: string[]; planId: string }>();
export function invalidatePreparationPlan(planId: string) {
  planEpochs.set(planId, (planEpochs.get(planId) ?? 0) + 1);
  for (const [jobId, job] of jobs)
    if (job.planId === planId)
      void invoke("reasoning_cancel", { jobId }).catch(() => {});
}
const listeners = new Set<(workspaceId: string) => void>();
export function invalidatePreparationWorkspace(workspaceId: string) {
  epochs.set(workspaceId, (epochs.get(workspaceId) ?? 0) + 1);
  for (const [jobId, job] of jobs)
    if (job.scopes.includes(workspaceId))
      void invoke("reasoning_cancel", { jobId }).catch(() => {});
  for (const listener of listeners) listener(workspaceId);
}
export function subscribePreparationInvalidation(
  listener: (workspaceId: string) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function isExplicitPublicWeb(
  hit: SourceHit,
  plan: PublicMeetingPlan,
): boolean {
  try {
    const url = new URL(hit.locator);
    return (
      plan.publicResearchTopics.length > 0 &&
      hit.workspaceId === plan.workspaceId &&
      hit.kind === "web" &&
      !hit.derived &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hit.sourceId === `web:${plan.workspaceId}:${hit.locator}` &&
      Number.isSafeInteger(hit.revision) &&
      hit.revision > 0
    );
  } catch {
    return false;
  }
}
export async function preparationEvidence(plan: PublicMeetingPlan) {
  const scopes = [plan.workspaceId, ...plan.sharedLibraryIds];
  const capturedPlanEpoch = planEpochs.get(plan.id) ?? 0;
  const capturedEpochs = scopes.map((id) => [id, epochs.get(id) ?? 0] as const);
  const assertEpoch = () => {
    if (
      (planEpochs.get(plan.id) ?? 0) !== capturedPlanEpoch ||
      capturedEpochs.some(([id, epoch]) => (epochs.get(id) ?? 0) !== epoch)
    )
      throw Error("preparationEvidenceChanged");
  };
  const metadata = async (): Promise<PublicWorkspace[]> => {
    if (plan.workspaceId === "default") {
      if (plan.sharedLibraryIds.length || plan.sourceIds.length)
        throw Error("preparationEvidenceChanged");
      return [];
    }
    const all = await publicClient.listWorkspaces();
    const main = all.find((w) => w.id === plan.workspaceId);
    if (
      !main ||
      plan.sharedLibraryIds.some((id) => !main.sharedLibraryIds.includes(id))
    )
      throw Error("preparationEvidenceChanged");
    return scopes.map((id) => {
      const workspace = all.find((w) => w.id === id);
      if (!workspace) throw Error("preparationEvidenceChanged");
      return workspace;
    });
  };
  try {
    assertEpoch();
    if (plan.workspaceId !== "default")
      await publicClient.refreshWorkspace(
        plan.workspaceId,
        plan.sharedLibraryIds,
      );
    const original = await metadata();
    assertEpoch();
    const originalSignature = wireSignature(original);
    const validate = async (
      hits: SourceHit[],
      publicResearchIds: Set<string>,
      refresh = true,
    ) => {
      try {
        assertEpoch();
        if (refresh && plan.workspaceId !== "default")
          await publicClient.refreshWorkspace(
            plan.workspaceId,
            plan.sharedLibraryIds,
          );
        const [current, available] = await Promise.all([
          metadata(),
          plan.workspaceId === "default"
            ? Promise.resolve([])
            : publicClient.sources(plan.workspaceId),
        ]);
        assertEpoch();
        if (wireSignature(current) !== originalSignature)
          throw Error("preparationEvidenceChanged");
        for (const hit of hits) {
          if (publicResearchIds.has(hit.sourceId)) {
            if (!isExplicitPublicWeb(hit, plan))
              throw Error("preparationEvidenceChanged");
            continue;
          }
          if (
            plan.workspaceId === "default" ||
            !scopes.includes(hit.workspaceId) ||
            (plan.sourceSelection === "selected" &&
              !plan.sourceIds.includes(hit.sourceId))
          )
            throw Error("preparationEvidenceChanged");
          const source = available.find(
            (s) =>
              s.sourceId === hit.sourceId && s.workspaceId === hit.workspaceId,
          );
          if (!source || source.revision !== hit.revision)
            throw Error("preparationEvidenceChanged");
        }
      } catch {
        throw Error("preparationEvidenceChanged");
      }
    };
    return {
      validate,
      register: (jobId: string) => {
        assertEpoch();
        jobs.set(jobId, { scopes, planId: plan.id });
        return () => {
          jobs.delete(jobId);
        };
      },
    };
  } catch {
    throw Error("preparationEvidenceChanged");
  }
}
