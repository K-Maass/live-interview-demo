// Sizes shared by the Week grid and the event blocks (#123). Pure.
//
//   HOUR_REM                height of one hour in the Week grid, in rem so text=200 scales it (--hour-h in calendar.css)
//   MIN_BLOCK_MINUTES       shortest block, passed to layoutDay as minHeightMinutes (1.5 rem)
//   weekTier(lengthMinutes) how much a Week block can show: one line, time + title, or the full card
export const HOUR_REM = 3.43;
/** 1.5 rem expressed in grid minutes at HOUR_REM per hour. */
export const MIN_BLOCK_MINUTES = Math.ceil((1.5 / HOUR_REM) * 60);

export type WeekTier = "line" | "two" | "full";

/** Content tier for a Week block that is `lengthMinutes` tall on the grid (after the minimum height was applied). */
export function weekTier(lengthMinutes: number): WeekTier {
  const rem = (lengthMinutes / 60) * HOUR_REM;
  return rem < 2.2 ? "line" : rem < 4.2 ? "two" : "full";
}
