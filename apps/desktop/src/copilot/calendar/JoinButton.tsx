// "Join" for a meeting that has a video link (#123). Always its own button, never inside an event's open button.
//
//   <JoinButton item={item} busy={busy} now={now} />
//
// Renders nothing without an http(s) joinUrl. Opens the link in the default browser (`openUrl`, as the billing links do)
// and does nothing else: it never starts a recording and never navigates inside the app. While a live meeting runs
// (`busy`) it keeps its place but is inert (`aria-disabled`, not `disabled`, so it stays readable and focusable).
// Within 10 minutes of the start, or while the meeting is in progress, it gets an accent border.
import { Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

export const JOIN_SOON_MS = 10 * 60_000;

/** True from 10 minutes before the start until the end. */
export function isJoinSoon(item: { startMs: number; endMs: number }, now: number): boolean {
  return now >= item.startMs - JOIN_SOON_MS && now < item.endMs;
}

export async function openJoinUrl(url: string): Promise<void> {
  try { await openUrl(url); }
  catch { if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) window.open(url, "_blank", "noopener,noreferrer"); }
}

export function JoinButton({ item, busy, now }: { item: { title: string; joinUrl?: string; startMs: number; endMs: number }; busy: boolean; now: number }) {
  const url = item.joinUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return <button type="button" className={"cal-join" + (isJoinSoon(item, now) ? " is-soon" : "")} aria-label={`Join call: ${item.title}`} aria-disabled={busy ? true : undefined} onClick={(event) => { event.stopPropagation(); if (busy) return; void openJoinUrl(url); }}><Video size={14} aria-hidden />Join</button>;
}
