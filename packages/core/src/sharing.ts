import type {
  MeetingRecord,
  ShareSelection,
  WorkspaceBundle,
  SourceHit,
} from "./contracts";
const nestedKeys = {
  attendees: ["id", "name"],
  brief: ["revision", "text", "objectives", "evidence"],
  segments: [
    "meetingId",
    "segmentId",
    "revision",
    "journalSequence",
    "lane",
    "startMs",
    "endMs",
    "language",
    "text",
    "kind",
    "sourceSegmentId",
    "speakerClusterId",
    "confidence",
  ],
  importedSegments: [
    "id",
    "text",
    "language",
    "provenance",
    "sourceId",
    "speakerLabel",
  ],
  attributions: [
    "clusterId",
    "personId",
    "status",
    "evidence",
    "confirmedByUser",
  ],
  sources: [
    "sourceId",
    "workspaceId",
    "kind",
    "title",
    "text",
    "locator",
    "revision",
    "derived",
  ],
};
const pick = (input: object, allowed: readonly string[]) =>
  Object.fromEntries(
    Object.entries(input).filter(([k]) => allowed.includes(k)),
  );
const nestedSafe = (input: unknown, allowed: string[]) =>
  input === undefined ||
  (!!input &&
    typeof input === "object" &&
    Object.keys(input).every((k) => allowed.includes(k)));
const keys = [
  "id",
  "workspaceId",
  "purpose",
  "date",
  "objectives",
  "attendees",
  "brief",
  "profileId",
  "profileRevision",
  "scheduledEndMs",
  "revision",
  "segments",
  "importedSegments",
  "attributions",
  "translationStatus",
  "fixtureMode",
  "pendingSegments",
] as const;
export function exportSelected(
  selection: ShareSelection,
  records: MeetingRecord[],
  sources: SourceHit[],
): WorkspaceBundle {
  const whitelist = (r: MeetingRecord) =>
    Object.fromEntries(
      keys
        .filter((k) => r[k] !== undefined)
        .map((k) => {
          const value = structuredClone(r[k]);
          const mask = nestedKeys[k as keyof typeof nestedKeys];
          return [
            k,
            mask
              ? Array.isArray(value)
                ? value.map((v) => pick(v as object, mask))
                : pick(value as object, mask)
              : value,
          ];
        }),
    ) as unknown as MeetingRecord;
  return {
    version: 1,
    records: records
      .filter(
        (r) =>
          selection.workspaceIds.includes(r.workspaceId) &&
          selection.meetingIds.includes(r.id),
      )
      .map(whitelist),
    sources: sources
      .filter((s) => selection.workspaceIds.includes(s.workspaceId))
      .map((s) => pick(s, nestedKeys.sources) as unknown as SourceHit),
  };
}
export function validateBundle(input: unknown): input is WorkspaceBundle {
  if (!input || typeof input !== "object") return false;
  const v = input as WorkspaceBundle;
  if (
    v.version !== 1 ||
    !Array.isArray(v.records) ||
    !Array.isArray(v.sources) ||
    Object.keys(v).some((k) => !["version", "records", "sources"].includes(k))
  )
    return false;
  const forbidden = (x: unknown): boolean => {
    if (x && typeof x === "object")
      return Object.entries(x).some(
        ([k, val]) =>
          /api.?key|credential|audio|provider.?settings|token/i.test(k) ||
          forbidden(val),
      );
    return false;
  };
  return (
    !forbidden(v) &&
    v.sources.every((s) => nestedSafe(s, nestedKeys.sources)) &&
    v.records.every(
      (r) =>
        typeof r.id === "string" &&
        /^[\w-]{1,100}$/.test(r.id) &&
        Number.isInteger(r.revision) &&
        Array.isArray(r.segments) &&
        Array.isArray(r.attributions) &&
        Object.keys(r).every((k) =>
          keys.includes(k as (typeof keys)[number]),
        ) &&
        Object.entries(nestedKeys)
          .filter(([k]) => k !== "sources")
          .every(([k, allowed]) => {
            const value = (r as unknown as Record<string, unknown>)[k];
            return Array.isArray(value)
              ? value.every((x) => nestedSafe(x, allowed))
              : nestedSafe(value, allowed);
          }),
    )
  );
}
export function mergeSharedRecord(
  local: MeetingRecord | undefined,
  incoming: MeetingRecord,
) {
  if (!local)
    return { status: "new" as const, record: structuredClone(incoming) };
  if (JSON.stringify(local) === JSON.stringify(incoming))
    return { status: "duplicate" as const, record: local };
  return {
    status: "conflict" as const,
    local: structuredClone(local),
    incoming: structuredClone(incoming),
  };
}
