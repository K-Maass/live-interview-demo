import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pickActionTarget } from "../lib/public/pickTarget";
import { approveAndApply } from "../lib/public/applyFlow";
import {
  makeCalendarProposal,
  type ActionProposal,
} from "@live-interview/core";
import { CalendarConfirmSheet } from "./CalendarConfirmSheet";
import { calendarChangeSummary, calendarLabel, icsSaveFailure } from "../lib/public/calendarSave";
interface CalendarCapability {
  id: string;
  name: string;
  account: string;
  read: boolean;
  add: boolean;
  edit: boolean;
}
export function CalendarChangeReview({
  onStatus,
  onEvents,
  onCoverage,
}: {
  onStatus: (s: string) => void;
  onEvents: (
    events: { id: string; title: string; startMs: number; endMs: number }[],
  ) => void;
  onCoverage?: (range: { startMs: number; endMs: number }) => void;
}) {
  const [capabilities, setCapabilities] = useState<CalendarCapability[]>([]);
  const [calendar, setCalendar] = useState("");
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [proposal, setProposal] = useState<ActionProposal>();
  const [editable, setEditable] = useState<
    {
      id: string;
      calendarId: string;
      title: string;
      startMs: number;
      endMs: number;
    }[]
  >([]);
  const [editing, setEditing] = useState<string>("");
  async function connect() {
    try {
      const startMs = Date.now();
      const endMs = Date.now() + 604800000;
      const result = await invoke<{
        capabilities: CalendarCapability[];
        events: Parameters<typeof onEvents>[0];
      }>("read_upcoming_meetings", {
        startMs,
        endMs,
        requestPermission: true,
      });
      setCapabilities(result.capabilities || []);
      onEvents(result.events || []);
      onCoverage?.({ startMs, endMs });
      setEditable((result.events || []) as typeof editable);
      onStatus(
        result.capabilities?.length
          ? "Local calendar access connected"
          : "Calendar setup is unavailable. A reviewed ICS draft can be used separately.",
      );
    } catch {
      onStatus("Calendar access needs setup; no calendar was changed");
    }
  }
  async function prepare() {
    try {
      const change = {
        calendarId: calendar,
        eventId: editing || undefined,
        originalStartMs: editable.find((e) => e.id === editing)?.startMs,
        title,
        startMs: new Date(start).getTime(),
        endMs: new Date(end).getTime(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        inferred: true,
      };
      setProposal(
        await invoke<ActionProposal>("prepare_calendar_change", { change }),
      );
    } catch {
      onStatus("Calendar proposal could not be prepared");
    }
  }
  return (
    <section>
      <div className="section-heading">
        <h2>Calendar context and reviewed changes</h2>
        <button onClick={() => void connect()}>Connect local calendars</button>
      </div>
      <p className="muted">
        Read/add/edit capabilities are verified separately. Work-calendar desktop
        automation requires verification on each device. No change
        applies before your review.
      </p>
      <div className="calendar-capabilities">{capabilities.map((capability) => <p key={capability.id}><strong>{capability.account} · {capability.name}</strong><span>{capability.read ? "Read available" : "Read unavailable"} · {capability.add ? "Add available" : "Add unavailable"} · {capability.edit ? "Edit available" : "Edit unavailable"}</span></p>)}</div>
      <div className="calendar-revision-layout"><div className="calendar-draft">
        {!!editable.length && (
          <label>
            Existing event to edit
            <select
              value={editing}
              onChange={(e) => {
                const event = editable.find((v) => v.id === e.target.value);
                setEditing(e.target.value);
                if (event) {
                  setCalendar(event.calendarId);
                  setTitle(event.title);
                  const local = (ms: number) =>
                    new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
                      .toISOString()
                      .slice(0, 16);
                  setStart(local(event.startMs));
                  setEnd(local(event.endMs));
                }
              }}
            >
              <option value="">New event</option>
              {editable.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title} · {new Date(event.startMs).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Target calendar
          <select
            value={calendar}
            onChange={(e) => setCalendar(e.target.value)}
          >
            <option value="">Choose an account/calendar</option>
            {capabilities
              .filter((c) => c.add)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.account} · {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Event title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="buttons">
          <label>
            Start
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            End
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button
            disabled={!calendar || !title || !start || !end}
            onClick={() => void prepare()}
          >
            Prepare change for review
          </button>
          <button
            disabled={!title || !start || !end}
            onClick={() => {
              void (async () => {
                const draft = makeCalendarProposal({
                  id: crypto.randomUUID(),
                  title,
                  start: new Date(start).toISOString(),
                  end: new Date(end).toISOString(),
                  inferred: true,
                });
                const path = await pickActionTarget(
                  { kind: "icsFile", defaultName: "meeting-draft.ics" },
                  onStatus,
                );
                if (path)
                  setProposal(
                    await invoke<ActionProposal>("propose_action", {
                      targetPath: path,
                      operation: "rewrite",
                      content: draft.after,
                    }),
                  );
              })().catch(() =>
                onStatus("Calendar draft could not be prepared"),
              );
            }}
          >
            Prepare reviewed ICS file…
          </button>
        </div>
      </div>
      {proposal && (() => {
        const isCalendar = proposal.targetPath.startsWith("calendar:");
        const target = capabilities.find((c) => c.id === proposal.targetId);
        const read = (text: string) => { try { const v = JSON.parse(text); return typeof v?.title === "string" && typeof v?.startMs === "number" && typeof v?.endMs === "number" ? { title: v.title as string, startMs: v.startMs as number, endMs: v.endMs as number } : undefined; } catch { return undefined; } };
        const after = isCalendar ? read(proposal.after) : undefined;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const summary = after
          ? calendarChangeSummary({ after, before: read(proposal.before), calendar: target ? calendarLabel(target) : "your calendar", timeZone })
          : { heading: "Save calendar file", lines: [`Save “${title}” to ${proposal.targetPath.split("/").at(-1)}`, "Open the file afterwards to add it to any calendar."] };
        return <CalendarConfirmSheet
          heading={summary.heading}
          lines={summary.lines}
          confirmLabel={isCalendar ? (proposal.operation === "calendarEdit" ? "Update event" : "Add to calendar") : "Save file"}
          onConfirm={() => {
            void approveAndApply(invoke, proposal.id, isCalendar ? "apply_calendar_change" : "apply_action")
              .then((result) => {
                // Undefined: an earlier click saved it (or is saving it) and reports it.
                if (result !== undefined) onStatus(isCalendar ? "Reviewed calendar event saved and read back" : "Reviewed ICS file saved; calendar import remains your separate choice");
                setProposal(undefined);
              })
              .catch((error) => {
                // A calendar failure is final. A file failure wrote nothing; it stays to save again only when it is back in review.
                if (isCalendar) { onStatus("Calendar changed or apply failed; no completed action is claimed"); setProposal(undefined); return; }
                const failure = icsSaveFailure(error);
                onStatus(failure.message);
                if (!failure.retry) setProposal(undefined);
              });
          }}
          onCancel={() => { void invoke("decline_action", { proposalId: proposal.id }); setProposal(undefined); }}
        />;
      })()}
      </div>
    </section>
  );
}
