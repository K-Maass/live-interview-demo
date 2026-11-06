import { expect, test } from "vitest";
import { makeCalendarProposal } from "../src/calendar";
test("calendar draft preserves explicit offset/DST, escapes control text and claims only draft capability", () => {
  const p = makeCalendarProposal({
    id: "e",
    title: "Synthetic\nBEGIN:VEVENT",
    start: "2026-10-25T09:00:00+01:00",
    end: "2026-10-25T09:30:00+01:00",
    inferred: true,
  });
  expect(p.status).toBe("proposed");
  expect(p.after).toContain("DTSTART:20261025T080000Z");
  expect(p.after.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1);
  expect(p.inferred).toBe(true);
  expect(() =>
    makeCalendarProposal({
      id: "bad",
      title: "x",
      start: "bad",
      end: "bad",
      inferred: false,
    }),
  ).toThrow();
});
test("both calendar endpoints require an explicit offset or UTC", () => {
  expect(() =>
    makeCalendarProposal({
      id: "x",
      title: "Meeting",
      start: "2026-10-03T12:00:00",
      end: "2026-10-03T13:00:00Z",
      inferred: true,
    }),
  ).toThrow();
  expect(() =>
    makeCalendarProposal({
      id: "x",
      title: "Meeting",
      start: "2026-10-03T12:00:00Z",
      end: "2026-10-03T13:00:00",
      inferred: true,
    }),
  ).toThrow();
});
