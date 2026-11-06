import { useEffect, useMemo, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { assembleTranscripts, type LiveViewState, type SpeechEvent } from "@live-interview/core";

/**
 * The meeting's high-frequency data: frame counts (every 500 ms per lane), transcript events and the guidance view.
 * It lives outside React state, so an update re-renders only the surfaces that read it (meters, transcript, live
 * panel, widget bridge) and never the application shell or the hidden pages. Recording does not depend on it: it is a
 * display copy of what the native layer reports.
 */
export interface LiveSnapshot {
  events: SpeechEvent[];
  frames: Record<string, number>;
  view: LiveViewState;
}
export const emptyView = (): LiveViewState => ({ cards: [], savedPins: [], queued: 0 });

export class LiveStore {
  private snapshot: LiveSnapshot;
  private readonly listeners = new Set<() => void>();
  constructor(initial?: Partial<LiveSnapshot>) {
    this.snapshot = { events: [], frames: {}, view: emptyView(), ...initial };
  }
  readonly get = (): LiveSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private set<K extends keyof LiveSnapshot>(key: K, update: SetStateAction<LiveSnapshot[K]>) {
    const old = this.snapshot[key];
    const next = typeof update === "function" ? (update as (old: LiveSnapshot[K]) => LiveSnapshot[K])(old) : update;
    // Same value, no notification: like React's own bail-out for an unchanged state.
    if (Object.is(old, next)) return;
    this.snapshot = { ...this.snapshot, [key]: next };
    for (const listener of [...this.listeners]) listener();
  }
  readonly setEvents: Dispatch<SetStateAction<SpeechEvent[]>> = (update) => this.set("events", update);
  readonly setFrames: Dispatch<SetStateAction<Record<string, number>>> = (update) => this.set("frames", update);
  readonly setView: Dispatch<SetStateAction<LiveViewState>> = (update) => this.set("view", update);
}

/** Anything that carries a live store, or (in tests and older callers) the plain values. */
export interface LiveSource {
  live?: LiveStore;
  events?: SpeechEvent[];
  frames?: Record<string, number>;
  view?: LiveViewState;
}

/** The controller's store, or a fixed one built from plain values (a test's stub controller). */
export function useLiveStore(source: LiveSource): LiveStore {
  const plain = !source.live;
  const events = plain ? source.events : undefined, frames = plain ? source.frames : undefined, view = plain ? source.view : undefined;
  const fixed = useMemo(() => (plain ? new LiveStore({ ...(events ? { events } : {}), ...(frames ? { frames } : {}), ...(view ? { view } : {}) }) : undefined), [plain, events, frames, view]);
  return source.live ?? fixed!;
}

/** Reads one derived value; the component re-renders only when that value changes (by `equal`). */
export function useLiveSelector<T>(source: LiveSource, select: (snapshot: LiveSnapshot) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const store = useLiveStore(source);
  const memo = useRef<{ store: LiveStore; snapshot: LiveSnapshot; value: T } | undefined>(undefined);
  const selectRef = useRef(select); selectRef.current = select;
  const read = () => {
    const snapshot = store.get(), last = memo.current;
    if (last && last.store === store && last.snapshot === snapshot) return last.value;
    const value = selectRef.current(snapshot);
    if (last && last.store === store && equal(last.value, value)) { memo.current = { store, snapshot, value: last.value }; return last.value; }
    memo.current = { store, snapshot, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
export const useLiveEvents = (source: LiveSource) => useLiveSelector(source, (s) => s.events);
export const useLiveView = (source: LiveSource) => useLiveSelector(source, (s) => s.view);
export const useLiveFrames = (source: LiveSource) => useLiveSelector(source, (s) => s.frames);

/**
 * Whether each lane has reported any frame: all the capture rows need. It changes once per lane per meeting, so the
 * pages that show capture status do not re-render for every 500 ms frame report.
 */
const started = { none: {}, me: { me: 1 }, remote: { remote: 1 }, both: { me: 1, remote: 1 } } as const;
export function framesStarted(frames: Record<string, number>): Record<string, number> {
  const me = (frames.me ?? 0) > 0, remote = (frames.remote ?? 0) > 0;
  return me && remote ? started.both : me ? started.me : remote ? started.remote : started.none;
}
export const useFramesStarted = (source: LiveSource) => useLiveSelector(source, (s) => framesStarted(s.frames));

/** Runs `listener` on every store change without rendering (for side effects such as publishing to the widget). */
export function useLiveSubscription(source: LiveSource, listener: (snapshot: LiveSnapshot) => void, deps: unknown[] = []) {
  const store = useLiveStore(source);
  const latest = useRef(listener); latest.current = listener;
  useEffect(() => store.subscribe(() => latest.current(store.get())), [store, ...deps]);
  return store;
}

// The assembled transcript is computed once per events array and shared by every reader (controller, conversation
// rail, transcript drawer): the arrays are immutable, replaced on each change.
const assembled = new WeakMap<SpeechEvent[], ReturnType<typeof assembleTranscripts>>();
export function transcriptOf(events: SpeechEvent[]) {
  let transcript = assembled.get(events);
  if (!transcript) { transcript = assembleTranscripts(events); assembled.set(events, transcript); }
  return transcript;
}
const entries = { source: new WeakMap<SpeechEvent[], SpeechEvent[]>(), english: new WeakMap<SpeechEvent[], SpeechEvent[]>() };
/** Same result as core's `liveTranscriptEntries` (newest first), from the shared transcript. */
export function transcriptEntriesOf(events: SpeechEvent[], english: boolean) {
  const cache = english ? entries.english : entries.source;
  let list = cache.get(events);
  if (!list) { const transcript = transcriptOf(events); list = [...(english ? transcript.english : transcript.source)].reverse(); cache.set(events, list); }
  return list;
}
