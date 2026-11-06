import { beforeEach, expect, test, vi } from "vitest";
import type {
  ModelJob,
  PublicSource,
  PublicWorkspace,
  SourceHit,
} from "@live-interview/core";
const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: boundary.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
import {
  generatePreparation,
  invalidatePreparationWorkspace,
} from "./reasoning";
import { newMeetingPlan } from "./state";
let workspace: PublicWorkspace;
let libraries: PublicWorkspace[] = [];
let sources: PublicSource[];
let hit: SourceHit;
let finish: (value: unknown) => void;
let job: ModelJob;
const plan = () => ({
  ...newMeetingPlan("plan"),
  workspaceId: "workspace",
  title: "Approval meeting",
});
beforeEach(() => {
  libraries = [];
  workspace = {
    id: "workspace",
    root: "/selected",
    name: "Selected",
    roots: ["/selected"],
    sharedLibraryIds: [],
    appendTargets: [],
    revision: 1,
  };
  sources = [
    {
      sourceId: "doc",
      workspaceId: "workspace",
      title: "Plan",
      path: "/selected/plan.md",
      revision: 1,
    },
  ];
  hit = {
    ...sources[0],
    kind: "markdown",
    text: "The release is under review.",
    locator: sources[0].path,
    derived: false,
  };
  boundary.invoke.mockReset();
  boundary.invoke.mockImplementation(async (command, args) => {
    if (command === "public_list_workspaces")
      return structuredClone([workspace, ...libraries]);
    if (command === "public_workspace_sources") return structuredClone(sources);
    if (command === "refresh_workspace") return { changedSourceIds: [] };
    if (command === "retrieve_context") return [structuredClone(hit)];
    if (command === "search_public_text") return [structuredClone(hit)];
    if (command === "reasoning_cancel") return;
    if (command === "reasoning_run") {
      job = args.job;
      return new Promise((resolve) => (finish = resolve));
    }
    throw Error("unexpected " + command);
  });
});
async function dispatch(p = plan()) {
  const pending = generatePreparation(p);
  await vi.waitFor(() =>
    expect(
      boundary.invoke.mock.calls.some(([c]) => c === "reasoning_run"),
    ).toBe(true),
  );
  return {
    pending,
    complete: () =>
      finish({
        outcome: "complete",
        jobId: job.id,
        basis: job.basis,
        output: {
          text: "Draft grounded in the selected source",
          evidence: [hit.sourceId],
        },
      }),
  };
}
test("unchanged source evidence can finish after refresh/revalidation", async () => {
  const run = await dispatch();
  run.complete();
  expect((await run.pending).text).toContain("selected source");
  expect(
    boundary.invoke.mock.calls.some(([c]) => c === "refresh_workspace"),
  ).toBe(true);
});
test.each(["workspace", "edited source", "deleted source"])(
  "a delayed draft is rejected after %s changes",
  async (change) => {
    const run = await dispatch();
    if (change === "workspace")
      workspace = {
        ...workspace,
        roots: ["/replaced"],
        root: "/replaced",
        revision: 2,
      };
    if (change === "edited source") sources[0].revision = 2;
    if (change === "deleted source") sources = [];
    run.complete();
    await expect(run.pending).rejects.toThrow("preparationEvidenceChanged");
  },
);
test("workspace invalidation cancels the in-flight text job and rejects late output", async () => {
  const run = await dispatch();
  invalidatePreparationWorkspace("workspace");
  run.complete();
  await expect(run.pending).rejects.toThrow("preparationEvidenceChanged");
  expect(boundary.invoke).toHaveBeenCalledWith("reasoning_cancel", {
    jobId: job.id,
  });
});
test("folderless research accepts clearly public-web provenance but fails closed on an unclear source", async () => {
  hit = {
    sourceId: "web:default:https://example.test/article",
    workspaceId: "default",
    kind: "web",
    title: "Article",
    text: "Public evidence",
    locator: "https://example.test/article",
    revision: 1,
    derived: false,
  };
  const run = await dispatch({
    ...newMeetingPlan("web-plan"),
    publicResearchTopics: ["Approved public topic"],
  });
  run.complete();
  expect((await run.pending).evidence).toEqual([hit.sourceId]);
  hit = {
    ...hit,
    kind: "markdown",
    sourceId: "unclear",
    locator: "/private/secret.md",
  };
  await expect(
    generatePreparation({
      ...newMeetingPlan("unsafe-plan"),
      publicResearchTopics: ["Approved public topic"],
    }),
  ).rejects.toThrow("preparationEvidenceChanged");
});
test("editing a preparation request cancels its job without needing a workspace change", async () => {
  const { invalidatePreparationPlan } = await import("./preparationEvidence");
  const run = await dispatch();
  invalidatePreparationPlan("plan");
  run.complete();
  await expect(run.pending).rejects.toThrow("preparationEvidenceChanged");
  expect(boundary.invoke).toHaveBeenCalledWith("reasoning_cancel", {
    jobId: job.id,
  });
});

test("changing a selected shared library invalidates delayed preparation", async () => {
  workspace.sharedLibraryIds = ["shared"];
  libraries = [
    {
      ...workspace,
      id: "shared",
      name: "Shared",
      root: "/shared",
      roots: ["/shared"],
      sharedLibraryIds: [],
    },
  ];
  sources[0] = { ...sources[0], workspaceId: "shared", path: "/shared/doc.md" };
  hit = { ...hit, workspaceId: "shared", locator: "/shared/doc.md" };
  const run = await dispatch({ ...plan(), sharedLibraryIds: ["shared"] });
  libraries[0].revision = 2;
  run.complete();
  await expect(run.pending).rejects.toThrow("preparationEvidenceChanged");
});
test("the save-time evidence check rejects file edits after the model result completes", async () => {
  const run = await dispatch();
  run.complete();
  const result = await run.pending;
  sources[0].revision = 2;
  await expect(result.validateEvidence()).rejects.toThrow(
    "preparationEvidenceChanged",
  );
});
