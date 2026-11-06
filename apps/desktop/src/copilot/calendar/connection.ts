// Whether there is a calendar to read at all, and if not, why (pure). It decides which one notice the Calendar shows,
// so an empty day is never mistaken for a missing connection and the same problem is never reported twice.
//
//   calendarConnection(input) ->
//     checking     the account list has not arrived yet: say nothing (quiet, like loading)
//     none         no calendar account is connected: invite to connect one
//     accessOff    macOS refuses Live Interview access to its calendars (denied in Privacy & Security → Calendars)
//     noCalendars  an account is connected but no calendar in it is chosen to be shown
//     failed       the last load was refused as a whole; `reason` is plain words, `code` the native code
//     ok           at least one chosen calendar is being read; coverage.ts decides what each day means
//
// Accounts with status "disconnected" or "accessOff" are placeholders from the native side (public_calendar_accounts),
// not connections. When the public product is off (personal edition) only `calendarRange` is known: none until a
// range has been loaded.
import type { CalendarAccount, CalendarCoverage, CalendarSource } from "@live-interview/core";
import { calendarCodeHint } from "../../lib/public/calendarErrors";

export type CalendarConnection =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "accessOff"; name: string }
  | { kind: "noCalendars"; accounts: string[] }
  | { kind: "failed"; reason: string; code: string }
  | { kind: "ok" };

export interface ConnectionInput {
  enabled: boolean;
  /** False until the first account list has arrived (or failed). Missing means "already known". */
  accountsLoaded?: boolean;
  accounts: Pick<CalendarAccount, "id" | "name" | "email" | "provider" | "status" | "selectedCalendarIds">[];
  /** The native code of the last range load that was refused as a whole; cleared by the next success. */
  rangeError?: string;
  calendarRange?: { startMs: number; endMs: number } | null;
}

const PLACEHOLDER = new Set(["disconnected", "accessOff"]);

/** Plain words for a load that failed as a whole: the actionable hint when there is one, otherwise what happened. */
export function calendarLoadReason(code: string): string {
  return calendarCodeHint(code) ?? "The calendars on this Mac didn’t answer.";
}

export function calendarConnection(input: ConnectionInput): CalendarConnection {
  if (!input.enabled) return input.calendarRange ? { kind: "ok" } : { kind: "none" };
  if (input.accountsLoaded === false) return { kind: "checking" };
  const connected = input.accounts.filter((a) => !PLACEHOLDER.has(a.status));
  if (connected.some((a) => a.selectedCalendarIds?.length)) return input.rangeError ? { kind: "failed", reason: calendarLoadReason(input.rangeError), code: input.rangeError } : { kind: "ok" };
  const off = input.accounts.find((a) => a.status === "accessOff");
  if (off) return { kind: "accessOff", name: off.name || "macOS Calendar" };
  if (connected.length) return { kind: "noCalendars", accounts: connected.map((a) => a.name || a.email || a.provider) };
  if (input.rangeError) return { kind: "failed", reason: calendarLoadReason(input.rangeError), code: input.rangeError };
  return { kind: "none" };
}

/** True when there is nothing to read, so days are neither "loaded" nor "not loaded": the page notice says why. */
export function nothingToRead(connection: CalendarConnection): boolean {
  return connection.kind === "none" || connection.kind === "accessOff" || connection.kind === "noCalendars";
}

