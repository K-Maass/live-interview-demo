// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";
import { liveTranscriptEntries, type SpeechEvent } from "@live-interview/core";
import { LiveStore, framesStarted, transcriptEntriesOf, transcriptOf, useFramesStarted, useLiveEvents } from "./liveStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (i: number, language = i % 2 ? "de" : "en"): SpeechEvent => ({ meetingId: "m", segmentId: "s" + i, revision: 0, journalSequence: i * 2, lane: i % 2 ? "remote" : "me", startMs: i * 1000, endMs: i * 1000 + 900, language, text: "line " + i, kind: "final" });
const translation = (i: number): SpeechEvent => ({ ...line(i), segmentId: "t" + i, sourceSegmentId: "s" + i, journalSequence: i * 2 + 1, language: "en", text: "translated " + i, kind: "translation" });

describe("LiveStore", () => {
  test("notifies only on a changed value", () => {
    const store = new LiveStore();
    let calls = 0;
    store.subscribe(() => calls++);
    const frames = { me: 3 };
    store.setFrames(frames);
    store.setFrames(frames);
    store.setFrames((old) => old);
    expect(calls).toBe(1);
    store.setEvents([line(1)]);
    expect(calls).toBe(2);
    expect(store.get().frames).toBe(frames);
  });
  test("a selector re-renders its component only when the selected value changes", async () => {
    const store = new LiveStore();
    const counts = { frames: 0, events: 0 };
    const Started = () => { useFramesStarted({ live: store }); counts.frames++; return null; };
    const Events = () => { useLiveEvents({ live: store }); counts.events++; return null; };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(Started), createElement(Events))));
    for (let i = 1; i <= 100; i++) act(() => store.setFrames((old) => ({ ...old, me: i, remote: i > 50 ? i : 0 })));
    // Two changes only: the microphone started, then system audio.
    expect(counts.frames).toBe(3);
    // Frames are not events.
    expect(counts.events).toBe(1);
    act(() => store.setEvents([line(1)]));
    expect(counts.events).toBe(2);
    await act(async () => root.unmount());
  });
  test("a stub controller with plain values still works (tests and older callers)", async () => {
    let seen: SpeechEvent[] = [];
    const Reader = ({ events }: { events: SpeechEvent[] }) => { seen = useLiveEvents({ events }); return null; };
    const root = createRoot(document.createElement("div"));
    const events = [line(1)];
    await act(async () => root.render(createElement(Reader, { events })));
    expect(seen).toBe(events);
    const next = [line(1), line(2)];
    await act(async () => root.render(createElement(Reader, { events: next })));
    expect(seen).toBe(next);
    await act(async () => root.unmount());
  });
});

describe("shared transcript", () => {
  test("is assembled once per events array and matches core's live entries", () => {
    const events = Array.from({ length: 40 }, (_, i) => i).flatMap((i) => (i % 2 ? [line(i), translation(i)] : [line(i)]));
    expect(transcriptOf(events)).toBe(transcriptOf(events));
    expect(transcriptEntriesOf(events, false)).toBe(transcriptEntriesOf(events, false));
    expect(transcriptEntriesOf(events, false)).toEqual(liveTranscriptEntries(events, false));
    expect(transcriptEntriesOf(events, true)).toEqual(liveTranscriptEntries(events, true));
    // A new array (a new line) is a new transcript.
    expect(transcriptOf([...events, line(99)])).not.toBe(transcriptOf(events));
  });
  test("framesStarted is the same object until a lane starts", () => {
    expect(framesStarted({ me: 1 })).toBe(framesStarted({ me: 500 }));
    expect(framesStarted({})).toBe(framesStarted({ me: 0, remote: 0 }));
    expect(framesStarted({ me: 2, remote: 4 })).toEqual({ me: 1, remote: 1 });
  });
});
