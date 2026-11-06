import { describe, expect, test, vi } from "vitest";
import { approveAndApply, FILE_APPLY_CLOSED, FILE_APPLY_RETRY, fileApplyFailure, isEarlierApply } from "./applyFlow";

const invoker = (approve: () => Promise<string>, apply: () => Promise<unknown>) =>
  vi.fn(async (command: string) => (command === "approve_action" ? approve() : apply())) as never as Parameters<typeof approveAndApply>[0] & ReturnType<typeof vi.fn>;

describe("approve and apply", () => {
  test("approves, then applies with that approval", async () => {
    const invoke = invoker(async () => "token", async () => ({ applied: true }));
    await expect(approveAndApply(invoke, "p1", "apply_action")).resolves.toEqual({ applied: true });
    expect(invoke).toHaveBeenLastCalledWith("apply_action", { proposalId: "p1", approval: "token" });
  });
  test("an earlier click that applied or is applying the proposal is a no-op, not an error", async () => {
    for (const code of ["alreadyApplied", "applyInProgress"]) {
      const invoke = invoker(async () => { throw code; }, async () => { throw new Error("must not apply"); });
      await expect(approveAndApply(invoke, "p1", "apply_calendar_change")).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
  test("a replayed apply that returns the earlier result is a success", async () => {
    const earlier = { applied: true, alreadyApplied: true, event: { id: "e1" }, publicEvent: null };
    const invoke = invoker(async () => "token", async () => earlier);
    await expect(approveAndApply(invoke, "p1", "apply_calendar_change")).resolves.toBe(earlier);
  });
  test("an apply refused because the earlier click is still applying is a no-op, not an error", async () => {
    const invoke = invoker(async () => "token", async () => { throw "applyInProgress"; });
    await expect(approveAndApply(invoke, "p1", "apply_calendar_change")).resolves.toBeUndefined();
    const failing = invoker(async () => "token", async () => { throw "approvalRequired"; });
    await expect(approveAndApply(failing, "p1", "apply_calendar_change")).rejects.toBe("approvalRequired");
  });
  test("other approval failures still fail", async () => {
    const invoke = invoker(async () => { throw "approvalFailed"; }, async () => ({}));
    await expect(approveAndApply(invoke, "p1", "apply_action")).rejects.toBe("approvalFailed");
    expect(isEarlierApply("approvalFailed")).toBe(false);
    expect(isEarlierApply(new Error("applyInProgress"))).toBe(true);
  });
  test("only a reopened proposal offers Apply again; any other failure closes it with its own message", () => {
    expect(fileApplyFailure("applyFailedOrTargetChanged")).toEqual({ retry: true, message: FILE_APPLY_RETRY });
    expect(fileApplyFailure("approvalFailed")).toEqual({ retry: false, message: FILE_APPLY_CLOSED });
    // apply_action refuses an expired, used or declined approval token before any write: Apply again cannot succeed.
    expect(fileApplyFailure("approvalRequired")).toEqual({ retry: false, message: FILE_APPLY_CLOSED });
    expect(fileApplyFailure(new Error("actionBusy"))).toEqual({ retry: false, message: FILE_APPLY_CLOSED });
    expect(fileApplyFailure("approvalFailed", (code) => "mapped " + code)).toEqual({ retry: false, message: "mapped approvalFailed" });
    expect(FILE_APPLY_CLOSED).not.toMatch(/apply again/i);
  });
});

test("a cancelled replace sheet keeps the proposal open with a calm message", async () => {
  const { fileApplyFailure, FILE_APPLY_DECLINED } = await import("./applyFlow");
  const { icsSaveFailure } = await import("./calendarSave");
  expect(fileApplyFailure("grantDeclined")).toEqual({ retry: true, message: FILE_APPLY_DECLINED });
  expect(icsSaveFailure("grantDeclined")).toEqual({ retry: true, message: FILE_APPLY_DECLINED });
  expect(FILE_APPLY_DECLINED).not.toMatch(/fail|error/i);
});
