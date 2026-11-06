// First-run model download state (#30). Pure: the helper reports bytes on disk against the size the model host
// lists; this derives honest text from those facts. It owns no readiness truth and never gates recording.
export type SetupStage = "checking" | "downloading" | "retrying" | "tokenizer";
export interface ModelSetupProgressEvent {
  kind: "setupProgress";
  stage: SetupStage;
  asset: string;
  completedBytes: number;
  totalBytes: number;
  /** Bytes already on disk when this run started, so a resumed download is not credited with them as speed. */
  resumedBytes: number;
  attempt: number;
}
export interface ModelSetupFailedEvent {
  kind: "setupFailed";
  code: string;
  details?: { neededBytes?: number; availableBytes?: number } | null;
}
export type ModelSetupEvent = ModelSetupProgressEvent | ModelSetupFailedEvent;

export interface ModelSetupState {
  phase: "idle" | "running" | "failed";
  stage?: SetupStage;
  asset?: string;
  completedBytes: number;
  totalBytes: number;
  resumedBytes: number;
  attempt: number;
  /** Recent (time, bytes) readings of this run, used for speed and time remaining. */
  samples: { at: number; bytes: number }[];
  failure?: { code: string; neededBytes?: number; availableBytes?: number };
  /** The person pressed Cancel and the helper has not stopped yet. */
  cancelling?: boolean;
}

export const idleModelSetup: ModelSetupState = { phase: "idle", completedBytes: 0, totalBytes: 0, resumedBytes: 0, attempt: 1, samples: [] };
const WINDOW_MS = 30_000;
/** Speed is only quoted once there is this much history; a time estimate from a few seconds would be a guess. */
const MIN_SPAN_MS = 5_000;

/** Cancel was pressed; the run is still `running` until the command rejects with "cancelled". */
export const requestModelSetupCancel = (state: ModelSetupState): ModelSetupState => (state.phase === "running" ? { ...state, cancelling: true } : state);

export const startModelSetup = (): ModelSetupState => ({ ...idleModelSetup, phase: "running" });

export function applyModelSetupEvent(state: ModelSetupState, event: ModelSetupEvent, now: number): ModelSetupState {
  if (event.kind === "setupFailed") return failModelSetup(state, event.code, event.details ?? undefined);
  // A line that arrives after the run ended (finished or failed) must not turn the state back into a running download.
  if (state.phase !== "running") return state;
  const samples = [...state.samples, { at: now, bytes: event.completedBytes }].filter((sample) => now - sample.at <= WINDOW_MS);
  return {
    phase: "running",
    stage: event.stage,
    asset: event.asset,
    completedBytes: event.completedBytes,
    totalBytes: event.totalBytes,
    resumedBytes: event.resumedBytes,
    attempt: event.attempt,
    samples,
    cancelling: state.cancelling,
  };
}

/** Details already received (for a full disk, the byte counts) are kept when the command then rejects with only a code. */
export function failModelSetup(state: ModelSetupState, code: string, details?: { neededBytes?: number; availableBytes?: number }): ModelSetupState {
  const kept = state.failure?.code === code ? state.failure : undefined;
  return {
    ...state,
    phase: "failed",
    cancelling: false,
    samples: [],
    failure: { code, neededBytes: details?.neededBytes ?? kept?.neededBytes, availableBytes: details?.availableBytes ?? kept?.availableBytes },
  };
}

const GB = 1_000_000_000;
const MB = 1_000_000;
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1) + " GB";
  return Math.max(0, Math.round(bytes / MB)) + " MB";
}
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min`;
}

/** Bytes per second over the recent window, or undefined while there is too little history or no movement. */
export function downloadSpeed(samples: ModelSetupState["samples"]): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS || last.bytes <= first.bytes) return undefined;
  return ((last.bytes - first.bytes) / span) * 1000;
}

export interface ModelSetupView {
  /** 0..1, or undefined while the total size is not known yet. */
  fraction?: number;
  headline: string;
  detail: string;
}
const assetName = (asset?: string) => (asset === "translation" ? "experimental translation model" : "speech recognition model");

export function describeModelSetup(state: ModelSetupState): ModelSetupView {
  const known = state.totalBytes > 0;
  const fraction = known ? Math.min(1, state.completedBytes / state.totalBytes) : undefined;
  if (state.stage === "checking" || !state.stage) return { headline: "Checking what to download…", detail: "Asking the model host for the download size." };
  if (state.stage === "tokenizer") return { fraction, headline: "Finishing setup…", detail: "Fetching the small language files the models need." };
  const parts: string[] = [];
  if (known) parts.push(`${formatBytes(state.completedBytes)} of ${formatBytes(state.totalBytes)}`);
  const speed = downloadSpeed(state.samples);
  if (speed !== undefined) {
    parts.push(`${formatBytes(speed)}/s`);
    if (known && state.completedBytes < state.totalBytes) parts.push(formatDuration(((state.totalBytes - state.completedBytes) / speed) * 1000) + " left");
  } else if (known && state.completedBytes < state.totalBytes) {
    parts.push("estimating time left…");
  }
  if (state.resumedBytes > 0) parts.push(`continuing from ${formatBytes(state.resumedBytes)} already downloaded`);
  if (state.stage === "retrying") return { fraction, headline: `Connection interrupted; retrying (attempt ${state.attempt} of 3)…`, detail: parts.join(" · ") };
  return { fraction, headline: `Downloading the ${assetName(state.asset)}`, detail: parts.join(" · ") };
}

export interface SetupFailureText {
  message: string;
  recovery: string;
}
export function describeSetupFailure(failure: NonNullable<ModelSetupState["failure"]>): SetupFailureText {
  const kept = "Files already downloaded are kept. Recording is not affected.";
  if (failure.code === "cancelled") return { message: "The download was cancelled.", recovery: `Choose Retry to continue where it stopped. ${kept}` };
  if (failure.code === "diskFull") {
    const space = failure.neededBytes !== undefined && failure.availableBytes !== undefined ? ` It needs about ${formatBytes(failure.neededBytes)} free; ${formatBytes(failure.availableBytes)} is available.` : "";
    return { message: "There is not enough free disk space for the speech models." + space, recovery: `Free up space (empty the Trash or remove large files), then choose Retry. The download continues where it stopped. ${kept}` };
  }
  if (failure.code === "network") return { message: "The connection dropped or the model host could not be reached.", recovery: `Check your internet connection, then choose Retry. The download continues where it stopped. ${kept}` };
  return { message: "Model setup stopped before it finished.", recovery: `Choose Retry. ${kept}` };
}
