import { describe, expect, test } from "vitest";
import type { GuidanceCard, LiveViewState } from "@live-interview/core";
import { applyModelSetupEvent, failModelSetup, idleModelSetup, requestModelSetupCancel, startModelSetup, type ModelSetupState } from "../public/modelSetup";
import { loadingStatus, slowStatus, warmPendingStatus, warmStatus } from "../public/speechWarmup";
import {
  AnnouncementGate,
  assistanceAnnouncement,
  callOfferAnnouncement,
  captureAnnouncement,
  guidanceAnnouncement,
  modelSetupAnnouncement,
  speechStatusAnnouncement,
} from "./announcements";
import { describeStatus } from "./status";

describe("speech warm-up", () => {
  const oneTime = "Preparing local speech (one-time, a few minutes) · recording continues";
  test("announces the load as plain sentences, then that it is ready", () => {
    expect(speechStatusAnnouncement("Local", oneTime)).toEqual({ text: "Preparing local speech (one-time, a few minutes). Recording continues.", politeness: "polite" });
    expect(speechStatusAnnouncement(oneTime, warmStatus)).toEqual({ text: "Local speech is ready.", politeness: "polite" });
  });
  test("a quiet launch where the status was never preparing says nothing", () => {
    expect(speechStatusAnnouncement(undefined, warmStatus)).toBeUndefined();
    expect(speechStatusAnnouncement(warmStatus, warmStatus)).toBeUndefined();
    expect(speechStatusAnnouncement("Local", "Local speech running")).toBeUndefined();
  });
  test("a failed warm-up is polite and says recording is still available", () => {
    const result = speechStatusAnnouncement(loadingStatus, warmPendingStatus);
    expect(result?.politeness).toBe("polite");
    expect(result?.text).toContain("Local recording still available");
  });
  test("an overdue load is announced once, politely, and its later finish is announced as ready", () => {
    expect(speechStatusAnnouncement(loadingStatus, slowStatus)).toEqual({ text: "Local speech is taking longer than usual. Recording continues.", politeness: "polite" });
    expect(speechStatusAnnouncement(slowStatus, slowStatus)).toBeUndefined();
    expect(speechStatusAnnouncement(slowStatus, warmStatus)).toEqual({ text: "Local speech is ready.", politeness: "polite" });
  });
});

describe("model download", () => {
  const progress = (state: ModelSetupState, completedBytes: number, totalBytes = 1000, stage: "downloading" | "retrying" = "downloading", asset = "recognition", now = 0) =>
    applyModelSetupEvent(state, { kind: "setupProgress", stage, asset, completedBytes, totalBytes, resumedBytes: 0, attempt: 1 }, now);
  test("announces the start once, not each progress line", () => {
    const started = startModelSetup();
    expect(modelSetupAnnouncement(idleModelSetup, started)?.text).toContain("download started");
    const first = progress(started, 10);
    expect(modelSetupAnnouncement(started, first)).toBeUndefined();
    expect(modelSetupAnnouncement(first, progress(first, 20))).toBeUndefined();
  });
  test("announces each quarter once, in a single message per crossing", () => {
    let state = progress(startModelSetup(), 10);
    const spoken: string[] = [];
    for (let bytes = 20; bytes <= 1000; bytes += 10) {
      const next = progress(state, bytes);
      const message = modelSetupAnnouncement(state, next);
      if (message) spoken.push(message.text);
      state = next;
    }
    expect(spoken).toEqual([
      "Downloading the speech recognition model: 25 percent.",
      "Downloading the speech recognition model: 50 percent.",
      "Downloading the speech recognition model: 75 percent.",
    ]);
  });
  test("a jump over several quarters announces only the latest", () => {
    const before = progress(startModelSetup(), 100);
    expect(modelSetupAnnouncement(before, progress(before, 800))?.text).toContain("75 percent");
  });
  test("an unknown total never produces a percentage", () => {
    const before = progress(startModelSetup(), 0, 0);
    expect(modelSetupAnnouncement(before, progress(before, 5_000_000, 0))).toBeUndefined();
  });
  test("a second asset restarts the quarters", () => {
    const first = progress(startModelSetup(), 900, 1000, "downloading", "recognition");
    const second = progress(first, 300, 1000, "downloading", "translation");
    expect(modelSetupAnnouncement(first, second)?.text).toBe("Downloading the experimental translation model: 25 percent.");
  });
  test("cancel, retry, finish and failure", () => {
    const running = progress(startModelSetup(), 100);
    expect(modelSetupAnnouncement(running, requestModelSetupCancel(running))?.text).toBe("Cancelling the download.");
    expect(modelSetupAnnouncement(running, progress(running, 100, 1000, "retrying"))?.text).toContain("retrying");
    expect(modelSetupAnnouncement(running, idleModelSetup)).toEqual({ text: "Speech models are downloaded and ready.", politeness: "polite" });
    const cancelled = modelSetupAnnouncement(running, failModelSetup(running, "cancelled"));
    expect(cancelled?.politeness).toBe("polite");
    expect(cancelled?.text).toContain("cancelled");
    const network = modelSetupAnnouncement(running, failModelSetup(running, "network"));
    expect(network?.politeness).toBe("assertive");
    expect(network?.text).toContain("Retry");
  });
  test("a late progress line after a failure says nothing", () => {
    const failed = failModelSetup(progress(startModelSetup(), 100), "network");
    expect(modelSetupAnnouncement(failed, applyModelSetupEvent(failed, { kind: "setupProgress", stage: "downloading", asset: "recognition", completedBytes: 500, totalBytes: 1000, resumedBytes: 0, attempt: 1 }, 0))).toBeUndefined();
  });
});

