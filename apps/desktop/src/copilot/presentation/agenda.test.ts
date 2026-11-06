import { describe, expect, test } from "vitest";
import { agendaDayLabel, filterAgenda } from "./agenda";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

describe("agenda wording", () => {
  const now = at(16, 9);
  test("groups by today, tomorrow and then the date", () => {
    expect(agendaDayLabel(at(16, 23), now)).toBe("Today");
    expect(agendaDayLabel(at(17, 0, 30), now)).toBe("Tomorrow");
    expect(agendaDayLabel(at(19, 10), now)).not.toMatch(/Today|Tomorrow/);
  });
});

describe("agenda search", () => {
  const events = [{ title: "Customer discovery" }, { title: "Project kickoff" }];
  test("matches part of a title regardless of case, and keeps everything for an empty query", () => {
    expect(filterAgenda(events, "  KICK ")).toEqual([{ title: "Project kickoff" }]);
    expect(filterAgenda(events, "")).toEqual(events);
    expect(filterAgenda(events, "budget")).toEqual([]);
  });
});
