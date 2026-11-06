// The props every grid view (Week, Month, and Today later) takes from CalendarView (#123). Types only.
import type { CoverageState } from "../presentation/accessibility";
import type { CalendarItem } from "./model";

export interface GridViewProps {
  /** Local midnights, Monday first: 7 for Week, 42 for Month. */
  days: Date[];
  items: CalendarItem[];
  /** Current time in ms (CalendarView passes the minute-aligned `useNow`). */
  now: number;
  /** Coverage of one day, see coverage.ts. Unloaded days are hatched and labelled; they never read as empty. */
  coverage(day: Date): CoverageState;
  /** A live meeting is running: blocks and Join stay readable but inert. */
  busy: boolean;
  /** A block was pressed: open that meeting. */
  onOpen(item: CalendarItem): void;
  /** A day header, date, "+N" or "+N more" was pressed: open the day drawer. `opener` gets focus back when it closes. */
  onDay(day: Date, opener: HTMLElement): void;
  /** Roving-focus id from useCalendarKeyboard; when omitted the view picks its default tab stop. */
  activeId?: string;
  /** The day the default tab stop should land on (the anchor); falls back to today, then the first day. */
  focusDay?: Date;
}
