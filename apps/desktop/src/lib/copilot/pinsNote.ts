import type { GuidanceCard } from "@live-interview/core";

/** The `save_internal_note` arguments that persist a meeting's saved pins, including each pin's outcome. */
export function pinsNote(meetingId: string, pins: GuidanceCard[]) {
  return { meetingId, kind: "pins" as const, text: JSON.stringify(pins) };
}
