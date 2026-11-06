import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AssistanceIntent, MeetingRecord } from "@live-interview/core";
export function PilotFeedback({
  record,
  onStatus,
}: {
  record: MeetingRecord;
  onStatus: (s: string) => void;
}) {
  const [intent, setIntent] = useState<AssistanceIntent>("contribute");
  const [notes, setNotes] = useState("");
  const [useful, setUseful] = useState(3);
  const [specific, setSpecific] = useState(3);
  const [value, setValue] = useState(3);
  const [timeliness, setTimeliness] = useState(3);
  const [distraction, setDistraction] = useState(3);
  return (
    <section className="pilot-feedback">
      <h2>Guidance feedback</h2>
      <p className="muted">
        Rate how useful and specific the guidance was. Judge responses by answer quality and contributions by the value they added.
      </p>
      <label>
        Intent
        <select
          value={intent}
          onChange={(e) => setIntent(e.target.value as AssistanceIntent)}
        >
          {[
            "contribute",
            "digDeeper",
            "respond",
            "checkConversation",
            "checkObjectives",
          ].map((i) => (
            <option key={i} value={i}>{{contribute:"Contribute",digDeeper:"Dig deeper",respond:"Respond",checkConversation:"Check conversation",checkObjectives:"Check objectives"}[i as AssistanceIntent]}</option>
          ))}
        </select>
      </label>
      <div className="buttons">
        {[
          ["Usefulness", useful, setUseful],
          ["Conversation specificity", specific, setSpecific],
          ["Timeliness", timeliness, setTimeliness],
          ["Distraction (1 is low)", distraction, setDistraction],
          [
            intent === "respond" ? "Best-answer quality" : "Non-obvious value",
            value,
            setValue,
          ],
        ].map(([label, rating, set]) => (
          <label key={label as string}>
            {label as string}
            <select
              value={rating as number}
              onChange={(e) =>
                (set as (v: number) => void)(Number(e.target.value))
              }
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} out of 5</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label>
        Missed opportunities, repetition, timing or distraction
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button
        onClick={() => {
          const text = JSON.stringify(
            {
              kind: "humanPilotFeedback",
              fixtureMode: record.fixtureMode ?? false,
              intent,
              usefulness: useful,
              specificity: specific,
              timeliness,
              distraction,
              [intent === "respond" ? "answerQuality" : "nonObviousValue"]:
                value,
              notes,
              date: new Date().toISOString(),
            },
            null,
            2,
          );
          void invoke("save_internal_note", {
            meetingId: record.id,
            kind: "pilot",
            text,
          })
            .then(() =>
              onStatus("Pilot feedback saved in the app’s internal note"),
            )
            .catch(() => onStatus("Feedback note changed; review is required"));
        }}
      >
        Save feedback
      </button>
    </section>
  );
}
