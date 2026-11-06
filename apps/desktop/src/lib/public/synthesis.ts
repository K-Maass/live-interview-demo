import type { MeetingRecord } from "@live-interview/core";
import { ArtifactCache } from "./artifacts";
import { publicClient } from "./client";
import { generateSynthesis } from "./reasoning";
export const publicArtifacts = new ArtifactCache(publicClient);
export function ensureSynthesis(
  record: MeetingRecord,
  automatic = false,
  force = false,
) {
  if (
    (record.pendingSegments ?? 0) > 0 ||
    record.translationStatus === "pending" ||
    !record.segments.length
  )
    return Promise.reject(Error("localProcessingPending"));
  return publicArtifacts.generateCached(
    {
      meetingId: record.id,
      kind: "synthesis",
      recordRevision: record.revision,
    },
    () => generateSynthesis(record, automatic),
    force,
  );
}
