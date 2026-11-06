// @vitest-environment happy-dom
// The real wiring, in a DOM and under StrictMode: controller status -> useLiveAnnouncements -> useAnnouncer's gate ->
// the permanent polite live region. Counts what the region actually says, not what a pure function returns.
import { StrictMode, act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeStatus, initialAssistanceStatus, type AssistanceStatus, type StatusEvent } from "../lib/copilot/status";
import { idleModelSetup } from "../lib/public/modelSetup";
import { useAnnouncer } from "./Announcer";
import { useLiveAnnouncements } from "./useLiveAnnouncements";
import type { CopilotController } from "./useCopilotController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const controller = (assistance: AssistanceStatus) => ({
  speechStatus: "Local speech ready",
  modelSetup: idleModelSetup,
  activeMeeting: undefined,
  view: { cards: [], savedPins: [], queued: 0 },
  assistance,
  entry: { callOffer: undefined },
}) as unknown as CopilotController;

function Harness({ c }: { c: CopilotController }): ReactNode {
  const { announce, regions } = useAnnouncer();
  useLiveAnnouncements(c, undefined, announce);
  return regions;
}

let root: Root;
let host: HTMLElement;
let spoken: string[];
let observer: MutationObserver;
let sequence = 0;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
const report = async (event: StatusEvent) => {
  const status = describeStatus(event, ++sequence);
  await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { c: controller(status) }))));
  await settle();
};

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { c: controller(initialAssistanceStatus) }))));
  const polite = host.querySelector('[data-announcer="polite"]')!;
  spoken = [];
  observer = new MutationObserver(() => { if (polite.textContent) spoken.push(polite.textContent); });
  observer.observe(polite, { childList: true, characterData: true, subtree: true });
});
afterEach(async () => {
  observer.disconnect();
  await act(async () => root.unmount());
  host.remove();
});

describe("assistance confirmations reach the live region", () => {
  // The info-level confirmations panels report through setAssistanceStatus (severity info, code message).
  const confirmations = [
    "Approved record link created",
    "Practical steps saved to an app-owned internal note",
    "Action extraction pending · source record is saved",
    "Pilot feedback saved in the app’s internal note",
    "Meeting notes saved to 2 destinations.",
    "Meeting saved. Its synthesis needs service access; make it from Overview when available.",
  ];
  test("each info confirmation is spoken exactly once, politely", async () => {
    for (const text of confirmations) await report({ code: "message", text });
    expect(spoken).toEqual(confirmations);
    expect(host.querySelector('[data-announcer="assertive"]')!.textContent).toBe("");
  });
  test("ok statuses and coded runtime hints are not spoken; degraded ones are", async () => {
    await report({ code: "guidanceReady", detail: "prepared · 412 ms" });
    await report({ code: "message", text: "Nothing to say", severity: "ok" });
    await report({ code: "contextPending" });
    expect(spoken).toEqual([]);
    await report({ code: "reasoningUnavailable" });
    expect(spoken).toEqual(["Suggestions are unavailable right now. Recording continues."]);
  });
  test("the same words reported again straight away are a new report and are spoken again", async () => {
    await report({ code: "message", text: "Meeting synthesis saved." });
    await report({ code: "message", text: "Meeting synthesis saved." });
    expect(spoken).toEqual(["Meeting synthesis saved.", "Meeting synthesis saved."]);
  });
  test("re-rendering the same report does not speak it again", async () => {
    const status = describeStatus({ code: "message", text: "Approved record link created" }, ++sequence);
    for (let i = 0; i < 3; i++) {
      await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { c: controller(status) }))));
      await settle();
    }
    expect(spoken).toEqual(["Approved record link created"]);
  });
});
