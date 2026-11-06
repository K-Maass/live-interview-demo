/**
 * Plain-language text for the calendar error codes that need a user action. Other codes keep the
 * generic message. The native side only ever returns a short `calendar…` code.
 */
const ACTIONS: Record<string, string> = {
  calendarScopeIncomplete:
    "Both Google Calendar permissions are needed (list your calendars and read their events). Connect again and leave both boxes ticked. Nothing was connected.",
  calendarReauthenticationRequired:
    "This calendar needs you to sign in again. Choose Connect for this provider; your selections and saved meetings are kept.",
  calendarPermissionDenied:
    "Calendar access for Live Interview is off on this Mac. Turn it on in System Settings → Privacy & Security → Calendars.",
  calendarPermissionRequired:
    "Live Interview can’t read the calendars on this Mac yet. Allow access in System Settings → Privacy & Security → Calendars.",
  calendarNetworkUnavailable:
    "Couldn’t reach the calendar provider. Check the internet connection; saved events stay visible and update when it returns.",
  calendarAccessDenied:
    "The provider refused calendar access, which can happen when a permission was withdrawn or an administrator restricted it. Connect again to review the permissions.",
};
export const GENERIC_CALENDAR_ERROR =
  "Calendar connection or selection unavailable. Existing records are preserved.";
export function calendarErrorMessage(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  return ACTIONS[code] ?? GENERIC_CALENDAR_ERROR;
}
/** Account row hint: only codes with a user action get a sentence, others stay a raw code. */
export function calendarCodeHint(code?: string): string | undefined {
  return code ? ACTIONS[code] : undefined;
}
