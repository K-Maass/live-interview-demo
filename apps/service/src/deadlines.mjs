/**
 * One chain of deadlines, each bounding the next:
 *
 *   desktop wait (60 s)  <=  provider budget (90 s)  <  reservation (120 s)  <  HTTP socket (125 s)
 *
 * - The desktop sends every job a relative `timeoutMs` of at most 60 s and
 *   waits no longer than that (managed.rs). Its hang-up aborts the provider call.
 * - The service measures `timeoutMs` (at most PROVIDER_BUDGET_MS) on its own
 *   clock from receipt, so the Mac's clock no longer matters. The older
 *   absolute `deadlineMs` is still accepted up to PROVIDER_BUDGET_MS ahead (the
 *   30 s over the desktop's 60 s absorb clock skew). The provider call runs
 *   until the deadline and never longer than this budget.
 * - A reservation outlives the longest provider call by a settlement margin,
 *   so it can never expire (and free a slot) while its call is still running.
 * - The socket timeout and the shutdown drain outlast the reservation.
 *
 * Decisions (/v1/decide) are short: the provider gets DECIDE_BUDGET_MS, below
 * the desktop's 10 s, so the service answers before the client gives up.
 */
export const PROVIDER_BUDGET_MS = 90000;
export const RESERVATION_TTL_MS = PROVIDER_BUDGET_MS + 30000;
export const SOCKET_TIMEOUT_MS = RESERVATION_TTL_MS + 5000;
export const DECIDE_BUDGET_MS = 8000;
