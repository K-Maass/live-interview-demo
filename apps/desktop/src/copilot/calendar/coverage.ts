// Which dates have a loaded calendar, and what to say about it (#123). Pure.
//
//   dayCoverage(day, input)       'loaded' | 'partial' | 'loading' | 'missing' for one local day
//   coverageText(state)           "Not loaded" / "Partly loaded" for headers and cells
//   rangeStatus(coverage, names)  the status line: all fine, partly loaded (with account names) or failed (with names)
//   errorReason(coverage)         the plain-language reason of a failed row, when its code has one
//
// A "source" is one account + calendar. A day is loaded when every source has a `ready` row that covers the whole day.
// It is partial when some do, or when a source has a partial/stale row touching the day. Anything else is missing, and a
// missing day is never drawn as an empty day: the views hatch it and say "Not loaded". While a range is loading,
// missing days read as 'loading' instead (no hatch, no "Not loaded") so a normal fetch does not flash the warning.
// When there is no calendar to read at all they are 'none': plain, because the page notice already says why.
import type { CalendarCoverage } from "@live-interview/core";
import type { CoverageState } from "../presentation/accessibility";
import { calendarCodeHint } from "../../lib/public/calendarErrors";
import { dayBounds } from "./layout";

export interface CoverageInput {
  /** Public edition: coverage rows come from the providers. Otherwise only `calendarRange` is known. */
  enabled: boolean;
  coverage: CalendarCoverage[];
  calendarRange?: { startMs: number; endMs: number } | null;
  loading?: boolean;
  /** No calendar can be read (see connection.ts): unloaded days are 'none', not hatched as "Not loaded". */
  nothingToRead?: boolean;
}

/** The short note a header or cell shows for a day that is not fully loaded; undefined when nothing needs saying. */
export function coverageText(state: CoverageState): string | undefined {
  return state === "missing" ? "Not loaded" : state === "partial" ? "Partly loaded" : undefined;
}

const sourceKey = (row: CalendarCoverage) => row.accountId + ":" + (row.calendarId ?? "");

export function dayCoverage(day: Date, input: CoverageInput): CoverageState {
  const { startMs, endMs } = dayBounds(day);
  let state: CoverageState;
  if (!input.enabled) {
    const range = input.calendarRange;
    state = !range || endMs <= range.startMs || startMs >= range.endMs ? "missing" : range.startMs <= startMs && range.endMs >= endMs ? "loaded" : "partial";
  } else {
    const sources = new Map<string, CalendarCoverage[]>();
    for (const row of input.coverage) sources.set(sourceKey(row), [...(sources.get(sourceKey(row)) ?? []), row]);
    let ready = 0, partial = 0;
    for (const rows of sources.values()) {
      if (rows.some((r) => r.status === "ready" && r.startMs <= startMs && r.endMs >= endMs)) ready++;
      else if (rows.some((r) => (r.status === "partial" || r.status === "stale") && r.startMs < endMs && r.endMs > startMs)) partial++;
    }
    state = sources.size && ready === sources.size ? "loaded" : ready + partial > 0 ? "partial" : "missing";
  }
  if (state !== "missing") return state;
  return input.nothingToRead ? "none" : input.loading ? "loading" : state;
}

/** Plain words for the first failed row that has an actionable code ("sign in again", "access is off"), if any. */
export function errorReason(coverage: CalendarCoverage[]): string | undefined {
  for (const row of coverage) if (row.status === "error" || row.status === "stale") { const hint = calendarCodeHint(row.code); if (hint) return hint; }
  return undefined;
}

export type RangeStatus = { kind: "ok" } | { kind: "partial"; accounts: string[] } | { kind: "error"; accounts: string[] };

/**
 * `accountNames` maps an account id to the name shown to people. Error means every row failed; partial means at least one
 * row is partial, stale or failed while another is fine (or the row itself is partial).
 */
export function rangeStatus(coverage: CalendarCoverage[], accountNames: (accountId: string) => string): RangeStatus {
  const bad = coverage.filter((r) => r.status !== "ready");
  if (!bad.length) return { kind: "ok" };
  const names = [...new Set(bad.map((r) => accountNames(r.accountId)))];
  const allFailed = bad.length === coverage.length && bad.every((r) => r.status === "error");
  return allFailed ? { kind: "error", accounts: names } : { kind: "partial", accounts: names };
}
