import { afterEach, expect, test, vi } from "vitest";
import { installPreview } from "../../src/copilot/dev/installPreview";
import { CalendarMoveController } from "../../src/lib/public/calendarMove";

// The fictional calendar applies reviewed moves to the same fixture event, so the day panel can be exercised.
const install = (search: string) => {
  const win: Record<string, any> = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { search });
  installPreview();
  return (win.__LIVE_INTERVIEW_PREVIEW__ as { invoke: (command: string, args?: Record<string, unknown>) => Promise<any> }).invoke;
};
afterEach(() => vi.unstubAllGlobals());
const today = () => { const start = new Date(); start.setHours(0, 0, 0, 0); return { startMs: start.getTime(), endMs: start.getTime() + 86_400_000 }; };
const controllerFor = (invoke: (command: string, args?: Record<string, unknown>) => Promise<any>, onMoved = vi.fn(async () => {})) =>
  new CalendarMoveController({
    api: {
      prepareCalendarMove: (change) => invoke("prepare_calendar_change", { change }),
      applyCalendarChange: async (proposalId) => invoke("apply_calendar_change", { proposalId, approval: await invoke("approve_action", { proposalId }) }),
      declineCalendarChange: (proposalId) => invoke("decline_action", { proposalId }),
    },
    onMoved,
  });

test("the default preview has a repeating, a read-only and an invitation event with their flags", async () => {
  const invoke = install("?preview=full&state=normal");
  const { events } = await invoke("public_calendar_events", today());
  const byId = (id: string) => events.find((e: any) => e.id === id);
  expect(byId("event-weekly-sync")).toMatchObject({ recurring: true, readOnly: false });
  expect(byId("event-all-hands")).toMatchObject({ readOnly: true, calendarWritable: false });
  expect(byId("event-partner")).toMatchObject({ invitation: true, organiserIsCurrentUser: false, readOnly: false });
  expect(byId("event-discovery")).toMatchObject({ invitation: false, readOnly: false, version: expect.any(String) });
});

test("a confirmed move edits the same fixture event in place, and Undo moves it back", async () => {
  const invoke = install("?preview=full&state=normal");
  const { events } = await invoke("public_calendar_events", today());
  const partner = events.find((e: any) => e.id === "event-partner");
  const controller = controllerFor(invoke);
  const pending = await controller.propose(partner, { startMs: partner.startMs + 3_600_000, endMs: partner.endMs + 3_600_000 });
  expect(pending).toMatchObject({ invitation: true, calendarName: "Work" });
  // Nothing moved before confirmation.
  expect((await invoke("public_calendar_events", today())).events.find((e: any) => e.id === "event-partner").startMs).toBe(partner.startMs);
  await controller.confirm();
  const after = (await invoke("public_calendar_events", today())).events;
  expect(after.filter((e: any) => e.title === "Partner briefing")).toHaveLength(1);
  expect(after.find((e: any) => e.id === "event-partner").startMs).toBe(partner.startMs + 3_600_000);
  expect(after).toHaveLength(events.length);
  await controller.proposeRevert();
  await controller.confirm();
  expect((await invoke("public_calendar_events", today())).events.find((e: any) => e.id === "event-partner").startMs).toBe(partner.startMs);
});

test("the fictional calendar refuses repeating and read-only events and reports changes made meanwhile", async () => {
  const invoke = install("?preview=full&state=normal");
  const { events } = await invoke("public_calendar_events", today());
  const byId = (id: string) => events.find((e: any) => e.id === id);
  const move = (e: any) => ({ calendarId: e.calendarId, move: true, stableId: e.sourceEventId, originalStartMs: e.startMs, startMs: e.startMs + 900_000, endMs: e.endMs + 900_000, expectedVersion: e.version, inferred: false });
  await expect(invoke("prepare_calendar_change", { change: move(byId("event-weekly-sync")) })).rejects.toBe("recurringUnsupported");
  await expect(invoke("prepare_calendar_change", { change: move(byId("event-all-hands")) })).rejects.toBe("calendarReadOnly");
  await expect(invoke("prepare_calendar_change", { change: { ...move(byId("event-discovery")), expectedVersion: "stale" } })).rejects.toBe("eventChanged");
  vi.unstubAllGlobals();
  const changed = install("?preview=full&state=move-changed");
  const discovery = (await changed("public_calendar_events", today())).events.find((e: any) => e.id === "event-discovery");
  const controller = controllerFor(changed);
  await controller.propose(discovery, { startMs: discovery.startMs + 900_000, endMs: discovery.endMs + 900_000 });
  expect(controller.state.error).toBe("The event changed in your calendar. Nothing was changed.");
});
