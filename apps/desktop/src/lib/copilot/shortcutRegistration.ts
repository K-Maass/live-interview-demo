import type { ShortcutAction, Shortcuts } from "./shortcuts";

/** The two calls of `@tauri-apps/plugin-global-shortcut` this uses; a seam so registration order is testable. */
export interface GlobalShortcutApi {
  register: (shortcut: string, handler: (event: { state: string }) => void) => Promise<void>;
  unregister: (shortcuts: string | string[]) => Promise<void>;
}

/**
 * System-wide shortcuts, registered one change at a time. Every change (and `clear`) joins one promise chain, so an
 * older registration can never keep running after a newer one started: each run first unregisters every key this
 * registrar holds, and a run that is overtaken stops before its next key. Without this, saving shortcuts while the
 * first loop was still registering left old keys behind and reported keys as "unavailable" that were only taken by
 * the stale loop. (The app's capability allows `unregister` but not `unregisterAll`, so the held keys are tracked here.)
 *
 * A run that finishes reports its outcome once: `onApplied` always, with the keys that could not register (empty when
 * every key registered), and `onUnavailable` only when some failed. An overtaken run reports nothing, so the newest
 * outcome is the one shown, and a later successful apply clears an earlier failure.
 */
export class ShortcutRegistrar {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly held = new Set<string>();
  constructor(
    private readonly api: GlobalShortcutApi,
    private readonly onAction: (action: ShortcutAction) => void,
    private readonly onUnavailable: (shortcuts: string[]) => void,
    private readonly onApplied: (unavailable: string[]) => void = () => {},
  ) {}
  apply(shortcuts: Shortcuts): Promise<void> {
    const mine = ++this.generation;
    return this.enqueue(async () => {
      await this.releaseAll();
      const unavailable: string[] = [];
      for (const [action, shortcut] of Object.entries(shortcuts)) {
        if (mine !== this.generation) return;
        try {
          await this.api.register(shortcut, (event) => {
            if (event.state === "Pressed") this.onAction(action as ShortcutAction);
          });
          this.held.add(shortcut);
        } catch {
          unavailable.push(shortcut);
        }
      }
      if (mine !== this.generation) return;
      this.onApplied(unavailable);
      if (unavailable.length) this.onUnavailable(unavailable);
    });
  }
  /** Releases every key. A finished clear reports no unavailable keys, so a past meeting's failures do not linger. */
  clear(): Promise<void> {
    const mine = ++this.generation;
    return this.enqueue(async () => {
      await this.releaseAll();
      if (mine === this.generation) this.onApplied([]);
    });
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
  /**
   * One key at a time, and a key leaves `held` only once its unregister succeeded: a key that failed to release stays
   * recorded and is retried by the next apply or clear, instead of staying registered with nothing tracking it.
   */
  private async releaseAll() {
    for (const key of [...this.held]) {
      try {
        await this.api.unregister(key);
        this.held.delete(key);
      } catch {
        // Still held; the next apply or clear tries again.
      }
    }
  }
}
