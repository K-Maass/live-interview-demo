// @vitest-environment happy-dom
// Overview notices and keyboard availability, rendered in a DOM under StrictMode and driven by clicks and real saves.
import { StrictMode, act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PublicArtifact } from "@live-interview/core";
import { ArtifactCache } from "../lib/public/artifacts";
import { attentionAfterArtifactSave, attentionNotices, clearAttention, destinationOutcome, markAttention, type AttentionMap, type AttentionNotice } from "../lib/copilot/recordAttention";
import { defaultShortcuts } from "../lib/copilot/shortcuts";
import { shortcutAvailabilityLine } from "../lib/copilot/status";
import { AttentionNotices } from "./screens/ReviewMeetingPage";
import { ShortcutSettings } from "./ShortcutSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (node: ReactNode) => act(async () => root.render(createElement(StrictMode, null, node)));
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const click = (label: string) => act(async () => button(label)!.click());

/** The Overview's notices for one record, wired to the same map operations the controller uses. */
function Overview({ initial, cache, actions }: { initial: AttentionMap; cache: ArtifactCache; actions: string[] }) {
  const [map, setMap] = useState(initial);
  // As in useCopilotController: subscribed in an effect, so StrictMode's remount must not leave a stale listener.
  useEffect(() => cache.subscribe((saved) => setMap((old) => attentionAfterArtifactSave(old, saved))), [cache]);
  const onAction = (notice: AttentionNotice) => actions.push(`${notice.action}:${notice.kind}`);
  return createElement(AttentionNotices, { notices: attentionNotices(map.m1), onAction, onDismiss: (notice) => setMap((old) => clearAttention(old, "m1", notice.kind)) });
}
const saved: PublicArtifact = { meetingId: "m1", kind: "synthesis", recordRevision: 1, status: "ready", text: "Summary", evidence: [], humanEdited: false, updatedAtMs: 1 };
const cache = () => new ArtifactCache({ getArtifact: async () => null, saveArtifact: async (a) => a });

describe("Overview attention notices", () => {
  test("a synthesis saved by another path (Generate on Overview) clears the synthesis notice", async () => {
    const artifacts = cache();
    await render(createElement(Overview, { initial: markAttention({}, "m1", { synthesis: "failed", destinations: 1 }), cache: artifacts, actions: [] }));
    expect(host.textContent).toContain("its synthesis could not be made yet");
    await act(async () => { await artifacts.saveGenerated({ ...saved, status: "pending" }); });
    expect(host.textContent).toContain("its synthesis could not be made yet");
    await act(async () => { await artifacts.saveGenerated(saved); });
    expect(host.textContent).not.toContain("synthesis");
    expect(host.textContent).toContain("One note destination could not be updated.");
  });
  test("the service-access case is a persistent notice too", async () => {
    await render(createElement(Overview, { initial: markAttention({}, "m1", { synthesis: "needsAccess" }), cache: cache(), actions: [] }));
    expect(host.textContent).toContain("Its synthesis needs service access");
    expect(button("Make synthesis")).toBeDefined();
  });
  test("each notice can be dismissed", async () => {
    await render(createElement(Overview, { initial: markAttention({}, "m1", { synthesis: "failed", destinations: 2 }), cache: cache(), actions: [] }));
    expect(host.querySelectorAll(".attention-notice")).toHaveLength(2);
    await click("Dismiss");
    expect(host.querySelectorAll(".attention-notice")).toHaveLength(1);
    await click("Dismiss");
    expect(host.querySelectorAll(".attention-notice")).toHaveLength(0);
  });
  test("a revoked or changed destination explains why and opens Knowledge settings instead of retrying", async () => {
    const actions: string[] = [];
    const initial = destinationOutcome({}, "m1", { failed: [{ code: "appendGrantMissing" }] });
    await render(createElement(Overview, { initial, cache: cache(), actions }));
    expect(host.textContent).toContain("Access to one note destination was removed.");
    expect(button("Retry notes")).toBeUndefined();
    await click("Open Knowledge settings");
    expect(actions).toEqual(["openKnowledge:blocked"]);
  });
});

describe("unavailable shortcuts stay visible", () => {
  test("Settings › Keyboard names the affected action until the registrar reports success", async () => {
    const pin = defaultShortcuts.pin;
    await render(createElement(ShortcutSettings, { expanded: true, value: defaultShortcuts, onChange() {}, unavailable: [pin] }));
    const notes = host.querySelectorAll(".shortcut-unavailable");
    expect(notes).toHaveLength(1);
    expect(notes[0].closest("label")!.textContent).toContain("Pin suggestion");
    expect(notes[0].textContent).toMatch(/is unavailable, probably used by another app\. The button still works/);
    const input = notes[0].closest("label")!.querySelector("input")!;
    expect(input.getAttribute("aria-describedby")).toBe(notes[0].id);
    await render(createElement(ShortcutSettings, { expanded: true, value: defaultShortcuts, onChange() {}, unavailable: [] }));
    expect(host.querySelectorAll(".shortcut-unavailable")).toHaveLength(0);
  });
  test("the live page line comes from the last apply, not from the latest status", () => {
    expect(shortcutAvailabilityLine([])).toBeUndefined();
    expect(shortcutAvailabilityLine(["CommandOrControl+Alt+Escape"])).toBe("The shortcut ⌘⌥⎋ is unavailable. The buttons still work.");
    expect(shortcutAvailabilityLine(["CommandOrControl+Alt+Escape", "CommandOrControl+Shift+P"])).toMatch(/^The shortcuts ⌘⌥⎋, .+ are unavailable\. The buttons still work\.$/);
  });
});
