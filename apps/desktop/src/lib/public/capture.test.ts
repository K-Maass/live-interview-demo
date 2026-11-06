import { expect, test } from "vitest";
import { newMeetingPlan } from "./state";
import { publicCaptureOptions, acceptedCallPlan, accountSelfName } from "./capture";
test("accepting unrelated detected call B never inherits plan A's title, brief, attendees or private workspace", () => {
  const a = {
    ...newMeetingPlan("A"),
    title: "Client A",
    workspaceId: "client-a",
    sourceIds: ["secret-a"],
    sharedLibraryIds: ["private-library"],
    objectives: ["Confidential A objective"],
    attendees: [{ id: "person-a", name: "Person A" }],
    briefDraft: "Secret A",
    reviewedBrief: {
      text: "Secret A",
      objectives: [],
      evidence: ["secret-a"],
      revision: 1,
    },
    retainAudio: true,
    inputDevice: "Private mic",
  };
  const b = acceptedCallPlan("Call B", "B", 100);
  const options = publicCaptureOptions(b, "capture-b");
  expect(options.purpose).toBe("Call B");
  expect(options.workspaceId).toBe("default");
  expect(options.brief).toBeUndefined();
  expect(options.attendees).toEqual([]);
  expect(options.objectives).toEqual([]);
  expect(options.sourceIds).toEqual([]);
  expect(options.sharedLibraryIds).toEqual([]);
  expect(options.retainAudio).toBe(false);
  expect(b.inputDevice).toBe("");
  const manual = publicCaptureOptions(a, "capture-a");
  expect(manual.purpose).toBe("Client A");
  expect(manual.workspaceId).toBe("client-a");
  expect(manual.brief?.text).toBe("Secret A");
  expect(manual.retainAudio).toBe(true);
});

test("the me lane takes the signed-in account's display name and is neutral otherwise", () => {
  expect(accountSelfName({ signedIn: true, user: { name: " Priya Nair " } })).toBe("Priya Nair");
  expect(accountSelfName({ signedIn: true, user: {} })).toBeUndefined();
  expect(accountSelfName({ signedIn: false, user: { name: "Priya Nair" } })).toBeUndefined();
  expect(accountSelfName(undefined)).toBeUndefined();
});
