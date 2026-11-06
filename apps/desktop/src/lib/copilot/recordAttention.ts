// What still needs the person after a meeting was saved: the synthesis could not be made (or needs service access), or
// some granted note destinations could not be written. These used to be passing toasts that vanished after six
// seconds; they now stay on the record's Overview until the problem is resolved or the person dismisses them. Pure;
// nothing here touches the saved record.
//
// The notices are held in memory for the app's session and do not survive a restart: the saved record does not keep
// which destinations failed, and a missing synthesis artifact cannot tell "never attempted" from "needs service access".

export type SynthesisAttention = "failed" | "needsAccess";
/** Why a note destination cannot be written again until the person changes it in Knowledge. */
export type BlockedReason = "changed" | "revoked" | "outsideWorkspace" | "folderChanged";

export interface RecordAttention {
  /** Synthesis failed after the meeting was saved, or was not attempted because the account cannot use the service. */
  synthesis?: SynthesisAttention;
  /** Note destinations that failed for a reason a retry may fix; 0 means the count is unknown (the whole call failed). */
  destinations?: number;
  /** Note destinations a retry cannot fix (the file changed, the grant was removed): one reason per destination. */
  blocked?: BlockedReason[];
}
export type AttentionMap = Record<string, RecordAttention>;
export type AttentionKind = keyof RecordAttention;

export function markAttention(map: AttentionMap, recordId: string, patch: RecordAttention): AttentionMap {
  return { ...map, [recordId]: { ...map[recordId], ...patch } };
}
export function clearAttention(map: AttentionMap, recordId: string, kind: AttentionKind): AttentionMap {
  const current = map[recordId];
  if (!current || current[kind] === undefined) return map;
  const { [kind]: _cleared, ...rest } = current;
  const next = { ...map };
  if (Object.keys(rest).length) next[recordId] = rest;
  else delete next[recordId];
  return next;
}

/** A synthesis saved by any path (Generate on Overview, an edit, a retry) resolves that record's synthesis notice. */
export function attentionAfterArtifactSave(map: AttentionMap, saved: { meetingId: string; kind: string; status: string; humanEdited: boolean }): AttentionMap {
  return saved.kind === "synthesis" && (saved.status === "ready" || saved.humanEdited) ? clearAttention(map, saved.meetingId, "synthesis") : map;
}

/** Error codes from `public_apply_granted_notes` that a retry cannot fix. Any other code is treated as retryable. */
const permanentCodes: Record<string, BlockedReason> = {
  appendTargetChanged: "changed",
  appendGrantMissing: "revoked",
  appendGrantOutsideWorkspace: "outsideWorkspace",
  outputGrantChanged: "folderChanged",
};
export const blockedReason = (code: string): BlockedReason | undefined => (Object.hasOwn(permanentCodes, code) ? permanentCodes[code] : undefined);

/**
 * The attention one note-destination write leaves behind. `failed` is the per-destination list of a completed call;
 * `callError` is the code of a call that failed as a whole. The outcome replaces both destination kinds, so a write
 * where everything succeeded clears every destination notice for the record.
 */
export function destinationOutcome(map: AttentionMap, recordId: string, outcome: { failed?: { code: string }[] } | { callError: string }): AttentionMap {
  let retryable: number | undefined;
  const blocked: BlockedReason[] = [];
  const failures = "callError" in outcome ? [{ code: outcome.callError, whole: true }] : (outcome.failed ?? []).map((f) => ({ code: f.code, whole: false }));
  for (const failure of failures) {
    const reason = blockedReason(failure.code);
    if (reason) blocked.push(reason);
    else retryable = failure.whole ? 0 : (retryable ?? 0) + 1;
  }
  let next = clearAttention(clearAttention(map, recordId, "destinations"), recordId, "blocked");
  if (retryable !== undefined) next = markAttention(next, recordId, { destinations: retryable });
  if (blocked.length) next = markAttention(next, recordId, { blocked });
  return next;
}

/** `retry` runs the failed step again; `openKnowledge` opens the page where note destinations are granted. */
export type AttentionAction = "retry" | "openKnowledge";
export interface AttentionNotice { kind: AttentionKind; text: string; action: AttentionAction; actionLabel: string }

const reasonText: Record<BlockedReason, (one: boolean) => string> = {
  changed: (one) => one ? "One note file was moved or replaced, so the app no longer writes to it." : "Some note files were moved or replaced, so the app no longer writes to them.",
  revoked: (one) => one ? "Access to one note destination was removed." : "Access to some note destinations was removed.",
  outsideWorkspace: (one) => one ? "One note destination is no longer inside the workspace folders." : "Some note destinations are no longer inside the workspace folders.",
  folderChanged: () => "The workspace's notes folder changed, so the app no longer writes to it.",
};

/** Calm, plain words for the Overview notices; the record itself is always saved. Every notice can also be dismissed. */
export function attentionNotices(attention: RecordAttention | undefined): AttentionNotice[] {
  const notices: AttentionNotice[] = [];
  if (attention?.synthesis === "failed") notices.push({ kind: "synthesis", text: "The meeting is saved, but its synthesis could not be made yet.", action: "retry", actionLabel: "Retry synthesis" });
  if (attention?.synthesis === "needsAccess") notices.push({ kind: "synthesis", text: "The meeting is saved. Its synthesis needs service access; make it here when it is available.", action: "retry", actionLabel: "Make synthesis" });
  if (attention?.destinations !== undefined) {
    const count = attention.destinations;
    const which = count === 1 ? "One note destination" : count > 1 ? `${count} note destinations` : "Your note destinations";
    notices.push({ kind: "destinations", text: `The meeting is saved. ${which} could not be updated.`, action: "retry", actionLabel: "Retry notes" });
  }
  const blocked = attention?.blocked ?? [];
  if (blocked.length) {
    const reasons = [...new Set(blocked)].map((reason) => reasonText[reason](blocked.filter((r) => r === reason).length === 1));
    notices.push({ kind: "blocked", text: `The meeting is saved. ${reasons.join(" ")} Choose the destination again in Knowledge settings.`, action: "openKnowledge", actionLabel: "Open Knowledge settings" });
  }
  return notices;
}
