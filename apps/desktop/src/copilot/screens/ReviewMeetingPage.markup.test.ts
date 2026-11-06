import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { MeetingRecord } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";

// The record page's own wording is under test; the artifact panels it hosts have their own tests.
vi.mock("../AfterMeeting", () => ({ AfterMeeting: () => "[after meeting]" }));
vi.mock("../FilingReview", () => ({ FilingReview: () => null }));
vi.mock("../PilotFeedback", () => ({ PilotFeedback: () => null }));
vi.mock("./PublicSynthesis", () => ({ PublicSynthesis: () => "[public synthesis]" }));
vi.mock("../live/TranscriptView", () => ({ TranscriptView: () => null }));
vi.mock("../PinnedTopicsReview", () => ({ PinnedTopicsReview: ({ meetingId }: { meetingId: string }) => `[pinned topics for ${meetingId}]` }));

const { ReviewMeetingPage } = await import("./ReviewMeetingPage");

const record = (extra: Partial<MeetingRecord>) =>
  ({ id: "m1", purpose: "Supplier review", profileId: "workClient", workspaceId: "default", date: "2026-10-20T09:00:00.000Z", attendees: [], segments: [], importedSegments: [], attributions: [], revision: 1, canonicalEnglishPath: "/records/m1/english.md", translationStatus: "complete", pendingSegments: 0, ...extra }) as unknown as MeetingRecord;
const render = (r: MeetingRecord, recordAttention: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReviewMeetingPage, {
    controller: { selectedRecord: r, publicProduct: { enabled: true, account: undefined }, events: [], english: false, setEnglish() {}, setAssistanceStatus() {}, workspaces: [], recover: async () => {}, recordAttention, retryAttention: async () => {}, dismissAttention() {} } as unknown as CopilotController,
    artifact: "overview",
    navigate() {},
  }));

describe("an archive summary before the full record arrives", () => {
  test("mounts no segment-dependent panel and shows a calm loading state", () => {
    const html = render(record({ summary: true }));
    expect(html).toContain("Opening the saved meeting…");
    expect(html).not.toContain("[after meeting]");
    expect(html).not.toContain("[public synthesis]");
    expect(html).not.toContain("[pinned topics for m1]");
  });
  test("the full record mounts the panels", () => {
    const html = render(record({}));
    expect(html).not.toContain("Opening the saved meeting");
    expect(html).toContain("[after meeting]");
    expect(html).toContain("[public synthesis]");
  });
});

describe("record page processing wording", () => {
  test("a record whose translation is unavailable never claims an English record, and is plain muted text", () => {
    const html = render(record({ translationStatus: "unavailable" }));
    expect(html).toContain("Saved · translation unavailable");
    expect(html).not.toContain("Source and English record saved");
    expect(html).not.toContain("English translation available");
    expect(html).toContain('<span class="pending-status">Source saved · translation unavailable</span>');
    expect(html).toContain("English translation unavailable on this Mac");
    expect(html).not.toContain("complete-status");
    expect(html).not.toContain("processing-notice");
  });
  test("a complete record keeps the complete wording", () => {
    const html = render(record({ translationStatus: "complete" }));
    expect(html).toContain('<span class="complete-status">Source and English record saved</span>');
    expect(html).toContain("English translation available");
  });
  test("a pending record says the translation is pending", () => {
    const html = render(record({ translationStatus: "pending" }));
    expect(html).toContain('<span class="pending-status">Source saved · translation pending</span>');
    expect(html).toContain("English translation pending");
  });
  test("the overview hosts the read-only pinned topics of this record", () => {
    expect(render(record({}))).toContain("[pinned topics for m1]");
  });
  test("a failed synthesis or note destination stays on the overview as a plain notice with Retry", () => {
    const html = render(record({}), { m1: { synthesis: "failed", destinations: 1 } });
    expect(html).toContain("The meeting is saved, but its synthesis could not be made yet.");
    expect(html).toContain(">Retry synthesis</button>");
    expect(html).toContain("One note destination could not be updated.");
    expect(html).toContain(">Retry notes</button>");
    expect(render(record({}), { other: { synthesis: "failed" } })).not.toContain("Retry synthesis");
  });
  test("a meeting recovered after a crash says so in plain words, and Retry stays for what is still pending", () => {
    const recovering = render(record({ translationStatus: "pending", pendingSegments: 2, recovery: { state: "recovering" } }));
    expect(recovering).toContain('<p class="notice recovery-notice">The app closed during this meeting. What it saved is being processed now.</p>');
    expect(recovering).not.toContain("Retry processing"); // recovery is already processing it
    const recovered = render(record({ translationStatus: "pending", pendingSegments: 1, recovery: { state: "recovered" } }));
    expect(recovered).toContain("Recovered after the app closed unexpectedly.");
    expect(recovered).toContain(">Retry processing</button>");
    expect(render(record({}))).not.toContain("recovery-notice");
  });
});
