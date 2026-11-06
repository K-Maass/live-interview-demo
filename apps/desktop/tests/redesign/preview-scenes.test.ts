import { afterEach, expect, test, vi } from "vitest";
import { createMeetingState, SnapshotStore, createGuidanceJob, DraftAccumulator } from "@live-interview/core";
import { installPreview } from "../../src/copilot/dev/installPreview";

// The preview scenes used for the setup-checklist and provisional-draft visual checks (docs/acceptance/setup-checklist-preview.md).
const install = (search: string) => {
  const win: Record<string, any> = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { search });
  installPreview();
  return win as { __LIVE_INTERVIEW_PREVIEW__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<any> }; __TAURI_INTERNALS__: { transformCallback: (callback: (value: any) => void) => number } };
};
afterEach(() => vi.unstubAllGlobals());

test("?mic= and ?audio= set the status commands, ignore unknown values, and leave the request commands as the prompting path", async () => {
  const set = install("?preview=full&state=normal&mic=denied&audio=restricted").__LIVE_INTERVIEW_PREVIEW__;
  expect(await set.invoke("microphone_access_status")).toBe("denied");
  expect(await set.invoke("system_audio_access_status")).toBe("restricted");
  vi.unstubAllGlobals();
  const bogus = install("?preview=full&state=normal&mic=bogus").__LIVE_INTERVIEW_PREVIEW__;
  expect(await bogus.invoke("microphone_access_status")).toBe("notDetermined");
  expect(await bogus.invoke("system_audio_access_status")).toBe("notDetermined");
  // Only a click on the card reaches the request command; reading the status never changes it.
  expect(await bogus.invoke("request_microphone_access")).toBe("granted");
  expect(await bogus.invoke("microphone_access_status")).toBe("granted");
});

test("state=warmup-first-load reports the one-time load and keeps the warm-up pending", async () => {
  const preview = install("?preview=full&state=warmup-first-load").__LIVE_INTERVIEW_PREVIEW__;
  expect(await preview.invoke("speech_warmup_state")).toMatchObject({ firstLoad: true, status: expect.stringContaining("one-time") });
  const outcome = await Promise.race([preview.invoke("warm_local_speech").then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("pending"), 30))]);
  expect(outcome).toBe("pending");
  vi.unstubAllGlobals();
  // ?warmup=first adds the same load to another scene, so the live meeting page can show it.
  const live = install("?preview=full&state=live&warmup=first").__LIVE_INTERVIEW_PREVIEW__;
  expect(await live.invoke("speech_warmup_state")).toMatchObject({ firstLoad: true });
  vi.unstubAllGlobals();
  const normal = install("?preview=full&state=normal").__LIVE_INTERVIEW_PREVIEW__;
  expect(await normal.invoke("speech_warmup_state")).toMatchObject({ firstLoad: false });
  expect(await normal.invoke("warm_local_speech")).toEqual({});
});

test("state=live-draft streams raw JSON fragments for a requested answer and never finishes it", async () => {
  const win = install("?preview=full&state=live-draft");
  const preview = win.__LIVE_INTERVIEW_PREVIEW__;
  const received: { delta?: string }[] = [];
  const id = win.__TAURI_INTERNALS__.transformCallback((raw: { message: { delta?: string } }) => received.push(raw.message));
  const state = createMeetingState({ id: "fixture", workspaceId: "fixture", purpose: "Discovery", objectives: [], attendees: [] });
  const store = new SnapshotStore(); store.initialise(state);
  const job = createGuidanceJob("checkConversation", store.read(state), "requested");
  const outcome = await Promise.race([preview.invoke("reasoning_run", { job, onDraft: `__CHANNEL__:${id}` }).then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("pending"), 30))]);
  expect(outcome).toBe("pending");
  const draft = new DraftAccumulator();
  let text: string | undefined;
  for (const update of received) text = draft.push(update.delta!).text;
  expect(text).toBe("Could we separate working, review and waiting time so we can see where the handoff slows");
});

// Calendar redesign scenes (#123).
const weekRange = () => { const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 8); return { startMs: start.getTime(), endMs: end.getTime() }; };
const calendar = async (scene: string) => install(`?preview=full&state=${scene}`).__LIVE_INTERVIEW_PREVIEW__.invoke("public_calendar_events", weekRange());

test("state=calendar-dense has fourteen meetings today, including clusters of four, two and three overlaps", async () => {
  const { events, coverage } = await calendar("calendar-dense");
  expect(events).toHaveLength(14);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  expect(events.every((e: any) => e.startMs >= today.getTime() && e.endMs <= tomorrow.getTime())).toBe(true);
  const overlapping = (id: string) => { const e = events.find((x: any) => x.id === id); return events.filter((x: any) => x.startMs < e.endMs && x.endMs > e.startMs).length; };
  expect(overlapping("event-sync")).toBeGreaterThanOrEqual(4);
  expect(overlapping("event-budget")).toBe(2);
  // The three ten-minute meetings overlap only partly in real time (A and B not at all); they collide through the minimum block height.
  expect(overlapping("event-quick-a")).toBe(1);
  expect(overlapping("event-quick-b")).toBe(2);
  expect(coverage.every((c: any) => c.status === "ready")).toBe(true);
  expect(events.some((e: any) => e.attendees?.some((a: any) => !a.email.endsWith("@example.test")))).toBe(false);
});

test("state=calendar-allday adds all-day, multi-day, overnight and recurring events with their flags", async () => {
  const { events } = await calendar("calendar-allday");
  const byId = (id: string) => events.find((e: any) => e.id === id);
  expect(byId("event-holiday")).toMatchObject({ isAllDay: true, startDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), endDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(byId("event-offsite").endDay > byId("event-offsite").startDay).toBe(true);
  expect(byId("event-offsite").endMs - byId("event-offsite").startMs).toBeGreaterThan(5 * 23 * 3600_000);
  expect(new Date(byId("event-oncall").startMs).getDate()).not.toBe(new Date(byId("event-oncall").endMs).getDate());
  expect(byId("event-weekly").recurring).toBe(true);
  expect(byId("event-discovery").isAllDay).toBeUndefined();
  expect(byId("event-discovery").joinUrl).toContain("example.test");
});

test("state=calendar-empty has an account and coverage but no events", async () => {
  const preview = install("?preview=full&state=calendar-empty").__LIVE_INTERVIEW_PREVIEW__;
  const { events, coverage } = await preview.invoke("public_calendar_events", weekRange());
  expect(events).toEqual([]);
  expect(coverage).toHaveLength(1);
  expect(coverage[0].status).toBe("ready");
  expect(await preview.invoke("public_calendar_accounts")).toHaveLength(1);
});

test("state=calendar-partial is ready for the first half of the range and partial for the rest", async () => {
  const range = weekRange();
  const { coverage } = await calendar("calendar-partial");
  expect(coverage.map((c: any) => c.status)).toEqual(["ready", "partial"]);
  expect(coverage[0].startMs).toBe(range.startMs);
  expect(coverage[0].endMs).toBe(coverage[1].startMs);
  expect(coverage[1].endMs).toBe(range.endMs);
});

test("state=calendar-loading answers the events call only after 2.5 seconds", async () => {
  vi.useFakeTimers();
  try {
    const preview = install("?preview=full&state=calendar-loading").__LIVE_INTERVIEW_PREVIEW__;
    let done = false;
    const pending = preview.invoke("public_calendar_events", weekRange()).then((value) => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(2400);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).events.length).toBeGreaterThan(0);
  } finally { vi.useRealTimers(); }
});
