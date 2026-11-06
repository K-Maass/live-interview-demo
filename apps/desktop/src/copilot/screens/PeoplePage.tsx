import { useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { CopilotController } from "../useCopilotController";
import { PeoplePicker } from "../PeoplePicker";
import { PageHeading, StubPanel, Avatar, Section, EmptyState, dayText } from "../ui";

export function PeoplePage({ controller: c, openRecord, openPlan }: { controller: CopilotController; openRecord: (id: string) => void; openPlan: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  if (!c.publicProduct.enabled) return <div className="screen-frame"><PageHeading title="People" subtitle="Reuse exact identities or add attendees to your meeting setup." /><div className="page-body people-page"><PeoplePicker reuseExpanded value={c.setup.participants} onChange={c.setup.setParticipants} model={c.people} /><StubPanel title="Person profiles" /></div></div>;
  const people = [...new Map([...c.people.known, ...c.publicProduct.plans.flatMap(p => p.attendees), ...c.records.flatMap(r => r.attendees), ...c.setup.participants].map(p => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name));
  // A person is an exact identity, never a name match: two saved "Alex Morgan"s keep separate histories.
  const meetingsWith = (id: string) => c.records.filter((r) => r.attendees.some((p) => p.id === id));
  const plansWith = (id: string) => c.publicProduct.plans.filter((p) => p.status !== "cancelled" && p.attendees.some((a) => a.id === id));
  const sameName = (name: string) => people.filter((p) => p.name === name).length > 1;
  const person = people.find(p => p.id === selected);
  const shown = people.filter(p => p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const assigned = !!person && c.setup.participants.some(p => p.id === person.id);
  return <div className="screen-frame"><PageHeading title="People" subtitle="Everyone you have met or planned to meet, with your meetings together." />
    <div className="page-body public-people">
      <div className="people-list">
        <label className="search-field"><Search size={16} aria-hidden /><span className="visually-hidden">Find a person</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a person" /></label>
        {shown.map(p => { const count = meetingsWith(p.id).length; return <button className={selected === p.id ? "public-person selected" : "public-person"} aria-current={selected === p.id ? "true" : undefined} key={p.id} onClick={() => setSelected(p.id)}><Avatar name={p.name} /><span>{p.name}<small>{count ? `${count} meeting${count === 1 ? "" : "s"}` : "No saved meetings yet"}{sameName(p.name) ? " · ID " + p.id.slice(0, 8) : ""}</small></span></button>; })}
        {!people.length && <p className="muted">Names saved in meeting plans and records appear here.</p>}
        {!!people.length && !shown.length && <p className="muted">Nobody matches “{query.trim()}”.</p>}
      </div>
      <div className="person-detail">{person ? <>
        <header className="person-heading"><Avatar name={person.name} /><div><h2>{person.name}</h2>{sameName(person.name) && <small className="muted">Identity {person.id}</small>}</div><button disabled={!!c.activeMeeting || !c.publicProduct.current || assigned} onClick={() => c.setup.setParticipants([...c.setup.participants, person as typeof c.setup.participants[number]])}>{assigned ? "In the open meeting" : "Add to open meeting"}</button></header>
        <Section title="Coming up">{plansWith(person.id).length ? plansWith(person.id).map(plan => <button className="agenda-row" key={plan.id} disabled={!!c.activeMeeting} onClick={() => openPlan(plan.id)}><span className="agenda-time">{plan.startMs ? dayText(plan.startMs) : "Draft"}</span><span className="agenda-title">{plan.title || "Untitled meeting"}</span><ArrowRight size={16} aria-hidden /></button>) : <p className="muted">No planned meetings with {person.name}.</p>}</Section>
        <Section title="Past meetings">{meetingsWith(person.id).length ? meetingsWith(person.id).map(r => <button className="agenda-row" key={r.id} disabled={!!c.activeMeeting} onClick={() => openRecord(r.id)}><span className="agenda-time">{dayText(r.date)}</span><span className="agenda-title">{r.purpose}</span><ArrowRight size={16} aria-hidden /></button>) : <p className="muted">No saved meetings with {person.name} yet.</p>}</Section>
        <p className="muted">Attendees are listed by the identity you chose. Voices and quotations are never assigned to a person automatically.</p>
      </> : <EmptyState title="Select a person">See your past and planned meetings with them. Add new people from a meeting’s plan.</EmptyState>}</div>
    </div>
  </div>;
}