// ---- Settings → Calendar connections ------------------------------------------------------------------------------
//
//   accountState(account, ctx) -> one display state per account row (design: docs/design/2026-10-18-calendar-connections.md §5)
//     updating         this account is connecting, retrying or loading its calendar list for the first time
//     accessOff        macOS refuses access (only System Settings can change it)
//     signInAgain      the provider needs the person to sign in again
//     accessWithdrawn  the provider refused access (permission withdrawn or an administrator restricted it)
//     scopeIncomplete  Google was connected without both calendar permissions
//     failed           the last load failed (account error, error/stale coverage, or the whole range was refused)
//     listIncomplete   the calendar list could not be loaded completely
//     nothingChosen    connected, but no calendar is ticked
//     ok               connected and reading at least one calendar
//
// `ticked`/`readable` count the calendars for "n of m"; `showingFrom` is the last ready snapshot when the load failed.
export type AccountStateKind = "updating" | "accessOff" | "signInAgain" | "accessWithdrawn" | "scopeIncomplete" | "failed" | "listIncomplete" | "nothingChosen" | "ok";
export interface AccountState { kind: AccountStateKind; ticked: number; readable: number; updatedMs?: number; showingFrom?: number }
export type ConnectionAccount = Pick<CalendarAccount, "id" | "provider" | "name" | "email" | "status" | "code" | "selectedCalendarIds" | "selectionSaved" | "lastSyncMs">;
export interface AccountStateContext {
  /** The account whose row is connecting or retrying right now. */
  busyId?: string;
  /** The account's calendars, once loaded. Undefined while the first list is still loading. */
  sources?: CalendarSource[];
  /** The calendars ticked in Settings right now (local state, saved or about to be saved). */
  ticked?: string[];
  /** Coverage rows of the loaded range (any account; only this account's rows are used). */
  coverage?: CalendarCoverage[];
  /** The native code of a range load that was refused as a whole. */
  rangeError?: string;
  /** The calendar list could not be loaded. */
  sourcesFailed?: boolean;
  /** True while the first calendar list for this account is loading. */
  loadingSources?: boolean;
}

/** Calendars on this Mac are read by default until the person saves a choice, so every readable one counts as ticked. */
export function defaultTicks(account: Pick<CalendarAccount, "provider" | "selectionSaved">, sources: CalendarSource[]): string[] {
  const readable = sources.filter((s) => s.read);
  if (account.provider === "apple" && !account.selectionSaved) return readable.map((s) => s.id);
  return readable.filter((s) => s.selected).map((s) => s.id);
}

export function accountState(account: ConnectionAccount, ctx: AccountStateContext = {}): AccountState {
  const sources = ctx.sources;
  const readable = sources ? sources.filter((s) => s.read) : [];
  const tickedIds = ctx.ticked ?? (sources ? defaultTicks(account, sources) : account.selectedCalendarIds ?? []);
  const ticked = sources ? readable.filter((s) => tickedIds.includes(s.id)).length : tickedIds.length;
  const rows = (ctx.coverage ?? []).filter((r) => r.accountId === account.id);
  const refreshed = rows.map((r) => r.refreshedAtMs ?? 0).filter(Boolean);
  const updatedMs = Math.max(account.lastSyncMs ?? 0, ...refreshed) || undefined;
  const base = { ticked, readable: readable.length, updatedMs };
  if (ctx.busyId === account.id || ctx.loadingSources) return { ...base, kind: "updating" };
  if (account.status === "accessOff") return { ...base, kind: "accessOff" };
  if (account.code === "calendarReauthenticationRequired") return { ...base, kind: "signInAgain" };
  if (account.code === "calendarAccessDenied") return { ...base, kind: "accessWithdrawn" };
  if (account.code === "calendarScopeIncomplete") return { ...base, kind: "scopeIncomplete" };
  const badCoverage = rows.some((r) => r.status === "error" || r.status === "stale");
  const rangeFailed = !!ctx.rangeError && (account.selectedCalendarIds?.length ?? 0) > 0;
  if (account.status === "error" || badCoverage || rangeFailed) {
    const ready = rows.filter((r) => r.status === "ready" && r.refreshedAtMs).map((r) => r.refreshedAtMs!);
    return { ...base, kind: "failed", showingFrom: ready.length ? Math.max(...ready) : undefined };
  }
  if (account.status === "partial" || ctx.sourcesFailed) return { ...base, kind: "listIncomplete" };
  if (ticked === 0) return { ...base, kind: "nothingChosen" };
  return { ...base, kind: "ok" };
}

