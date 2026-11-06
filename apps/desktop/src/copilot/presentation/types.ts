export type MeetingsView = "calendar" | "upcoming" | "past";
export type ReviewArtifact = "overview" | "transcript" | "actions" | "notes" | "details";
export type SettingsSection = "setup" | "account" | "updates" | "speech" | "reasoning" | "keyboard" | "calendars" | "sharing" | "diagnostics";
export type AppLocation =
  | { kind: "meetings"; view: MeetingsView }
  | { kind: "meeting"; id: string; preparationOpen: boolean; artifact: ReviewArtifact; autoStart?: boolean }
  | { kind: "knowledge" }
  | { kind: "people" }
  | { kind: "settings"; section: SettingsSection };
/** A page the main window shows. Settings is not a page: `navigate({ kind: "settings", section })` opens it as a window over the current page. */
export type PageLocation = Exclude<AppLocation, { kind: "settings" }>;
export interface UpcomingMeeting {
  id: string; title: string; startMs: number; endMs: number;
  /** Optional, present for calendar events (not for app-only plan rows). All-day events carry local days, end exclusive. */
  isAllDay?: boolean; startDay?: string; endDay?: string; recurring?: boolean;
  attendees?: { name: string; email?: string }[]; joinUrl?: string; accountId?: string;
}
export interface Workspace { id: string; root: string }
export interface LoadedCalendarRange { startMs: number; endMs: number }
