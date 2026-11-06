import { expect, test } from "vitest";
import { processingClass, processingLabel, processingState } from "./processing";

test("an unavailable translation reads 'Translation unavailable', never 'Complete'", () => {
  expect(processingState({ translationStatus: "unavailable" })).toBe("translationUnavailable");
  expect(processingLabel[processingState({ translationStatus: "unavailable" })]).toBe("Translation unavailable");
  expect(processingClass.translationUnavailable).toBe("pending-status");
  expect(processingState({ translationStatus: "complete" })).toBe("complete");
  expect(processingState({ translationStatus: "pending" })).toBe("pending");
  expect(processingState({ translationStatus: "complete", pendingSegments: 2 })).toBe("pending");
});
// The record page's wording for each state is tested by rendering it in screens/ReviewMeetingPage.markup.test.ts.
