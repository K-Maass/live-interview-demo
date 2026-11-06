import { useEffect, useRef } from "react";
import type { GuidanceCard, LiveViewState } from "@live-interview/core";
import { useLiveStore } from "./liveStore";
import {
  assistanceAnnouncement,
  callOfferAnnouncement,
  captureAnnouncement,
  guidanceAnnouncement,
  modelSetupAnnouncement,
  speechStatusAnnouncement,
  type Announcement,
} from "../lib/copilot/announcements";
import { intents } from "./LivePanel";
import { stopPromptLine } from "../lib/copilot/status";
import type { CopilotController } from "./useCopilotController";

const guidanceLabel = (card: GuidanceCard) => card.headline || intents.find((intent) => intent.id === card.intent)?.label || "Suggestion";

/**
 * Feeds status changes to the announcer. Each source keeps its own previous value, so a first render and a remount
 * announce nothing, and a change is compared only with the value before it. Display and recording are untouched.
 */
export function useLiveAnnouncements(c: CopilotController, captureLabel: string | undefined, announce: (announcement: Announcement | undefined) => void) {
  const speech = useRef(c.speechStatus);
  useEffect(() => { announce(speechStatusAnnouncement(speech.current, c.speechStatus)); speech.current = c.speechStatus; }, [c.speechStatus]);

  const setup = useRef(c.modelSetup);
  useEffect(() => { announce(modelSetupAnnouncement(setup.current, c.modelSetup)); setup.current = c.modelSetup; }, [c.modelSetup]);

  // A new meeting starts from no previous view, so recovered or earlier cards are never read out.
  // The view lives in the live store and changes often; it is followed by subscription, so the shell hosting this hook
  // does not re-render for each guidance update.
  const store = useLiveStore(c);
  const announceRef = useRef(announce); announceRef.current = announce;
  const meeting = useRef(c.activeMeeting?.id);
  const view = useRef<LiveViewState | undefined>(c.activeMeeting ? store.get().view : undefined);
  const meetingId = c.activeMeeting?.id;
  useEffect(() => {
    const check = () => {
      const next = store.get().view;
      if (meeting.current !== meetingId) { meeting.current = meetingId; view.current = meetingId ? next : undefined; return; }
      if (!meetingId || next === view.current) return;
      announceRef.current(guidanceAnnouncement(view.current, next, guidanceLabel));
      view.current = next;
    };
    check();
    return store.subscribe(check);
  }, [store, meetingId]);

  const capture = useRef(captureLabel);
  useEffect(() => { announce(captureAnnouncement(capture.current, captureLabel)); capture.current = captureLabel; }, [captureLabel]);

  const assistance = useRef(c.assistance.id);
  useEffect(() => { announce(assistanceAnnouncement(assistance.current, c.assistance)); assistance.current = c.assistance.id; }, [c.assistance.id]);

  // The first Stop & save key press is usually made with Teams in front, so the request for a second press is spoken.
  useEffect(() => { const text = c.stopArm ? stopPromptLine(c.shortcuts.stop, c) : undefined; if (text) announce({ politeness: "polite", text, eventId: `stop-confirm:${c.stopArm}` }); }, [c.stopArm]);

  const call = useRef(c.entry.callOffer?.title);
  useEffect(() => { announce(callOfferAnnouncement(call.current, c.entry.callOffer?.title)); call.current = c.entry.callOffer?.title; }, [c.entry.callOffer?.title]);
}
