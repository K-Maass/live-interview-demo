import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PublicWorkspace,
  PublicSource,
  PublicMeetingPlan,
  CalendarAccount,
  CalendarCoverage,
  PublicAccountStatus,
  PublicCalendarEvent,
  ActionProposal,
} from "@live-interview/core";
import { inferProfile, makeCalendarProposal } from "@live-interview/core";
import { publicClient as api } from "./client";
import {
  PlanSession,
  newMeetingPlan,
  acceptPreparation,
  preparationIdentity,
} from "./state";
import { PremiumPreparationScheduler } from "./scheduler";
import { keepIfUnchanged } from "./accountRefresh";
import { acceptedCallPlan as createAcceptedCallPlan } from "./capture";
import {
  invalidatePreparationPlan,
  subscribePreparationInvalidation,
} from "./preparationEvidence";
import { generatePreparation } from "./reasoning";
import { PUBLIC_EDITION } from "../edition";
import {
  calendarLabel,
  calendarSaveState,
  writableCalendars as onlyWritable,
  type CalendarChange,
  type WritableCalendar,
  calendarSaveErrorMessage,
  icsSaveFailure,
  applyCalendarSave,
  PLAN_SYNC_NOT_SAVED,
} from "./calendarSave";
import { CalendarMoveController, type AppliedMove, type MoveRange } from "./calendarMove";
/** A calendar change waiting for the user's confirmation in the sheet. */
export type PendingCalendarChange =
  | { kind: "calendar"; proposal: ActionProposal; planId: string; calendar: WritableCalendar; after: CalendarChange; before?: CalendarChange }
  | { kind: "ics"; proposal: ActionProposal; planId: string; path: string; after: CalendarChange };
