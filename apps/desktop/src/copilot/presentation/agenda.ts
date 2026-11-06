// Relative wording for the Meetings agenda. Pure functions of a clock value, so they are tested without a DOM.
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Tomorrow" or "Monday, October 19", used to group the agenda by day. */
export function agendaDayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** Meetings whose title contains the query, ignoring case and surrounding spaces; an empty query keeps everything. */
export function filterAgenda<T extends { title: string }>(events: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? events.filter((event) => event.title.toLocaleLowerCase().includes(needle)) : events;
}
