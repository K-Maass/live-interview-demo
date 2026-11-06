// One meeting on the Today spine (#123): an <article> with a stretched title button.
//
//   <TodayCard item now busy selected? onOpen onPick defaultPeopleOpen? />
//
//   row 1   time range, recurring glyph, title: together the "open" button (`today-card-open`). Its ::after stretches over
//           the whole card (stretched-link pattern), so a click anywhere selects or opens the meeting.
//   row 2   up to three avatars, up to two names as text, a "People" toggle (names only: no invitation responses and no
//           place exist in the data), readiness as coloured text on the right, and a separate Join button.
//   People and Join sit above the stretched button (position: relative; z-index: 1) and never trigger it.
//
// Click selects the meeting for the details panel (`onPick`, which opens it straight away when no panel is shown);
// Enter and double-click open the plan (`onOpen`). While a live meeting runs (`busy`) the card stays readable and the
// buttons carry aria-disabled="true". App-only plan rows get a dashed outline and read "Only in this app".
import { useId, useState } from "react";
import { ChevronDown, Repeat } from "lucide-react";
import { timeText } from "../ui";
import { calendarEventLabel } from "../presentation/accessibility";
import { AvatarStack } from "./AvatarStack";
import { JoinButton } from "./JoinButton";
import type { CalendarItem } from "./model";

export interface TodayCardProps {
  item: CalendarItem;
  now: number;
  busy: boolean;
  /** The meeting shown in the details panel beside Today. */
  selected?: boolean;
  onOpen(item: CalendarItem): void;
  onPick(item: CalendarItem): void;
  /** Start with the People list expanded (tests; the toggle is local state). */
  defaultPeopleOpen?: boolean;
}

/** "Alex Morgan, Sam Lee" or "Alex Morgan, Sam Lee and 3 more": the first two names as text. */
export function namesText(people: string[]): string {
  const shown = people.slice(0, 2).join(", ");
  const rest = people.length - 2;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

export function TodayCard({ item, now, busy, selected, onOpen, onPick, defaultPeopleOpen = false }: TodayCardProps) {
  const [peopleOpen, setPeopleOpen] = useState(defaultPeopleOpen);
  const listId = useId();
  const label = calendarEventLabel(item, "range", { readiness: item.readinessText, recurring: item.recurring, people: item.people });
  const classes = ["today-card", "tone-" + item.readiness];
  if (item.isPlan) classes.push("dashed");
  if (item.endMs <= now) classes.push("is-past");
  if (selected) classes.push("is-selected");
  if (busy) classes.push("is-busy");
  return <article className={classes.join(" ")}>
    <button type="button" className="today-card-open" aria-label={label} aria-disabled={busy ? true : undefined} aria-current={selected ? true : undefined}
      onClick={() => { if (!busy) onPick(item); }}
      onDoubleClick={() => { if (!busy) onOpen(item); }}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!busy) onOpen(item); } }}>
      <span className="today-card-time">{timeText(item.startMs)} – {timeText(item.endMs)}</span>
      {item.recurring && <Repeat className="today-card-repeat" size={12} aria-hidden />}
      <span className="today-card-title">{item.title}</span>
    </button>
    <div className="today-card-meta">
      {item.people.length > 0 && <>
        <AvatarStack people={item.people} size="today" />
        <span className="today-card-names">{namesText(item.people)}</span>
        <button type="button" className="today-people-toggle" aria-expanded={peopleOpen} aria-controls={listId} onClick={() => setPeopleOpen((open) => !open)}>People<ChevronDown size={13} aria-hidden /></button>
      </>}
      <span className={"today-card-ready tone-" + item.readiness}>{item.readinessText}</span>
      <JoinButton item={item} busy={busy} now={now} />
    </div>
    {peopleOpen && item.people.length > 0 && <ul id={listId} className="today-people-list">{item.people.map((name) => <li key={name}>{name}</li>)}</ul>}
  </article>;
}
