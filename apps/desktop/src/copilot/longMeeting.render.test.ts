// @vitest-environment happy-dom
// A long bilingual meeting through the real controller and the real application shell, with the native side faked:
// `recording-frames` every 500 ms per lane and a source line about every 3.6 s (two of three in German, each with its
// English translation). Counts how often each page renders, so a live meeting never re-renders the hidden pages.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { MeetingRecord, SpeechEvent } from "@live-interview/core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Node's own `localStorage` (without a backing file) would shadow the DOM's; the app only needs a working one.
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, String(v)), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear(), key: (i: number) => [...memory.keys()][i] ?? null, get length() { return memory.size; } });

const renders = { controller: 0, meetings: 0, knowledge: 0, people: 0, setup: 0, livePage: 0, livePanel: 0 };
const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
const meetingId = "long-meeting";
const record = { id: meetingId, purpose: "Quarterly supplier review", profileId: "workClient", profileRevision: 0, workspaceId: "default", date: "2026-11-04T09:00:00.000Z", attendees: [], objectives: [], segments: [], importedSegments: [], attributions: [], revision: 1, canonicalEnglishPath: "/r/english.md", translationStatus: "complete", pendingSegments: 0, paused: false, captureHealth: {} } as unknown as MeetingRecord;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "current_local_session") return record;
    if (command === "list_meeting_records" || command === "list_people" || command === "list_input_devices") return [];
    throw "unavailableInTest";
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; }),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(async () => {}), unregister: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn(async () => null) } }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn(async () => null), getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }) }));
// The hidden pages are counted, not drawn: what matters is whether the shell asks them to render at all.
vi.mock("./screens/MeetingsPage", () => ({ MeetingsPage: () => { renders.meetings++; return null; } }));
vi.mock("./screens/KnowledgePage", () => ({ KnowledgePage: () => { renders.knowledge++; return null; } }));
const mounts = { people: 0 };
vi.mock("./screens/PeoplePage", async () => {
  const { useState } = await import("react");
  return { PeoplePage: () => { useState(() => ++mounts.people); renders.people++; return null; } };
});
vi.mock("./screens/MeetingSetupPage", () => ({ MeetingSetupPage: () => { renders.setup++; return null; } }));
// The live surfaces are the real ones, counted from inside: the guidance panel re-renders as the conversation moves.
vi.mock("./LivePanel", async (original) => {
  const real = await original<typeof import("./LivePanel")>();
  return { ...real, LivePanel: (props: Parameters<typeof real.LivePanel>[0]) => { renders.livePanel++; return createElement(real.LivePanel, props); } };
});
vi.mock("./screens/LiveMeetingPage", async (original) => {
  const real = await original<typeof import("./screens/LiveMeetingPage")>();
  return { LiveMeetingPage: (props: Parameters<typeof real.LiveMeetingPage>[0]) => { renders.livePage++; return createElement(real.LiveMeetingPage, props); } };
});

const minutes = Number(process.env.LONG_MEETING_MINUTES ?? 90);
let root: Root;
let host: HTMLElement;
const fire = (name: string, payload: unknown) => listeners.get(name)?.forEach((handler) => handler({ payload }));
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeAll(async () => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "__preview-test" } } };
  const { useCopilotController } = await import("./useCopilotController");
  const { CopilotApplication } = await import("./CopilotApplication");
  function Host() {
    const controller = useCopilotController();
    renders.controller++;
    return createElement(CopilotApplication, { controller });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Host)));
  await flush();
  await flush();
}, 60_000);
afterAll(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe(`a ${minutes}-minute bilingual meeting`, () => {
  test("frames and transcript lines re-render only the live surfaces; hidden pages stay at 0 renders", async () => {
    expect(host.querySelector(".live-meeting-page"), "the recovered meeting shows the live page").not.toBeNull();
    for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
    const seconds = minutes * 60;
    let line = 0, journal = 0, frames = 0;
    const started = performance.now();
    // One task per native event, as in the app: React cannot batch a frame report with the next one.
    const send = (name: string, payload: unknown) => act(() => fire(name, payload));
    for (let second = 0; second < seconds; second++) {
      // Two frame reports per lane per second (every 500 ms).
      for (let half = 0; half < 2; half++) { frames += 8; await send("recording-frames", { meetingId, lane: "me", frames }); await send("recording-frames", { meetingId, lane: "remote", frames }); }
      if (second * 1000 >= line * 3600) {
        const lane = line % 2 ? "remote" : "me", language = line % 3 === 0 ? "en" : "de", startMs = line * 3600;
        const final: SpeechEvent = { meetingId, segmentId: "s" + line, revision: 0, journalSequence: journal++, lane, startMs, endMs: startMs + 3000, language, text: "line " + line, kind: "final" };
        await send("speech-event", final);
        if (language !== "en") await send("speech-event", { ...final, segmentId: "t" + line, sourceSegmentId: final.segmentId, journalSequence: journal++, language: "en", text: "translated " + line, kind: "translation" } satisfies SpeechEvent);
        line++;
      }
    }
    const elapsed = performance.now() - started;
    const frameEvents = seconds * 4, speechEvents = journal;
    console.info(`[long-meeting] ${minutes} min · ${line} source lines · ${frameEvents} frame events · ${speechEvents} speech events · renders ${JSON.stringify(renders)} · ${Math.round(elapsed)} ms`);
    // The hidden pages are not asked to render at all while the meeting runs (before this change: once per event).
    expect(renders.meetings).toBe(0);
    expect(renders.knowledge).toBe(0);
    expect(renders.people).toBe(0);
    // The controller host (and so the shell) does not re-render per frame or per line either. What remains is driven by
    // the wall clock (the 15 s reminder clock, runtime retries), so it is bounded by the test's duration, not its events.
    expect(renders.controller).toBeLessThanOrEqual(10 + elapsed / 1000);
    expect(renders.controller).toBeLessThan(speechEvents / 10);
    // The live panel still follows the conversation: about once per speech event, never per frame report.
    expect(renders.livePanel).toBeGreaterThanOrEqual(line);
    expect(renders.livePanel).toBeLessThanOrEqual(speechEvents + renders.livePage + 10);
    const rail = host.querySelector('[aria-label="Latest transcript lines"]');
    expect(rail?.textContent).toContain("line " + (line - 1));
  }, 600_000);
  test("a hidden page renders fresh when shown, stays mounted (its state kept) and freezes again when left", async () => {
    const nav = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("nav .nav-item")].find((b) => b.textContent?.includes(label))!;
    const before = { ...renders }, mounted = mounts.people;
    await act(async () => nav("People").click());
    expect(renders.people).toBeGreaterThan(before.people);
    expect(renders.meetings).toBe(before.meetings);
    await act(async () => (host.querySelector<HTMLButtonElement>(".active-session-link") ?? host.querySelector<HTMLButtonElement>(".live-return button"))!.click());
    expect(host.querySelector(".live-meeting-page")?.closest("[hidden]")).toBeNull();
    const shown = renders.people;
    for (let i = 1; i <= 50; i++) act(() => fire("recording-frames", { meetingId, lane: "me", frames: 10_000_000 + i }));
    await act(async () => fire("speech-event", { meetingId, segmentId: "late", revision: 0, journalSequence: 1e6, lane: "me", startMs: 1e7, endMs: 1e7 + 500, language: "en", text: "late line", kind: "final" } satisfies SpeechEvent));
    expect(renders.people).toBe(shown);
    expect(mounts.people).toBe(mounted);
  });
});
