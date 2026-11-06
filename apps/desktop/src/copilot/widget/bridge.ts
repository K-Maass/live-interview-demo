import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { widgetPosition } from "./position";
import { asOfText } from "../presentation/accessibility";
import { effectiveContext, visibleCards } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";
import { captureRows, consumeWidgetAction, type WidgetAction } from "../presentation/model";
import { cheatSheetRows, type CheatSheetRow } from "../ShortcutCheatSheet";
import { stopPromptLine } from "../../lib/copilot/status";
import { useStopReveal } from "./stopReveal";
import { framesStarted, useLiveSubscription } from "../liveStore";
export interface WidgetCard { id: string; headline?: string; say: string; pinned: boolean; /** Pinned and saved, so Answered / Outdated take effect in the main workspace. */ settleable?: boolean; stale: boolean; outdatedSuggested?: boolean; provisional?: boolean; /** The card is an inference rather than verified by its evidence. */ inferred?: boolean; /** "as of hh:mm:ss" when the card was written against an earlier moment. */ asOf?: string; sourceHint: string; clarification: boolean }
export interface WidgetState { version: 1; ownerId: string; meetingId?: string; title: string; active: boolean; cards: WidgetCard[]; captureLabel: string; warnings: string[]; paused: boolean; assistancePaused: boolean; /** The meeting keys for the held-⌘⌥ list; absent from an older main window. */ shortcuts?: CheatSheetRow[]; /** After the first Stop & save key press: the line asking for the second. */ stopPrompt?: string; /** The main window showed this hidden widget for the Stop & save prompt: hide again once the prompt is gone. */ hideWithStopPrompt?: boolean }
export function actualNativeWindow(): boolean {
  const shim = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return !!shim && !shim.metadata?.currentWindow?.label?.startsWith("__preview-");
}
/** Cards the main workspace can settle: pinned and in the saved pins. The widget offers Answered / Outdated only for these. */
export function settleableCardIds(view: CopilotController["view"]): string[] {
  return visibleCards(view).filter((card) => card.pinned && view.savedPins.some((p) => p.id === card.id)).map((card) => card.id);
}
type WidgetActionSource = Pick<CopilotController, "activeMeeting" | "view" | "pin" | "dismiss" | "settle" | "expand">;
/**
 * Validates one widget action against the current meeting and cards (each request id once) and applies it to the
 * main workspace. Returns the accepted action, or undefined when it was refused or already handled.
 */