const readBack = (text: string): CalendarChange | undefined => {
  try {
    const v = JSON.parse(text);
    return typeof v?.title === "string" && typeof v?.startMs === "number" && typeof v?.endMs === "number"
      ? { title: v.title, startMs: v.startMs, endMs: v.endMs }
      : undefined;
  } catch {
    return undefined;
  }
};
export function usePublicProduct(hydrate: (plan: PublicMeetingPlan) => void) {
  const [, render] = useState(0);
  const hydrateRef = useRef(hydrate);
  hydrateRef.current = hydrate;
  const sessionRef = useRef<PlanSession | undefined>(undefined);
  if (!sessionRef.current)
    sessionRef.current = new PlanSession(api, () => render((n) => n + 1));
  const session = sessionRef.current;
  const [plans, setPlans] = useState<PublicMeetingPlan[]>([]);
  const [workspaces, setWorkspaces] = useState<PublicWorkspace[]>([]);
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  // False until the first account list has arrived or failed, so the Calendar does not flash "Connect a calendar".
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  // The native code of the last range load that was refused as a whole (cleared by the next success).
  const [rangeError, setRangeError] = useState<string>();
  const [coverage, setCoverage] = useState<CalendarCoverage[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<PublicCalendarEvent[]>(
    [],
  );
  const [account, setAccount] = useState<PublicAccountStatus>();
  // Each message is its own event (id), so the same words said again show again instead of being swallowed.
  const [notice, setNotice] = useState({ id: 0, text: "" });
  const message = notice.text;
  const setMessage = (text: string) => setNotice((old) => ({ id: old.id + 1, text }));
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [range, setRange] = useState<{ startMs: number; endMs: number }>();
  const rangeGeneration = useRef(0);
  const scheduler = useRef(new PremiumPreparationScheduler()).current;
  const mounted = useRef(true);
  const schedulerRef = useRef<() => Promise<void>>(async () => {});
  const refreshAccount = useCallback(async () => {
    try {
      // Re-read every minute: an unchanged account keeps the same object, so nothing re-renders.
      const next = await api.account();
      setAccount((old) => keepIfUnchanged(old, next));
    } catch {
      const unavailable: PublicAccountStatus = {
        configured: false,
        signedIn: false,
        plan: "none",
        subscriptionStatus: "unavailable",
        canUseAI: false,
        canAutoPrepare: false,
        billingAvailable: false,
      };
      setAccount((old) => keepIfUnchanged(old, unavailable));
    }
  }, []);
  const refreshWorkspaces = useCallback(async () => {
    setWorkspaces(await api.listWorkspaces());
  }, []);
  const refreshAccounts = useCallback(async () => {
    try {
      const next = await api.accounts();
      // Keep the same array when nothing changed, so views and Settings do not re-read their calendar lists.
      setAccounts((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    } finally {
      setAccountsLoaded(true);
    }
  }, []);
  const save = useCallback(async () => {
    try {
      const saved = await session.save();
      if (saved)
        setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
      setMessage("Meeting plan saved locally");
      return saved;
    } catch (error) {
      setMessage(
        "Plan save conflict or unavailable. Your edits remain here; reload the saved plan before retrying.",
      );
      throw error;
    }
  }, [session]);
  const edit = (patch: Partial<PublicMeetingPlan>) => {
    if (session.current) invalidatePreparationPlan(session.current.id);
    if (patch.sharedLibraryIds && session.current) {
      const allowed = [session.current.workspaceId, ...patch.sharedLibraryIds];
      patch = {
        ...patch,
        sourceIds: session.current.sourceIds.filter((id) => {
          const source = sources.find((s) => s.sourceId === id);
          return !source || allowed.includes(source.workspaceId);
        }),
      };
    }
    session.edit(patch);
  };
  const openPlan = async (id: string) => {
    setLoading(true);
    try {
      await session.open(id);
      if (session.current) {
        hydrateRef.current(session.current);
        setMessage("Saved meeting plan loaded");
      }
    } catch {
      setMessage(
        "Could not open the saved plan. Current edits were preserved.",
      );
    } finally {
      setLoading(false);
    }
  };
  const reloadPlan = async () => {
    setLoading(true);
    try {
      await session.reloadPreservingDraft(crypto.randomUUID());
      if (session.current) hydrateRef.current(session.current);
      setPlans(await api.listPlans());
      setMessage(
        "Saved plan reloaded. Any unsaved work was preserved as a recovered manual draft.",
      );
    } catch {
      setMessage(
        "Reload unavailable. Your current edits remain in this editor.",
      );
    } finally {
      setLoading(false);
    }
  };
  /**
   * A new plan, from a calendar event or made by hand. `initial` (the Calendar's New meeting popover) gives a hand-made
   * plan its title and time up front; that caller shows its own confirmation, so the generic "saved" message is skipped.
   * Resolves to the saved plan, or undefined when it could not be saved (the message then says why).
   */
  const newPlan = async (event?: PublicCalendarEvent, initial?: { title: string; startMs: number; endMs: number }): Promise<PublicMeetingPlan | undefined> => {
    setLoading(true);
    try {
      if (session.dirty) await save();
      const existing = event
        ? plans.find((p) => p.eventId === event.id)
        : undefined;
      if (existing) {
        await openPlan(existing.id);
        return existing;
      }
      const fresh = newMeetingPlan(crypto.randomUUID(), Date.now(), event);
      const plan = initial && !event ? { ...fresh, ...initial, title: initial.title.trim(), profileId: inferProfile(initial.title) } : fresh;
      session.replace(plan);
      hydrateRef.current(plan);
      const saved = await save();
      if (initial) setMessage("");
      return saved;
    } catch {
      setMessage(
        "Could not save this plan. Current draft remains in the editor.",
      );
    } finally {
      setLoading(false);
    }
  };
  const acceptedCallPlan = async (title: string) => {
    if (session.dirty) await save();
    const fresh = createAcceptedCallPlan(title, crypto.randomUUID());
    const saved = await api.savePlan(fresh);
    session.replace(saved);
    hydrateRef.current(saved);
    setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
    return saved;
  };
  const loadRange = useCallback(async (startMs: number, endMs: number) => {
    const generation = ++rangeGeneration.current;
    setRange({ startMs, endMs });
    try {
      const result = await api.events(startMs, endMs);
      if (generation !== rangeGeneration.current) return;
      setCalendarEvents(result.events.filter((e) => !e.cancelled));
      setCoverage(result.coverage);
      setRangeError(undefined);
      // Loading re-checks macOS access and account state natively; pick that up (access withdrawn, sign-in needed).
      void refreshAccounts().catch(() => {});
    } catch (error) {
      if (generation !== rangeGeneration.current) return;
      setCalendarEvents([]);
      setCoverage([]);
      // The Calendar's status line says this with Retry (rangeError); no second message in a toast.
      setRangeError(typeof error === "string" && error.startsWith("calendar") ? error : "calendarUnavailable");
    }
  }, [refreshAccounts]);
  const [writable, setWritable] = useState<WritableCalendar[]>();
  const [pendingCalendar, setPendingCalendar] = useState<PendingCalendarChange>();
  // Plans whose event was added to the calendar while their own record of it failed to save (by plan id).
  const unrecordedCalendarSaves = useRef(new Map<string, Partial<PublicMeetingPlan>>());
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState("");
  const refreshWritableCalendars = useCallback(async () => {
    try {
      const result = await api.calendarCapabilities();
      setWritable(result.permission === "granted" ? onlyWritable(result.capabilities) : []);
    } catch {
      setWritable([]);
    }
  }, []);
  /** Prepares the exact add or update for the current plan; nothing is written until `confirmCalendarChange`. */
  const proposeCalendarSave = async (calendar: WritableCalendar) => {
    const plan = session.current;
    if (!plan || plan.startMs === undefined || plan.endMs === undefined) return;
    const state = calendarSaveState(plan);
    if (state !== "notSaved" && state !== "changed") return;
    const unrecorded = unrecordedCalendarSaves.current.get(plan.id);
    if (state === "notSaved" && unrecorded?.calendarSync) {
      // This plan's event was written but its record was not saved; a second add would duplicate the event.
      setCalendarError(PLAN_SYNC_NOT_SAVED(unrecorded.calendarSync.calendarName));
      return;
    }
    const sync = state === "changed" ? plan.calendarSync : undefined;
    const target = sync ? { ...calendar, id: sync.calendarId } : calendar;
    const after = { title: plan.title, startMs: plan.startMs, endMs: plan.endMs };
    setCalendarBusy(true);
    setCalendarError("");
    try {
      const proposal = await api.prepareCalendarChange({
        calendarId: target.id,
        eventId: sync?.nativeEventId,
        originalStartMs: sync?.syncedStartMs,
        ...after,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        inferred: false,
      });
      setPendingCalendar({
        kind: "calendar",
        proposal,
        planId: plan.id,
        calendar: target,
        after,
        before: sync ? readBack(proposal.before) : undefined,
      });
    } catch (error) {
      setCalendarError(calendarSaveErrorMessage(error));
    } finally {
      setCalendarBusy(false);
    }
  };
  const confirmCalendarChange = async () => {
    const pending = pendingCalendar;
    if (!pending) return;
    setCalendarBusy(true);
    setCalendarError("");
    if (pending.kind === "ics") {
      try {
        // Undefined: an earlier click saved it (or is saving it) and reports it; nothing to do here.
        const saved = await api.applyFileProposal(pending.proposal.id);
        setPendingCalendar(undefined);
        if (saved !== undefined) setMessage("Calendar file saved. Open it to add the meeting to any calendar.");
      } catch (error) {
        // A failed file save wrote nothing. Keep it open to save again only when the proposal is back in review;
        // a refused approval can never succeed under it, so say why and close it.
        const failure = icsSaveFailure(error);
        setCalendarError(failure.message);
        if (!failure.retry) setPendingCalendar(undefined);
      } finally {
        setCalendarBusy(false);
      }
      return;
    }
    const outcome = await applyCalendarSave(
      { proposalId: pending.proposal.id, calendar: pending.calendar },
      {
        apply: (proposalId) => api.applyCalendarChange(proposalId),
        recordOnPlan: async (patch) => {
          if (session.current?.id === pending.planId) {
            // The record stays on the open plan even if the save below fails, so it does not offer a second add.
            session.edit(patch);
            await save();
          } else {
            const stored = await api.getPlan(pending.planId);
            if (!stored) throw new Error("planNotFound");
            const saved = await api.savePlan({ ...stored, ...patch });
            setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
          }
        },
      },
    );
    setPendingCalendar(undefined);
    setCalendarBusy(false);
    if (outcome.status === "earlier") return;
    if (outcome.status === "notApplied") {
      setCalendarError(outcome.error);
      return;
    }
    if (outcome.status === "planNotSaved") {
      // The event exists: block another add of this plan until a reload shows its saved state.
      unrecordedCalendarSaves.current.set(pending.planId, outcome.patch);
      setPlans((old) => old.map((p) => (p.id === pending.planId ? { ...p, ...outcome.patch } : p)));
      setCalendarError(outcome.error);
    } else {
      unrecordedCalendarSaves.current.delete(pending.planId);
      setMessage(`Saved to ${calendarLabel(pending.calendar)}`);
    }
    void refreshAccounts().catch(() => {});
    if (range) void loadRange(range.startMs, range.endMs);
  };
  /** The fallback when no calendar on this Mac can be written: a reviewed .ics file the user opens themselves. */
  const proposeIcsFile = async () => {
    const plan = session.current;
    if (!plan || plan.startMs === undefined || plan.endMs === undefined) return;
    const after = { title: plan.title, startMs: plan.startMs, endMs: plan.endMs };
    setCalendarError("");
    try {
      const path = await api.chooseIcsPath(plan.title);
      if (!path) return;
      setCalendarBusy(true);
      const draft = makeCalendarProposal({
        id: plan.id,
        title: after.title,
        start: new Date(after.startMs).toISOString(),
        end: new Date(after.endMs).toISOString(),
        inferred: false,
      });
      const proposal = await api.proposeFile(path, draft.after);
      setPendingCalendar({ kind: "ics", proposal, planId: plan.id, path, after });
    } catch (error) {
      setCalendarError(calendarSaveErrorMessage(error));
    } finally {
      setCalendarBusy(false);
    }
  };
  const cancelCalendarChange = () => {
    const pending = pendingCalendar;
    setPendingCalendar(undefined);
    if (pending) void api.declineCalendarChange(pending.proposal.id).catch(() => {});
  };
  // ---- Moving a calendar event (reviewed; see calendarMove.ts) ----
  // The controller lives across renders; what it calls back into reads the latest state through this ref.
  const moveRef = useRef<{ applied: (move: AppliedMove) => Promise<void>; changed: () => void; name: (id: string) => string | undefined }>(undefined as never);
  moveRef.current = {
    applied: async (move) => {
      setCalendarEvents((old) => old.map((e) => (e.id === move.previousEventId ? move.event : e)));
      const planId =
        move.planId ??
        (session.current?.eventId === move.previousEventId ? session.current.id : plans.find((p) => p.eventId === move.previousEventId)?.id);
      if (planId) {
        // New times and the event's new list id; an app-created plan keeps its sync record in step. A plan opened from
        // someone's calendar is not marked as created by the app.
        const patchFor = (plan: PublicMeetingPlan): Partial<PublicMeetingPlan> => ({
          startMs: move.after.startMs,
          endMs: move.after.endMs,
          ...(plan.eventId ? { eventId: move.eventId } : {}),
          ...(plan.calendarSync
            ? { calendarSync: { ...plan.calendarSync, nativeEventId: move.native.id, version: move.native.version, syncedStartMs: move.after.startMs, syncedEndMs: move.after.endMs } }
            : {}),
        });
        if (session.current?.id === planId) {
          session.edit(patchFor(session.current));
          await save();
        } else {
          const stored = await api.getPlan(planId);
          if (stored) {
            const saved = await api.savePlan({ ...stored, ...patchFor(stored) });
            setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
          }
        }
      }
      setMessage(move.revert ? `Moved back in ${move.calendarName}` : `Moved in ${move.calendarName}`);
      if (range) void loadRange(range.startMs, range.endMs);
    },
    changed: () => {
      if (range) void loadRange(range.startMs, range.endMs);
    },
    name: (id) => {
      const calendar = writable?.find((c) => c.id === id);
      return calendar ? calendarLabel(calendar) : undefined;
    },
  };
  const moverRef = useRef<CalendarMoveController | undefined>(undefined);
  if (!moverRef.current)
    moverRef.current = new CalendarMoveController(
      {
        api,
        calendarName: (id) => moveRef.current.name(id),
        onMoved: (move) => moveRef.current.applied(move),
        onChangedMeanwhile: () => moveRef.current.changed(),
      },
      () => render((n) => n + 1),
    );
  const mover = moverRef.current;
  /**
   * Prepares moving a calendar event (or the event a plan is linked to) to `range`; nothing is written until
   * `calendarMove.confirm`. Only macOS events that are not repeating or all-day, in calendars that accept changes, can
   * move; an invitation can, and the pending move carries the warning to show.
   */
  const proposeMove = async (subject: PublicMeetingPlan | PublicCalendarEvent, target: MoveRange) => {
    const isEvent = "provider" in subject;
    const event = isEvent ? subject : calendarEvents.find((e) => e.id === subject.eventId);
    if (!event) {
      mover.refuse("eventNotLoaded", "Calendar not loaded for this day. Nothing was changed.");
      return;
    }
    const planId = isEvent
      ? session.current?.eventId === event.id
        ? session.current.id
        : plans.find((p) => p.eventId === event.id)?.id
      : subject.id;
    return mover.propose(event, target, { planId });
  };
  /**
   * Saves new times for a plan that lives only in this app (the day panel's direct move of another meeting). The open
   * plan is edited in place and autosaved; another plan is read, changed and saved. Resolves to false when it failed.
   */
  const setPlanTimes = async (planId: string, target: MoveRange): Promise<boolean> => {
    if (session.current?.id === planId) {
      edit({ startMs: target.startMs, endMs: target.endMs });
      return true;
    }
    try {
      const stored = await api.getPlan(planId);
      if (!stored) return false;
      const saved = await api.savePlan({ ...stored, startMs: target.startMs, endMs: target.endMs });
      setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
      return true;
    } catch {
      return false;
    }
  };
  const prepare = async (
    request = "",
    automatic = false,
    started = session.current,
  ) => {
    if (!started || (!automatic && preparing)) return;
    if (!automatic) setPreparing(true);
    try {
      if (!account?.canUseAI)
        throw Error(
          "An active app subscription is required for online text reasoning",
        );
      const result = await generatePreparation(
        structuredClone(started),
        request,
        automatic,
      );
      if (!mounted.current) return;
      if (automatic && started.eventId) {
        const checked = await api.events(Date.now(), Date.now() + 86400000);
        const event = checked.events.find(
          (e) => e.id === started.eventId && !e.cancelled,
        );
        if (
          !event ||
          event.title !== started.title ||
          event.startMs !== started.startMs ||
          event.endMs !== started.endMs
        ) {
          setMessage(
            "The scheduled event changed during preparation. Your saved draft was preserved; review the updated calendar event.",
          );
          return;
        }
      }
      await result.validateEvidence();
      if (session.current?.id === started.id) {
        const accepted = acceptPreparation(
          session.current,
          started,
          result.text,
        );
        if (!accepted) {
          setMessage(
            "Preparation finished after edits changed; your newer draft was preserved.",
          );
          return;
        }
        session.edit({
          briefDraft: accepted.briefDraft,
          draftEvidence: result.evidence,
        });
        hydrateRef.current(session.current!);
        await save();
      } else {
        const current = await api.getPlan(started.id);
        if (!current) return;
        await result.validateEvidence();
        // A user may reopen and edit this meeting while the native reads are pending.
        const latest =
          session.current?.id === started.id ? session.current : current;
        const accepted = acceptPreparation(latest, started, result.text);
        if (!accepted) return;
        if (session.current?.id === started.id) {
          session.edit({
            briefDraft: accepted.briefDraft,
            draftEvidence: result.evidence,
          });
          hydrateRef.current(session.current!);
          await save();
          setMessage("Preparation draft saved. Review it before finalizing.");
          return;
        }
        const saved = await api.savePlan({
          ...accepted,
          draftEvidence: result.evidence,
        });
        setPlans((old) => [saved, ...old.filter((p) => p.id !== saved.id)]);
      }
      setMessage("Preparation draft saved. Review it before finalizing.");
    } catch (error) {
      setMessage(
        "Preparation unavailable. You can edit a brief yourself or start without one.",
      );
    } finally {
      if (!automatic) setPreparing(false);
    }
  };
  schedulerRef.current = async () => {
    if (!PUBLIC_EDITION) return;
    const all = plans.map((p) =>
      p.id === session.current?.id ? session.current : p,
    );
    try {
      await scheduler.tick(
        all,
        account,
        Date.now(),
        async (candidate) => {
          await prepare(
            "Prepare from the opted-in meeting objectives and selected evidence.",
            true,
            candidate,
          );
        },
        async (candidate) => {
          if (!candidate.eventId) return false;
          const now = Date.now();
          const result = await api.events(now, now + 86400000);
          const event = result.events.find(
            (e) => e.id === candidate.eventId && !e.cancelled,
          );
          const covered = result.coverage.some(
            (row) =>
              row.accountId === candidate.calendarAccountId &&
              (!row.calendarId || row.calendarId === candidate.calendarId) &&
              row.status === "ready" &&
              row.startMs <= candidate.startMs! &&
              row.endMs >= candidate.endMs!,
          );
          const latest =
            session.current?.id === candidate.id
              ? session.current
              : await api.getPlan(candidate.id);
          return (
            !!event &&
            covered &&
            !!latest &&
            latest.automaticPreparation &&
            preparationIdentity(latest) === preparationIdentity(candidate) &&
            event.title === candidate.title &&
            event.startMs === candidate.startMs &&
            event.endMs === candidate.endMs
          );
        },
      );
    } catch {
      setMessage(
        "Automatic preparation waiting for calendar or service access. Existing drafts remain saved.",
      );
    }
  };
  useEffect(
    () =>
      subscribePreparationInvalidation((workspaceId) => {
        const plan = session.current;
        if (
          !plan ||
          !(
            plan.workspaceId === workspaceId ||
            plan.sharedLibraryIds.includes(workspaceId)
          )
        )
          return;
        session.edit({
          reviewedBrief: undefined,
          draftEvidence: [],
          status: "draft",
        });
        hydrateRef.current(session.current!);
        setMessage(
          "Workspace context changed. Review your retained draft and regenerate its evidence before finalizing.",
        );
      }),
    [],
  );
  useEffect(() => {
    if (!PUBLIC_EDITION) return;
    mounted.current = true;
    void refreshAccount();
    void refreshWorkspaces().catch(() =>
      setMessage("Workspace library unavailable"),
    );
    void refreshAccounts().catch(() => {});
    void api
      .listPlans()
      .then(setPlans)
      .catch(() => setMessage("Saved meeting plans unavailable"));
    session.replace(newMeetingPlan(crypto.randomUUID()));
    session.dirty = false;
    hydrateRef.current(session.current!);
    const timer = setInterval(() => void schedulerRef.current(), 30000);
    const statusTimer = setInterval(() => void refreshAccount(), 60000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearInterval(statusTimer);
    };
  }, []);
  const current = session.current;
  useEffect(() => {
    if (!PUBLIC_EDITION || !current || !session.dirty) return;
    const timer = setTimeout(() => void save().catch(() => {}), 600);
    return () => clearTimeout(timer);
  }, [current?.updatedAtMs, current?.id, session.dirty]);
  useEffect(() => {
    if (!PUBLIC_EDITION || !current || current.workspaceId === "default") {
      setSources([]);
      return;
    }
    let valid = true;
    void api
      .sources(current.workspaceId)
      .then((rows) => {
        if (valid)
          setSources(
            rows.filter(
              (s) =>
                s.workspaceId === current.workspaceId ||
                current.sharedLibraryIds.includes(s.workspaceId),
            ),
          );
      })
      .catch(() => {
        if (valid) setSources([]);
      });
    return () => {
      valid = false;
    };
  }, [
    current?.workspaceId,
    JSON.stringify(current?.sharedLibraryIds),
    workspaces,
  ]);
  const assignWorkspace = async (id: string) => {
    edit({
      workspaceId: id,
      sourceSelection: "workspace",
      sourceIds: [],
      sharedLibraryIds: [],
    });
    hydrateRef.current(session.current!);
    if (id !== "default") {
      try {
        const rows = await api.sources(id);
        if (session.current?.workspaceId !== id) return;
        setSources(rows.filter((s) => s.workspaceId === id));
      } catch {
        setMessage(
          "Workspace sources unavailable; source selection remains empty.",
        );
      }
    }
  };
  return {
    enabled: PUBLIC_EDITION,
    current,
    plans,
    workspaces,
    sources,
    accounts,
    accountsLoaded,
    rangeError,
    coverage,
    calendarEvents,
    account,
    message,
    messageId: notice.id,
    loading,
    preparing,
    range,
    dirty: session.dirty,
    edit,
    save,
    openPlan,
    setPlanTimes,
    reloadPlan,
    newPlan,
    acceptedCallPlan,
    assignWorkspace,
    prepare,
    invalidatePreparationRequest: () => {
      if (session.current) invalidatePreparationPlan(session.current.id);
    },
    refreshAccount,
    refreshWorkspaces,
    refreshAccounts,
    loadRange,
    setMessage,
    calendarSave: {
      writable,
      pending: pendingCalendar,
      busy: calendarBusy,
      error: calendarError,
      refresh: refreshWritableCalendars,
      propose: proposeCalendarSave,
      proposeIcs: proposeIcsFile,
      confirm: confirmCalendarChange,
      cancel: cancelCalendarChange,
    },
    calendarMove: {
      pending: mover.state.pending,
      busy: mover.state.busy,
      error: mover.state.error,
      errorCode: mover.state.errorCode,
      /** The last verified move, for "Moved in Work calendar · Undo". */
      lastMove: mover.state.lastMove,
      propose: proposeMove,
      /** Undo = the reverse move, reviewed again (opens the same pending card). */
      proposeRevert: (move?: AppliedMove) => mover.proposeRevert(move),
      confirm: () => mover.confirm(),
      cancel: () => mover.cancel(),
      clearError: () => mover.clearError(),
    },
    saveWorkspace: async (workspace: PublicWorkspace) => {
      const saved = await api.saveWorkspace(workspace);
      await refreshWorkspaces();
      return saved;
    },
    signIn: async () => {
      setAccount(await api.signIn());
    },
    cancelSignIn: () => api.cancelSignIn(),
    signOut: async () => {
      await api.signOut();
      await refreshAccount();
    },
    signOutAll: async () => {
      try {
        await api.signOutAll();
      } finally {
        await refreshAccount();
      }
    },
  };
}
export type PublicProduct = ReturnType<typeof usePublicProduct>;
