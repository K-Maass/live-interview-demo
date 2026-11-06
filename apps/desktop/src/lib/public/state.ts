import type {
  PublicMeetingPlan,
  PublicAccountStatus,
  PublicCalendarEvent,
} from "@live-interview/core";
import { wireSignature } from "./value";
import { defaultMeetingTimes } from "./calendarSave";
export function newMeetingPlan(
  id: string,
  now = Date.now(),
  event?: PublicCalendarEvent,
): PublicMeetingPlan {
  // A meeting made by hand starts at the next half hour so it can go straight onto a calendar.
  const times = event ?? defaultMeetingTimes(now);
  return {
    id,
    eventId: event?.id,
    calendarAccountId: event?.accountId,
    calendarId: event?.calendarId,
    title: event?.title ?? "Untitled meeting",
    startMs: times.startMs,
    endMs: times.endMs,
    workspaceId: "default",
    sourceSelection: "workspace",
    sourceIds: [],
    sharedLibraryIds: [],
    profileId: "workClient",
    attendees: [],
    objectives: [],
    publicResearchTopics: [],
    briefDraft: "",
    inputDevice: "",
    retainAudio: false,
    automaticPreparation: false,
    revision: 0,
    updatedAtMs: now,
    status: "draft",
  };
}
export class PlanSession {
  current?: PublicMeetingPlan;
  dirty = false;
  private generation = 0;
  private edits = 0;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private client: {
      getPlan: (id: string) => Promise<PublicMeetingPlan | null>;
      savePlan: (plan: PublicMeetingPlan) => Promise<PublicMeetingPlan>;
    },
    private changed: () => void = () => {},
  ) {}
  async open(id: string) {
    const generation = ++this.generation;
    if (this.dirty) await this.save();
    const plan = await this.client.getPlan(id);
    if (generation !== this.generation) return;
    this.current = plan ?? undefined;
    this.dirty = false;
    this.edits++;
    this.changed();
  }
  replace(plan: PublicMeetingPlan) {
    this.generation++;
    this.current = plan;
    this.dirty = plan.revision === 0;
    this.edits++;
    this.changed();
  }
  edit(patch: Partial<PublicMeetingPlan>) {
    if (!this.current) return;
    const contextKeys =
      "workspaceId sourceSelection sourceIds sharedLibraryIds title attendees objectives publicResearchTopics profileId".split(
        " ",
      ) as (keyof PublicMeetingPlan)[];
    const invalidates = contextKeys.some(
      (key) =>
        key in patch &&
        JSON.stringify(patch[key]) !== JSON.stringify(this.current![key]),
    );
    const draftChanged =
      "briefDraft" in patch && patch.briefDraft !== this.current.briefDraft;
    this.current = {
      ...this.current,
      ...patch,
      ...(invalidates
        ? {
            reviewedBrief: undefined,
            draftEvidence: [],
            status: "draft" as const,
          }
        : draftChanged
          ? { reviewedBrief: undefined, status: "draft" as const }
          : {}),
      id: this.current.id,
      revision: this.current.revision,
      updatedAtMs: Date.now(),
    };
    this.generation++;
    this.edits++;
    this.dirty = true;
    this.changed();
  }
  async reloadPreservingDraft(recoveryId: string) {
    await this.pending.catch(() => {});
    if (!this.current) return;
    const original = this.current.id;
    const edits = this.edits;
    let recovery: PublicMeetingPlan | undefined;
    if (this.dirty)
      recovery = await this.client.savePlan({
        ...this.current,
        id: recoveryId,
        eventId: undefined,
        calendarAccountId: undefined,
        calendarId: undefined,
        startMs: undefined,
        endMs: undefined,
        automaticPreparation: false,
        title: (this.current.title || "Meeting") + " (recovered draft)",
        revision: 0,
      });
    if (this.current?.id !== original || edits !== this.edits) return recovery;
    this.dirty = false;
    try {
      await this.open(original);
    } catch (error) {
      this.dirty = true;
      throw error;
    }
    return recovery;
  }
  save(): Promise<PublicMeetingPlan | undefined> {
    if (!this.current || !this.dirty) return Promise.resolve(this.current);
    const snapshot = structuredClone(this.current);
    const edits = this.edits;
    const run = async () => {
      const request = {
        ...snapshot,
        revision:
          this.current?.id === snapshot.id
            ? this.current.revision
            : snapshot.revision,
      };
      const saved = await this.client.savePlan(request);
      if (this.current?.id === snapshot.id) {
        this.current =
          this.edits === edits
            ? saved
            : { ...this.current, revision: saved.revision };
        this.dirty = this.edits !== edits;
        this.changed();
      }
      return saved;
    };
    const result = this.pending.catch(() => {}).then(run);
    this.pending = result;
    return result;
  }
}
export function preparationCandidates(
  plans: PublicMeetingPlan[],
  account: PublicAccountStatus | undefined,
  now: number,
): PublicMeetingPlan[] {
  if (
    !account?.canAutoPrepare ||
    !account.canUseAI ||
    account.plan !== "premium"
  )
    return [];
  return plans
    .filter(
      (p) =>
        p.automaticPreparation &&
        p.status === "draft" &&
        !p.reviewedBrief &&
        !p.briefDraft.trim() &&
        p.startMs !== undefined &&
        p.startMs >= now &&
        p.startMs <= now + 30 * 60000,
    )
    .sort((a, b) => a.startMs! - b.startMs!)
    .slice(0, 2);
}
export function preparationIdentity(plan: PublicMeetingPlan): string {
  const { revision, updatedAtMs, ...content } = plan;
  return wireSignature(content);
}
export function acceptPreparation(
  current: PublicMeetingPlan,
  started: PublicMeetingPlan,
  draft: string,
): PublicMeetingPlan | null {
  if (
    current.id !== started.id ||
    current.status !== "draft" ||
    current.reviewedBrief ||
    preparationIdentity(current) !== preparationIdentity(started)
  )
    return null;
  return { ...current, briefDraft: draft, updatedAtMs: Date.now() };
}
export function visibleCalendarRange(date: Date, period: "week" | "month") {
  const first = new Date(date);
  first.setHours(0, 0, 0, 0);
  if (period === "month") first.setDate(1);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const end = new Date(first);
  end.setDate(end.getDate() + (period === "week" ? 7 : 42));
  return { startMs: first.getTime(), endMs: end.getTime() };
}

export function objectiveLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
