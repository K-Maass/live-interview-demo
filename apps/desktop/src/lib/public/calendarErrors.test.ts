import { expect, test } from "vitest";
import {
  calendarCodeHint,
  calendarErrorMessage,
  GENERIC_CALENDAR_ERROR,
} from "./calendarErrors";
test("a partial Google grant explains what to do instead of failing silently", () => {
  expect(calendarErrorMessage("calendarScopeIncomplete")).toMatch(
    /both .*permissions/i,
  );
  expect(calendarErrorMessage("calendarReauthenticationRequired")).toMatch(
    /sign in again/i,
  );
});
test("unknown or non-string errors keep the generic message", () => {
  expect(calendarErrorMessage("calendarProviderUnavailable")).toBe(
    GENERIC_CALENDAR_ERROR,
  );
  expect(calendarErrorMessage(new Error("x"))).toBe(GENERIC_CALENDAR_ERROR);
  expect(calendarCodeHint("calendarRateLimited")).toBeUndefined();
  expect(calendarCodeHint(undefined)).toBeUndefined();
});
test("being offline is explained as a connection problem, not as signing in again", () => {
  const offline = calendarCodeHint("calendarNetworkUnavailable");
  expect(offline).toMatch(/internet connection/i);
  expect(offline).not.toMatch(/sign in/i);
});
