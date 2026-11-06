import { expect, test } from "vitest";
import { attentionNotices, clearAttention, destinationOutcome, markAttention } from "./recordAttention";

test("a failed synthesis and failed note destinations stay as notices with Retry until cleared", () => {
  let map = markAttention({}, "m1", { synthesis: "failed" });
  map = markAttention(map, "m1", { destinations: 2 });
  expect(attentionNotices(map.m1).map((n) => [n.kind, n.actionLabel])).toEqual([["synthesis", "Retry synthesis"], ["destinations", "Retry notes"]]);
  expect(attentionNotices(map.m1)[1].text).toBe("The meeting is saved. 2 note destinations could not be updated.");
  map = clearAttention(map, "m1", "synthesis");
  expect(attentionNotices(map.m1).map((n) => n.kind)).toEqual(["destinations"]);
  map = clearAttention(map, "m1", "destinations");
  expect(map).toEqual({});
  expect(attentionNotices(map.m1)).toEqual([]);
});

test("notices are per record, and an unknown destination count still reads plainly", () => {
  const map = markAttention(markAttention({}, "m1", { destinations: 0 }), "m2", { destinations: 1 });
  expect(attentionNotices(map.m1)[0].text).toBe("The meeting is saved. Your note destinations could not be updated.");
  expect(attentionNotices(map.m2)[0].text).toBe("The meeting is saved. One note destination could not be updated.");
  expect(clearAttention(map, "m3", "synthesis")).toBe(map);
});

test("a synthesis that needs service access is a persistent notice of its own", () => {
  const [notice] = attentionNotices(markAttention({}, "m1", { synthesis: "needsAccess" }).m1);
  expect(notice).toMatchObject({ kind: "synthesis", action: "retry", actionLabel: "Make synthesis" });
  expect(notice.text).toBe("The meeting is saved. Its synthesis needs service access; make it here when it is available.");
});

test("permanent destination failures name the reason and point to Knowledge instead of Retry", () => {
  const map = destinationOutcome({}, "m1", { failed: [{ code: "appendTargetChanged" }, { code: "appendGrantMissing" }, { code: "publicStoreFailed" }] });
  expect(map.m1).toEqual({ destinations: 1, blocked: ["changed", "revoked"] });
  const notices = attentionNotices(map.m1);
  expect(notices.map((n) => [n.kind, n.action, n.actionLabel])).toEqual([["destinations", "retry", "Retry notes"], ["blocked", "openKnowledge", "Open Knowledge settings"]]);
  expect(notices[1].text).toBe("The meeting is saved. One note file was moved or replaced, so the app no longer writes to it. Access to one note destination was removed. Choose the destination again in Knowledge settings.");
  expect(notices[1].text).not.toMatch(/append|Grant(Missing)?[A-Z]/);
});

test("a write where everything succeeds clears both destination notices; a whole-call failure is classified too", () => {
  let map = destinationOutcome({}, "m1", { failed: [{ code: "appendTargetChanged" }, { code: "busy" }] });
  map = destinationOutcome(map, "m1", { failed: [] });
  expect(map).toEqual({});
  expect(destinationOutcome({}, "m1", { callError: "outputGrantChanged" }).m1).toEqual({ blocked: ["folderChanged"] });
  expect(destinationOutcome({}, "m1", { callError: "Error: network" }).m1).toEqual({ destinations: 0 });
  // Codes that only look like object keys are not mistaken for permanent reasons.
  expect(destinationOutcome({}, "m1", { failed: [{ code: "toString" }] }).m1).toEqual({ destinations: 1 });
});