const NEEDS_ACTION: AccountStateKind[] = ["accessOff", "signInAgain", "accessWithdrawn", "scopeIncomplete", "failed", "listIncomplete", "nothingChosen"];
const PROVIDER_ORDER = { apple: 0, microsoft: 1, google: 2 } as const;
/** Rows that need action first (access off … no calendars chosen), then healthy rows; within a group Mac, Microsoft, Google, name. */
export function sortAccounts<T extends ConnectionAccount>(accounts: T[], stateOf: (a: T) => AccountStateKind): T[] {
  const rank = (a: T) => { const i = NEEDS_ACTION.indexOf(stateOf(a)); return i < 0 ? NEEDS_ACTION.length : i; };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider] || accountTitle(a).localeCompare(accountTitle(b)));
}

export function accountTitle(a: Pick<CalendarAccount, "provider" | "email" | "name">): string {
  return a.provider === "apple" ? "Calendars on this Mac" : a.email || a.name || (a.provider === "microsoft" ? "Microsoft account" : "Google account");
}
export const PROVIDER_NAME = { apple: "Calendars on this Mac", microsoft: "Microsoft", google: "Google" } as const;

/** "just now", "2 min ago", "1 h ago", then the date ("14 Oct"). */
export function updatedText(ms: number, now = Date.now()): string {
  const s = Math.max(0, now - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(ms);
}
/** A time today ("9:40"), otherwise the date ("14 Oct"). */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now);
  return d.toDateString() === n.toDateString()
    ? d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0")
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d);
}

/** The status line words for a state (the "Microsoft · " prefix and "Updated …" are added by the row). */
export function stateText(state: AccountState, now = Date.now()): string[] {
  switch (state.kind) {
    case "updating": return ["Updating…"];
    case "accessOff": return ["Access is off in System Settings"];
    case "signInAgain": return ["Sign in again to keep reading"];
    case "accessWithdrawn": return ["Access was withdrawn"];
    case "scopeIncomplete": return ["Needs both calendar permissions"];
    case "failed": return state.showingFrom ? ["Couldn’t update", "Showing meetings from " + shortTime(state.showingFrom, now)] : ["Couldn’t update"];
    case "listIncomplete": return ["Couldn’t load all calendars"];
    case "nothingChosen": return ["No calendars chosen"];
    case "ok": {
      const count = !state.readable ? [] : state.readable === 1 ? ["1 calendar"] : state.ticked >= state.readable ? ["All " + state.readable + " calendars"] : [state.ticked + " of " + state.readable + " calendars"];
      return ["Connected", ...count, ...(state.updatedMs ? ["Updated " + updatedText(state.updatedMs, now)] : [])];
    }
  }
}

/** The list footer's left text when nothing is being saved. */
export function calendarListFooter(a: Pick<CalendarAccount, "provider" | "selectionSaved">): string {
  if (a.provider === "apple") return a.selectionSaved ? "New calendars on this Mac start unticked." : "All calendars are read until you untick one.";
  return "Read only. Live Interview can’t change " + (a.provider === "microsoft" ? "Microsoft" : "Google") + " calendars.";
}

/** Mac calendars grouped by their macOS account. Older native builds send "{account} · {name}" without `group`. */
export function calendarGroups(provider: CalendarAccount["provider"], sources: CalendarSource[]): { group?: string; sources: (CalendarSource & { label: string })[] }[] {
  const out: { group?: string; sources: (CalendarSource & { label: string })[] }[] = [];
  for (const s of sources) {
    let group = provider === "apple" ? s.group : undefined;
    let label = s.name;
    if (provider === "apple" && !s.group) {
      const i = s.name.indexOf(" · ");
      if (i > 0) { group = s.name.slice(0, i); label = s.name.slice(i + 3); }
    }
    let bucket = out.find((g) => g.group === group);
    if (!bucket) out.push((bucket = { group, sources: [] }));
    bucket.sources.push({ ...s, label });
  }
  return out;
}
/** A calendar colour safe to put in a style attribute, or undefined (no dot is drawn; a colour is never invented). */
export function calendarColor(color?: string): string | undefined {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}
