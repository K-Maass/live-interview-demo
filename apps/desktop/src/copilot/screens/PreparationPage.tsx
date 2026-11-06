import { ArrowLeft } from "lucide-react";
import { meetingProfiles } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation } from "../presentation/types";
import { PreparationView } from "../PreparationView";
import { MeetingSetupPage, PreparationPeople } from "./MeetingSetupPage";
import { PageHeading, Section } from "../ui";

/**
 * The Preparation route. In the public edition the brief lives in a card on the meeting page, so this route shows
 * that same page with the brief editor open and scrolled into view. The personal edition keeps its preparation view.
 */
export function PreparationPage({ controller: c, navigate, back }: { controller: CopilotController; navigate: (location: AppLocation) => void; back: () => void }) {
  const s = c.setup;
  if (c.publicProduct.enabled) return <MeetingSetupPage controller={c} navigate={navigate} prepare={() => {}} focusBrief />;
  return <div className="screen-frame"><PageHeading eyebrow={<button onClick={back}><ArrowLeft size={15} /> Meeting plan</button>} title={s.purpose || "New meeting"} subtitle="A brief is optional." /><div className="page-body preparation-page"><PreparationView options={{ id: "preparation", workspaceId: s.workspace, purpose: s.purpose || meetingProfiles[c.profile].label, objectives: s.objectives.split("\n").filter(Boolean), attendees: s.participants, publicResearchTopics: s.publicTopics.split(/[,;\n]/).map((topic) => topic.trim()).filter(Boolean), profileId: c.profile, profileRevision: 0 }} onFinalise={s.setBrief} onStatus={c.setAssistanceStatus} workspaceName={c.workspaces.find((w) => w.id === s.workspace)?.root.split("/").at(-1) ?? "Conversation only"} onKnowledge={() => navigate({ kind: "knowledge" })} sidePanel={<><Section title="Objectives">{s.objectives.split("\n").filter(Boolean).length ? <ul className="objective-list">{s.objectives.split("\n").filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}</ul> : <p className="muted">No objectives yet.</p>}</Section><Section title="People"><PreparationPeople controller={c} /></Section><button className="link-button" onClick={back}>Edit the plan</button></>} /></div></div>;
}
