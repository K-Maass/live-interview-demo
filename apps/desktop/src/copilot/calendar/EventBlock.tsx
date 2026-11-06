// One meeting as ONE button, in the Week grid, a Month cell or the day drawer (#123).
//
//   <EventBlock item variant="week" tier="full" busy now onOpen style nav tabIndex />
//
//   variant   'week'   absolutely positioned by the caller through `style`; `tier` ('line' | 'two' | 'full', see weekTier)
//                      decides how much it shows. All-day items render as a one-line bar.
//             'month'  one 1.5 rem entry: "09:00 AM · Title", or the title alone for an all-day bar
//             'drawer' a full-width row: time, title, readiness words, avatars (Join is a sibling, see JoinButton)
//   item      a CalendarItem. Colour means brief readiness only: ready accent, draft blue, none outlined grey, unsynced
//             (an app-only plan row) dashed. Past meetings use the raised surface and muted text.
//   busy      a live meeting is running: the block stays readable (`aria-disabled="true"`) and clicking does nothing.
//   nav       { id, col, order } become data-nav / data-col / data-order for the keyboard model (useCalendarKeyboard).
//
// The accessible name comes from calendarEventLabel and starts with the visible text, then adds day, readiness,
// "repeats" and the people. Nothing here ever shows an invitation response or a place: that data does not exist.
import type { CSSProperties } from "react";
import { Repeat } from "lucide-react";
import { timeText } from "../ui";
import { calendarEventLabel } from "../presentation/accessibility";
import { AvatarStack } from "./AvatarStack";
import type { CalendarItem } from "./model";
import type { WeekTier } from "./geometry";

export type EventVariant = "week" | "month" | "drawer";

export interface EventBlockProps {
  item: CalendarItem;
  variant: EventVariant;
  busy: boolean;
  now: number;
  onOpen(item: CalendarItem): void;
  /** Week only. Default 'two'. */
  tier?: WeekTier;
  /** Week only: the block's width in rem. Under 6.85 rem (96 px) it shows the title alone; under 10 rem (140 px) a one-line block drops the time after the title. The time stays in `title` and the accessible name. */
  widthRem?: number;
  style?: CSSProperties;
  className?: string;
  nav?: { id: string; col: number; order: number };
  tabIndex?: number;
  /** Week: the meeting started before this day / ends after it (square corners on that side). */
  continuesBefore?: boolean;
  continuesAfter?: boolean;
}

export const NARROW_BLOCK_REM = 6.85;
export const TIME_AFTER_TITLE_REM = 10;

export function labelView(variant: EventVariant, tier: WeekTier, allDay: boolean, titleOnly = false): "range" | "titleTime" | "title" {
  if (allDay) return "title";
  if (titleOnly || variant === "month") return "titleTime";
  if (variant === "week" && tier === "line") return "titleTime";
  return "range";
}

export function EventBlock({ item, variant, tier = "two", widthRem, busy, now, onOpen, style, className, nav, tabIndex, continuesBefore, continuesAfter }: EventBlockProps) {
  const allDay = !!item.allDay;
  const titleOnly = variant === "week" && widthRem !== undefined && widthRem < NARROW_BLOCK_REM && !allDay;
  const timeAfterTitle = widthRem === undefined || widthRem >= TIME_AFTER_TITLE_REM;
  const label = calendarEventLabel(item, labelView(variant, tier, allDay, titleOnly), { readiness: item.readinessText, recurring: item.recurring, people: item.people, allDay: item.allDay ?? false });
  const classes = ["cal-event", "v-" + variant, "tone-" + item.readiness];
  if (item.readiness === "unsynced") classes.push("dashed");
  if (allDay) classes.push("is-bar");
  if (variant === "week") classes.push("tier-" + tier);
  if (titleOnly) classes.push("is-narrow");
  if (item.endMs < now && !allDay) classes.push("is-past");
  if (continuesBefore) classes.push("cont-before");
  if (continuesAfter) classes.push("cont-after");
  if (busy) classes.push("is-busy");
  if (className) classes.push(className);
  const repeat = item.recurring && <Repeat className="cal-ev-repeat" size={11} aria-hidden />;
  const range = `${timeText(item.startMs)} – ${timeText(item.endMs)}`;
  let content;
  if (allDay) content = <><span className="cal-ev-title">{item.title}</span>{repeat}</>;
  else if (titleOnly) content = <span className="cal-ev-title">{item.title}</span>;
  else if (variant === "month") content = <><span className="cal-ev-title">{item.title}</span><span className="cal-ev-when">{timeText(item.startMs)}</span>{repeat}</>;
  else if (variant === "drawer") content = <><span className="cal-ev-time">{range}</span><span className="cal-ev-main"><span className="cal-ev-title">{item.title}{repeat}</span><span className={"cal-ev-ready tone-" + item.readiness}>{item.readinessText}</span></span><AvatarStack people={item.people} size="today" /></>;
  else if (tier === "line") content = <><span className="cal-ev-title">{item.title}</span>{timeAfterTitle && <span className="cal-ev-when">{timeText(item.startMs)}</span>}</>;
  else content = <><span className="cal-ev-time">{range}</span><span className="cal-ev-title">{item.title}{repeat}</span>{tier === "full" && <span className="cal-ev-foot"><span className={"cal-ev-ready tone-" + item.readiness}>{item.readinessText}</span><AvatarStack people={item.people} size="week" /></span>}</>;
  return <button type="button" className={classes.join(" ")} style={style} tabIndex={tabIndex} aria-label={label} aria-disabled={busy ? true : undefined} title={titleOnly || (variant === "week" && tier === "line" && !allDay && !timeAfterTitle) ? `${range} ${item.title}` : item.title}
    data-nav={nav?.id} data-col={nav?.col} data-order={nav?.order}
    onClick={() => { if (busy) return; onOpen(item); }}>{content}</button>;
}
