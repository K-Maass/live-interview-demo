import { memo } from "react";
import type { SpeechEvent } from "@live-interview/core";
import { transcriptEntriesOf, transcriptOf } from "../liveStore";
/**
 * One line. Lines are immutable events, so a new line or translation renders only its own row; the other rows of a
 * long meeting are skipped. Off-screen rows also skip layout and paint (`content-visibility` in live.css) while staying
 * in the page, so find-in-page and screen readers still reach the whole transcript.
 */
const TranscriptLine = memo(function TranscriptLine({ entry }: { entry: SpeechEvent }) {
  return <article><div className="transcript-meta"><strong>{entry.lane === "me" ? "Me" : "Remote"}</strong><small>{entry.lane === "me" ? "Microphone" : "System audio"} · {Math.floor(entry.startMs / 60000).toString().padStart(2, "0")}:{Math.floor(entry.startMs / 1000 % 60).toString().padStart(2, "0")} · {entry.language}</small></div><p>{entry.text}</p></article>;
});
export function TranscriptView({ events, english, onEnglish }: { events: SpeechEvent[]; english: boolean; onEnglish: (value: boolean) => void }) {
  const transcript = transcriptOf(events);
  return <div className="transcript-view"><div className="section-heading"><h2>Transcript</h2><div className="segmented-control" role="group" aria-label="Transcript language"><button className={!english ? "selected" : ""} aria-pressed={!english} onClick={() => onEnglish(false)}>Source language</button><button className={english ? "selected" : ""} aria-pressed={english} onClick={() => onEnglish(true)}>English</button></div></div>{english && transcript.status === "pending" && <div className="notice">English translations pending. Source evidence remains saved.</div>}<div className="transcript-entries">{transcriptEntriesOf(events, english).map((entry) => <TranscriptLine key={entry.segmentId} entry={entry} />)}{!events.length && <p className="muted">Your conversation will appear here. Nothing is captured before you start.</p>}</div></div>;
}
