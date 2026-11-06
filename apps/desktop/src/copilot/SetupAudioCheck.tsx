import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Play, LoaderCircle } from "lucide-react";
import { checkFailureText, emptyBars, isHeard, pushLevel, type Lane, type LevelEvent, type LevelSample } from "../lib/public/audioCheck";

interface AudioMeter {
  bars: LevelSample[];
  listening?: Lane;
  /** A check was asked for and the device is still opening. */
  starting: boolean;
  heard: Record<Lane, boolean>;
  error?: string;
  start: (lane: Lane) => Promise<boolean>;
  stop: () => void;
}

/**
 * Drives one native audio check at a time. Only loudness levels arrive here; the audio never leaves the native
 * side. Unmounting stops the check, so leaving the screen releases the device. `autoStart` starts one lane on mount.
 */
function useAudioMeter(autoStart?: Lane): AudioMeter {
  const [bars, setBars] = useState(emptyBars);
  const [listening, setListening] = useState<Lane>();
  const [starting, setStarting] = useState(!!autoStart);
  const [heard, setHeard] = useState<Record<Lane, boolean>>({ me: false, remote: false });
  const [error, setError] = useState<string>();
  const current = useRef<number | undefined>(undefined);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen<LevelEvent>("audio-check-level", ({ payload }) => {
      if (payload.check !== current.current) return;
      if (payload.ended) { current.current = undefined; setListening(undefined); return; }
      setBars((old) => {
        const next = pushLevel(old, payload);
        if (isHeard(next, payload.lane)) setHeard((h) => (h[payload.lane] ? h : { ...h, [payload.lane]: true }));
        return next;
      });
    }).then((off) => { if (gone) off(); else unlisten = off; });
    return () => { gone = true; unlisten?.(); if (current.current !== undefined) void invoke("stop_audio_check").catch(() => {}); };
  }, []);
  const start = async (lane: Lane) => {
    setError(undefined);
    setStarting(true);
    try {
      current.current = await invoke<number>("start_audio_check", { lane });
      setListening(lane);
      return true;
    } catch (e) {
      setError(checkFailureText(lane, e));
      return false;
    } finally {
      setStarting(false);
    }
  };
  useEffect(() => { if (autoStart) void start(autoStart); }, []);
  return {
    bars, listening, starting, heard, error, start,
    stop: () => { current.current = undefined; setListening(undefined); void invoke("stop_audio_check").catch(() => {}); },
  };
}

/** A short, gentle three-note chime played by the app itself, so the system-audio tap can hear it. */
function playTestTone(): Promise<void> {
  return new Promise((resolve) => {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) { resolve(); return; }
    const context = new Context();
    const notes = [523.25, 659.25, 783.99, 523.25, 659.25, 783.99];
    notes.forEach((frequency, i) => {
      const start = context.currentTime + 0.05 + i * 0.4;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.38);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.4);
    });
    window.setTimeout(() => { void context.close(); resolve(); }, 50 + notes.length * 400 + 300);
  });
}

function Meter({ bars, label }: { bars: LevelSample[]; label: string }) {
  return <div className="audio-meter" role="img" aria-label={label}>
    {bars.map((bar, i) => <span key={i} className={"audio-meter-bar " + (bar.level < 0.05 ? "quiet" : bar.lane)} style={{ height: `${Math.round(4 + bar.level * 60)}px` }} />)}
  </div>;
}

function Status({ tone, children }: { tone: "done" | "busy" | "quiet" | "error"; children: string }) {
  return <p className={"audio-check-status " + tone} role={tone === "error" ? "alert" : "status"}>
    {tone === "done" ? <Check size={16} aria-hidden /> : tone === "busy" ? <LoaderCircle size={16} className="audio-check-spin" aria-hidden /> : null}{children}
  </p>;
}

/**
 * Microphone screen, once access is on: a live meter that starts by itself and says when it hears speech.
 * It stops after 20 seconds or when the screen changes; "Listen again" restarts it.
 */
export function MicCheck() {
  const meter = useAudioMeter("me");
  const listening = meter.listening === "me";
  const label = meter.heard.me ? "Microphone level: hearing you" : listening ? "Microphone level: listening" : "Microphone level: not listening";
  return <div className="audio-check">
    <Meter bars={meter.bars} label={label} />
    <div className="audio-check-row">
      {meter.error ? <Status tone="error">{meter.error}</Status> : meter.heard.me ? <Status tone="done">We can hear you</Status> : listening ? <Status tone="quiet">Say a few words. The bars move when it hears you.</Status> : meter.starting ? <Status tone="busy">Starting the microphone…</Status> : <Status tone="quiet">Not listening.</Status>}
      {!listening && !meter.starting && <button className="link-button" onClick={() => void meter.start("me")}>{meter.error ? "Try again" : "Listen again"}</button>}
    </div>
  </div>;
}

/**
 * System audio screen, once access is on: plays a short chime from the app and listens on the "remote" lane
 * while it plays. The chime reaches the tap the same way a Teams call does, so hearing it is a real end-to-end
 * check, not just a permission read.
 */
export function SystemAudioCheck({ onResult, openPrivacy }: { onResult: (heard: boolean) => void; openPrivacy: () => void }) {
  const meter = useAudioMeter();
  const [phase, setPhase] = useState<"idle" | "playing" | "heard" | "missed">("idle");
  const run = async () => {
    setPhase("playing");
    if (!(await meter.start("remote"))) { setPhase("idle"); return; }
    await playTestTone();
    await new Promise((r) => window.setTimeout(r, 400));
    meter.stop();
  };
  // The verdict comes when listening ends, from what the meter heard while the chime played.
  useEffect(() => {
    if (phase !== "playing" || meter.listening) return;
    setPhase(meter.heard.remote ? "heard" : "missed");
    onResult(meter.heard.remote);
  }, [meter.listening]);
  const label = phase === "heard" ? "System audio level: test sound came through" : "System audio level";
  return <div className="audio-check">
    <Meter bars={meter.bars} label={label} />
    <div className="audio-check-row">
      {meter.error ? <Status tone="error">{meter.error}</Status>
        : phase === "playing" ? <Status tone="busy">Playing the test sound…</Status>
        : phase === "heard" ? <Status tone="done">Remote audio comes through</Status>
        : phase === "missed" ? <Status tone="error">The test sound did not come through. If macOS just asked for permission, allow it and play again. Otherwise check that the volume is not muted and that Live Interview is on under Screen &amp; System Audio Recording.</Status>
        : <Status tone="quiet">Play a short chime to check that the other side of a call will be heard.</Status>}
      {phase === "missed" && <button onClick={openPrivacy}>Open Privacy settings</button>}
      {phase !== "playing" && <button onClick={() => void run()}><Play size={14} aria-hidden />{phase === "idle" && !meter.error ? "Play a test sound" : "Play again"}</button>}
    </div>
  </div>;
}
