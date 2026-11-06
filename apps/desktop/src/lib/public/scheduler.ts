import type {
  PublicMeetingPlan,
  PublicAccountStatus,
} from "@live-interview/core";
import { preparationCandidates, preparationIdentity } from "./state";
/** One text job at a time; each unchanged plan is attempted once per app session.
 * Saved drafts make successful preparation idempotent across restarts. */
export class PremiumPreparationScheduler {
  private running = false;
  private attempted = new Set<string>();
  async tick(
    plans: PublicMeetingPlan[],
    account: PublicAccountStatus | undefined,
    now: number,
    prepare: (plan: PublicMeetingPlan) => Promise<void>,
    confirm: (plan: PublicMeetingPlan) => Promise<boolean> = async () => true,
  ) {
    if (this.running) return false;
    const candidates = preparationCandidates(
      plans.filter(
        (p) => p.revision > 0 && !this.attempted.has(preparationIdentity(p)),
      ),
      account,
      now,
    );
    const candidate = candidates[0];
    if (!candidate) return false;
    this.running = true;
    try {
      if (!(await confirm(candidate))) return false;
      this.attempted.add(preparationIdentity(candidate));
      await prepare(structuredClone(candidate));
      return true;
    } finally {
      this.running = false;
    }
  }
}
