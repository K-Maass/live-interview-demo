import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { CopilotController } from "../useCopilotController";

/** Brief actions as plain decisions, so the card and its tests agree on what can be done. */
export function briefActions(plan: { briefDraft: string; status: string }, account: { canUseAI: boolean } | undefined, busy: boolean) {
  const hasDraft = !!plan.briefDraft.trim();
  return {
    canDraftWithAI: !!account?.canUseAI && !busy,
    needsSubscription: !account?.canUseAI,
    aiLabel: hasDraft ? "Improve with AI" : "Draft with AI",
    canUse: hasDraft && !busy && plan.status !== "prepared",
    inUse: plan.status === "prepared",
  };
}

/** "Needs a subscription · See plans": Draft with AI needs any paid plan. Writing a brief yourself never does. */
export function NeedsSubscription({ onSeePlans }: { onSeePlans: () => void }) {
  return <span className="needs-subscription"><Sparkles size={14} aria-hidden /><span>Draft with AI</span><span aria-hidden> · </span><span>Needs a subscription</span><span aria-hidden> · </span><button type="button" className="link-button" onClick={onSeePlans}>See plans</button></span>;
}

/**
 * The brief editor, opened in place inside the Brief card of the meeting page (it used to be the Brief tab). Context
 * is not edited here: the page's Context card is the only place for it. An AI draft is marked as a draft until it is
 * reviewed and used, so a suggestion is never mistaken for the brief live assistance relies on.
 */
export function PublicPreparationEditor({
  controller: c,
  onClose,
  onSeePlans,
  autoFocus = false,
}: {
  controller: CopilotController;
  onClose: () => void;
  onSeePlans: () => void;
  autoFocus?: boolean;
}) {
  const p = c.publicProduct;
  const plan = p.current;
  const [request, setRequest] = useState("");
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) text.current?.focus({ preventScroll: true }); }, [autoFocus]);
  if (!plan) return <p className="muted">Loading the meeting plan…</p>;
  const busy = p.preparing || p.loading;
  const actions = briefActions(plan, p.account, busy);
  return (
    <div className="brief-editor">
      {/* Asking for a draft sits above the text it changes: focus first, then draft or improve. */}
      {actions.needsSubscription ? <p className="brief-ai-line"><NeedsSubscription onSeePlans={onSeePlans} /></p> : <div className="brief-request">
        <label>
          <span className="visually-hidden">What should the assistant focus on?</span>
          <input
            value={request}
            onChange={(e) => {
              p.invalidatePreparationRequest();
              setRequest(e.target.value);
            }}
            placeholder="Optional focus, e.g. challenge the budget assumptions"
          />
        </label>
        <button type="button" disabled={!actions.canDraftWithAI} onClick={() => void p.prepare(request)}>
          <Sparkles size={16} aria-hidden />
          {p.preparing ? "Preparing…" : actions.aiLabel}
        </button>
      </div>}
      <label className="preparation-writing">
        <span className="visually-hidden">Brief</span>
        <textarea
          ref={text}
          value={plan.briefDraft}
          onChange={(e) => {
            p.edit({
              briefDraft: e.target.value,
              draftEvidence: [],
              reviewedBrief: undefined,
              status: "draft",
            });
            c.setup.setBrief(undefined);
          }}
          placeholder="A brief is optional. Live assistance uses your selected workspace and the conversation. Write your own notes here, or draft them with AI."
        />
      </label>
      {plan.draftEvidence?.length ? (
        <details className="brief-evidence">
          <summary>
            AI draft from {plan.draftEvidence.length} {plan.draftEvidence.length === 1 ? "source" : "sources"} · review before using it
          </summary>
          {plan.draftEvidence.map((id) => (
            <p key={id} className="muted">
              {p.sources.find((s) => s.sourceId === id)?.title || id}
            </p>
          ))}
        </details>
      ) : null}
      <div className="brief-editor-actions">
        <button
          type="button"
          disabled={!actions.canUse}
          onClick={() => {
            c.setup.setBrief({
              text: plan.briefDraft,
              objectives: plan.objectives,
              evidence: plan.draftEvidence || [],
              revision: Date.now(),
            });
            void p.save().catch(() => {});
          }}
        >
          {actions.inUse ? "In use" : "Use this brief"}
        </button>
        <button type="button" className="link-button" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
