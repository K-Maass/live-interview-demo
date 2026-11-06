import { ArrowRight } from "lucide-react";
import type { MeetingRecord, PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import type { UpcomingMeeting } from "../presentation/types";
import { meetingWhen } from "../calendar/when";
import { Avatar } from "../ui";

/**
 * The selected calendar meeting, side by side with the agenda. It only reads what is saved: the meeting's plan when
 * one exists plus calendar invitees not on it, otherwise the calendar's own attendee list. Statuses are plain text, never badges.
 */
export function MeetingDetails({ event, plan, calendarEvent, records, workspaceName, onOpen, disabled }: { event: UpcomingMeeting; plan?: PublicMeetingPlan; calendarEvent?: PublicCalendarEvent; records: MeetingRecord[]; workspaceName?: string; onOpen: () => void; disabled?: boolean }) {
  // People are counted by exact identity, never by matching names.
  const meetingsWith = (id: string) => records.filter((r) => r.attendees.some((p) => p.id === id)).length;
  const brief = plan?.reviewedBrief?.text || plan?.briefDraft || "";
  const objectives = plan?.objectives.filter((o) => o.trim()) ?? [];
  const calendarPeople = calendarEvent?.attendees ?? [];
  // With a plan, its people come first; calendar invitees not on the plan follow, so the panel matches the agenda row.
  // This only hides a repeated name in the list; it never links a calendar invitee to a saved identity.
  const planNames = new Set(plan?.attendees.map((p) => p.name.trim().toLocaleLowerCase()) ?? []);
  const invitees = calendarPeople.filter((p) => !planNames.has(p.name.trim().toLocaleLowerCase()));
  return <aside className="meeting-details" aria-label={"Details: " + event.title}>
    <header><h2>{event.title}</h2><p className="muted">{meetingWhen(event)}</p></header>
    <section><h3>Objectives</h3>{objectives.length ? <ul className="detail-objectives">{objectives.map((o, i) => <li key={i}>{o}</li>)}</ul> : <p className="muted">No objectives yet.</p>}</section>
    <section><h3>People</h3>{plan?.attendees.length || invitees.length ? <ul className="detail-people">{plan?.attendees.map((p) => { const count = meetingsWith(p.id); return <li key={p.id}><Avatar name={p.name} /><span>{p.name}</span><small>{count ? `${count} meeting${count === 1 ? "" : "s"}` : "First meeting"}</small></li>; })}{invitees.map((p, i) => <li key={"calendar:" + i}><Avatar name={p.name} /><span>{p.name}</span><small>From calendar</small></li>)}</ul> : <p className="muted">{calendarEvent?.organiser ? "Organised by " + calendarEvent.organiser : "No attendees listed."}</p>}</section>
    <section><h3>Brief</h3>{brief ? <p className="detail-brief">{brief}</p> : <p className="muted">No brief yet.</p>}{plan?.status === "prepared" && <small className="brief-text ready">Brief ready</small>}</section>
    <section><h3>Context</h3><p>{workspaceName || "Conversation only"}</p></section>
    <button disabled={disabled} onClick={onOpen}>Open plan <ArrowRight size={15} /></button>
  </aside>;
}
