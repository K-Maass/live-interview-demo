import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes, type RefObject } from "react";
import { CircleCheck, UserRound, X, type LucideIcon } from "lucide-react";
export function Section({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={"ui-section " + className}><div className="section-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
export function StubPanel({ title, description = "Not available yet.", children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="stub-panel" data-stub><div className="stub-title">{title}<span>Planned</span></div><p>{description}</p>{children}</div>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2>{children && <p>{children}</p>}{action}</div>;
}
export function IconButton({ icon: Icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" className={"icon-button " + (props.className ?? "")} title={label} aria-label={label} {...props}><Icon size={18} aria-hidden /></button>;
}
export function Avatar({ name }: { name: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const graphemes = (value: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((s) => s.segment);
  const initials = words.length > 1 ? (graphemes(words[0])[0] ?? "") + (graphemes(words.at(-1)!)[0] ?? "") : graphemes(words[0] ?? "").slice(0, 2).join("");
  return <span className="avatar" aria-hidden>{initials ? initials.toLocaleUpperCase() : <UserRound size={16} />}</span>;
}
export function PageHeading({ eyebrow, title, subtitle, actions, leading }: { eyebrow?: ReactNode; title: string; subtitle?: ReactNode; actions?: ReactNode; leading?: ReactNode }) {
  return <header className="page-heading">{leading}<div className="heading-copy">{eyebrow && <div className="breadcrumb">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <div className="page-subtitle">{subtitle}</div>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}
export const dayText = (date: string | number | Date) => {
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "Date unavailable";
};
export const timeText = (ms: number) => Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "Time unavailable";
/**
 * A <details> used as a popover: Escape closes it and returns focus to its summary, and tabbing out of it closes it
 * so it does not stay open over the page. Escape is stopped here so it does not also close a drawer behind it.
 */
export function useDismissableDetails(ref: RefObject<HTMLDetailsElement | null>, enabled = true) {
  useEffect(() => {
    const details = ref.current;
    if (!details || !enabled) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details.open) return;
      event.stopPropagation();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    const leave = (event: FocusEvent) => {
      if (details.open && event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) details.open = false;
    };
    details.addEventListener("keydown", key);
    details.addEventListener("focusout", leave);
    return () => { details.removeEventListener("keydown", key); details.removeEventListener("focusout", leave); };
  }, [enabled]);
}
/**
 * A passing status message ("Meeting plan saved locally"). It hides itself after a few seconds and comes back with
 * every new report (keyed by its id, so the same words reported again show again). Failures that need an action stay
 * on the page as inline notices instead. It has no live role: the caller speaks through the app's Announcer, so a
 * message is never read out twice.
 */
export interface ToastNotice { id: number; text: string }
export function Toast({ notice, timeoutMs = 6000 }: { notice?: ToastNotice; timeoutMs?: number }) {
  const [shown, setShown] = useState<ToastNotice>();
  useEffect(() => {
    if (!notice?.text) { setShown(undefined); return; }
    setShown(notice);
    const timer = window.setTimeout(() => setShown(undefined), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [notice?.id, notice?.text, timeoutMs]);
  return <div className="toast" hidden={!shown}>{shown && <><span>{shown.text}</span><IconButton icon={X} label="Dismiss message" onClick={() => setShown(undefined)} /></>}</div>;
}
/**
 * A passing confirmation with one action ("Meeting created" · Open plan). Like `Toast` it fades after a few seconds,
 * but the timer waits while the pointer is over it or focus is inside it, so the action can still be reached. It has no
 * live role of its own: the caller announces the same text through the app's Announcer, which speaks reliably.
 */
export interface ActionNotice { id: string; text: string; detail?: string; actionLabel: string }
export function ActionToast({ notice, onAction, onClose, timeoutMs = 7000 }: { notice?: ActionNotice; onAction: () => void; onClose: () => void; timeoutMs?: number }) {
  const [held, setHeld] = useState({ hover: false, focus: false });
  const paused = held.hover || held.focus;
  useEffect(() => { setHeld({ hover: false, focus: false }); }, [notice?.id]);
  useEffect(() => {
    if (!notice || paused) return;
    const timer = window.setTimeout(onClose, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [notice?.id, paused, timeoutMs]);
  if (!notice) return null;
  return <div className="toast action-toast" role="group" aria-label={notice.text} onPointerEnter={() => setHeld((h) => ({ ...h, hover: true }))} onPointerLeave={() => setHeld((h) => ({ ...h, hover: false }))}
    onFocus={() => setHeld((h) => ({ ...h, focus: true }))} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld((h) => ({ ...h, focus: false })); }}>
    <CircleCheck size={18} className="action-toast-icon" aria-hidden />
    <span className="action-toast-text"><strong>{notice.text}</strong>{notice.detail && <small>{notice.detail}</small>}</span>
    <button type="button" className="link-button action-toast-action" onClick={() => { onAction(); onClose(); }}>{notice.actionLabel}</button>
    <IconButton icon={X} label="Dismiss notification" onClick={onClose} />
  </div>;
}
