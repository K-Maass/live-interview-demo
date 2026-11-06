const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function utcDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return utcDay(new Date(Date.UTC(y, m - 1, d + count)));
}

/**
 * Events cached before the all-day fields existed have no `isAllDay`. Providers reported their
 * all-day events as midnight to midnight in the calendar's zone or in UTC, so such a row is
 * treated as all-day when it lasts at least 23 hours, is within an hour of a whole number of
 * days, and starts at local or UTC midnight. Returns the local-calendar days the event covers
 * (`endDay` exclusive), or undefined when the row is not recognisably all-day or already carries
 * the field. A fresh fetch replaces these rows; this only covers the stale-cache window.
 */
export function legacyAllDay(
  event: { startMs: number; endMs: number; isAllDay?: boolean },
): { startDay: string; endDay: string } | undefined {
  if (event.isAllDay !== undefined) return undefined;
  const duration = event.endMs - event.startMs;
  if (!Number.isFinite(duration) || duration < 23 * HOUR) return undefined;
  const days = Math.round(duration / DAY);
  if (days < 1 || Math.abs(duration - days * DAY) > HOUR) return undefined;
  const start = new Date(event.startMs);
  if (
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    start.getSeconds() === 0
  ) {
    const startDay = localDay(start);
    return { startDay, endDay: addDays(startDay, days) };
  }
  if (
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0
  ) {
    const startDay = utcDay(start);
    return { startDay, endDay: addDays(startDay, days) };
  }
  return undefined;
}
