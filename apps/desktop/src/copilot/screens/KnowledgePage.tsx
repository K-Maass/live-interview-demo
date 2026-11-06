import type { CopilotController } from "../useCopilotController";
import { PublicKnowledge } from "./PublicKnowledge";
import { WorkspaceSetup } from "../WorkspaceSetup";
import { PageHeading } from "../ui";
export function KnowledgePage({ controller: c }: { controller: CopilotController }) {
  return <div className="screen-frame"><PageHeading title="Knowledge" subtitle="Connected folders provide read-only workspace context." /><div className="page-body">{c.publicProduct.enabled ? <PublicKnowledge controller={c} /> : c.activeMeeting ? <div className="notice">Workspace setup remains available after this meeting ends.</div> : <><WorkspaceSetup presentation="knowledge" value={c.setup.workspace} onChange={c.setup.setWorkspace} onStatus={c.setAssistanceStatus} onWorkspaces={c.setWorkspaces} /></>}</div></div>;
}