describe("guidance", () => {
  const card = (id: string, extra: Partial<GuidanceCard> = {}) => ({ id, headline: "Headline " + id, say: "Say " + id, intent: "digDeeper", pinned: false, stale: false, evidence: [], ...extra }) as unknown as GuidanceCard;
  const view = (cards: GuidanceCard[], extra: Partial<LiveViewState> = {}): LiveViewState => ({ cards, savedPins: [], queued: 0, ...extra });
  const label = (c: GuidanceCard) => c.headline ?? "Suggestion";
  test("nothing is announced for the first view of a meeting", () => {
    expect(guidanceAnnouncement(undefined, view([card("a")]), label)).toBeUndefined();
  });
  test("an automatic card announces its headline only", () => {
    expect(guidanceAnnouncement(view([]), view([card("a", { trigger: "automatic" })]), label)).toEqual({ text: "New suggestion: Headline a", politeness: "polite" });
  });
  test("card text is never read, even for a card the person requested", () => {
    for (const extra of [{ trigger: "requested" as const }, { trigger: "requested" as const, provisional: true }]) {
      const text = guidanceAnnouncement(view([]), view([card("a", extra)]), label)?.text;
      expect(text).toBe("New suggestion: Headline a");
      expect(text).not.toContain("Say a");
    }
  });
  test("a refinement that replaces a card says updated, not new", () => {
    expect(guidanceAnnouncement(view([card("a", { provisional: true })]), view([card("b")]), label)?.text).toBe("Suggestion updated: Headline b");
  });
  test("pin, dismiss and unchanged views are silent", () => {
    expect(guidanceAnnouncement(view([card("a")]), view([card("a", { pinned: true })]), label)).toBeUndefined();
    expect(guidanceAnnouncement(view([card("a"), card("b")]), view([card("a")]), label)).toBeUndefined();
  });
  test("several new cards are summarised in one message", () => {
    expect(guidanceAnnouncement(view([]), view([card("a"), card("b")]), label)?.text).toBe("2 new suggestions: Headline a; Headline b");
  });
  test("a draft is announced once and its text is never read", () => {
    const first = guidanceAnnouncement(view([]), view([], { draft: { intent: "digDeeper", text: "Could you tell me" } }), label);
    expect(first).toEqual({ text: "Draft guidance is being checked.", politeness: "polite" });
    expect(guidanceAnnouncement(view([], { draft: { intent: "digDeeper", text: "Could you" } }), view([], { draft: { intent: "digDeeper", text: "Could you tell me more" } }), label)).toBeUndefined();
  });
  test("the placeholder behind a draft is not announced separately", () => {
    const placeholder = card("p", { origin: "clarification", provisional: true });
    expect(guidanceAnnouncement(view([]), view([placeholder], { draft: { intent: "digDeeper", text: "Could" } }), label)?.text).toBe("Draft guidance is being checked.");
  });
});

