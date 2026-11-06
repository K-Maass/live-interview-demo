import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { GripVertical, ArrowUpRight, ChevronDown, ChevronUp, X, Pin } from "lucide-react";
import { ACTION_ERROR_MS, actualNativeWindow, sendWidgetAction, visibleActionError, type WidgetActionError, type WidgetState } from "./bridge";
import { cardActionLabel } from "../presentation/accessibility";
import type { WidgetAction } from "../presentation/model";
import type { WidgetCard } from "./bridge";
import { ShortcutCheatSheet, useModifierHold } from "../ShortcutCheatSheet";
import { hideAfterStopPrompt } from "./stopReveal";
const outcomeText = { answered: "Answered", outdated: "Outdated" } as const;
/** One widget card. A pinned, saved card offers the same plain Answered / Outdated buttons as the main workspace. */
export function WidgetCardView({ card, selected, onSelect, act }: { card: WidgetCard; selected: boolean; onSelect: () => void; act: (kind: WidgetAction["kind"], cardId?: string) => void }) {
  const title = card.headline || "Suggestion";
  return <article tabIndex={0} aria-labelledby={"widget-card-" + card.id} className="widget-card" data-selected={selected} onPointerDown={onSelect}><div className="widget-card-heading"><h2 id={"widget-card-" + card.id}>{title}</h2>{card.pinned && <Pin size={15} fill="currentColor" className="widget-pin-state" role="img" aria-label="Pinned" />}<div className="widget-card-actions"><button aria-label={cardActionLabel("pin", title)} aria-pressed={card.pinned} title="Pin suggestion" onClick={() => act("pin", card.id)}><Pin size={15} fill={card.pinned ? "currentColor" : "none"} /></button>{card.pinned && card.settleable && (["answered", "outdated"] as const).map((outcome) => <button key={outcome} className="widget-pin-outcome" aria-label={cardActionLabel(outcome, title)} onClick={() => act(outcome, card.id)}>{outcomeText[outcome]}</button>)}<button aria-label={cardActionLabel("dismiss", title)} title="Dismiss suggestion" onClick={() => act("dismiss", card.id)}><X size={16} /></button><button aria-label={cardActionLabel("why", title)} onClick={() => act("evidence", card.id)}>Why</button></div></div><p>{card.say}</p>{(card.stale || card.provisional || card.clarification || card.outdatedSuggested || card.inferred || card.asOf) && <small>{[card.inferred && !card.clarification ? "Inferred" : "", card.clarification ? "Clarification" : card.outdatedSuggested ? "May be outdated: a cited source changed" : card.stale ? "Earlier context" : card.provisional ? "Reasoning pending" : "", card.asOf ?? ""].filter(Boolean).join(" · ")}</small>}<small className="widget-source">{card.sourceHint}</small></article>;
}
export function WidgetApp() {
  const [state, setState] = useState<WidgetState>();
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [opaque, setOpaque] = useState(() => matchMedia("(prefers-reduced-transparency: reduce)").matches);
  const panel = useRef<HTMLDivElement>(null);
  const cheatSheet = useModifierHold(!!state?.active && !!state.shortcuts);
  useEffect(() => {
    document.documentElement.classList.add("widget-document");
    document.title = "Live assistance";
    if (!("__TAURI_INTERNALS__" in window)) return;
    const owner = new URLSearchParams(location.search).get("owner");
    const subscription = listen<WidgetState>("live-widget-state", (event) => {
      if (event.payload?.version !== 1 || (!actualNativeWindow() && owner && event.payload.ownerId !== owner)) return;
      setState(event.payload);
    });
    void subscription.then(() => emit("live-widget-ready", {})).catch(() => {});
    const media = matchMedia("(prefers-reduced-transparency: reduce)");
    const change = () => setOpaque(media.matches);
    media.addEventListener("change", change);
    return () => { document.documentElement.classList.remove("widget-document"); void subscription.then((stop) => stop()).catch(() => {}); media.removeEventListener("change", change); };
  }, []);
  useEffect(() => {
    if (!actualNativeWindow() || !panel.current) return;
    const resize = () => {
      const children = Array.from(panel.current!.children) as HTMLElement[];
      const natural = children.reduce((height, child) => height + (child.classList.contains("widget-recommendations") ? child.scrollHeight : child.offsetHeight), 2);
      const height = Math.max(collapsed ? 62 : 150, Math.min(natural, screen.availHeight * .8));
      void getCurrentWindow().setSize(new LogicalSize(480, Math.ceil(height))).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(panel.current);
    panel.current.querySelectorAll(".widget-card, .widget-heading, .widget-footer, .widget-warning").forEach((card) => observer.observe(card));
    resize(); return () => observer.disconnect();
  }, [collapsed, state, selected, cheatSheet]);
  const [actionError, setActionError] = useState<WidgetActionError>();
  // Cleared by the next action that gets through, by a new meeting, or after ACTION_ERROR_MS.
  const act = (kind: WidgetAction["kind"], cardId?: string) => { if (state) { const meetingId = state.meetingId; void sendWidgetAction(state, kind, cardId).then(() => setActionError(undefined), () => setActionError({ text: "Action could not reach the main workspace. Open it to retry.", meetingId, atMs: Date.now() })); } };
  useEffect(() => {
    if (!actionError) return;
    const timer = window.setTimeout(() => setActionError(undefined), Math.max(0, actionError.atMs + ACTION_ERROR_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [actionError]);
  const shownError = visibleActionError(actionError, state?.meetingId, Date.now());
  const hide = () => { if (actualNativeWindow()) void getCurrentWindow().hide(); else window.close(); };
  // Shown by the main window only for a Stop & save prompt: hide again once it has gone, as the widget was before.
  useEffect(() => { if (actualNativeWindow() && hideAfterStopPrompt(state)) void getCurrentWindow().hide().catch(() => {}); }, [state]);
  return <div role="region" aria-label="Live assistance" className={"widget-panel " + (opaque ? "opaque" : "") + (collapsed ? "collapsed" : "")} ref={panel}>
    <header className="widget-heading" onPointerDown={(event) => { if (actualNativeWindow() && event.button === 0 && !(event.target as Element).closest("button")) { event.preventDefault(); void getCurrentWindow().startDragging().catch(() => {}); } }}><GripVertical size={15} aria-hidden /><strong>Live assistance</strong>{collapsed && state && <span className="widget-mini-status"><span className={"status-dot " + (state.warnings.length ? "unavailable" : state.paused ? "paused" : "active")} />{state.captureLabel}{state.assistancePaused ? " · Assistance paused" : ""}</span>}{collapsed && state?.cards.some((card) => card.pinned) && <span className="widget-pin-count" role="img" aria-label={state.cards.filter((card) => card.pinned).length + " pinned suggestions"}><Pin size={13} />{state.cards.filter((card) => card.pinned).length}</span>}<div className="widget-window-controls"><button aria-label="Open main workspace" title="Open main workspace" onClick={() => act("openMain")}><ArrowUpRight size={17} /></button><button aria-label={collapsed ? "Expand widget" : "Collapse widget"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button><button aria-label="Hide widget" onClick={hide}><X size={17} /></button></div></header>
    {!collapsed && <div className="widget-recommendations">{state?.cards.map((card) => <WidgetCardView key={card.id} card={card} selected={selected === card.id} onSelect={() => setSelected(card.id)} act={act} />)}{!state?.cards.length && <div className="widget-empty">{!state ? "Waiting for the main workspace…" : state.active ? "No current recommendation. Proactive assistance remains available in the main workspace." : "No active meeting."}</div>}</div>}
    <footer className="widget-footer"><span className={"status-dot " + (state?.warnings.length ? "unavailable" : state?.paused ? "paused" : state?.active ? "active" : "")} /><span>{state?.captureLabel ?? "Connecting to main workspace…"}{state?.assistancePaused ? " · Assistance paused" : ""}</span>{collapsed && state?.cards.some((card) => card.pinned) && <span className="widget-pin-count"><Pin size={13} />{state.cards.filter((card) => card.pinned).length}</span>}</footer>
    {state?.stopPrompt && <div className="widget-stop-prompt">{state.stopPrompt}</div>}
    <ShortcutCheatSheet rows={state?.shortcuts ?? []} visible={cheatSheet && !!state?.active} className="in-widget" />
    {shownError && !collapsed && <div className="widget-warning" role="alert">{shownError.text}</div>}
    {!collapsed && !!state?.warnings.length && <div className="widget-warning" role="alert">{state.warnings.join(" · ")}</div>}
  </div>;
}
