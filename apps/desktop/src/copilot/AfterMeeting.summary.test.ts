// @vitest-environment happy-dom
// Opening an archived meeting: the summary (no transcript) arrives first, the full record after load_meeting_record.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MeetingRecord, SpeechEvent } from "@live-interview/core";

const saved = [{ task: "Send the file", inferred: false, owner: null, due: null, evidence: ["segment:t@1"] }];
const loadLatest = vi.fn(async () => ({ meetingId: "m1", kind: "actions", recordRevision: 1, status: "ready", text: JSON.stringify(saved), evidence: [], humanEdited: false, updatedAtMs: 1 }));
vi.mock("../lib/public/synthesis", () => ({ publicArtifacts: { loadLatest, load: async () => null, subscribe: () => () => {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("not under test"); }) }));
const { AfterMeeting } = await import("./AfterMeeting");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
beforeEach(() => { loadLatest.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const segment: SpeechEvent = { meetingId: "m1", segmentId: "t", revision: 1, journalSequence: 1, lane: "remote", startMs: 0, endMs: 1, language: "de", text: "Wir senden morgen.", kind: "final" };
const record = (extra: Partial<MeetingRecord>) =>
  ({ id: "m1", purpose: "Supplier review", profileId: "workClient", workspaceId: "default", date: "2026-10-20T09:00:00.000Z", attendees: [], segments: [], importedSegments: [], attributions: [], revision: 1, canonicalEnglishPath: "/records/m1/english.md", translationStatus: "complete", pendingSegments: 0, ...extra }) as unknown as MeetingRecord;
const render = (r: MeetingRecord) => act(async () => root.render(createElement(AfterMeeting, { record: r, onStatus() {}, artifact: "actions" })));

test("saved commitments stay explicit once the full record replaces the archive summary", async () => {
  await render(record({ summary: true }));
  // Nothing is grounded against the transcript-less summary.
  expect(loadLatest).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Send the file");
  // Same id, revision and pendingSegments: only the transcript arrives.
  await render(record({ segments: [segment] }));
  expect(loadLatest).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Send the file");
  expect(host.textContent).toContain("Explicit commitment");
  expect(host.textContent).not.toContain("Inferred opportunity");
});
