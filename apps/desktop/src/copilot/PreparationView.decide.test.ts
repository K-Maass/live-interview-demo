import { describe, expect, it } from "vitest";
import { createMeetingState, SnapshotStore } from "@live-interview/core";
// The service's own validator: the preparation decision must pass it as sent.
// @ts-expect-error plain ESM module without type declarations
import { decideRequest } from "../../../service/src/validation.mjs";
import { preparationResearchDecision } from "./PreparationView";

function preparationBasis() {
  const state = createMeetingState({
    id: "prep-1",
    workspaceId: "workspace-1",
    purpose: "Vendor review",
    objectives: ["Check SOC 2 scope"],
    attendees: [],
    selfName: "Fixture Person",
    profileId: "workClient",
    profileRevision: 1,
  });
  const snapshots = new SnapshotStore();
  snapshots.initialise(state);
  return JSON.parse(JSON.stringify(snapshots.read(state)));
}

describe("preparation public-research decision", () => {
  it("sends a real basis that the service accepts", () => {
    const args = preparationResearchDecision(
      preparationBasis(),
      ["SOC 2 official documentation", "SOC 2 governance requirements"],
      "Focus on the audit window",
    );
    expect(() => decideRequest(JSON.parse(JSON.stringify(args)))).not.toThrow();
    expect(args).not.toHaveProperty("effectiveContext");
    expect(args.questions.query.instructions).toContain(
      "Focus on the audit window",
    );
  });
  it("bounds the request text and the number of candidate queries", () => {
    const args = preparationResearchDecision(
      preparationBasis(),
      Array.from({ length: 40 }, (_, n) => `topic ${n} official documentation`),
      "x".repeat(5000),
    );
    expect(Object.keys(args.questions.query.criteria)).toHaveLength(32);
    expect(() => decideRequest(JSON.parse(JSON.stringify(args)))).not.toThrow();
  });
});
