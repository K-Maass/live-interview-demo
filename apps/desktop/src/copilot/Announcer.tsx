import { useEffect, useRef, useState } from "react";
import { AnnouncementGate, type Announcement } from "../lib/copilot/announcements";

/**
 * Two permanent, visually hidden live regions. A region that exists before its text changes is announced reliably;
 * one that is inserted together with its text often is not, which is why status changes go through here instead of
 * `role="status"` on elements that appear and disappear. The text is cleared first so identical words are spoken again
 * when the gate lets them through: always for a new report (a new event id), otherwise after the gate's window.
 */
export function useAnnouncer() {
  const [message, setMessage] = useState<Record<Announcement["politeness"], string>>({ polite: "", assertive: "" });
  const gate = useRef(new AnnouncementGate());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const announce = (announcement: Announcement | undefined) => {
    if (!announcement || !gate.current.accept(announcement, Date.now())) return;
    setMessage((old) => ({ ...old, [announcement.politeness]: "" }));
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== timer);
      setMessage((old) => ({ ...old, [announcement.politeness]: announcement.text }));
    }, 60);
    timers.current.push(timer);
  };
  const regions = <>
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-announcer="polite">{message.polite}</div>
    <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true" data-announcer="assertive">{message.assertive}</div>
  </>;
  return { announce, regions };
}
