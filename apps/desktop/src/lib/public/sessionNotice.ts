// Plain-text copy for this Mac's sign-in in Settings > Account & plan: the warning ahead of
// expiry when background renewal is not working, and the result of "Sign out of all Macs".
import type { PublicSessionStatus } from "@live-interview/core";

const DAY_MS = 86400000;
/** Warn this long before the sign-in ends (the app renews within the last seven days). */
export const SESSION_WARNING_MS = 7 * DAY_MS;

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

/**
 * A calm note when this Mac's sign-in will end soon and cannot be renewed in the background,
 * or undefined when there is nothing to say. Recording never depends on it.
 */
export function sessionNotice(session: PublicSessionStatus | undefined, now = Date.now()): string | undefined {
  const expires = session?.expiresAtMs;
  if (!session || expires === undefined || expires - now > SESSION_WARNING_MS) return undefined;
  const unaffected = "Recording and transcription keep working either way.";
  if (session.signInRequiredAtMs !== undefined && expires >= session.signInRequiredAtMs)
    return `For security, sign in again on this Mac before ${day(expires)} to keep live assistance. ${unaffected}`;
  if (session.renewalFailed)
    return `Your sign-in on this Mac ends on ${day(expires)}. Renewing it has not worked yet; the app keeps trying in the background. If this stays, sign out and sign in again. ${unaffected}`;
  return undefined;
}

export const SIGN_OUT_ALL_CONFIRM = [
  "Every Mac signed in to this account, including this one, is signed out and must sign in again.",
  "Live assistance stops on those Macs until they sign in. Recording, transcripts and notes stay on each Mac.",
  "Your subscription is not changed.",
];

export const SIGNED_OUT_ALL_MESSAGE = "Signed out of all Macs. Sign in again on each Mac you use.";

export function signOutAllErrorMessage(error: unknown): string {
  const c = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (["unauthenticated", "signInRequired", "sessionExpired"].includes(c))
    return "This Mac was already signed out, so other Macs could not be signed out from here. Sign in and try again.";
  if (c === "rateLimited") return "Too many attempts. Try again in a few minutes.";
  return "Could not reach the service, so nothing changed and this Mac is still signed in. Try again later.";
}
