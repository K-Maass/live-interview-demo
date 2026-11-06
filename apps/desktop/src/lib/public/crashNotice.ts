// When the crash-report notice may load and show. Pure, so it can be tested without a DOM (#47).
// The notice never competes with a live meeting, and "Not now" lasts until the next launch.

let notNow = false;
export const notNowThisLaunch = () => notNow;
export const chooseNotNow = () => {
  notNow = true;
};
/** Tests only: a new launch. */
export const resetNotNowForTests = () => {
  notNow = false;
};

export type NoticeGate = { native: boolean; meetingActive: boolean; notNow: boolean };

/** Ask the native side for a waiting report only when it could be shown. */
export const shouldLoadCrashReport = (gate: NoticeGate) => gate.native && !gate.meetingActive && !gate.notNow;

/** Show the notice only for a loaded report, outside a meeting, and not after "Not now". */
export const crashNoticeVisible = (gate: { hasReport: boolean; meetingActive: boolean; notNow: boolean }) =>
  gate.hasReport && !gate.meetingActive && !gate.notNow;
