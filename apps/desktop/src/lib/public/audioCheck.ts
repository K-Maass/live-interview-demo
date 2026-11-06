// Setup audio check: the meter's history and the "did it hear anything" verdict. Pure, so the thresholds are
// tested without a device. Levels come from the native check as 0–1 (-60 dBFS to 0 dBFS); no audio reaches here.
export type Lane = "me" | "remote";
export interface LevelSample { lane: Lane; level: number }
export interface LevelEvent { check: number; lane: Lane; level: number; ended?: boolean }

/** Bars shown in the meter, newest last. */
export const BAR_COUNT = 48;
/** About -39 dBFS: above room noise, below normal speech and a test tone at an ordinary volume. */
export const HEARD_LEVEL = 0.35;
/** Loud samples needed before saying it was heard, so a single click or bump does not count. */
export const HEARD_SAMPLES = 3;

export const emptyBars = (): LevelSample[] => Array.from({ length: BAR_COUNT }, () => ({ lane: "me" as const, level: 0 }));

export function pushLevel(bars: LevelSample[], sample: LevelSample): LevelSample[] {
  const level = Number.isFinite(sample.level) ? Math.max(0, Math.min(1, sample.level)) : 0;
  return [...bars, { lane: sample.lane, level }].slice(-BAR_COUNT);
}

/** True once the lane has crossed the heard level often enough within the bars on screen. */
export function isHeard(bars: LevelSample[], lane: Lane): boolean {
  return bars.filter((b) => b.lane === lane && b.level >= HEARD_LEVEL).length >= HEARD_SAMPLES;
}

/** Plain words for a check that could not start. */
export function checkFailureText(lane: Lane, error: unknown): string {
  if (error === "meetingActive") return "The check is available after the current meeting ends.";
  if (error === "notGranted") return lane === "me" ? "Allow the microphone first, then the meter starts." : "Allow system audio first, then play the test sound.";
  return lane === "me" ? "The microphone could not be opened for the check. Check the input device in System Settings → Sound." : "System audio could not be opened for the check. Try again, or continue and check it in your first meeting.";
}
