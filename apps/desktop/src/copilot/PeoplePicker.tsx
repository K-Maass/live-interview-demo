import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MeetingOptions, PersonId } from "@live-interview/core";
import { UserPlus, X } from "lucide-react";
import { Avatar } from "./ui";
type Person = MeetingOptions["attendees"][number];

/**
 * Suggestions for what was typed: saved people first (an identity, matched on the name only to find it), then always
 * "Add ‘Sam’ as a new person". Picking a saved person reuses that exact identity; nothing is ever merged by name, so
 * two people called Sam stay two people and the new-person option is offered even when a saved name matches.
 */
export function peopleSuggestions(known: Person[], selected: Person[], text: string, limit = 6) {
  const query = text.trim().toLocaleLowerCase();
  const existing = known.filter((p) => !selected.some((s) => s.id === p.id) && (!query || p.name.toLocaleLowerCase().includes(query))).slice(0, limit);
  return { existing, newName: text.trim() };
}

/**
 * The name shown for a person. Two different people with the same name are told apart by a number in the order they
 * appear in `people` ("Alex Morgan (2)"); an internal ID is never shown.
 */
export function personLabel(person: Person, people: Person[]): string {
  const sameName = people.filter((p, i) => p.name === person.name && people.findIndex((q) => q.id === p.id) === i);
  if (sameName.length < 2) return person.name;
  const index = sameName.findIndex((p) => p.id === person.id);
  return index < 0 ? person.name : `${person.name} (${index + 1})`;
}

/**
 * One field for the people in a meeting: the chosen people are avatar-and-name entries inside it and typing shows suggestions.
 * Enter adds what was typed as a new person unless a suggestion was chosen with the arrow keys; Backspace in the empty
 * field removes the last person; Escape closes the suggestions. `reuseExpanded` (People page) lists every saved person
 * below the field instead of in a popup.
 */
export function PeoplePicker({
  value,
  onChange,
  model,
  reuseExpanded = false,
}: {
  value: Person[];
  onChange: (p: Person[]) => void;
  reuseExpanded?: boolean;
  model?: { known: Person[]; name: string; setName: (name: string) => void };
}) {
  const [localKnown, setKnown] = useState<Person[]>([]);
  const [localName, setLocalName] = useState("");
  const known = model?.known ?? localKnown;
  const name = model?.name ?? localName;
  const setName = model?.setName ?? setLocalName;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (model) return;
    void invoke<Person[]>("list_people")
      .then(setKnown)
      .catch(() => {});
  }, [model]);
  const { existing, newName } = peopleSuggestions(known, value, name, reuseExpanded ? 50 : 6);
  // Options in order: saved people, then the new person (when something is typed).
  const options: ({ kind: "existing"; person: Person } | { kind: "new"; name: string })[] = [...existing.map((person) => ({ kind: "existing" as const, person })), ...(newName ? [{ kind: "new" as const, name: newName }] : [])];
  const showList = !reuseExpanded && open && options.length > 0;
  // Saved people first, so a person keeps the same number wherever they appear.
  const label = (p: Person) => personLabel(p, [...known, ...value]);
  const add = (person: Person) => { onChange([...value, person]); setName(""); setActive(-1); input.current?.focus(); };
  const pick = (index: number) => {
    const option = options[index];
    if (!option) return;
    add(option.kind === "existing" ? option.person : { id: crypto.randomUUID() as PersonId, name: option.name });
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && options.length) { event.preventDefault(); setOpen(true); setActive((a) => (a + 1) % options.length); }
    else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); setOpen(true); setActive((a) => (a <= 0 ? options.length - 1 : a - 1)); }
    else if (event.key === "Enter") {
      // Without an explicit choice Enter adds a new person: a saved identity is reused only when it was picked.
      event.preventDefault();
      if (active >= 0 && showList) pick(active);
      else if (newName) pick(options.length - 1);
    } else if (event.key === "Escape" && showList) { event.stopPropagation(); setOpen(false); setActive(-1); }
    else if (event.key === "Backspace" && !name && value.length) onChange(value.slice(0, -1));
  };
  const listId = id + "-list";
  const optionId = (i: number) => id + "-option-" + i;
  return (
    <div className={"people-picker" + (reuseExpanded ? " roster-list" : "")}>
      <div className="people-combo">
      <div className="people-field" onClick={(e) => { if (e.target === e.currentTarget) input.current?.focus(); }}>
        {value.map((p) => <span className="person-entry" key={p.id}>
          <Avatar name={p.name} />
          <span className="person-entry-name">{label(p)}</span>
          <button type="button" className="icon-button person-entry-remove" aria-label={"Remove person " + label(p)} onClick={() => { onChange(value.filter((v) => v.id !== p.id)); input.current?.focus(); }}><X size={13} aria-hidden /></button>
        </span>)}
        <input
          ref={input}
          className="people-input"
          value={name}
          role="combobox"
          aria-label="Add a person"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={reuseExpanded ? undefined : listId}
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          onChange={(e) => { setName(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); setActive(-1); }}
          onKeyDown={key}
          placeholder={value.length ? "Add person…" : "Add people by name"}
        />
      </div>
      {showList && <ul className="people-suggestions" role="listbox" id={listId} aria-label="People suggestions">
        {options.map((option, i) => <li key={option.kind === "existing" ? option.person.id : "new"} id={optionId(i)} role="option" aria-selected={i === active}
          className={"people-option" + (i === active ? " is-active" : "") + (option.kind === "new" ? " is-new" : "")}
          // Keep focus in the field: the choice happens on mouse down, before the field would blur.
          onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setActive(i)}>
          {option.kind === "existing"
            ? <><Avatar name={option.person.name} /><span className="people-option-name">{label(option.person)}</span><small>Saved person</small></>
            : <><span className="avatar new-person" aria-hidden><UserPlus size={15} /></span><span className="people-option-name">Add “{option.name}” as a new person</span>{active < 0 && <kbd>↵</kbd>}</>}
        </li>)}
      </ul>}
      </div>
      {reuseExpanded && <div className="reuse-person-options">
        <h3>Saved people</h3>
        {existing.map((p) => <button type="button" key={p.id} onClick={() => add(p)}><Avatar name={p.name} />{label(p)}<small>Add to meeting</small></button>)}
        {!existing.length && <p className="muted">No matching saved identity.</p>}
      </div>}
      <p className="muted people-note">
        Picking a saved person keeps the same person reference. Attendees do not assign voices or quotes.
      </p>
    </div>
  );
}
