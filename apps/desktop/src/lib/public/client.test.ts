import { expect, test, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ changedSourceIds: [] })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { publicClient } from "./client";
test("refresh index uses the native workspace id argument and explicit shared scope", async () => {
  await publicClient.refreshWorkspace("workspace-a", ["library-b"]);
  expect(invoke).toHaveBeenCalledWith("refresh_workspace", {
    id: "workspace-a",
    sharedLibraryIds: ["library-b"],
  });
});
test("account export and deletion call the native commands with no renderer-supplied target", async () => {
  invoke.mockClear();
  await publicClient.exportAccount();
  await publicClient.deleteAccount();
  expect(invoke.mock.calls).toEqual([["public_export_account"], ["public_delete_account"]]);
});
