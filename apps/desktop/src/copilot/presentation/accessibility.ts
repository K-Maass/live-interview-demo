// Accessible names and titles (#37). Pure text, so the wording is tested without a DOM.
import type { AppLocation, PageLocation, SettingsSection } from "./types";

export const settingsNames: Record<SettingsSection, string> = {
  setup: "Setup",
  account: "Account and plan",
  updates: "Updates",
  speech: "Local speech",
  reasoning: "Reasoning",
  keyboard: "Keyboard shortcuts",
  calendars: "Calendars",
  sharing: "Data and sharing",
  diagnostics: "Diagnostics",
};

/** The accessible name of the Settings window on a section: "Settings, Calendars". */
export const settingsTitle = (section: SettingsSection) => "Settings, " + settingsNames[section];

/**
 * The window title a screen reader announces after navigation. `meeting` is the title of the meeting being shown. While
 * Settings is open over a page, pass `{ kind: "settings", section }`: the title then names the open section.
 */
export function pageTitle(location: AppLocation, meeting?: string): string {
  const page =
    location.kind === "meetings" ? "Meetings"
    : location.kind === "meeting" ? meeting?.trim() || "Meeting"
    : location.kind === "knowledge" ? "Knowledge"
    : location.kind === "people" ? "People"
    : settingsTitle(location.section);
  return page + " · Live Interview";
}

/**
 * Identifies the screen, not the tab inside it: moving focus to the heading is right when the screen changes and wrong
 * when someone switches an Upcoming/Past view, a meeting's Plan/Brief tab or a settings section with the keyboard.
 */
export function screenKey(location: PageLocation | AppLocation, live = false): string {
  // A saved record keeps the id of the meeting it came from, so going from live to review needs `live` to be a new screen.
  return location.kind === "meeting" ? `meeting:${location.id}:${live ? "live" : "static"}` : location.kind;
}

const dayFormat = (date: Date) => date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * What is known about a date: its calendar is loaded, partly loaded, loading right now, or not loaded at all; 'none' when
 * there is no calendar to read (none connected, access off, none chosen), which the page explains once above the views.
 */
export type CoverageState = "loaded" | "partial" | "loading" | "missing" | "none";

/** Optional facts a calendar card shows besides its text; each is read out after the visible words. */
export interface CalendarLabelExtras {
  /** Plain words such as "Brief ready" or "No brief". */
  readiness?: string;
  recurring?: boolean;
  /** Attendee names, own address already removed. */
  people?: string[];
  /** True, or the local days (end exclusive) of an all-day event. */
  allDay?: boolean | { startDay: string; endDay: string };
}

/** "Alex", "Alex and Sam", "Alex Morgan and 2 others". */
function withPeople(people: string[]): string {
  if (people.length === 1) return `with ${people[0]}`;
  if (people.length === 2) return `with ${people[0]} and ${people[1]}`;
  const rest = people.length - 1;
  return `with ${people[0]} and ${rest} others`;
}

const dayFromKey = (key: string) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };

/**
 * The visible text first, then the day it does not show: "02:00 PM – 03:00 PM Customer discovery, Wednesday, October 14".
 * Starting with exactly what is on the button keeps it operable by voice control ("click 02:00 PM Customer discovery").
 * The week view shows the whole range; the month view shows the start only; "title" is for cards that show only the
 * title (all-day bars). `extras` then adds what the card shows beside the text: ", Brief ready, repeats, with Alex Morgan and 2 others".
 */
export function calendarEventLabel(event: { title: string; startMs: number; endMs: number }, view: "range" | "start" | "title" | "titleTime" = "range", extras?: CalendarLabelExtras): string {
  // "titleTime" is for cards that show the title first and the start time after it ("Budget check 02:00 PM").
  const when = view === "title" ? event.title : view === "titleTime" ? `${event.title} ${clock(event.startMs)}` : view === "range" ? `${clock(event.startMs)} – ${clock(event.endMs)} ${event.title}` : `${clock(event.startMs)} · ${event.title}`;
  const parts = [when, dayFormat(new Date(event.startMs))];
  if (extras?.allDay) {
    parts.push("all day");
    if (typeof extras.allDay === "object") {
      const last = dayFromKey(extras.allDay.endDay); last.setDate(last.getDate() - 1);
      if (dayFromKey(extras.allDay.startDay).getTime() < last.getTime()) parts.push(`until ${dayFormat(last)}`);
    }
  }
  if (extras?.readiness) parts.push(extras.readiness);
  if (extras?.recurring) parts.push("repeats");
  if (extras?.people?.length) parts.push(withPeople(extras.people));
  return parts.join(", ");
}

/** The "+N" item that stands for meetings that do not fit beside each other: "3 more meetings, 11:00 AM to 12:30 PM, Tuesday, October 13". */
export function calendarOverflowLabel(overflow: { count: number; startMs: number; endMs: number }, day: Date): string {
  const meetings = overflow.count === 1 ? "1 more meeting" : `${overflow.count} more meetings`;
  return `${meetings}, ${clock(overflow.startMs)} to ${clock(overflow.endMs)}, ${dayFormat(day)}`;
}

/**
 * Names a day column or month cell, including the shading that otherwise only colour carries. Pass `coverage`, or the
 * older `loaded` flag (true is 'loaded', false is 'missing').
 */
export function calendarDayLabel(day: Date, state: { loaded: boolean; meetings: number } | { coverage: CoverageState; meetings: number }): string {
  const meetings = state.meetings === 1 ? "1 meeting" : `${state.meetings} meetings`;
  const coverage: CoverageState = "coverage" in state ? state.coverage : state.loaded ? "loaded" : "missing";
  const note = coverage === "missing" ? ", calendar not loaded for this date" : coverage === "partial" ? ", calendar partly loaded" : coverage === "loading" ? ", loading" : coverage === "none" ? ", no calendar connected" : "";
  return `${dayFormat(day)}, ${meetings}${note}`;
}

/** Both ends in full ("October 12, 2026 to October 18, 2026"): a bare "- 18" does not read as a date range. */
export function weekRangeLabel(first: Date, last: Date): string {
  const full = (date: Date) => date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return `${full(first)} to ${full(last)}`;
}

/** Icon-only and short-text buttons repeat on every card, so each one names the card it acts on. */
export function cardActionLabel(action: "pin" | "dismiss" | "why" | "answered" | "outdated" | "reopen", headline: string): string {
  const verb = action === "pin" ? "Pin suggestion" : action === "dismiss" ? "Dismiss suggestion" : action === "why" ? "Why this suggestion"
    : action === "answered" ? "Mark answered" : action === "outdated" ? "Mark outdated" : "Reopen";
  return `${verb}: ${headline}`;
}
/** A card written against an earlier moment of the meeting: "as of 14:03:07" (local time, 24 h). */
export function asOfText(ms: number): string {
  const d = new Date(ms), two = (n: number) => String(n).padStart(2, "0");
  return `as of ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