describe("capture, assistance and detected call", () => {
  test("start, pause and resume are announced once; the start-up step and failure are not (failure is an alert where it happens)", () => {
    expect(captureAnnouncement("Starting audio capture", "Recording locally")?.text).toBe("Recording started.");
    expect(captureAnnouncement("Recording locally", "Recording paused")?.text).toBe("Recording paused.");
    expect(captureAnnouncement("Recording paused", "Recording locally")?.text).toBe("Recording resumed.");
    expect(captureAnnouncement(undefined, "Recording locally")).toBeUndefined();
    expect(captureAnnouncement("Recording locally", "Recording needs attention")).toBeUndefined();
    expect(captureAnnouncement("Recording locally", "Recording locally")).toBeUndefined();
  });
  test("healthy statuses and coded runtime hints stay silent; degradation is spoken", () => {
    expect(assistanceAnnouncement(0, describeStatus({ code: "guidanceReady", detail: "prepared · 412 ms" }, 1))).toBeUndefined();
    expect(assistanceAnnouncement(0, describeStatus({ code: "contextPending" }, 1))).toBeUndefined();
    expect(assistanceAnnouncement(0, describeStatus({ code: "reasoningUnavailable" }, 1))?.text).toBe("Suggestions are unavailable right now. Recording continues.");
    expect(assistanceAnnouncement(0, describeStatus({ code: "message", text: "Compact widget could not open; main assistance remains available.", severity: "degraded" }, 1))?.politeness).toBe("polite");
  });
  test("info confirmations from panels are spoken politely; ok messages are not", () => {
    expect(assistanceAnnouncement(0, describeStatus({ code: "message", text: "Approved record link created" }, 1))).toEqual({ text: "Approved record link created", politeness: "polite", eventId: "assistance:1" });
    expect(assistanceAnnouncement(0, describeStatus({ code: "message", text: "Quiet", severity: "ok" }, 1))).toBeUndefined();
  });
  test("the status model's severity decides what is spoken, once per report, not the wording", () => {
    expect(assistanceAnnouncement(0, { id: 1, code: "message", text: "Guidance is taking a break", severity: "degraded" })?.text).toBe("Guidance is taking a break");
    expect(assistanceAnnouncement(0, { id: 1, code: "refinementPending", text: "Refinement unavailable, by design", severity: "ok" })).toBeUndefined();
    expect(assistanceAnnouncement(4, { id: 4, code: "message", text: "Same", severity: "degraded" })).toBeUndefined();
    expect(assistanceAnnouncement(4, { id: 5, code: "message", text: "Same", severity: "degraded" })?.eventId).toBe("assistance:5");
  });
  test("a detected call is offered once per title", () => {
    expect(callOfferAnnouncement(undefined, "Customer discovery")?.text).toContain("Customer discovery");
    expect(callOfferAnnouncement("Customer discovery", "Customer discovery")).toBeUndefined();
    expect(callOfferAnnouncement("Customer discovery", undefined)).toBeUndefined();
  });
});

describe("AnnouncementGate", () => {
  test("drops the same text inside the window and lets it through afterwards", () => {
    const gate = new AnnouncementGate(1000);
    const a = { text: "Recording paused.", politeness: "polite" as const };
    expect(gate.accept(a, 0)).toBe(true);
    expect(gate.accept(a, 500)).toBe(false);
    expect(gate.accept({ text: "Other", politeness: "polite" }, 600)).toBe(true);
    expect(gate.accept(a, 1500)).toBe(true);
  });
  test("a new report with the same words is spoken again; the same report never twice", () => {
    const gate = new AnnouncementGate(15_000);
    const saved = (id: number) => ({ text: "Meeting notes saved to 2 destinations.", politeness: "polite" as const, eventId: `assistance:${id}` });
    expect([gate.accept(saved(1), 0), gate.accept(saved(2), 1000), gate.accept(saved(2), 2000), gate.accept(saved(1), 3000)]).toEqual([true, true, false, false]);
    // A state announcement without an event id is still deduplicated by its words.
    const paused = { text: "Recording paused.", politeness: "polite" as const };
    expect([gate.accept(paused, 4000), gate.accept(paused, 5000)]).toEqual([true, false]);
  });
  test("pause, resume, pause inside the window is never swallowed", () => {
    const gate = new AnnouncementGate(15_000);
    const paused = { text: "Recording paused.", politeness: "polite" as const };
    const resumed = { text: "Recording resumed.", politeness: "polite" as const };
    expect([gate.accept(paused, 0), gate.accept(resumed, 2000), gate.accept(paused, 4000)]).toEqual([true, true, true]);
  });
});
