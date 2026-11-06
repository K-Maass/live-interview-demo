// A clock that ticks once a minute, on the minute (#123), for the now line and "Join soon" styling.
// Also refreshes when the window becomes visible again, because timers pause while a Mac sleeps.
import { useEffect, useState } from "react";

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const schedule = () => { timer = window.setTimeout(() => { setNow(Date.now()); schedule(); }, 60_000 - (Date.now() % 60_000) + 50); };
    const visible = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    schedule();
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return now;
}
