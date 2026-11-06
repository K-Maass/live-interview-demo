import { invoke } from "@tauri-apps/api/core";
import type {
  LocalMeetingOptions,
  MeetingRecord,
  SpeechReadiness,
} from "@live-interview/core";
export const native = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const readiness = () => invoke<SpeechReadiness>("speech_readiness");
export const warmupState = () => invoke<{ firstLoad: boolean; status: string }>("speech_warmup_state");
export const warmSpeech = () => invoke("warm_local_speech");
/** Stops any speech-model load in progress so the next `warmSpeech` starts a fresh helper (Retry). */
export const restartSpeech = () => invoke("restart_local_speech");
export const setupModels = () => invoke<SpeechReadiness>("setup_local_models");
export const cancelModelSetup = () => invoke<boolean>("cancel_local_models_setup");
export const setExperimentalMediumTranslation = (enabled: boolean) =>
  invoke<SpeechReadiness>("set_experimental_medium_translation", { enabled });
export const startLocalMeeting = (
  options: LocalMeetingOptions,
  inputDevice?: string,
) => invoke<string>("start_local_meeting", { options, inputDevice });
export const pauseLocalMeeting = (id: string) =>
  invoke<void>("set_local_meeting_paused", { id, paused: true });
export const resumeLocalMeeting = (id: string) =>
  invoke<void>("set_local_meeting_paused", { id, paused: false });
export const stopLocalMeeting = (id: string) =>
  invoke<MeetingRecord>("stop_local_meeting", { id });
