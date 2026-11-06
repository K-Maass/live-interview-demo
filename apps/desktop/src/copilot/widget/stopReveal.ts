import { useEffect, useRef, useState } from "react";

/** The two calls of a Tauri window this needs; a seam so the reveal is testable without the native app. */
export interface RevealableWindow {
  isVisible: () => Promise<boolean>;
  show: () => Promise<void>;
}

/**
 * The first Stop & save key press is usually made with Teams in front, where the main window's line cannot be seen.
 * If the compact widget exists but is hidden, it is shown for the confirmation window so the "press again" line is
 * visible; true when this showed it. A widget already on screen, or none at all, is left as it is.
 */
export async function revealForStop(widget: RevealableWindow | null | undefined): Promise<boolean> {
  if (!widget) return false;
  try {
    if (await widget.isVisible()) return false;
    await widget.show();
    return true;
  } catch {
    return false;
  }
}

/**
 * Main window side. `revealed` is true from the moment the widget was shown for a Stop & save request until the
 * request has ended and been published once without its prompt, which is the widget's cue to hide itself again (the
 * main window may show the widget but not hide it). `forget` drops the reveal when the person opens the widget
 * themselves, so it then stays.
 */
export function useStopReveal(stopPending: boolean, getWidget: () => Promise<RevealableWindow | null | undefined>) {
  const [revealed, setRevealed] = useState(false);
  const shownForThisRequest = useRef(false);
  useEffect(() => {
    if (!stopPending) { shownForThisRequest.current = false; return; }
    if (shownForThisRequest.current) return;
    shownForThisRequest.current = true;
    void getWidget().then(revealForStop, () => false).then((shown) => { if (shown) setRevealed(true); });
  }, [stopPending]);
  // Kept for one render after the request ends, so that publish carries "hide" with no prompt; then cleared.
  useEffect(() => { if (revealed && !stopPending) setRevealed(false); }, [revealed, stopPending]);
  return { revealed, forget: () => setRevealed(false) };
}

/** Widget side: hide again once the prompt this window was shown for has gone. */
export const hideAfterStopPrompt = (state: { stopPrompt?: string; hideWithStopPrompt?: boolean } | undefined) =>
  !!state?.hideWithStopPrompt && !state.stopPrompt;
