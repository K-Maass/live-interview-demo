// DEV only: the meeting page's day panel with fictional meetings, so it can be seen and exercised before the page
// integration (Chunk C). Open http://localhost:<port>/src/copilot/dev/dayPanel.html (Vite dev server).
//   ?width=360       panel width in px (default 360)
//   ?untimed=1       this meeting has no time yet (draw one)
//   ?coverage=missing|partial|loading|none   force the calendar coverage of every day
// It stands in for the page: a direct change is saved at once with an Undo toast; a calendar change opens the review
// card, "Move event" pretends to write for 700 ms. "Simulate changed meanwhile" makes the next confirm fail the version
// check. Nothing is saved anywhere; everything is fictional.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/dm-sans";
import "../copilot.css";
import { MeetingDayPanel } from "../MeetingDayPanel";
import { ActionToast, type ActionNotice } from "../ui";
import type { CoverageState } from "../presentation/accessibility";
import { movability, type DayPanelMeeting, type TimeRange } from "../../lib/public/dayEdit";
import { lengthText } from "../../lib/public/calendarSave";

document.documentElement.style.fontSize = "14px";
const params = new URLSearchParams(location.search);
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (dayMs: number, n: number) => { const d = new Date(dayMs); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const today = startOfDay(Date.now());
// Fixed-hour fixtures go on today in the morning, on tomorrow later in the day, so most of them can still move.
const fixtureDay = new Date().getHours() < 14 ? today : addDays(today, 1);
const at = (day: number, h: number, m = 0) => { const d = new Date(day); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
const work = { appOnly: false, provider: "apple" as const, calendarName: "Work" };

function fixtures(untimed: boolean): DayPanelMeeting[] {
  const D = fixtureDay, now = Date.now();
  const list: DayPanelMeeting[] = [
    { id: "offsite", title: "Company offsite", startMs: D, endMs: addDays(D, 1), allDay: true, isThis: false, movability: movability({ ...work, allDay: true }), eventId: "apple:offsite" },
    { id: "standup", title: "Team standup", startMs: at(D, 9), endMs: at(D, 9, 15), isThis: false, movability: movability({ ...work, recurring: true }), eventId: "apple:standup" },
    { id: "riley", title: "1:1 with Riley", startMs: at(D, 10), endMs: at(D, 10, 30), isThis: false, movability: movability({ ...work, invitation: true }), eventId: "apple:riley", planId: "plan-riley" },
    { id: "client", title: "Client sync with Acme", startMs: at(D, 11), endMs: at(D, 12), isThis: false, movability: movability({ appOnly: false, provider: "google" }), eventId: "google:client" },
    { id: "focus", title: "Focus: write the proposal", startMs: at(D, 13), endMs: at(D, 14, 30), isThis: false, movability: movability({ appOnly: true }), planId: "plan-focus" },
    { id: "team-review", title: "Team review", startMs: at(D, 14), endMs: at(D, 15), isThis: false, movability: movability({ ...work, appCreated: true }), eventId: "apple:team-review", planId: "plan-team" },
    { id: "holidays", title: "Board call (shared calendar)", startMs: at(D, 16), endMs: at(D, 16, 45), isThis: false, movability: movability({ ...work, readOnly: true }), eventId: "apple:board" },
  ];
  if (!untimed) list.push({ id: "this", title: "Design review", startMs: at(D, 14, 30), endMs: at(D, 15, 30), isThis: true, movability: movability({ ...work, appCreated: true }), eventId: "apple:design", planId: "plan-this" });
  // Today also gets meetings around now, so the shaded past and the now line can be tried.
  if (D !== today) {
    const h = new Date(now).getHours();
    if (h >= 2) list.push({ id: "earlier", title: "Earlier check-in", startMs: at(today, h - 2), endMs: at(today, h - 1), isThis: false, movability: movability({ appOnly: true }), planId: "plan-earlier" });
    if (h <= 21) list.push({ id: "evening", title: "Evening call", startMs: at(today, h + 1), endMs: at(today, h + 1, 45), isThis: false, movability: movability({ ...work }), eventId: "apple:evening" });
  }
  return list;
}

function Scene() {
  const [untimed] = useState(params.get("untimed") === "1");
  const [meetings, setMeetings] = useState(() => fixtures(untimed));
  const [thisTimed, setThisTimed] = useState(!untimed);
  const [day, setDay] = useState(fixtureDay);
  const [pending, setPending] = useState<{ meetingId: string; startMs: number; endMs: number }>();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [toast, setToast] = useState<ActionNotice & { undo: { meetingId: string; range: TimeRange } }>();
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [width, setWidth] = useState(Number(params.get("width")) || 360);
  const note = (line: string) => setLog((l) => [new Date().toLocaleTimeString() + "  " + line, ...l].slice(0, 12));
  const byId = (id: string) => meetings.find((m) => m.id === id);
  const forced = params.get("coverage") as CoverageState | null;
  const coverage: CoverageState = forced ?? (Math.abs(day - fixtureDay) > 3 * 86_400_000 ? "missing" : "loaded");
  const shown = meetings.filter((m) => m.startMs < addDays(day, 1) && m.endMs > day);
  const save = (id: string, range: TimeRange) => setMeetings((ms) => ms.map((m) => m.id === id ? { ...m, ...range } : m));

  return <div style={{ display: "flex", gap: 24, alignItems: "flex-start", padding: 24, minHeight: "100vh", background: "var(--shell)" }}>
    <div style={{ width, height: "calc(100vh - 48px)", display: "flex", flexShrink: 0 }}>
      <MeetingDayPanel day={day} meetings={shown} coverage={coverage} pending={pending} confirming={confirming} notice={notice}
        partialAccounts={["Work · Exchange"]} untimedMeetingId={thisTimed ? undefined : "this"}
        onDayChange={(d) => { setDay(d); note("day → " + new Date(d).toDateString()); }}
        onPropose={(id, range) => {
          setNotice(undefined);
          const m = byId(id);
          note(`propose ${m?.title ?? id} → ${new Date(range.startMs).toLocaleTimeString()}–${new Date(range.endMs).toLocaleTimeString()}`);
          if (id === "this" && !thisTimed) {
            setThisTimed(true);
            setMeetings((ms) => [...ms, { id: "this", title: "Design review", ...range, isThis: true, movability: { kind: "direct" }, planId: "plan-this" }]);
            return;
          }
          if (m?.movability.kind === "direct") {
            const before = { startMs: m.startMs, endMs: m.endMs };
            save(id, range);
            setToast({ id: String(Date.now()), text: `Moved “${m.title}”`, detail: lengthText(range.startMs, range.endMs), actionLabel: "Undo", undo: { meetingId: id, range: before } });
          } else setPending({ meetingId: id, ...range });
        }}
        onConfirm={() => {
          if (!pending) return;
          note("confirm");
          setConfirming(true);
          window.setTimeout(() => {
            setConfirming(false);
            const m = byId(pending.meetingId);
            if (changedMeanwhile) {
              setChangedMeanwhile(false);
              if (m) save(m.id, { startMs: m.startMs + 30 * 60_000, endMs: m.endMs + 30 * 60_000 });
              setNotice("The event changed in your calendar. Nothing was changed.");
            } else if (m) {
              const before = { startMs: m.startMs, endMs: m.endMs };
              save(m.id, pending);
              const calendar = m.movability.kind === "review" ? m.movability.calendarName : "calendar";
              setToast({ id: String(Date.now()), text: `Moved in ${calendar} calendar`, detail: m.title, actionLabel: "Undo", undo: { meetingId: m.id, range: before } });
            }
            setPending(undefined);
          }, 700);
        }}
        onCancel={() => { note("cancel"); setPending(undefined); }}
        onOpen={(m) => note("open plan of " + m.title)}
        onRetry={() => note("retry")}
        onConnectCalendar={() => note("connect a calendar")}>
        {thisTimed && (() => { const m = byId("this"); return m ? <div className="muted" style={{ fontSize: ".8125rem" }}>Footer slot: {new Date(m.startMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–{new Date(m.endMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {lengthText(m.startMs, m.endMs)} · In Work calendar</div> : null; })()}
      </MeetingDayPanel>
    </div>
    <aside style={{ fontSize: 13, maxWidth: 380 }} className="dp-scene-controls">
      <h2 style={{ fontSize: 15 }}>Day panel preview (fictional)</h2>
      <p className="muted">Drag any movable meeting (body moves, either edge resizes). Locked ones open on click. Keyboard on a focused meeting: ↑/↓, Shift+↑/↓, Option+↑/↓, Option+←/→, Enter, Esc.</p>
      <div className="buttons" style={{ justifyContent: "flex-start", gap: 8 }}>
        {[260, 300, 360, 440].map((w) => <button key={w} type="button" aria-pressed={w === width} onClick={() => setWidth(w)}>{w}px</button>)}
      </div>
      <p><label className="checkbox" style={{ marginTop: 12 }}><input type="checkbox" checked={changedMeanwhile} onChange={(e) => setChangedMeanwhile(e.target.checked)} />Simulate changed meanwhile on next confirm</label></p>
      <ol style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, paddingLeft: 16 }} data-testid="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
    </aside>
    <div className="toast-stack"><ActionToast notice={toast} onClose={() => setToast(undefined)} onAction={() => {
      if (!toast) return;
      const m = byId(toast.undo.meetingId);
      if (m?.movability.kind === "direct") save(m.id, toast.undo.range);
      else setPending({ meetingId: toast.undo.meetingId, ...toast.undo.range });
    }} /></div>
  </div>;
}

// One root across hot reloads of this module.
const host = window as Window & { __dayPanelRoot?: ReactDOM.Root };
if (import.meta.env.DEV) (host.__dayPanelRoot ??= ReactDOM.createRoot(document.getElementById("root")!)).render(<Scene />);
