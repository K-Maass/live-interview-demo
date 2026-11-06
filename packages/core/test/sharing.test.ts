import { expect, test } from "vitest";
import {
  exportSelected,
  mergeSharedRecord,
  validateBundle,
} from "../src/sharing";
import type { MeetingRecord } from "../src/contracts";
const record: MeetingRecord = {
  id: "m",
  workspaceId: "w",
  purpose: "Synthetic",
  date: "2026-10-02",
  objectives: [],
  attendees: [],
  profileId: "workClient",
  profileRevision: 0,
  revision: 1,
  segments: [],
  importedSegments: [],
  attributions: [],
  translationStatus: "complete",
  audioReference: "/private.wav",
};
test("selected whitelist export excludes audio/settings/keys; conflicts preserve both versions", () => {
  const bundle = exportSelected(
    { workspaceIds: ["w"], meetingIds: ["m"] },
    [record, { ...record, id: "other", workspaceId: "hidden" }],
    [],
  );
  expect(bundle.records).toHaveLength(1);
  expect(JSON.stringify(bundle)).not.toContain("private.wav");
  expect(validateBundle({ ...bundle, apiKey: "sentinel" })).toBe(false);
  expect(
    mergeSharedRecord(record, { ...record, revision: 2, purpose: "changed" })
      .status,
  ).toBe("conflict");
});
