import { DAY_MINUTES, SNAP, atMinutes, minutesOfDay, onDay } from "./calendarSave";

/**
 * The New meeting popover on the Calendar: a title, a day and a time, nothing else. It only creates the in-app meeting
 * plan; adding it to a calendar stays on the planning page, where every calendar write goes through the confirm sheet.
 */
export interface QuickMeetingDraft {
  title: string;
  /** Local midnight of the chosen day. */
  dayMs: number;
  /** Minutes after midnight. */
  startMinutes: number;
  lengthMinutes: number;
}

export const QUICK_LENGTHS = [15, 30, 45, 60] as const;
const midnight = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * The day the popover opens on: the day the Calendar is showing when that is today or later (Week: its first day;
 * Month: the first of the month), otherwise today. Today starts at the next half hour, another day at 09:00; 30 minutes.
 */
export function quickMeetingDefaults(now = Date.now(), shown?: { startMs: number; endMs: number; layout: "today" | "week" | "month" }): QuickMeetingDraft {
  const today = midnight(now);
  let day = today;
  if (shown && shown.layout !== "today" && !(shown.startMs <= now && now < shown.endMs)) {
    const mid = new Date((shown.startMs + shown.endMs) / 2);
    const first = shown.layout === "month" ? new Date(mid.getFullYear(), mid.getMonth(), 1).getTime() : midnight(shown.startMs);
    if (first > today) day = first;
  }
  return withDay({ title: "", dayMs: day, startMinutes: 0, lengthMinutes: 30 }, day, now, true);
}

/** Moves the draft to another day, keeping its time unless it is fresh (then today = next half hour, else 09:00). */
export function withDay(draft: QuickMeetingDraft, dayMs: number, now = Date.now(), fresh = false): QuickMeetingDraft {
  const day = midnight(dayMs);
  if (!fresh) return { ...draft, dayMs: day };
  const range = onDay(day, {}, now);
  // The next half hour can be tomorrow (after 23:30); keep it on the chosen day then.
  if (midnight(range.startMs) !== day) return { ...draft, dayMs: day, startMinutes: DAY_MINUTES - draft.lengthMinutes };
  return { ...draft, dayMs: day, startMinutes: minutesOfDay(range.startMs), lengthMinutes: Math.round((range.endMs - range.startMs) / 60_000) };
}

/** Takes the time drawn on the day timeline: its start and length, on the draft's day (an end at midnight is 24:00). */
export function withRange(draft: QuickMeetingDraft, range: { startMs: number; endMs: number }): QuickMeetingDraft {
  const startMinutes = minutesOfDay(range.startMs);
  const endMinutes = range.endMs >= draft.dayMs + 86_400_000 ? DAY_MINUTES : minutesOfDay(range.endMs);
  return { ...draft, startMinutes, lengthMinutes: Math.max(SNAP, endMinutes - startMinutes) };
}

/** Changes the length; a meeting that would run past midnight starts earlier instead. */
export function withLength(draft: QuickMeetingDraft, minutes: number): QuickMeetingDraft {
  return { ...draft, lengthMinutes: minutes, startMinutes: Math.min(draft.startMinutes, DAY_MINUTES - minutes) };
}

export function quickMeetingRange(draft: QuickMeetingDraft): { startMs: number; endMs: number } {
  const startMs = atMinutes(draft.dayMs, draft.startMinutes);
  return { startMs, endMs: startMs + draft.lengthMinutes * 60_000 };
}

/** Why Create is not available yet, in words shown beside it; undefined when the meeting can be created. */
export function quickMeetingProblem(draft: QuickMeetingDraft, now = Date.now()): string | undefined {
  if (!draft.title.trim()) return "Add a title to create the meeting.";
  if (quickMeetingRange(draft).endMs <= now) return "This time has passed. Choose a later time.";
  return undefined;
}

export const lengthLabel = (minutes: number) => minutes < 60 ? `${minutes} min` : minutes === 60 ? "1 h" : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
