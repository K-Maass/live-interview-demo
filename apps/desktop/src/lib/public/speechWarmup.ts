// Wording for the background speech-model load (#83). The native side says whether this helper build has loaded here
// before; this only turns that into status text. It never gates recording, and a failed lookup changes only the words.
export interface WarmupDeps {
  /** Native `speech_warmup_state`: the status text for the load that is about to start. */
  state: () => Promise<{ status: string }>;
  warm: () => Promise<unknown>;
  setStatus: (status: string) => void;
  /** False once a newer attempt (Retry) has started, so a superseded load cannot overwrite its status. */
  isCurrent?: () => boolean;
}

export const loadingStatus = "Preparing local speech · recording continues";
/** Must equal `READY_STATUS` in `src-tauri/src/local_speech/warmup.rs`, which a meeting's load emits when it ends. */
export const warmStatus = "Warm · local";
export const warmPendingStatus = "Warm-up pending · local recording still available";
/** Shown when a load has run well past its usual time (#58). It is still bounded: the helper is stopped at 15 min. */
export const slowStatus = "Local speech is taking longer than usual · recording continues";

/**
 * How long a load may take before the notice stops saying "Preparing" and offers Retry. Measured on an M4: a first
 * load after an update 246–416 s, a later load about 4 s, and up to 452 s after the OS evicted CoreML's cache
 * (docs/acceptance/speech-warmup-after-update.md, speech-helper-warmup.md). The native side gives up at 900 s.
 */
export const firstLoadSlowAfterMs = 10 * 60_000;
export const loadSlowAfterMs = 4 * 60_000;
export function slowAfterMs(status: string): number | undefined {
  if (!status.startsWith("Preparing local speech")) return undefined;
  return status.includes("one-time") ? firstLoadSlowAfterMs : loadSlowAfterMs;
}

/**
 * The words for a notice beside the places where a person would wonder why transcript text is late (#106): the one
 * status line was easy to miss. Undefined once the load is done or when the status is anything else, so a settled
 * app shows nothing. `busy` is true only while a load is running within its usual time, so the spinner never runs
 * on; `retry` offers a fresh helper. Informational only; it never gates recording.
 */
export interface WarmupNotice { title: string; detail: string; busy: boolean; retry: boolean }
export function warmupNotice(status: string): WarmupNotice | undefined {
  if (status.startsWith("Preparing local speech")) {
    return {
      title: status.includes("one-time") ? "Preparing local speech (one-time, a few minutes)" : "Preparing local speech",
      detail: "Transcript text can appear late until this finishes. Recording continues, and everything stays on this Mac.",
      busy: true,
      retry: false,
    };
  }
  if (status === slowStatus) {
    return {
      title: "Local speech is taking longer than usual",
      detail: "Recording continues and nothing is lost: audio waits on this Mac and is transcribed once local speech is ready. Retry starts local speech again.",
      busy: false,
      retry: true,
    };
  }
  if (status.startsWith("Warm-up pending")) {
    return {
      title: "Local speech warm-up has not finished",
      detail: "Recording is still available. Transcript text can appear late until local speech is ready. Retry starts local speech again.",
      busy: false,
      retry: true,
    };
  }
  if (status === "decodePending") {
    return {
      title: "Transcription is waiting",
      detail: "Recording continues. Audio waits on this Mac and is transcribed once local speech catches up. Retry starts local speech again.",
      busy: false,
      retry: true,
    };
  }
  if (status === "workerUnavailable") {
    return {
      title: "Local speech could not start",
      detail: "Recording continues and nothing is lost: audio waits on this Mac. Retry starts local speech again.",
      busy: false,
      retry: true,
    };
  }
  if (status === "translationPending") {
    return {
      title: "Translation is waiting",
      detail: "The original-language transcript is saved. English translation finishes later on this Mac.",
      busy: false,
      retry: false,
    };
  }
  return undefined;
}

/** Statuses that mean local speech is fine; nothing needs saying beyond a calm "running". */
const settledStatuses = new Set(["Local", warmStatus, "Warming local model…", "Local speech running"]);
export function speechStatusSettled(status: string): boolean {
  return settledStatuses.has(status);
}

/**
 * Plain words for any local-speech status, including the native `speech-health` codes. A raw code never reaches
 * the screen: an unknown one gets a generic sentence that still says recording continues.
 */
export function speechStatusText(status: string): string {
  if (speechStatusSettled(status)) return "Running on this Mac";
  const notice = warmupNotice(status);
  if (notice) return notice.title + (/Recording continues|Recording is still available/.test(notice.detail) ? ". Recording continues." : ".");
  return "Local speech needs attention. Recording continues.";
}

export interface WarmupTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimers: WarmupTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * While `status` says a load is running, switch to `slowStatus` once it has run past its usual time. Covers both the
 * launch warm-up and a meeting's own load (whose status comes from the native `speech-health` event). Returns the
 * cleanup for a React effect: any new status cancels the timer, so a finished load is never relabelled.
 */
export function watchSlowWarmup(status: string, setStatus: (update: (current: string) => string) => void, timers: WarmupTimers = realTimers): () => void {
  const after = slowAfterMs(status);
  if (after === undefined) return () => {};
  const handle = timers.set(() => setStatus((current) => (current === status ? slowStatus : current)), after);
  return () => timers.clear(handle);
}

export async function warmLocalSpeech({ state, warm, setStatus, isCurrent = () => true }: WarmupDeps): Promise<void> {
  const show = (status: string) => { if (isCurrent()) setStatus(status); };
  const status = await state().then((s) => s.status, () => loadingStatus);
  show(status);
  await warm().then(
    () => show(warmStatus),
    () => show(warmPendingStatus),
  );
}

/** Retry: stop any load in progress (native `restart_local_speech`), then load again with a fresh helper. */
export async function retryLocalSpeech(restart: () => Promise<unknown>, deps: WarmupDeps): Promise<void> {
  await restart().catch(() => undefined);
  await warmLocalSpeech(deps);
}
