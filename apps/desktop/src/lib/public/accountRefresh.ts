/**
 * The account re-read every minute: the previous object when nothing changed (so nothing re-renders),
 * otherwise the new one. Every field counts, so a plan, payment-grace or usage-reset change (including
 * the grace date disappearing when it ends) always reaches the app and the reasoning host's plan.
 */
export function keepIfUnchanged<T>(old: T | undefined, next: T): T {
  return old !== undefined && JSON.stringify(old) === JSON.stringify(next) ? old : next;
}
