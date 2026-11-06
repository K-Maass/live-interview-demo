// Loads the range a calendar view shows and tells the view how that is going (#123).
//
//   const r = useCalendarRange({ enabled, mode, anchor, loadRange })
//   r.range     the requested { startMs, endMs } (what the footer Refresh needs)
//   r.pending   a load is in flight (use for "unloaded days are not hatched yet")
//   r.slow      pending for more than 300 ms: only then does the status line say "Loading calendar…"
//   r.failed    the last load rejected (loadRange normally reports its own errors and resolves)
//   r.refresh() load the same range again (Retry, Refresh)
//
// A generation counter drops the answer of a load that was replaced by navigating on, so a slow earlier week can never
// clear the loading state of the week now shown.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { periodRange, type PeriodMode } from "./layout";

export const SLOW_LOADING_MS = 300;

export function useCalendarRange({ enabled, mode, anchor, loadRange, slowMs = SLOW_LOADING_MS }: { enabled: boolean; mode: PeriodMode; anchor: Date; loadRange: (startMs: number, endMs: number) => Promise<unknown>; slowMs?: number }) {
  const raw = periodRange(mode, anchor);
  const range = useMemo(() => ({ startMs: raw.startMs, endMs: raw.endMs }), [raw.startMs, raw.endMs]);
  const load = useRef(loadRange);
  load.current = loadRange;
  const generation = useRef(0);
  const [state, setState] = useState({ pending: enabled, slow: false, failed: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ pending: false, slow: false, failed: false }); return; }
    const mine = ++generation.current;
    const timer = window.setTimeout(() => { if (generation.current === mine) setState((s) => ({ ...s, slow: true })); }, slowMs);
    setState({ pending: true, slow: false, failed: false });
    const done = (failed: boolean) => { window.clearTimeout(timer); if (generation.current === mine) setState({ pending: false, slow: false, failed }); };
    Promise.resolve(load.current(range.startMs, range.endMs)).then(() => done(false), () => done(true));
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [enabled, range, reload, slowMs]);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  return { range, pending: state.pending, slow: state.slow, failed: state.failed, refresh };
}
