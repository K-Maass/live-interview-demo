import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  meetingProfiles,
  type MeetingRecord,
  type ProfileId,
  type SpeechEvent,
  type SpeechReadiness,
  type LocalMeetingOptions,
  type Brief,
  type CallHint,
  offerUnpreparedCall,
  offerAmbiguousCalls,
  shouldStartPreparedCall,
  inferProfile,
  applyGuidanceEvent,
  pinTopic,
  settlePin,
  reopenPin,
  dismissCard,
  resurfacePins,
  type GuidanceCard,
  type PinOutcome,
  type MeetingOptions,
  type AssistanceIntent,
  type PreparationCounts,
} from "@live-interview/core";
import {
  native,
  readiness,
  setupModels,
  warmupState,
  warmSpeech,
  restartSpeech,
  cancelModelSetup,
  setExperimentalMediumTranslation,
  startLocalMeeting,
  pauseLocalMeeting,
  resumeLocalMeeting,
  stopLocalMeeting,
} from "../lib/localVoice";
import {
  applyModelSetupEvent,
  failModelSetup,
  idleModelSetup,
  requestModelSetupCancel,
  startModelSetup,
  type ModelSetupEvent,
  type ModelSetupState,
} from "../lib/public/modelSetup";
import { retryLocalSpeech, warmLocalSpeech, watchSlowWarmup } from "../lib/public/speechWarmup";
import { intents } from "./LivePanel";
import { routeSpeech, finalizationTargets } from "../lib/copilot/eventRouting";
import type { StatusTone } from "../lib/copilot/announcements";
import { describeStatus, initialAssistanceStatus, type AssistanceStatus, type StatusEvent } from "../lib/copilot/status";
import { useStopConfirmation } from "./useStopConfirmation";
import { useMeetingShortcuts } from "./useMeetingShortcuts";
import { attentionAfterArtifactSave, clearAttention, destinationOutcome, markAttention, type AttentionKind, type AttentionMap } from "../lib/copilot/recordAttention";
import { laneHealthMessage } from "./presentation/model";
import {
  CopilotRuntime,
  nativeReasoningHost,
  type GuidanceLatencyTrace,
} from "../lib/copilot/runtime";
import {
  defaultShortcuts,
  resolveShortcuts,
  targetCard,
  type Shortcuts,
  type ShortcutAction,
} from "../lib/copilot/shortcuts";
import type { Workspace, LoadedCalendarRange, UpcomingMeeting } from "./presentation/types";
import { usePublicProduct } from "../lib/public/usePublicProduct";
import { PUBLIC_EDITION } from "../lib/edition";
import type { PublicMeetingPlan } from "@live-interview/core";
import { objectiveLines } from "../lib/public/state";
import { accountSelfName, publicCaptureOptions } from "../lib/public/capture";
import { invalidatePreparationWorkspace } from "../lib/public/reasoning";
import { sourceScope } from "../lib/public/reasoning";
import { ensureSynthesis, publicArtifacts } from "../lib/public/synthesis";
import { publicClient } from "../lib/public/client";
import { pinsNote } from "../lib/copilot/pinsNote";
import { anotherInstanceStatus, capturePlanForStart, guidanceStartFailedStatus, planSaveFailedStatus, replayRefusal, startErrorMessage, startErrorTone, startRecordingSession, stopErrorStatus } from "../lib/copilot/startRecording";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { LiveStore, transcriptEntriesOf, transcriptOf } from "./liveStore";
/** Plain JSON from a native call: equal when it serialises the same, so an unchanged poll keeps the old value. */
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** A setter that keeps the current value (and skips the render) when the next one is structurally the same. */
const keepUnchanged = <T,>(set: (update: (old: T) => T) => void) => (next: T) => set((old) => (sameJson(old, next) ? old : next));
export type CaptureHealth = Record<string, { code: string; detail?: string | null }>;
export type DetectionDiagnostics = {
  processCount: number;
  incomplete: boolean;
  activation?: { windowsReturned?: number; uniqueWindows?: number }[];
  windows: {
    hasTitle: boolean;
    meetingShapedTitle?: boolean;
    matched: { leave: boolean; microphone: boolean; camera: boolean };
    counts: {
      nodesVisited: number;
      maxDepthSeen: number;
      clipped: boolean;
      errors: number;
      foreignWindowButtons?: number;
      unknownWindowButtons?: number;
    };
  }[];
};
// Stage timings only (no card text); read them in the webview console.
const logGuidanceLatency = (trace: GuidanceLatencyTrace) =>
  console.debug("[guidance-latency]", trace.path, trace.intent, trace.timings);
// Counts of speculative preparation jobs at the end of a meeting; never text.
const logPreparationCounts = (counts: PreparationCounts) =>
  console.debug("[guidance-preparation]", counts);

