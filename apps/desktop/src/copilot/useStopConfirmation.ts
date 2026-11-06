import { useEffect, useRef, useState } from "react";
import { StopConfirmation } from "../lib/copilot/hotkeyGestures";
import { STOP_CONFIRM_MS } from "../lib/copilot/shortcuts";

/**
 * Stop & save from the keyboard: the first press arms it and the page asks for a second; a second press within
 * STOP_CONFIRM_MS stops. The arm lapses after the window and with a new or ended meeting. `stopArm` is a number per
 * arming press (0 when none), so the spoken request is a new report each time.
 *
 * `stop` returns whether it accepted the request: it refuses while a start or stop is still running. A refused
 * confirmation keeps the arm (restarting the window) and sets `stopRefused`, so the page says to press again instead
 * of the second press silently doing nothing.
 */
export function useStopConfirmation(meetingId: string | undefined, stop: () => boolean) {
  const confirmation = useRef(new StopConfirmation());
  const [stopArm, setStopArm] = useState(0);
  const [stopRefused, setStopRefused] = useState(false);
  const count = useRef(0);
  const disarm = () => { confirmation.current.reset(); setStopArm(0); setStopRefused(false); };
  useEffect(disarm, [meetingId]);
  useEffect(() => {
    if (!stopArm) return;
    const timer = window.setTimeout(disarm, STOP_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [stopArm]);
  const press = () => {
    // Two presses: a single stray press during a call must never end the recording.
    const now = Date.now();
    if (confirmation.current.press(now) === "confirmed") {
      if (stop()) return disarm();
      confirmation.current.press(now);
      setStopRefused(true);
    } else setStopRefused(false);
    setStopArm(++count.current);
  };
  return { stopArm, stopPending: stopArm > 0, stopRefused: stopArm > 0 && stopRefused, press };
}
