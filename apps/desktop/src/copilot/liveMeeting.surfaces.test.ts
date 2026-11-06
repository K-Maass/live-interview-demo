// @vitest-environment happy-dom
// The live store's side effects through the real controller and shell (native side faked): a guidance card is spoken
// and reaches the widget once, frame reports publish nothing, and the real Meetings page, frozen while hidden, shows
// current records when it is opened mid-meeting and after the meeting ends.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyGuidanceEvent, type GuidanceCard, type MeetingRecord } from "@live-interview/core";
import type { CopilotController } from "./useCopilotController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, String(v)), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear(), key: (i: number) => [...memory.keys()][i] ?? null, get length() { return memory.size; } });

const meetingId = "live-1";
const saved = (id: string, purpose: string, extra: Partial<MeetingRecord> = {}) => ({ id, purpose, profileId: "workClient", profileRevision: 0, workspaceId: "default", date: "2026-11-04T09:00:00.000Z", attendees: [], objectives: [], segments: [], importedSegments: [], attributions: [], revision: 1, canonicalEnglishPath: "/r/" + id + ".md", translationStatus: "complete", pendingSegments: 0, ...extra }) as unknown as MeetingRecord;
const live = { ...saved(meetingId, "Supplier negotiation"), paused: false, captureHealth: {} };
const archive: MeetingRecord[] = [saved("old-1", "Kick-off from last week")];
let recording = true;
const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
const widgetStates: { cards: { say: string }[] }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { id?: string }) => {
    if (command === "current_local_session") return recording ? live : null;
    if (command === "list_meeting_records") return [...archive];
    if (command === "list_people" || command === "list_input_devices") return [];
    if (command === "stop_local_meeting") { recording = false; const done = saved(meetingId, "Supplier negotiation"); archive.unshift(done); return done; }
    if (command === "load_meeting_record") return archive.find((r) => r.id === args?.id) ?? saved(args?.id ?? "?", "?");
    throw "unavailableInTest";
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; }),
  emit: vi.fn(async (name: string, payload: unknown) => { if (name === "live-widget-state") widgetStates.push(payload as { cards: { say: string }[] }); }),
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(async () => {}), unregister: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn(async () => null) } }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn(async () => null), getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }) }));
// The Meetings page is the real one; only pages this test does not look at are stubbed.
vi.mock("./screens/KnowledgePage", () => ({ KnowledgePage: () => null }));
vi.mock("./screens/PeoplePage", () => ({ PeoplePage: () => null }));
vi.mock("./screens/ReviewMeetingPage", () => ({ ReviewMeetingPage: () => null }));
vi.mock("./screens/MeetingSetupPage", () => ({ MeetingSetupPage: () => null }));
vi.mock("./screens/PreparationPage", () => ({ PreparationPage: () => null }));

let root: Root;
let host: HTMLElement;
let controller: CopilotController;
const fire = (name: string, payload: unknown) => listeners.get(name)?.forEach((handler) => handler({ payload }));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
const nav = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("nav .nav-item")].find((b) => b.textContent?.includes(label))!;
const card = (id: string, headline: string): GuidanceCard => ({ id, headline, say: "Ask who signs off: " + id, why: "Approval is open.", intent: "digDeeper", pinned: false, stale: false, evidence: [], uncertain: false, createdAtMs: Date.now(), basis: { snapshot: { createdAtMs: 0, context: { sources: [], conversation: [] } }, transcriptDeltas: [], invalidatedSourceIds: [], observationSequence: 0, stateRevision: 0, profileId: "workClient", profileRevision: 0 } }) as unknown as GuidanceCard;

beforeAll(async () => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "__preview-test" } } };
  const { useCopilotController } = await import("./useCopilotController");
  const { CopilotApplication } = await import("./CopilotApplication");
  function Host() { controller = useCopilotController(); return createElement(CopilotApplication, { controller }); }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Host)));
  await settle();
  await settle();
}, 60_000);
afterAll(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("live store side effects", () => {
  test("a guidance card is announced and published to the widget once; frame reports and an equal view publish nothing", async () => {
    expect(host.querySelector(".live-meeting-page")).not.toBeNull();
    const polite = host.querySelector('[data-announcer="polite"]')!;
    const spoken: string[] = [];
    const observer = new MutationObserver(() => { if (polite.textContent) spoken.push(polite.textContent); });
    observer.observe(polite, { childList: true, characterData: true, subtree: true });
    const published = widgetStates.length;
    await act(async () => controller.live.setView((old) => applyGuidanceEvent(old, { kind: "card", card: card("c1", "Clarify approval") })));
    await settle();
    expect(spoken).toContain("New suggestion: Clarify approval");
    expect(widgetStates.length).toBe(published + 1);
    expect(widgetStates.at(-1)!.cards.map((c) => c.say)).toEqual(["Ask who signs off: c1"]);
    // The live panel shows it too.
    expect(host.querySelector(".live-meeting-page")!.textContent).toContain("Clarify approval");
    // Frame reports (once both lanes have started) and a structurally equal view do not publish again.
    for (let i = 1; i <= 40; i++) act(() => { fire("recording-frames", { meetingId, lane: "me", frames: i * 10 }); fire("recording-frames", { meetingId, lane: "remote", frames: i * 10 }); });
    const afterStart = widgetStates.length;
    for (let i = 41; i <= 200; i++) act(() => { fire("recording-frames", { meetingId, lane: "me", frames: i * 10 }); fire("recording-frames", { meetingId, lane: "remote", frames: i * 10 }); });
    await act(async () => controller.live.setView((old) => structuredClone(old)));
    await settle();
    expect(widgetStates.length).toBe(afterStart);
    // Starting capture changed the widget's capture label at most once.
    expect(afterStart - (published + 1)).toBeLessThanOrEqual(1);
    // Another card is a change: announced and published.
    await act(async () => controller.live.setView((old) => applyGuidanceEvent(old, { kind: "card", card: card("c2", "Confirm the deadline") })));
    await settle();
    expect(spoken).toContain("New suggestion: Confirm the deadline");
    expect(widgetStates.length).toBe(afterStart + 1);
    observer.disconnect();
  });

  test("the hidden Meetings page, opened mid-meeting, shows records that arrived while it was hidden", async () => {
    archive.unshift(saved("rec-2", "Recovered budget call"));
    // A launch recovery elsewhere refreshes the archive while the live page is shown.
    await act(async () => fire("record-recovery", { meetingId: "rec-2", state: "recovered" }));
    await settle();
    await act(async () => nav("Archive").click());
    await settle();
    const page = host.querySelector(".record-table");
    expect(page?.textContent).toContain("Recovered budget call");
    expect(page?.textContent).toContain("Kick-off from last week");
    expect(host.textContent).toContain(`${archive.length} saved on this Mac`);
    // Back to the live meeting.
    await act(async () => host.querySelector<HTMLButtonElement>(".live-return button")!.click());
    expect(host.querySelector(".live-meeting-page")?.closest("[hidden]")).toBeNull();
  });

  test("after Stop & save the Meetings page unfreezes and lists the finished meeting", async () => {
    await act(async () => host.querySelector<HTMLButtonElement>(".live-meeting-page button.stop")!.click());
    await settle();
    expect(controller.activeMeeting).toBeUndefined();
    expect(host.querySelector(".live-meeting-page")).toBeNull();
    await act(async () => nav("Archive").click());
    await settle();
    const rows = [...host.querySelectorAll(".record-table .record-row strong")].map((row) => row.textContent);
    expect(rows).toEqual(["Supplier negotiation", "Recovered budget call", "Kick-off from last week"]);
  });
});
