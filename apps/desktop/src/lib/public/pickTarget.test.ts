import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => boundary);
import { pickActionTarget, pickFailedMessage } from "./pickTarget";
import { calendarSaveErrorMessage } from "./calendarSave";

test("a failing picker says so instead of leaving an unhandled rejection", async () => {
  for (const code of ["pickFailed", "invalidPickedTarget"]) {
    const statuses: string[] = [];
    boundary.invoke.mockRejectedValueOnce(code);
    await expect(pickActionTarget({ kind: "appendNote" }, (s) => statuses.push(s))).resolves.toBeNull();
    expect(statuses).toEqual([pickFailedMessage]);
    expect(calendarSaveErrorMessage(code)).toMatch(/Could not open the file picker/);
  }
  expect(pickFailedMessage).toMatch(/^Could not open the file picker/);
});

test("a chosen target is returned and a cancelled picker is silent", async () => {
  const statuses: string[] = [];
  boundary.invoke.mockResolvedValueOnce("/notes/a.md");
  expect(await pickActionTarget({ kind: "appendNote" }, (s) => statuses.push(s))).toBe("/notes/a.md");
  expect(boundary.invoke).toHaveBeenLastCalledWith("pick_action_target", { kind: "appendNote" });
  boundary.invoke.mockResolvedValueOnce(null);
  expect(await pickActionTarget({ kind: "recordFolder" }, (s) => statuses.push(s))).toBeNull();
  expect(statuses).toEqual([]);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("components open the picker only through pickActionTarget", () => {
  const src = join(__dirname, "../..");
  // client.ts's chooseIcsPath has a caller that maps picker codes through calendarSaveErrorMessage.
  const allowed = new Set([join(__dirname, "pickTarget.ts"), join(__dirname, "client.ts")]);
  const offenders = sourceFiles(src)
    .filter((path) => !allowed.has(path) && !path.includes(join("copilot", "dev")))
    .filter((path) => /invoke\s*(<[^>]*>)?\s*\(\s*["'`]pick_action_target/.test(readFileSync(path, "utf8")))
    .map((path) => relative(src, path));
  expect(offenders).toEqual([]);
});

test("grant picks go through the native picker and a declined sheet is calm", async () => {
  const { pickGrantPath, isGrantDeclined, GRANT_DECLINED_MESSAGE } = await import("./pickTarget");
  const statuses: string[] = [];
  boundary.invoke.mockResolvedValueOnce("/work/project");
  expect(await pickGrantPath("workspaceFolder", (s) => statuses.push(s))).toBe("/work/project");
  expect(boundary.invoke).toHaveBeenLastCalledWith("pick_grant_path", { kind: "workspaceFolder" });
  boundary.invoke.mockRejectedValueOnce("pickFailed");
  expect(await pickGrantPath("outputFolder", (s) => statuses.push(s))).toBeNull();
  expect(statuses).toEqual([pickFailedMessage]);
  expect(isGrantDeclined("grantDeclined")).toBe(true);
  expect(isGrantDeclined(new Error("grantDeclined"))).toBe(true);
  expect(isGrantDeclined("publicStoreFailed")).toBe(false);
  expect(GRANT_DECLINED_MESSAGE).not.toMatch(/error|fail/i);
});
