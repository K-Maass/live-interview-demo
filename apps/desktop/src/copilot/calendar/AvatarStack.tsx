// Overlapping initials for the people on a meeting (#123). Decorative: the names are read out by the card's label.
//
//   <AvatarStack people={item.people} size="week" />      size: 'week' 20 px | 'month' 18 px | 'today' 24 px
//
// Reuses `Avatar` from ui.tsx unchanged; calendar.css resizes it (fill --fill, text --ink-soft, -2px overlap so initials stay readable, and a 2px
// ring in the colour of the surface behind, set through --ring). `max` avatars show, the rest become "+N".
import { Avatar } from "../ui";

export type AvatarSize = "week" | "month" | "today";

export function AvatarStack({ people, size, max = 3 }: { people: string[]; size: AvatarSize; max?: number }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return <span className={"cal-avatars size-" + size} aria-hidden="true">{shown.map((name) => <Avatar key={name} name={name} />)}{rest > 0 && <span className="cal-avatars-more">+{rest}</span>}</span>;
}
