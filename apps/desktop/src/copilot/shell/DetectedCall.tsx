import type { CopilotController } from "../useCopilotController";
export function DetectedCall({ controller: c }: { controller: CopilotController }) {
  if (c.activeMeeting || (!c.entry.callOffer && !c.entry.callChoices.length)) return null;
  return <aside className="detected-call notice" aria-label="Detected call">
    {c.entry.callOffer && <><p>Detected call: <strong>{c.entry.callOffer.title}</strong></p><button onClick={() => c.entry.acceptCall(c.entry.callOffer!, "offer")}>Accept unprepared call</button></>}
    {!!c.entry.callChoices.length && <><p>Choose the detected meeting context:</p><div className="buttons">{c.entry.callChoices.map((choice, index) => <button key={index} onClick={() => c.entry.acceptCall(choice, "choices")}>Start: {choice.title}</button>)}</div></>}
  </aside>;
}
