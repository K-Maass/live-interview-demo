import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pin, X, FileText } from "lucide-react";
import { asOfText, cardActionLabel } from "./presentation/accessibility";
import {
  meetingProfiles,
  type AssistanceIntent,
  type LiveViewState,
  effectiveContext,
  assembleTranscripts,
  visibleCards,
  openPins,
  settledPins,
  type PinOutcome,
} from "@live-interview/core";
export const intents: { id: AssistanceIntent; label: string; key: string }[] = [
  { id: "digDeeper", label: "Dig deeper", key: "⌘⌥1" },
  { id: "respond", label: "Help me respond", key: "⌘⌥2" },
  { id: "contribute", label: "Help me contribute", key: "⌘⌥3" },
  { id: "checkConversation", label: "Check conversation", key: "⌘⌥4" },
  { id: "checkObjectives", label: "Check objectives", key: "⌘⌥5" },
];
import { shortcutText } from "../lib/copilot/shortcuts";
export { shortcutText };
const cardTitle = (card: { headline?: string; intent: AssistanceIntent }) => card.headline || intents.find((intent) => intent.id === card.intent)?.label || "Suggestion";
const outcomeText: Record<PinOutcome, string> = { answered: "Answered", outdated: "Outdated" };
/** Plain text buttons for a person's decision on a pin. No live-region announcement: screen readers hear guidance headlines only. */
const PinOutcomeActions = ({ title, onSettle }: { title: string; onSettle: (outcome: PinOutcome) => void }) => <>{(["answered", "outdated"] as const).map((outcome) => <button key={outcome} className="evidence-action pin-outcome-action" aria-label={cardActionLabel(outcome, title)} onClick={() => onSettle(outcome)}>{outcomeText[outcome]}</button>)}</>;
export function LivePanel({
  view,
  onRequest,
  onPin,
  onDismiss,
  assistancePaused,
  onTogglePause,
  profile,
  onExpand,
  onCovered,
  onSettle = () => {},
  onReopen = () => {},
  reminders = [],
  shortcuts,
  objectives = [],
  conversation,
}: {
  view: LiveViewState;
  onExpand: (id: string) => void;
  onCovered: (id: string) => void;
  /** A person marks a pinned topic answered or outdated; it leaves the active cards for the Done list. */
  onSettle?: (id: string, outcome: PinOutcome) => void;
  onReopen?: (id: string) => void;
  reminders?: { cardId: string; text: string; reason: string }[];
  shortcuts: Record<AssistanceIntent, string>;
  objectives?: string[];
  /** The live transcript feed, shown first in the side rail so the conversation stays in view. */
  conversation?: ReactNode;
  onRequest: (intent: AssistanceIntent) => void;
  onPin: (id: string) => void;
  onDismiss: (id: string) => void;
  assistancePaused: boolean;
  onTogglePause: () => void;
  profile: keyof typeof meetingProfiles;
}) {
  const [selected, setSelected] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const expandAction = useRef(onExpand); expandAction.current = onExpand;
  const evidenceClose = useRef<HTMLButtonElement>(null);
  const cards = visibleCards(view);
  // While a draft is showing, the "reasoning pending" placeholder would only repeat it as a second, generic line.
  // Cards keep their order when pinned: moving the pinned card to the top put a different card under the pointer.
  const listed = view.draft ? cards.filter((c) => !(c.origin === "clarification" && c.provisional)) : cards;
  const detail = cards.find((c) => c.id === view.detailCardId);
  const open = openPins(view.savedPins), done = settledPins(view.savedPins);
  // The settled card leaves the list, so keyboard focus moves to its neighbour, or to the Done list it joined.
  const settleCard = (id: string, outcome: PinOutcome) => {
    const ids = listed.map((c) => c.id), at = ids.indexOf(id), neighbour = at < 0 ? undefined : ids[at + 1] ?? ids[at - 1];
    onSettle(id, outcome);
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(neighbour ? `[data-card-id="${CSS.escape(neighbour)}"]` : ".pins-done summary") ?? document.querySelector<HTMLElement>(".pins-done summary"))?.focus());
  };
  useEffect(() => {
    if (!detail) return;
    evidenceClose.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.altKey && !event.metaKey && !event.ctrlKey) {
        expandAction.current(detail.id);
        requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); });
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail?.id]);
  return <section aria-label="Live assistance" className={"live-assistance " + (detail ? "with-evidence" : "")}>
    <div className="assistance-toolbar"><span className="assistance-state"><span className={"status-dot " + (assistancePaused ? "paused" : "active")} />{assistancePaused ? "Assistance paused" : "Assistance active"}</span><div className="intent-bar" role="group" aria-label="Request help">{intents.map((i) => <button key={i.id} onClick={() => onRequest(i.id)} title={"Shortcut " + shortcutText(shortcuts[i.id])}><span>{i.label}</span><kbd>{shortcutText(shortcuts[i.id])}</kbd></button>)}</div><button className="link-button" onClick={onTogglePause}>{assistancePaused ? "Resume assistance" : "Pause assistance"}</button></div>
    <div className="live-layout"><div className="guidance-reading"><h2 className="visually-hidden">Suggestions</h2>{reminders.map((r) => <div className="saved-reminder" key={r.cardId}><small><Pin size={13} fill="currentColor" aria-hidden />{r.reason === "nearEnd" ? "Pinned · before the meeting ends" : "Pinned · related to now"}</small><p>{r.text}</p><button className="icon-button reminder-dismiss" aria-label={"Mark as covered: " + r.text} title="Mark as covered" onClick={() => onCovered(r.cardId)}><X size={14} /></button></div>)}<div className="guidance-list">{view.draft && <article className="guidance-object guidance-draft" aria-busy="true" aria-label="Draft guidance">
        <div className="guidance-copy"><small className="guidance-condition">Draft · still being checked</small><p className="say">{view.draft.text}</p></div>
      </article>}{listed.map((c, i) => {
      const source = c.evidence.length ? effectiveContext(c.basis).sources.find((s) => s.sourceId === c.evidence[0])?.title ?? "Conversation" : "No supporting source";
      return <article className="guidance-object" key={c.id} tabIndex={0} data-card-id={c.id} data-pinned={c.pinned} data-selected={selected === c.id || detail?.id === c.id} onPointerDown={() => setSelected(c.id)} aria-labelledby={"guidance-title-" + c.id}>
        <span className="guidance-number">{i + 1}.</span><div className="guidance-copy"><div className="guidance-title-line"><h3 id={"guidance-title-" + c.id}>{c.pinned && <Pin size={18} className="pin-state" fill="currentColor" role="img" aria-label="Pinned" />}{cardTitle(c)}</h3><div className="guidance-actions"><button className="icon-button" aria-label={cardActionLabel("pin", cardTitle(c))} aria-pressed={c.pinned} title={c.pinned ? "Pinned" : "Pin suggestion"} onClick={() => onPin(c.id)}><Pin size={17} fill={c.pinned ? "currentColor" : "none"} /></button>{c.pinned && <PinOutcomeActions title={cardTitle(c)} onSettle={(outcome) => settleCard(c.id, outcome)} />}<button className="icon-button" aria-label={cardActionLabel("dismiss", cardTitle(c))} title="Dismiss suggestion" onClick={() => onDismiss(c.id)}><X size={18} /></button><button className="evidence-action" aria-expanded={detail?.id === c.id} aria-label={(detail?.id === c.id ? "Hide details: " : "Why / evidence: ") + cardTitle(c)} onClick={(event) => { opener.current = event.currentTarget; onExpand(c.id); }}><FileText size={16} />{detail?.id === c.id ? "Hide details" : "Why / evidence"}</button></div></div>
        {(c.origin === "clarification" || c.uncertain || c.provisional || c.stale || c.asOfMs !== undefined || (c.pinned && c.outdatedSuggested)) && <small className="guidance-condition">{[c.origin === "clarification" ? "Clarification" : c.uncertain ? "Inferred" : "", c.provisional ? "reasoning pending" : "", c.stale ? "earlier context" : "", c.asOfMs !== undefined ? asOfText(c.asOfMs) : "", c.pinned && c.outdatedSuggested ? "may be outdated: a cited source changed" : ""].filter(Boolean).join(" · ")}</small>}
        <p className="say">{c.say}</p><small className="guidance-source">{source}</small></div>
      </article>;
    })}</div>{!cards.length && !view.draft && <div className="live-empty"><h3>Listening for a useful opportunity</h3><p className="muted">Automatic assistance appears when it can advance the conversation. Request help whenever you need it.</p></div>}
    {view.requestedCard && <button className="link-button" onClick={() => onDismiss(view.requestedCard!.id)}>Return to pinned topics</button>}
    {!!view.queued && <p className="muted queue-status">{view.queued} updates kept quiet while pins protect your cards.</p>}
    </div><aside className="live-rail">{conversation && <div className="rail-conversation">{conversation}</div>}<div><h3>Meeting focus</h3><p className="muted">{meetingProfiles[profile].label}</p>{objectives.length > 0 && <ul className="objective-list">{objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>}</div><div><h3>Saved topics ({open.length})</h3>{open.length ? open.map((c) => <details key={c.id}><summary>{c.headline || c.say}</summary><p>{c.say}</p>{c.outdatedSuggested && <p className="muted pin-suggestion">May be outdated: a cited source changed.</p>}<div className="pin-outcome-actions"><PinOutcomeActions title={c.headline || c.say} onSettle={(outcome) => settleCard(c.id, outcome)} /></div></details>) : <p className="muted">{done.length ? "No open pinned topics." : "Pin a suggestion to keep it available."}</p>}{done.length > 0 && <details className="pins-done"><summary>Done ({done.length})</summary><ul>{done.map((c) => <li key={c.id}><span>{c.headline || c.say}</span><small className="muted"> · {outcomeText[c.pinOutcome!]}</small> <button className="link-button" aria-label={cardActionLabel("reopen", c.headline || c.say)} onClick={() => onReopen(c.id)}>Reopen</button></li>)}</ul></details>}</div></aside></div>
    {detail && <aside className="guidance-drawer" role="dialog" aria-label="Why this suggestion"><div className="drawer-heading"><h2>Why this suggestion</h2><button ref={evidenceClose} className="icon-button" aria-label="Close evidence" onClick={() => { onExpand(detail.id); requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus()); }}><X size={20} /></button></div><h3>Why this matters</h3><p>{detail.why}</p>{detail.uncertain && <div className="notice"><strong>Interpretation / uncertainty</strong><p>Assess this suggestion against the cited evidence.</p></div>}<h3>Supporting evidence</h3>{detail.evidence.length ? detail.evidence.map((id) => {
      const context = effectiveContext(detail.basis); const source = context.sources.find((s) => s.sourceId === id); const segment = context.conversation.find((s) => "segment:" + s.segmentId === id);
      const translation = segment && assembleTranscripts(context.conversation).english.find((entry) => entry.sourceSegmentId === segment.segmentId);
      return <blockquote key={id}><small>{source ? source.title + " · " + source.locator + (source.derived ? " · derived" : "") : segment ? (segment.lane === "me" ? "Me" : "Remote") + " · " + Math.round(segment.startMs / 1000) + "s · " + segment.language : "Unavailable evidence"}</small><p>{source?.text ?? segment?.text ?? id}</p>{segment && segment.language !== "en" && <div className="evidence-translation"><small>English translation</small><p>{translation?.text ?? "Not available in this context snapshot. Source evidence is preserved."}</p></div>}</blockquote>;
    }) : <p className="muted">No supporting evidence is available for this suggestion.</p>}<details className="advanced-details"><summary>Context details</summary><p className="muted">Ready context published at {new Date(detail.basis.snapshot.createdAtMs).toLocaleTimeString()} · {detail.basis.transcriptDeltas.length} newer transcript spans included.</p>{detail.preparedFrom && <p className="muted">Prepared at {new Date(detail.preparedFrom.preparedAtMs).toLocaleTimeString()} · {detail.stale ? "Retained from earlier context" : "Context checked again for this request"}.</p>}</details></aside>}
  </section>;
}