export function useCopilotController() {
  const [brief, setBrief] = useState<Brief>();
  const [armed, setArmed] = useState(false);
  const [armedUntil, setArmedUntil] = useState(0);
  const publicReviewedBrief=useRef<Brief|undefined>(undefined);
  const [upcoming, setUpcoming] = useState<UpcomingMeeting[]>([]);
  const [scheduledEndMs, setScheduledEnd] = useState<number>();
  const [coveredPins, setCoveredPins] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [shortcuts, setShortcuts] = useState<Shortcuts>(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("liveInterview.shortcuts") || "null",
      );
      return resolveShortcuts(stored);
    } catch {
      return defaultShortcuts;
    }
  });
  const controls = useRef<(action: ShortcutAction) => void>(() => {});
  /** Accelerators the last completed registration could not claim; kept until a later apply registers them all. */
  const [unavailableShortcuts, setUnavailableShortcuts] = useState<string[]>([]);
  const sessionGeneration = useRef(0);
  const operationActive = useRef(false);
  const synthesisTargets = useRef(new Set<string>());
  const synthesizeStopped = useRef<(record: MeetingRecord) => void>(()=>{});
  const [callOffer, setCallOffer] = useState<{
    title: string;
    expiresAt: number;
  }>();
  const [callChoices, setCallChoices] = useState<
    ReturnType<typeof offerAmbiguousCalls>
  >([]);
  const [detectionStatus, setDetectionStatus] = useState(
    "Teams detection awaits setup/validation",
  );
  const [detectionDiagnostics, setDetectionDiagnostics] =
    useState<DetectionDiagnostics>();
  const startRef = useRef<
    ((purposeOverride?: string) => Promise<void>) | undefined
  >(undefined);
  const [participants, setParticipants] = useState<MeetingOptions["attendees"]>(
    [],
  );
  const [sessionKind, setSessionKind] = useState<"recording" | "replay">(
    "recording",
  );
  const displayedMeetingId = useRef<string | undefined>(undefined);
  const [selectedRecord, setSelectedRecord] = useState<MeetingRecord>();
  const runtime = useRef<CopilotRuntime | undefined>(undefined);
  // The signed-in plan, read by the reasoning host at each request (public edition only).
  const accountPlan = useRef<"none" | "standard" | "premium" | undefined>(undefined);
  const reasoningHost = () => nativeReasoningHost(() => accountPlan.current);
  const [workspace, setWorkspace] = useState("default");
  // Frames, transcript events and the guidance view change many times a minute during a meeting; they live in a small
  // external store so those updates re-render only the live surfaces, never this controller's host (see liveStore.ts).
  const [live] = useState(() => new LiveStore());
  const { setEvents, setFrames, setView } = live;
  const [assistance, setAssistance] = useState<AssistanceStatus>(initialAssistanceStatus);
  const statusSequence = useRef(0);
  /** Every report is a new event (its own id), so the same words reported twice show and are spoken again. */
  const latestAssistance = useRef(assistance);
  const reportStatus = (event: StatusEvent) => { const next = describeStatus(event, ++statusSequence.current); latestAssistance.current = next; setAssistance(next); };
  /**
   * The runtime's own reports. It repeats an informational hint (such as "summary is catching up" while a provider is
   * unreachable) on every transcript line; the same hint again keeps the current status instead of re-rendering the
   * shell for each line. A changed hint, any degraded report, and every panel message still arrive as new events.
   */
  const reportRuntimeStatus = (event: StatusEvent) => {
    const current = latestAssistance.current;
    if (event.code !== "message" && event.code !== "shortcutUnavailable" && current.code === event.code && current.severity === "info" && current.detail === event.detail) return;
    reportStatus(event);
  };
  /** Plain words from a panel; `degraded` (not the wording) decides whether a screen reader is told. */
  const setAssistanceStatus = (text: string, degraded = false) => reportStatus({ code: "message", text, severity: degraded ? "degraded" : "info" });
  const [assistancePaused, setAssistancePaused] = useState(false);
  const [ready, setReady] = useState<SpeechReadiness>();
  const [busy, setBusy] = useState(false);
  // Model download has its own state: it must never share `busy`, which disables Stop while a meeting records.
  const [modelSetup, setModelSetup] = useState<ModelSetupState>(idleModelSetup);
  const [statusLine, setStatusLine] = useState<{ text: string; tone: StatusTone }>({ text: "Ready to prepare", tone: "info" });
  const status = statusLine.text;
  /** `tone` (not the wording) decides whether the line is shown and announced as a problem. */
  const setStatus = (text: string, tone: StatusTone = "info") => setStatusLine((old) => (old.text === text && old.tone === tone ? old : { text, tone }));
  const [profile, setProfile] = useState<ProfileId>("workClient");
  const [purpose, setPurpose] = useState("");
  const [objectives, setObjectives] = useState("");
  const [publicTopics, setPublicTopics] = useState("");
  const [meeting, setMeeting] = useState<LocalMeetingOptions>();
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pauseInFlight = useRef(false);
  const [records, setRecords] = useState<MeetingRecord[]>([]);
  const [speechStatus, setSpeechStatus] = useState("Local");
  // Each launch, setup or Retry load gets a number; only the newest may change the status (#58).
  const warmAttempt = useRef(0);
  const startWarmup = (retry = false) => {
    const attempt = ++warmAttempt.current;
    const deps = { state: warmupState, warm: warmSpeech, setStatus: setSpeechStatus, isCurrent: () => warmAttempt.current === attempt };
    void (retry ? retryLocalSpeech(restartSpeech, deps) : warmLocalSpeech(deps));
  };
  const retrySpeech = () => startWarmup(true);
  // A load that runs well past its usual time says so and offers Retry instead of an endless "Preparing".
  useEffect(() => watchSlowWarmup(speechStatus, setSpeechStatus), [speechStatus]);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth>({});
  const [retain, setRetain] = useState(false);
  const [inputDevices, setInputDevices] = useState<string[]>([]);
  const [inputDevice, setInputDevice] = useState("");
  const [inputDeviceAvailability, setInputDeviceAvailability] = useState<
    "loading" | "ready" | "pending" | "unavailable"
  >("loading");
  const [english, setEnglish] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [calendarRange, setCalendarRange] = useState<LoadedCalendarRange>();
  const [knownPeople, setKnownPeople] = useState<MeetingOptions["attendees"]>([]);
  const [personName, setPersonName] = useState("");
  useEffect(() => {
    if (!meeting) void invoke<MeetingOptions["attendees"]>("list_people").then(setKnownPeople).catch(() => {});
  }, [!!meeting]);
  useEffect(() => {
    if (!native()) {
      setInputDeviceAvailability("unavailable");
      return;
    }
    void invoke<string[]>("list_input_devices")
      .then((devices) => {
        setInputDevices(devices);
        setInputDeviceAvailability("ready");
      })
      .catch((error: unknown) =>
        setInputDeviceAvailability(
          error === "inputDeviceListPending" ? "pending" : "unavailable",
        ),
      );
    void readiness().then((r) => {
      setReady(r);
      if (r.recognitionReady) {
        // Starts at launch, so after an update the new helper loads before the next meeting (#83).
        startWarmup();
      }
    }).catch(() => setReady({ recognitionReady: false, translationReady: false, code: "unavailable" }));
    void invoke<MeetingRecord[]>("list_meeting_records").then(setRecords).catch((error: unknown) => { console.warn("list_meeting_records failed", error); setStatus("Saved meetings could not be listed. Reopen Meetings to try again.", "alert"); });
    // A second copy of the app neither records nor recovers; it says so once, calmly.
    void invoke<{ primary: boolean }>("instance_state").then((s) => { if (!s.primary) setStatus(anotherInstanceStatus, "notice"); }).catch(() => {});
    const initialGeneration = sessionGeneration.current;
    void invoke<
      | (MeetingRecord & { paused: boolean; captureHealth?: CaptureHealth })
      | null
    >("current_local_session").then((record) => {
      if (record && initialGeneration === sessionGeneration.current) {
        runtime.current?.stop();
        displayedMeetingId.current = record.id;
        setMeeting({ ...record, retainAudio: false });
        setEvents(record.segments);
        setProfile(record.profileId);
        setPaused(record.paused);
        setCaptureHealth(record.captureHealth ?? {});
        setStatus(
          record.paused
            ? "Recovered paused recording"
            : "Recovered active recording",
        );
        runtime.current = new CopilotRuntime(
          record,
          (event) => setView((old) => applyGuidanceEvent(old, event)),
          reportRuntimeStatus,
          reasoningHost(),
          logGuidanceLatency,
          logPreparationCounts,
        );
        for (const event of record.segments) runtime.current.ingest(event);
        runtime.current.start();
        void invoke<{ text: string }>("read_internal_note", {
          meetingId: record.id,
          kind: "pins",
        })
          .then((note) => {
            if (runtime.current?.state.id !== record.id) return;
            const pins = JSON.parse(note.text) as GuidanceCard[];
            if (Array.isArray(pins)) {
              setView((old) => ({ ...old, savedPins: pins }));
              runtime.current.setPins(pins);
            }
          })
          .catch(() => {});
      }
    }).catch((error: unknown) => console.warn("current_local_session failed", error));
    const listeners = [
      listen<ModelSetupEvent>("model-setup-progress", (e) => setModelSetup((old) => applyModelSetupEvent(old, e.payload, Date.now()))),
      listen<{workspaceId:string}>("workspace-context-changed",e=>{invalidatePreparationWorkspace(e.payload.workspaceId);runtime.current?.invalidateWorkspace(e.payload.workspaceId);}),
      listen<SpeechEvent>("speech-event", (e) =>
        routeSpeech(
          e.payload,
          runtime.current,
          displayedMeetingId.current,
          (event) =>
            setEvents((old) =>
              old.some(
                (s) =>
                  s.segmentId === event.segmentId &&
                  (s.revision > event.revision ||
                    (s.revision === event.revision &&
                      s.kind === "final" &&
                      event.kind === "partial")),
              )
                ? old
                : old
                    .filter((s) => s.segmentId !== event.segmentId)
                    .concat(event),
            ),
        ),
      ),
      listen<{ meetingId: string; lane: string; frames: number }>(
        "recording-frames",
        (e) => {
          if (e.payload.meetingId === displayedMeetingId.current)
            setFrames((old) =>
              old[e.payload.lane] === e.payload.frames
                ? old
                : { ...old, [e.payload.lane]: e.payload.frames },
            );
        },
      ),
      listen<{ meetingId: string; code: string }>("speech-health", (e) => {
        if (e.payload.meetingId === displayedMeetingId.current)
          setSpeechStatus(e.payload.code);
      }),
      listen<{
        meetingId: string;
        lane: string;
        code: string;
        detail?: string | null;
      }>("recording-health", (e) => {
        if (e.payload.meetingId === displayedMeetingId.current) {
          setCaptureHealth((old) =>
            old[e.payload.lane]?.code === e.payload.code &&
            old[e.payload.lane]?.detail === e.payload.detail
              ? old
              : {
                  ...old,
                  [e.payload.lane]: {
                    code: e.payload.code,
                    detail: e.payload.detail,
                  },
                },
          );
          // Plain words, never the raw code; only a lane that stopped capturing is an alert.
          const message = laneHealthMessage(e.payload.lane, e.payload.code, e.payload.detail);
          setStatus(message.text, message.tone);
        }
      }),
      // Launch recovery of a meeting the app closed during: refresh the archive and the open record's notice.
      listen<{ meetingId: string; state: string }>("record-recovery", (e) => {
        void invoke<MeetingRecord[]>("list_meeting_records").then(setRecords).catch((error: unknown) => console.warn("list_meeting_records failed", error));
        if (displayedMeetingId.current !== e.payload.meetingId || runtime.current?.state.id === e.payload.meetingId) return;
        void invoke<MeetingRecord>("load_meeting_record", { id: e.payload.meetingId }).then((record) => {
          setSelectedRecord((current) => (current?.id === record.id ? record : current));
          if (displayedMeetingId.current === record.id) setEvents(record.segments);
        }).catch((error: unknown) => console.warn("load_meeting_record failed", error));
      }),
      listen<{ meetingId: string }>("recording-finalized", (e) => {
        void invoke<MeetingRecord[]>("list_meeting_records").then(setRecords).catch((error: unknown) => console.warn("list_meeting_records failed", error));
        void invoke<MeetingRecord>("load_meeting_record", {
          id: finalizationTargets(
            e.payload.meetingId,
            runtime.current?.state.id,
            displayedMeetingId.current,
          ).refreshRecordId,
        }).then((record) => {
          synthesizeStopped.current(record);
          if (
            runtime.current?.state.id === record.id &&
            runtime.current.state.status === "stopped" &&
            displayedMeetingId.current === record.id
          ) {
            setMeeting(undefined);
            setSelectedRecord(record);
            setEvents(record.segments);
          }
          setSelectedRecord((current) =>
            current?.id === record.id ? record : current,
          );
          if (
            displayedMeetingId.current === record.id &&
            runtime.current?.state.id !== record.id
          )
            setEvents(record.segments);
        }).catch((error: unknown) => { console.warn("load_meeting_record failed", error); setStatus("The finished meeting could not be reloaded; the local record is preserved.", "alert"); });
      }),
    ];
    return () => {
      runtime.current?.stop();
      listeners.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("liveInterview.shortcuts", JSON.stringify(shortcuts));
  }, [shortcuts]);
  // System-wide keys only while a meeting is live (started, recovered or replayed); released on stop, finalise and quit.
  useMeetingShortcuts({
    api: native() ? { register, unregister } : undefined,
    enabled: native(),
    live: !!meeting,
    shortcuts,
    onAction: (action) => controls.current(action),
    onUnavailable: (keys) => reportStatus({ code: "shortcutUnavailable", detail: keys.join(", ") }),
    onApplied: setUnavailableShortcuts,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const start = async (purposeOverride?: string) => {
    if (operationActive.current || meeting) return;
    operationActive.current = true;
    sessionGeneration.current++;
    setBusy(true);
    try {
      let capturePlan:PublicMeetingPlan|undefined;
      // A failed local plan save never blocks recording; it is reported once recording runs.
      let planSaveFailed=false;
      if(PUBLIC_EDITION){const prepared=await capturePlanForStart(publicProduct,purposeOverride);capturePlan=prepared.plan;planSaveFailed=prepared.saveFailed;}
      const options: LocalMeetingOptions = {
        id: crypto.randomUUID(),
        ...(PUBLIC_EDITION ? { sourceIds: publicProduct.current ? sourceScope(publicProduct.current) : undefined, sharedLibraryIds: publicProduct.current?.sharedLibraryIds ?? [] } : {}),
        workspaceId: workspace,
        purpose: purposeOverride || purpose || meetingProfiles[profile].label,
        brief,
        objectives: objectives.split("\n").filter(Boolean),
        attendees: participants,
        selfName: PUBLIC_EDITION ? accountSelfName(publicProduct.account) : undefined,
        profileId: profile,
        profileRevision: 0,
        retainAudio: retain,
        scheduledEndMs,
        publicResearchTopics: publicTopics
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (capturePlan) Object.assign(options, publicCaptureOptions(capturePlan,options.id));
      displayedMeetingId.current = options.id;
      setCaptureHealth({});
      // From the moment native recording starts, the meeting state is set even if guidance cannot start, so Stop & save
      // and the meeting keys stay available and the recording is never left running unseen.
      const session = await startRecordingSession({
        startNative: () => startLocalMeeting(options, capturePlan ? capturePlan.inputDevice || undefined : inputDevice || undefined),
        startGuidance: () => {
          const previous = runtime.current;
          runtime.current = undefined;
          previous?.stop();
          const next = new CopilotRuntime(
            options,
            (event) => setView((old) => applyGuidanceEvent(old, event)),
            reportRuntimeStatus,
            reasoningHost(),
            logGuidanceLatency,
            logPreparationCounts,
          );
          runtime.current = next;
          try {
            next.start();
          } catch (error) {
            runtime.current = undefined;
            throw error;
          }
          return next;
        },
        markLive: () => {
          setSessionKind("recording");
          setView({ cards: [], savedPins: [], queued: 0 });
          setCoveredPins([]);
          setPaused(false);
          setAssistancePaused(false);
          setMeeting(options);
          setFrames({});
        },
      });
      // Recording runs from here; a failed read below must not say it could not start.
      const started = session.guidance;
      try {
        const current = await invoke<
          (MeetingRecord & { captureHealth?: CaptureHealth }) | null
        >("current_local_session");
        if (current?.id === options.id)
          setCaptureHealth(current.captureHealth ?? {});
        const saved = await invoke<MeetingRecord>("load_meeting_record", {
          id: options.id,
        });
        for (const event of saved.segments) started?.ingest(event);
        setEvents(saved.segments);
        if (session.guidanceFailed) setStatus(guidanceStartFailedStatus, "alert");
        else if (planSaveFailed) setStatus(planSaveFailedStatus, "alert");
        else setStatus("Recording");
      } catch {
        setStatus(session.guidanceFailed ? guidanceStartFailedStatus : "Recording, but the saved transcript could not be read yet. New speech still appears.", "alert");
      }
    } catch (error) {
      setStatus(startErrorMessage(error), startErrorTone(error));
    } finally {
      operationActive.current = false;
      setBusy(false);
    }
  };
  startRef.current = start;
  // Read by the poll below, so typing a title does not restart its interval.
  const purposeRef = useRef(purpose);
  purposeRef.current = purpose;
  useEffect(() => {
    if (!native() || meeting) return;
    let polling = false;
    const poll = async () => {
      // A slow detection must not stack another call on top of it.
      if (polling) return;
      polling = true;
      try {
        const hint = await invoke<
          CallHint & { diagnostics?: DetectionDiagnostics }
        >("detect_teams_call");
        // Every five seconds: an unchanged result keeps the same values, so nothing re-renders (U4).
        setDetectionStatus(hint.code || "Verified Teams call");
        keepUnchanged(setDetectionDiagnostics)(hint.diagnostics);
        keepUnchanged(setCallChoices)(offerAmbiguousCalls(hint, Date.now()));
        if (
          armed && (!PUBLIC_EDITION || !!publicReviewedBrief.current) &&
          shouldStartPreparedCall(
            { title: purposeRef.current, armed: true, expiresAt: armedUntil },
            hint,
            Date.now(),
          )
        ) {
          setArmed(false);
          void startRef.current?.();
        } else {
          // An offer's expiry moves forward with each sighting, so a live offer is a new value; no offer stays the same.
          keepUnchanged(setCallOffer)(offerUnpreparedCall(hint, Date.now()));
        }
      } catch {
        setDetectionStatus(
          "Teams detection unavailable; manual start remains available",
        );
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 5000);
    return () => clearInterval(timer);
  }, [meeting, armed, armedUntil]);
  /** Whether Stop would run now: never while a start, stop or replay is still in flight. */
  const stopAccepted = () => !!meeting && !operationActive.current;
  const stop = async () => {
    if (!meeting || !stopAccepted()) return;
    operationActive.current = true;
    setBusy(true);
    try {
      const record =
        sessionKind === "replay"
          ? await invoke<MeetingRecord>("load_meeting_record", {
              id: meeting.id,
            })
          : await stopLocalMeeting(meeting.id);
      // Guidance stops only once the recording has: a failed stop leaves both running, not a silent half-meeting.
      runtime.current?.stop();
      if (PUBLIC_EDITION && sessionKind === "recording") { synthesisTargets.current.add(record.id); synthesizeStopped.current(record); if ((record.pendingSegments??0)>0 || record.translationStatus==="pending") void invoke<MeetingRecord>("load_meeting_record",{id:record.id}).then(latest=>synthesizeStopped.current(latest)).catch(()=>{}); }
      setRecords((old) => [record, ...old.filter((r) => r.id !== record.id)]);
      setSelectedRecord(record);
      setMeeting(undefined);

      setStatus(
        record.translationStatus === "pending"
          ? "Saved · translations pending"
          : "Saved locally",
      );
    } catch (error) {
      const failed = stopErrorStatus(error);
      setStatus(failed.text, failed.tone);
    } finally {
      operationActive.current = false;
      setBusy(false);
    }
  };
  const stopKey = useStopConfirmation(meeting?.id, () => {
    if (!stopAccepted()) return false;
    void stop();
    return true;
  });
  const { stopArm, stopPending, stopRefused } = stopKey;
  pausedRef.current = paused;
  const toggleRecordingPause = async () => {
    // One toggle at a time, from the latest state: a double press or hotkey repeat must not send the same change twice.
    if (!meeting || operationActive.current || pauseInFlight.current) return;
    pauseInFlight.current = true;
    const next = !pausedRef.current;
    try {
      if (sessionKind === "recording")
        await (next
          ? pauseLocalMeeting(meeting.id)
          : resumeLocalMeeting(meeting.id));
      pausedRef.current = next;
      setPaused(next);
      runtime.current?.setPaused(next);
    } catch {
      setStatus(next ? "Recording could not be paused and is still running." : "Recording could not be resumed and is still paused. Try again.", "alert");
    } finally {
      pauseInFlight.current = false;
    }
  };
  const toggleAssistance = () => {
    const next = !assistancePaused;
    setAssistancePaused(next);
    runtime.current?.setAssistancePaused(next);
  };
  const savePins = (pins: GuidanceCard[]) => {
    runtime.current?.setPins(pins);
    if (meeting)
      void invoke("save_internal_note", pinsNote(meeting.id, pins)).catch(() =>
        setAssistanceStatus(
          "Pinned topics remain visible; persistence needs attention",
          true,
        ),
      );
  };
  const pin = (id: string) => {
    const next = pinTopic(live.get().view, id);
    setView(next);
    savePins(next.savedPins);
  };
  /** A person's answered/outdated decision: saved with the pins note so it survives a restart within the meeting. */
  const settle = (id: string, outcome: PinOutcome) => {
    const view = live.get().view;
    const next = settlePin(view, id, outcome);
    if (next === view) return;
    setView(next);
    savePins(next.savedPins);
  };
  const reopen = (id: string) => {
    const next = reopenPin(live.get().view, id);
    setView(next);
    savePins(next.savedPins);
  };
  const expand = (id: string) =>
    setView((old) => ({
      ...old,
      detailCardId: old.detailCardId === id ? undefined : id,
    }));
  controls.current = (action) => {
    if (!meeting) return;
    const card = targetCard(live.get().view);
    if (intents.some((i) => i.id === action))
      void runtime.current?.request(action as (typeof intents)[number]["id"]);
    else if (action === "pin" && card) pin(card.id);
    else if (action === "dismiss" && card)
      setView((old) => dismissCard(old, card.id));
    else if (action === "expand" && card) expand(card.id);
    else if (action === "pauseAssistance") toggleAssistance();
    else if (action === "pauseRecording")
      void toggleRecordingPause().catch(() =>
        setStatus("Pause change needs attention", "alert"),
      );
    else if (action === "stop") stopKey.press();
  };
  /** Read at render by the live panel, which subscribes to the view and events it is computed from. */
  const reminders = () => {
    const { view, events } = live.get();
    return resurfacePins(
      view.savedPins,
      coveredPins,
      now,
      meeting?.scheduledEndMs,
      events
        .slice(-2)
        .map((e) => e.text)
        .join(" "),
    )
      .filter((r) => !view.cards.some((c) => c.id === r.cardId))
      .slice(0, 1);
  };

  const startReplay = () => {
    // Never over a live recording or a start/stop in flight; the native command should refuse too (separate change).
    const refused = replayRefusal({ meetingActive: !!meeting, operationActive: operationActive.current });
    if (refused) return Promise.reject(refused);
    operationActive.current = true;
    setBusy(true);
return invoke<MeetingRecord>("create_synthetic_record").finally(() => {
              operationActive.current = false;
              setBusy(false);
            }).then(
              (record) => {
                sessionGeneration.current++;
                runtime.current?.stop();
                setView({ cards: [], savedPins: [], queued: 0 });
                setCoveredPins([]);
                setPaused(false);
                setAssistancePaused(false);
                displayedMeetingId.current = record.id;
                setSessionKind("replay");
                setMeeting({ ...record, retainAudio: false });
                setProfile("interview");
                setEvents(record.segments);
                setStatus("Synthetic replay · microphone is off");
                runtime.current = new CopilotRuntime(
                  record,
                  (event) => setView((old) => applyGuidanceEvent(old, event)),
                  reportRuntimeStatus,
                  reasoningHost(),
                  logGuidanceLatency,
                  logPreparationCounts,
                );
                for (const event of record.segments)
                  runtime.current.ingest(event);
                runtime.current.start();
              },
            );
  };
  const changeProfile = (next: ProfileId) => { setProfile(next); runtime.current?.setProfile(next); };
  const changePurpose = (next: string) => { setPurpose(next); if (!meeting) setProfile(inferProfile(next)); };
  const selectUpcoming = (event: { id: string; title: string; startMs: number; endMs: number }) => {
    if (meeting) return;
    setPurpose(event.title); setScheduledEnd(event.endMs); setProfile(inferProfile(event.title)); setBrief(undefined);
  };
  const selectRecord = (record: MeetingRecord) => {
    if (meeting) return;
    displayedMeetingId.current = record.id; setSelectedRecord(record); setEvents(record.segments); setPurpose(record.purpose); setStatus("Viewing saved record");
    // The archive lists summaries; the transcript arrives with the full record.
    if (record.summary) void invoke<MeetingRecord>("load_meeting_record", { id: record.id }).then((full) => {
      if (displayedMeetingId.current !== full.id) return;
      setSelectedRecord((current) => (current?.id === full.id ? full : current));
      setEvents(full.segments);
    }).catch((error: unknown) => { console.warn("load_meeting_record failed", error); setStatus("The saved meeting could not be opened. Its local record is preserved.", "alert"); });
  };
  const recover = (id: string) => invoke("recover_local_record", { id }).then(() => setAssistanceStatus("Pending local transcription/translation retry started")).catch((error: unknown) => { console.warn("recover_local_record failed", error); setAssistanceStatus("Retry of local processing could not start; the source text is preserved", true); });
  const refreshRecords = () => { void invoke<MeetingRecord[]>("list_meeting_records").then(setRecords).catch((error: unknown) => console.warn("list_meeting_records failed", error)); };
  const installModels = () => {
    if (modelSetup.phase === "running") return;
    setModelSetup(startModelSetup());
    setStatus("Downloading local models…");
    void setupModels()
      .then((result) => {
        setReady(result);
        setModelSetup(idleModelSetup);
        setStatus("Local models ready");
        // The first model load compiles for this Mac and can take minutes; do it now rather than at the first meeting.
        if (result.recognitionReady) {
          startWarmup();
        }
      })
      .catch((error) => {
        // Another download already runs and keeps reporting; nothing to change.
        if (error === "setupInProgress") return;
        setModelSetup((old) => failModelSetup(old, typeof error === "string" ? error : "assetSetupFailed"));
        setStatus(error === "cancelled" ? "Model download cancelled; choose Retry to continue" : "Model setup stopped; choose Retry", "notice");
      });
  };
  // Stops only the download process; recording never shares this path. The partial files stay, so Retry resumes.
  const cancelModelInstall = () => {
    if (modelSetup.phase !== "running" || modelSetup.cancelling) return;
    setModelSetup(requestModelSetupCancel);
    setStatus("Cancelling model download…");
    void cancelModelSetup().catch(() => setModelSetup((old) => ({ ...old, cancelling: false })));
  };
  const toggleExperimentalMedium = (enabled: boolean) => {
    void setExperimentalMediumTranslation(enabled).then(setReady).catch(() => setStatus("Could not change the translation setting", "alert"));
  };
  const acceptCall = (offer: { title: string; expiresAt: number }, origin: "offer" | "choices") => {
    if (offer.expiresAt > Date.now()) { setPurpose(offer.title); void startRef.current?.(offer.title); if (origin === "offer") setCallOffer(undefined); else setCallChoices([]); }
  };
  const arm = (next: boolean) => { setArmed(next); setArmedUntil(Date.now() + 3600000); };
  const request = async (intent: AssistanceIntent) => { await runtime.current?.request(intent); };
  const dismiss = (id: string) => setView((old) => dismissCard(old, id));
  const coverReminder = (id: string) => setCoveredPins((old) => [...old, id]);
  const hydratePublicPlan = (plan: PublicMeetingPlan) => {
    if (meeting) return;
    setWorkspace(plan.workspaceId); setPurpose(plan.title); setObjectives(plan.objectives.join("\n"));
    setPublicTopics(plan.publicResearchTopics.join("\n")); setParticipants(plan.attendees as MeetingOptions["attendees"]);
    setBrief(plan.reviewedBrief); setProfile(plan.profileId); setScheduledEnd(plan.endMs); setInputDevice(plan.inputDevice||""); setRetain(plan.retainAudio===true); setArmed(false); setArmedUntil(0);
  };
  const publicProduct = usePublicProduct(hydratePublicPlan);
  accountPlan.current = PUBLIC_EDITION && publicProduct.account?.signedIn ? publicProduct.account.plan : undefined;
  publicReviewedBrief.current=publicProduct.current?.reviewedBrief;
  useEffect(()=>{if(PUBLIC_EDITION&&!publicProduct.current?.reviewedBrief)setArmed(false);},[publicProduct.current?.reviewedBrief]);
  synthesizeStopped.current = (record) => {
    if (!PUBLIC_EDITION || !synthesisTargets.current.has(record.id) || (record.pendingSegments ?? 0)>0 || record.translationStatus === "pending") return;
    synthesisTargets.current.delete(record.id);
    void writeDestinations(record.id);
    if (!publicProduct.account?.canUseAI) { needsServiceAccess(record.id); return; }
    void makeSynthesis(record, true);
  };
  // Failures stay on the record's Overview (recordAttention) until resolved or dismissed, not only as a passing toast.
  // In memory only: they do not survive a restart (see recordAttention.ts).
  const [recordAttention, setRecordAttention] = useState<AttentionMap>({});
  const needsServiceAccess = (id: string) => {
    setRecordAttention((old) => markAttention(old, id, { synthesis: "needsAccess" }));
    setAssistanceStatus("Meeting saved. Its synthesis needs service access; make it from Overview when available.");
  };
  const writeDestinations = (id: string) => publicClient.applyGrants(id).then((r) => {
    const failed = r.failed?.length ?? 0;
    setRecordAttention((old) => destinationOutcome(old, id, r));
    if (failed) setAssistanceStatus(`Meeting notes saved to ${r.applied} destination${r.applied === 1 ? "" : "s"}; ${failed} could not be updated. See Overview.`, true);
    else if (r.applied) setAssistanceStatus(`Meeting notes saved to ${r.applied} destination${r.applied === 1 ? "" : "s"}.`);
  }).catch((error: unknown) => { setRecordAttention((old) => destinationOutcome(old, id, { callError: String(error) })); setAssistanceStatus("Meeting saved. Note destinations could not be updated; see Overview.", true); });
  // An archive summary has no transcript; synthesise only from the full record.
  const makeSynthesis = (record: MeetingRecord, automatic: boolean) => (record.summary ? invoke<MeetingRecord>("load_meeting_record", { id: record.id }) : Promise.resolve(record)).then((full) => ensureSynthesis(full, automatic)).then(() => { setRecordAttention((old) => clearAttention(old, record.id, "synthesis")); setAssistanceStatus("Meeting synthesis saved."); }).catch(() => { setRecordAttention((old) => markAttention(old, record.id, { synthesis: "failed" })); setAssistanceStatus("Meeting saved. Its synthesis could not be made yet; retry from Overview.", true); });
  // A synthesis saved by any path (Generate on Overview, an edit, a retry) resolves that record's synthesis notice.
  useEffect(() => publicArtifacts.subscribe((saved) => setRecordAttention((old) => attentionAfterArtifactSave(old, saved))), []);
  const retryAttention = (record: MeetingRecord, kind: AttentionKind) => {
    if (kind !== "synthesis") return writeDestinations(record.id);
    if (PUBLIC_EDITION && !publicProduct.account?.canUseAI) { needsServiceAccess(record.id); return Promise.resolve(); }
    return makeSynthesis(record, false);
  };
  const dismissAttention = (recordId: string, kind: AttentionKind) => setRecordAttention((old) => clearAttention(old, recordId, kind));
  useEffect(() => { if (PUBLIC_EDITION) setWorkspaces(publicProduct.workspaces); }, [publicProduct.workspaces]);
  useEffect(() => { if (PUBLIC_EDITION) { setUpcoming(publicProduct.calendarEvents); setCalendarRange(publicProduct.range); } }, [publicProduct.calendarEvents, publicProduct.range]);
  const publicEdit = <T,>(set: (value: T) => void, patch: (value: T) => Partial<PublicMeetingPlan>) => (value: T) => { set(value); if (PUBLIC_EDITION) publicProduct.edit(patch(value)); };
  return {
    publicProduct,
    activeMeeting: meeting, selectedRecord, sessionKind,
    setup: { workspace, purpose, objectives, publicTopics, participants, brief: PUBLIC_EDITION ? publicProduct.current?.reviewedBrief : brief, inputDevice, retain, scheduledEndMs,
      setWorkspace: PUBLIC_EDITION ? (id: string) => { setWorkspace(id); void publicProduct.assignWorkspace(id); } : setWorkspace,
      // An emptied title saves as "Untitled meeting": a saved plan always needs one.
      setPurpose: publicEdit(changePurpose, title => ({title: title.trim() ? title : "Untitled meeting", profileId: inferProfile(title)})),
      setObjectives: publicEdit<string>(setObjectives, value => ({objectives:objectiveLines(value)})),
      setPublicTopics: publicEdit<string>(setPublicTopics, value => ({publicResearchTopics:value.split(/[,;\n]/).map(s=>s.trim()).filter(Boolean)})),
      setParticipants: publicEdit<MeetingOptions["attendees"]>(setParticipants, attendees => ({attendees})),
      setBrief: publicEdit<Brief | undefined>(setBrief, reviewedBrief => ({reviewedBrief,status:reviewedBrief?"prepared":"draft"})), setInputDevice:publicEdit<string>(setInputDevice,inputDevice=>({inputDevice})), setRetain:publicEdit<boolean>(setRetain,retainAudio=>({retainAudio})),
      // Both or neither: a plan has a full time range or no date at all.
      setSchedule: (range?: { startMs: number; endMs: number }) => { setScheduledEnd(range?.endMs); if (PUBLIC_EDITION) publicProduct.edit({ startMs: range?.startMs, endMs: range?.endMs }); } },
    // The live values read the store when accessed. A component that must follow them subscribes with the
    // liveStore hooks (useLiveEvents, useLiveView, useFramesStarted); reading them here does not re-render on change.
    live,
    get events() { return live.get().events; },
    get view() { return live.get().view; },
    get frames() { return live.get().frames; },
    get reminders() { return reminders(); },
    get transcript() { return transcriptOf(live.get().events); },
    get transcriptEntries() { return transcriptEntriesOf(live.get().events, english); },
    profile, changeProfile: publicEdit(changeProfile, profileId => ({profileId})), records, upcoming, setUpcoming,
    english, setEnglish,
    status, statusTone: statusLine.tone, speechStatus, retrySpeech, assistance, assistanceStatus: assistance.text, assistanceDegraded: assistance.degraded, setAssistanceStatus, busy, paused, assistancePaused,
    captureHealth, shortcuts, setShortcuts, unavailableShortcuts, stopPending, stopRefused, stopArm, ready, modelSetup, toggleExperimentalMedium, inputDevices, inputDeviceAvailability,
    workspaces, setWorkspaces, calendarRange, setCalendarRange,
    people: { known: knownPeople, name: personName, setName: setPersonName },
    entry: { armed, armedUntil, arm, callOffer, callChoices, acceptCall, detectionStatus, detectionDiagnostics },
    start, stop, startReplay, toggleRecordingPause, toggleAssistance, request, pin, settle, reopen, dismiss, expand, coverReminder,
    selectRecord, selectUpcoming: (event: {id:string;title:string;startMs:number;endMs:number}) => { if (PUBLIC_EDITION) { const full=publicProduct.calendarEvents.find(e=>e.id===event.id); if(full) void publicProduct.newPlan(full); } else selectUpcoming(event); }, recover, recordAttention, retryAttention, dismissAttention, refreshRecords, installModels, cancelModelInstall,
  };
}
export type CopilotController = ReturnType<typeof useCopilotController>;
