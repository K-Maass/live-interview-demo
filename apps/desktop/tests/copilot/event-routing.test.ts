import { expect, test } from "vitest";
import {
  routeSpeech,
  finalizationTargets,
} from "../../src/lib/copilot/eventRouting";
test("active meeting ingestion continues when another record is viewed", () => {
  const received: string[] = [],
    shown: string[] = [];
  routeSpeech(
    { meetingId: "A" } as any,
    { ingest: (e) => received.push(e.meetingId) },
    "B",
    (e) => shown.push(e.meetingId),
  );
  expect(received).toEqual(["A"]);
  expect(shown).toEqual([]);
});
test("late finalization A refreshes A without replacing newer runtime B or its view", () => {
  expect(finalizationTargets("A", "B", "B")).toEqual({
    refreshRecordId: "A",
    replaceRuntime: false,
    refreshVisibleTranscript: false,
  });
});