export function dispatchWidgetAction(payload: unknown, source: WidgetActionSource, ownerId: string, seen: { meetingId?: string; requests: Set<string> }, showMain: () => void): WidgetAction | undefined {
  if (seen.meetingId !== source.activeMeeting?.id) { seen.meetingId = source.activeMeeting?.id; seen.requests = new Set(); }
  const value = consumeWidgetAction(payload, ownerId, source.activeMeeting?.id, visibleCards(source.view).map((card) => card.id), seen.requests, settleableCardIds(source.view));
  if (!value) return undefined;
  if (value.kind === "pin") source.pin(value.cardId!);
  if (value.kind === "dismiss") source.dismiss(value.cardId!);
  if (value.kind === "answered" || value.kind === "outdated") source.settle(value.cardId!, value.kind);
  if (value.kind === "evidence") {
    if (source.view.detailCardId !== value.cardId) source.expand(value.cardId!);
    showMain();
  }
  if (value.kind === "openMain") showMain();
  return value;
}
function project(c: CopilotController, ownerId: string, hideWithStopPrompt = false): WidgetState {
  const settleable = new Set(c.activeMeeting ? settleableCardIds(c.view) : []);
  const rows = captureRows(c.captureHealth, framesStarted(c.frames), c.paused, !!c.activeMeeting && c.sessionKind === "recording");
  const warnings = rows.filter((r) => r.status === "unavailable").map((r) => r.label + " unavailable" + (r.detail ? ": " + r.detail : ""));
  return { version: 1, ownerId, meetingId: c.activeMeeting?.id, title: c.activeMeeting?.purpose ?? "Live assistance", active: !!c.activeMeeting, paused: c.paused, assistancePaused: c.assistancePaused,
    shortcuts: c.activeMeeting ? cheatSheetRows(c.shortcuts) : undefined, stopPrompt: c.activeMeeting ? stopPromptLine(c.shortcuts.stop, c) : undefined, hideWithStopPrompt: hideWithStopPrompt || undefined,
    cards: c.activeMeeting ? visibleCards(c.view).map((card) => ({ id: card.id, headline: card.headline, say: card.say, pinned: card.pinned, settleable: settleable.has(card.id), stale: card.stale, outdatedSuggested: card.pinned && card.outdatedSuggested, provisional: card.provisional, inferred: card.uncertain && card.origin !== "clarification", ...(card.asOfMs !== undefined ? { asOf: asOfText(card.asOfMs) } : {}), clarification: card.origin === "clarification", sourceHint: card.evidence.length ? effectiveContext(card.basis).sources.find((s) => s.sourceId === card.evidence[0])?.title ?? "Conversation" : "No supporting source" })) : [],
    captureLabel: !c.activeMeeting ? "No active meeting" : c.sessionKind === "replay" ? "Synthetic replay · microphone off" : warnings.length ? "Recording needs attention" : c.paused ? "Recording paused" : rows.every((r) => r.status === "starting") ? "Starting audio capture" : "Recording locally", warnings,
  };
}
export function useWidgetOwner(c: CopilotController, showMain: () => void) {
  const ownerId = useRef(crypto.randomUUID()).current;
  const current = useRef(c); current.current = c;
  const show = useRef(showMain); show.current = showMain;
  const seen = useRef({ meetingId: c.activeMeeting?.id, requests: new Set<string>() });
  const reveal = useStopReveal(c.stopPending, () => actualNativeWindow() ? WebviewWindow.getByLabel("live-assistance-widget") : Promise.resolve(null));
  const revealed = useRef(reveal.revealed); revealed.current = reveal.revealed;
  const state = project(c, ownerId, reveal.revealed);
  const latest = useRef(state); latest.current = state;
  const publish = () => emit("live-widget-state", latest.current).catch(() => {});
  // Cards and capture status also change through the live store, which does not re-render this hook's host: those
  // changes are projected here and published only when the widget's state actually differs.
  const published = useRef("");
  const publishIfChanged = () => {
    const text = JSON.stringify(latest.current);
    if (text === published.current) return;
    published.current = text;
    void publish();
  };
  // Only the parts the widget shows: the view, and whether each lane has started. A frame report that changes neither
  // (nearly all of them) costs two comparisons, not a projection and a serialisation.
  const followed = useRef<{ view?: unknown; started?: unknown }>({});
  useLiveSubscription(c, (snapshot) => {
    const started = framesStarted(snapshot.frames);
    if (followed.current.view === snapshot.view && followed.current.started === started) return;
    followed.current = { view: snapshot.view, started };
    latest.current = project(current.current, ownerId, revealed.current);
    publishIfChanged();
  });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const ready = listen("live-widget-ready", () => { void publish(); if (actualNativeWindow()) void WebviewWindow.getByLabel("live-assistance-widget").then((w) => w?.show()).catch(() => {}); });
    const action = listen<unknown>("live-widget-action", (event) => {
      const value = dispatchWidgetAction(event.payload, current.current, ownerId, seen.current, () => show.current());
      if (!value) return;
      if (value.kind === "openMain" || value.kind === "evidence") {
        if (actualNativeWindow()) { void getCurrentWindow().show().then(() => getCurrentWindow().setFocus()).catch(() => {}); }
        else window.focus();
      }
    });
    return () => { void ready.then((stop) => stop()); void action.then((stop) => stop()); };
  }, []);
  useEffect(() => { publishIfChanged(); }, [JSON.stringify(state)]);
  const placeWidget = async (widget: WebviewWindow, reset = false) => {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const origin = monitor.workArea.position.toLogical(monitor.scaleFactor);
    const area = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const scale = await widget.scaleFactor();
    const size = (await widget.outerSize()).toLogical(scale);
    const previous = reset ? undefined : (await widget.outerPosition()).toLogical(scale);
    const point = widgetPosition({ ...origin, ...area }, size, previous);
    await widget.setPosition(new LogicalPosition(point.x, point.y));
  };
  const resetWidget = async () => { if (actualNativeWindow()) { const widget = await WebviewWindow.getByLabel("live-assistance-widget"); if (widget) await placeWidget(widget, true); } };
  const openWidget = async () => {
    // Opened on purpose: it must stay open after a Stop & save prompt it was showing ends.
    reveal.forget();
    if (!actualNativeWindow()) {
      const url = new URL(location.href); url.searchParams.set("window", "widget"); url.searchParams.set("owner", ownerId);
      const popup = window.open(url.toString(), "live-assistance-widget", "popup,width=480,height=400");
      if (!popup) { c.setAssistanceStatus("Widget window could not open. Main assistance remains available.", true); return; }
      void publish(); return;
    }
    const existing = await WebviewWindow.getByLabel("live-assistance-widget");
    if (existing) { await placeWidget(existing); await existing.show(); void publish(); return; }
    const monitor = await currentMonitor();
    const areaOrigin = monitor?.workArea.position.toLogical(monitor.scaleFactor);
    const areaSize = monitor?.workArea.size.toLogical(monitor.scaleFactor);
    const point = widgetPosition(areaOrigin && areaSize ? { ...areaOrigin, ...areaSize } : { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight }, { width: 480, height: 390 });
    const widget = new WebviewWindow("live-assistance-widget", { url: import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "full" ? "index.html?preview=full&state=live" : "index.html", title: "Live assistance", width: 480, height: 390, minWidth: 360, minHeight: 62, decorations: false, transparent: true, shadow: true, alwaysOnTop: true, skipTaskbar: true, focus: false, focusable: false, visible: false, resizable: false, visibleOnAllWorkspaces: true, acceptFirstMouse: true, x: point.x, y: point.y });
    void widget.once("tauri://created", () => { void publish(); });
    void widget.once("tauri://error", () => c.setAssistanceStatus("Compact window unavailable. Main assistance remains available.", true));
  };
  return { ownerId, openWidget, resetWidget };
}
/** A widget action that did not reach the main window. It belongs to one meeting and fades: it is not a lasting state. */
export interface WidgetActionError { text: string; meetingId?: string; atMs: number }
export const ACTION_ERROR_MS = 8000;
/** The error still worth showing: same meeting and younger than the timeout. The next successful action clears it too. */
export function visibleActionError(error: WidgetActionError | undefined, meetingId: string | undefined, nowMs: number) {
  return error && error.meetingId === meetingId && nowMs - error.atMs < ACTION_ERROR_MS ? error : undefined;
}
export function sendWidgetAction(state: WidgetState, kind: WidgetAction["kind"], cardId?: string) {
  const action = { version: 1, requestId: crypto.randomUUID(), ownerId: state.ownerId, meetingId: state.meetingId, kind, cardId };
  return actualNativeWindow() ? invoke<void>("forward_widget_action", { action }) : emit("live-widget-action", action);
}
