import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => {
  class Channel {
    onmessage: (message: unknown) => void = () => {};
  }
  return { Channel, invoke: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => boundary);
import { invokeReasoning, type DraftUpdate } from "./reasoningInvoke";
import type { ModelJob } from "@live-interview/core";

test("every reasoning_run call carries an onDraft channel", async () => {
  const job = { id: "job-a" } as ModelJob;
  const result = { jobId: "job-a", outcome: "complete", output: {} };
  boundary.invoke.mockResolvedValueOnce(result);
  expect(await invokeReasoning(job, "prompt")).toEqual(result);
  const [command, args] = boundary.invoke.mock.lastCall!;
  expect(command).toBe("reasoning_run");
  expect(args).toMatchObject({ job, prompt: "prompt" });
  expect(args.onDraft).toBeInstanceOf(boundary.Channel);
});

test("draft fragments reach the consumer only while the call is in flight", async () => {
  const seen: DraftUpdate[] = [];
  let channel: InstanceType<typeof boundary.Channel> | undefined;
  boundary.invoke.mockImplementationOnce(async (_command, args) => {
    channel = args.onDraft;
    channel!.onmessage({ delta: "{" });
    throw Error("providerUnavailable");
  });
  await expect(
    invokeReasoning({ id: "j" } as ModelJob, "p", (u) => seen.push(u)),
  ).rejects.toThrow("providerUnavailable");
  channel!.onmessage({ delta: "late" });
  expect(seen).toEqual([{ delta: "{" }]);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}

test("no source file calls reasoning_run except through invokeReasoning", () => {
  const src = join(__dirname, "../..");
  const helper = join(__dirname, "reasoningInvoke.ts");
  const offenders = sourceFiles(src)
    .filter((path) => path !== helper)
    // The browser preview fakes the native boundary; it handles, not calls, the command.
    .filter((path) => !path.includes(`${join("copilot", "dev")}`))
    .filter((path) =>
      /invoke\s*(<[^>]*>)?\s*\(\s*["'`]reasoning_run/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(src, path));
  expect(offenders).toEqual([]);
});
