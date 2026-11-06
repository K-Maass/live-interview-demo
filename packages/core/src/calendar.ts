import type { ActionProposal } from "./contracts";
const escape = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
export function makeCalendarProposal(input: {
  id: string;
  title: string;
  start: string;
  end: string;
  inferred: boolean;
}): ActionProposal {
  const start = new Date(input.start),
    end = new Date(input.end);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    ![input.start, input.end].every((value) =>
      /(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    )
  )
    throw new Error("invalidOrAmbiguousDate");
  const date = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Live Interview//Reviewed Draft//EN\r\nBEGIN:VEVENT\r\nUID:${escape(input.id)}@liveinterview.local\r\nDTSTAMP:${date(new Date())}\r\nDTSTART:${date(start)}\r\nDTEND:${date(end)}\r\nSUMMARY:${escape(input.title)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  return {
    id: crypto.randomUUID(),
    targetId: input.id,
    targetPath: "calendar-draft",
    targetVersion: "newDraft",
    operation: "calendarAdd",
    before: "",
    after: ics,
    evidence: [],
    inferred: input.inferred,
    status: "proposed",
  };
}
