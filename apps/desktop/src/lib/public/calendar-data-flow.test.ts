import { beforeEach, expect, test, vi } from "vitest";
import type { PublicCalendarEvent, SourceHit } from "@live-interview/core";
import { createMeetingState, SnapshotStore } from "@live-interview/core";
const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: boundary.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
import { generatePreparation, meetingOptions } from "./reasoning";
import { newMeetingPlan } from "./state";

// Pins docs/public/calendar-verification-pack.md, "What calendar data leaves the Mac".
// Every calendar-derived value below is a unique canary so a leak cannot hide in a common word.
const event: PublicCalendarEvent = {
  id: "event-canary-id",
  title: "Canary meeting title 7731",
  startMs: 1893400000000,
  endMs: 1893456789012,
  accountId: "account-canary-id",
  calendarId: "calendar-canary-id",
  provider: "google",
  sourceEventId: "source-event-canary-id",
  timeZone: "Canary/Zone",
  joinUrl: "https://meet.example.test/canary-join-link",
  organiser: "organiser-canary@example.test",
  attendees: [
    { name: "Attendee Canary Name", email: "attendee-canary@example.test" },
  ],
  version: "version-canary",
  readOnly: true,
};
const others = [
  "event-canary-id",
  "account-canary-id",
  "calendar-canary-id",
  "source-event-canary-id",
  "Canary/Zone",
  "canary-join-link",
  "organiser-canary",
  "Attendee Canary Name",
  "attendee-canary@example.test",
  "version-canary",
  "1893456789012",
  "1893400000000",
];
const hit: SourceHit = {
  sourceId: "doc",
  workspaceId: "workspace",
  kind: "markdown",
  title: "Plan",
  text: "Local note",
  locator: "/selected/plan.md",
  revision: 1,
  derived: false,
};
beforeEach(() => {
  boundary.invoke.mockReset();
  boundary.invoke.mockImplementation(async (command: string) => {
    if (command === "public_list_workspaces")
      return [
        {
          id: "workspace",
          root: "/selected",
          name: "Selected",
          roots: ["/selected"],
          sharedLibraryIds: [],
          appendTargets: [],
          revision: 1,
        },
      ];
    if (command === "public_workspace_sources")
      return [
        {
          sourceId: "doc",
          workspaceId: "workspace",
          title: "Plan",
          path: "/selected/plan.md",
          revision: 1,
        },
      ];
    if (command === "refresh_workspace") return { changedSourceIds: [] };
    if (command === "retrieve_context") return [structuredClone(hit)];
    if (command === "reasoning_cancel") return;
    if (command === "reasoning_run")
      return {
        outcome: "failure",
        jobId: "x",
        basis: {},
        output: null,
        code: "fixture",
      };
    throw Error("unexpected " + command);
  });
});

test("a calendar event seeds only its title into the plan's wire-visible fields", () => {
  const plan = newMeetingPlan("plan", 1, event);
  expect(plan.title).toBe(event.title);
  expect(plan.attendees).toEqual([]);
  const options = meetingOptions(plan);
  expect(options.attendees).toEqual([]);
  expect(options.purpose).toBe(event.title);
  // The basis a model job carries is built from the options and does not hold event identity,
  // organiser, attendees, join link, calendar or account ids, or the scheduled times.
  const state = createMeetingState(options);
  const store = new SnapshotStore();
  store.initialise(state);
  const basis = JSON.stringify(store.read(state));
  expect(basis).toContain(event.title);
  for (const canary of others) expect(basis).not.toContain(canary);
});

test("preparation sends the title to the managed service and no other calendar field", async () => {
  const plan = { ...newMeetingPlan("plan", 1, event), workspaceId: "workspace" };
  await expect(generatePreparation(plan)).rejects.toThrow();
  const sent = boundary.invoke.mock.calls.filter(
    ([command]) => command === "reasoning_run",
  );
  expect(sent).toHaveLength(1);
  const body = JSON.stringify(sent[0][1]);
  // Both in the prompt ("Purpose") and in job.basis.snapshot.context.purpose.
  expect(body.split(event.title).length - 1).toBeGreaterThanOrEqual(2);
  for (const canary of others) expect(body).not.toContain(canary);
  // The local index query also uses the title but stays on the Mac.
  const retrieval = boundary.invoke.mock.calls.find(
    ([command]) => command === "retrieve_context",
  );
  expect(JSON.stringify(retrieval?.[1])).toContain(event.title);
  // No public web search is started from calendar data.
  expect(
    boundary.invoke.mock.calls.some(([c]) => c === "search_public_text"),
  ).toBe(false);
});

test("what the app saved to a calendar stays out of the model basis", () => {
  const plan = {
    ...newMeetingPlan("plan", 1),
    title: "Canary meeting title 7731",
    calendarSync: {
      nativeEventId: "native-event-canary-id",
      calendarId: "calendar-canary-id",
      calendarName: "Calendar Canary Name",
      version: "version-canary",
      syncedTitle: "Canary meeting title 7731",
      syncedStartMs: 1893400000000,
      syncedEndMs: 1893456789012,
    },
  };
  const state = createMeetingState(meetingOptions(plan));
  const store = new SnapshotStore();
  store.initialise(state);
  const basis = JSON.stringify(store.read(state));
  for (const canary of ["native-event-canary-id", "calendar-canary-id", "Calendar Canary Name", "version-canary", "1893456789012"])
    expect(basis).not.toContain(canary);
});
