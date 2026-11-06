// Approve-then-apply for reviewed proposals (files and calendar changes), shared by every Apply button.
//
// `approve_action` refuses with `alreadyApplied` or `applyInProgress` when an earlier click already applied the
// proposal or is applying it. That is the earlier click's success, never an error: the second click does nothing.
// `apply_action` / `apply_calendar_change` may answer a replayed token with `alreadyApplied: true` and the earlier
// result; that is a success like any other result. They refuse a replayed token with `applyInProgress` while the
// earlier click's apply is still running; that too is the earlier click.

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Refusal codes that mean an earlier click applied (or is applying) this proposal. */
export function isEarlierApply(error: unknown): boolean {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return code === "alreadyApplied" || code === "applyInProgress";
}

/**
 * Approves and applies `proposalId` with `command`. Resolves to the apply result, or to `undefined` when an earlier
 * click already applied it or is applying it (nothing to do here). Any other failure rejects as before.
 */
export async function approveAndApply<T>(invoke: Invoke, proposalId: string, command: "apply_action" | "apply_calendar_change"): Promise<T | undefined> {
  let approval: string;
  try {
    approval = await invoke<string>("approve_action", { proposalId });
  } catch (error) {
    if (isEarlierApply(error)) return undefined;
    throw error;
  }
  try {
    return await invoke<T>(command, { proposalId, approval });
  } catch (error) {
    // Both clicks approved under the same token and the earlier one is still applying (a calendar apply awaits the
    // helper): that click does the work.
    if (isEarlierApply(error)) return undefined;
    throw error;
  }
}

/**
 * The sentence after a failed FILE apply. Nothing was written and the proposal is back in review, so the person can
 * apply it again; a calendar failure is terminal and is not described here.
 */
export const FILE_APPLY_RETRY = "Could not apply this change; nothing was written. Apply again, or prepare a fresh proposal if the file changed.";
/** The sentence after a FILE apply that can never succeed under this proposal (it was refused before any write). */
export const FILE_APPLY_CLOSED = "Could not apply this change; nothing was written. This proposal can no longer be applied, so prepare a fresh one.";

const codeOf = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "");

/**
 * Whether a failed FILE apply left its proposal back in review, so "Apply again" can succeed. Only `apply_action`'s
 * `applyFailedOrTargetChanged` does (the writer reopens the proposal); a refused approval (`approvalFailed` from
 * approve_action, `approvalRequired` from apply_action for an expired, used, declined or ended proposal) or any other
 * failure cannot be retried under the same proposal.
 */
export function isRetryableFileApply(error: unknown): boolean {
  return codeOf(error) === "applyFailedOrTargetChanged";
}

/** The person cancelled the native "Replace this file?" sheet: nothing was approved, the proposal is still open. */
export const FILE_APPLY_DECLINED = "Not applied. The file was left as it was; apply when you are ready.";

/** What to show after a failed FILE apply, and whether to keep the proposal open with "Apply again". */
export function fileApplyFailure(error: unknown, closedMessage: (code: string) => string = () => FILE_APPLY_CLOSED): { retry: boolean; message: string } {
  if (codeOf(error) === "grantDeclined") return { retry: true, message: FILE_APPLY_DECLINED };
  return isRetryableFileApply(error) ? { retry: true, message: FILE_APPLY_RETRY } : { retry: false, message: closedMessage(codeOf(error)) };
}
