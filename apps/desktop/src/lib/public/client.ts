import { invoke } from "@tauri-apps/api/core";
import { approveAndApply } from "./applyFlow";
import type {
  PublicWorkspace,
  PublicSource,
  PublicMeetingPlan,
  PublicArtifact,
  PublicArtifactKind,
  CalendarAccount,
  CalendarSource,
  PublicCalendarEvent,
  CalendarCoverage,
  PublicAccountStatus,
  PublicAccountExportResult,
  PublicAccountDeletionResult,
  ActionProposal,
} from "@live-interview/core";
import type { CalendarCapabilityRow } from "./calendarSave";
/** The saved event as EventKit read it back, plus the same event as the calendar list will show it. */
export interface AppliedCalendarChange {
  applied: true;
  event: { id: string; stableId?: string; calendarId: string; title: string; startMs: number; endMs: number; version?: string };
  publicEvent: PublicCalendarEvent | null;
  /** A replay of the token this change was applied with: the earlier result, nothing written again. */
  alreadyApplied?: boolean;
  /** Set for a move: the event was edited in place and verified by a fresh read; `before` is where it was. */
  moved?: boolean;
  before?: { startMs: number; endMs: number };
}
/** A move of an existing macOS event, named as the calendar list knows it. Nothing is written until it is applied. */
export interface CalendarMoveRequest {
  calendarId: string;
  move: true;
  /** EventKit's calendarItemIdentifier (the list's `sourceEventId`); `eventId` is the native fallback. */
  stableId?: string;
  eventId?: string;
  originalStartMs: number;
  startMs: number;
  endMs: number;
  /** The version the person saw; a different one in the calendar refuses the move (`eventChanged`). */
  expectedVersion?: string;
  inferred: false;
}
// Only sanitized product state crosses IPC. Sessions and calendar tokens stay in native Keychain.
export const publicClient = {
  refreshWorkspace: (id: string, sharedLibraryIds: string[]) =>
    invoke<{ changedSourceIds: string[] }>("refresh_workspace", {
      id,
      sharedLibraryIds,
    }),
  listWorkspaces: () => invoke<PublicWorkspace[]>("public_list_workspaces"),
  saveWorkspace: (workspace: PublicWorkspace) =>
    invoke<PublicWorkspace>("public_save_workspace", { workspace }),
  sources: (workspaceId: string) =>
    invoke<PublicSource[]>("public_workspace_sources", { workspaceId }),
  listPlans: () => invoke<PublicMeetingPlan[]>("public_list_meeting_plans"),
  getPlan: (id: string) =>
    invoke<PublicMeetingPlan | null>("public_get_meeting_plan", { id }),
  savePlan: (plan: PublicMeetingPlan) =>
    invoke<PublicMeetingPlan>("public_save_meeting_plan", { plan }),
  getArtifact: (
    meetingId: string,
    kind: PublicArtifactKind,
    recordRevision: number,
  ) =>
    invoke<PublicArtifact | null>("public_get_artifact", {
      meetingId,
      kind,
      recordRevision,
    }),
  getLatestArtifact: (
    meetingId: string,
    kind: PublicArtifactKind,
    recordRevision: number,
  ) =>
    invoke<PublicArtifact | null>("public_get_latest_artifact", {
      meetingId,
      kind,
      recordRevision,
    }),
  saveArtifact: (artifact: PublicArtifact) =>
    invoke<PublicArtifact>("public_save_artifact", { artifact }),
  applyGrants: (meetingId: string) =>
    invoke<{ applied: number; skipped: number; failed?: { path: string; code: string }[] }>("public_apply_granted_notes", {
      meetingId,
    }),
  accounts: () => invoke<CalendarAccount[]>("public_calendar_accounts"),
  connectCalendar: (provider: "microsoft" | "google") =>
    invoke<CalendarAccount>("public_connect_calendar", { provider }),
  calendars: (accountId: string) =>
    invoke<CalendarSource[]>("public_calendar_sources", { accountId }),
  selectCalendars: (accountId: string, calendarIds: string[]) =>
    invoke<void>("public_select_calendars", { accountId, calendarIds }),
  disconnectCalendar: (accountId: string) =>
    invoke<void>("public_disconnect_calendar", { accountId }),
  events: (startMs: number, endMs: number) =>
    invoke<{ events: PublicCalendarEvent[]; coverage: CalendarCoverage[] }>(
      "public_calendar_events",
      { startMs, endMs },
    ),
  // Calendars on this Mac. Reading capabilities never asks for permission; connecting stays in Settings.
  calendarCapabilities: () =>
    invoke<{ capabilities?: CalendarCapabilityRow[]; permission?: string }>(
      "calendar_capabilities",
    ),
  // Every calendar write is a stored proposal that the action executor applies only after this exact approval.
  prepareCalendarChange: (change: {
    calendarId: string;
    eventId?: string;
    originalStartMs?: number;
    title: string;
    startMs: number;
    endMs: number;
    timeZone: string;
    inferred: boolean;
  }) => invoke<ActionProposal>("prepare_calendar_change", { change }),
  prepareCalendarMove: (change: CalendarMoveRequest) =>
    invoke<ActionProposal & { invitation?: boolean; calendar?: { id: string; name?: string; account?: string } }>("prepare_calendar_change", { change }),
  /** Undefined when an earlier click already applied this change or is applying it (see applyFlow). */
  applyCalendarChange: (proposalId: string) =>
    approveAndApply<AppliedCalendarChange>(invoke, proposalId, "apply_calendar_change"),
  // The native picker records the chosen file; the action executor accepts a proposal only for it.
  chooseIcsPath: (title: string) =>
    invoke<string | null>("pick_action_target", {
      kind: "icsFile",
      defaultName: (title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "meeting") + ".ics",
    }),
  proposeFile: (targetPath: string, content: string) =>
    invoke<ActionProposal>("propose_action", { targetPath, operation: "rewrite", content }),
  /** Undefined when an earlier click already applied this file or is applying it (see applyFlow). */
  applyFileProposal: (proposalId: string) =>
    approveAndApply<unknown>(invoke, proposalId, "apply_action"),
  declineCalendarChange: (proposalId: string) =>
    invoke<void>("decline_action", { proposalId }),
  account: () => invoke<PublicAccountStatus>("public_account_status"),
  signIn: () => invoke<PublicAccountStatus>("public_sign_in"),
  /** Abandons a pending browser sign-in; the pending call then rejects with signInCancelled. */
  cancelSignIn: () => invoke<void>("public_cancel_sign_in"),
  signOut: () => invoke<void>("public_sign_out"),
  /** Signs out every Mac of the account (the service revokes all sessions), then this one. */
  signOutAll: () =>
    invoke<{ signedOutEverywhere: true }>("public_sign_out_all"),
  checkout: (plan: "standard" | "premium") =>
    invoke<{ url: string }>("public_checkout", { plan }),
  portal: () => invoke<{ url: string }>("public_billing_portal"),
  exportAccount: () =>
    invoke<PublicAccountExportResult>("public_export_account"),
  deleteAccount: () =>
    invoke<PublicAccountDeletionResult>("public_delete_account"),
};
export type PublicClient = typeof publicClient;
