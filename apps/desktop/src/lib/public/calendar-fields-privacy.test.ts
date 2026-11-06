import { beforeEach, expect, test, vi } from "vitest";
import type { PublicCalendarEvent } from "@live-interview/core";
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

// Companion to calendar-data-flow.test.ts for the fields added with all-day and recurring
// support: the title is still the only calendar value that may reach a model or the service.
// Every value is a unique canary so a leak cannot hide in a common word.
const event: PublicCalendarEvent = {
  id: "fields-event-id",
  title: "Fields canary meeting 5521",
  startMs: 1893369600000,
  endMs: 1893456000000,
  accountId: "fields-account-id",
  calendarId: "fields-calendar-id",
  provider: "microsoft",
  sourceEventId: "fields-source-id",
  isAllDay: true,
  startDay: "2030-01-01",
  endDay: "2030-01-02",
  recurring: true,
  seriesId: "microsoft:series-canary-hash-9f3a",
  joinUrl: "https://meet.example.test/fields-join-canary",
  organiser: "fields-organiser@example.test",
  attendees: [
    { name: "Fields Attendee Canary", email: "fields-attendee@example.test" },
  ],
  version: "fields-version-canary",
  readOnly: true,
};
const others = [
  "fields-event-id",
  "fields-account-id",
  "fields-calendar-id",
  "fields-source-id",
  "series-canary-hash-9f3a",
  "2030-01-01",
  "2030-01-02",
  "fields-join-canary",
  "fields-organiser",
  "Fields Attendee Canary",
  "fields-attendee@example.test",
  "fields-version-canary",
  "1893369600000",
  "1893456000000",
];
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
    if (command === "public_workspace_sources") return [];
    if (command === "refresh_workspace") return { changedSourceIds: [] };
    if (command === "retrieve_context") return [];
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

test("series, day, join-link and attendee fields never reach the plan's model-visible state", () => {
  const plan = newMeetingPlan("plan", 1, event);
  expect(plan.title).toBe(event.title);
  expect(plan.attendees).toEqual([]);
  const options = meetingOptions(plan);
  expect(options.attendees).toEqual([]);
  const state = createMeetingState(options);
  const store = new SnapshotStore();
  store.initialise(state);
  const basis = JSON.stringify(store.read(state));
  expect(basis).toContain(event.title);
  for (const canary of others) expect(basis).not.toContain(canary);
});

test("preparation sends the title to the managed service and none of the new calendar fields", async () => {
  const plan = { ...newMeetingPlan("plan", 1, event), workspaceId: "workspace" };
  await expect(generatePreparation(plan)).rejects.toThrow();
  const sent = boundary.invoke.mock.calls.filter(
    ([command]) => command === "reasoning_run",
  );
  expect(sent).toHaveLength(1);
  const body = JSON.stringify(sent[0][1]);
  expect(body).toContain(event.title);
  for (const canary of others) expect(body).not.toContain(canary);
  // Nothing else leaves the Mac either: no public web search is started from calendar data.
  expect(
    boundary.invoke.mock.calls.some(([c]) => c === "search_public_text"),
  ).toBe(false);
  for (const [command, args] of boundary.invoke.mock.calls) {
    if (command === "reasoning_run") continue;
    for (const canary of ["series-canary-hash-9f3a", "fields-join-canary"])
      expect(JSON.stringify(args ?? null)).not.toContain(canary);
  }
});
