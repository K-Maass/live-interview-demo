// The one notice above Today, Week and Month when there is no calendar to read (see connection.ts). Presentational.
//
//   <CalendarSetupNotice connection={connection} onConnect onChooseCalendars onOpenPrivacy onCheckAgain />
//
//   none         "No calendar connected"      one action: Connect a calendar (Settings → Calendars)
//   accessOff    "Calendar access is off"     Open Privacy Settings, then Check again
//   noCalendars  "No calendars chosen"        Choose calendars (Settings → Calendars)
//   checking, failed, ok                     nothing: checking is quiet, a failed load is the view's status line
//
// The views keep their days plain ('none' coverage) while this is shown, so the same problem is never said twice.
import { CalendarCog, CalendarOff, CalendarPlus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { CalendarConnection } from "./connection";

export interface CalendarSetupNoticeProps {
  connection: CalendarConnection;
  onConnect(): void;
  onChooseCalendars(): void;
  onOpenPrivacy(): void;
  onCheckAgain(): void;
  checking?: boolean;
}

export function CalendarSetupNotice({ connection, onConnect, onChooseCalendars, onOpenPrivacy, onCheckAgain, checking }: CalendarSetupNoticeProps) {
  const body = (icon: LucideIcon, title: string, text: string, actions: ReactNode) => {
    const Icon = icon;
    return <section className="calendar-setup" role="group" aria-label={title}>
      <Icon className="calendar-setup-icon" size={20} strokeWidth={1.75} aria-hidden />
      <div className="calendar-setup-text">
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      <div className="calendar-setup-actions">{actions}</div>
    </section>;
  };
  if (connection.kind === "none") return body(CalendarPlus, "No calendar connected", "Connect a calendar to see your meetings here.",
    <button type="button" className="primary" onClick={onConnect}>Connect a calendar</button>);
  if (connection.kind === "accessOff") return body(CalendarOff, "Calendar access is off",
    "macOS isn’t letting Live Interview read your calendars. Turn on Live Interview in System Settings → Privacy & Security → Calendars, then check again.",
    <><button type="button" className="primary" onClick={onOpenPrivacy}>Open Privacy Settings</button><button type="button" onClick={onCheckAgain} disabled={checking}>Check again</button></>);
  if (connection.kind === "noCalendars") return body(CalendarCog, "No calendars chosen",
    `${connection.accounts.join(", ")} ${connection.accounts.length === 1 ? "is" : "are"} connected, but no calendar is chosen to show here.`,
    <button type="button" className="primary" onClick={onChooseCalendars}>Choose calendars</button>);
  return null;
}
