// Keyboard model for the Week and Month grids (#123). One tab stop per grid (roving tabindex).
//
// Markup contract: every focusable calendar element in the grid carries
//   data-nav="<unique id>"   data-col="<column or cell index>"   data-order="<sort position inside its column>"
//   data-kind="head"         only on day headers (Week) and date buttons (Month)
// and renders tabIndex={activeId === id ? 0 : -1}. The views take `activeId` and compute their own default.
//
// Keys (plain keys only: anything with Ctrl, Meta, Alt or Shift is left to the app and the browser, as is typing in a field)
//   Week   Left/Right  same row in the next/previous day; Up/Down  next/previous element in the day; Home/End  first/last day
//   Month  Left/Right  date -1/+1;  Up/Down  date -7/+7;  Home/End  start/end of the week
//   PageUp/PageDown previous/next period;  T  today;  Escape  closes the day drawer
// Enter and Space press the focused button natively. The container gets aria-keyshortcuts.
import { useEffect, useRef, useState, type KeyboardEvent, type FocusEvent, type RefObject } from "react";

export interface NavTarget { id: string; col: number; order: number; head: boolean }
export type NavLayout = "week" | "month";

/** Pure: the id to move to, or undefined when the key does nothing here. */
export function nextNavTarget(targets: NavTarget[], currentId: string, key: string, layout: NavLayout): string | undefined {
  const cur = targets.find((t) => t.id === currentId);
  if (!cur) return undefined;
  const inCol = (col: number) => targets.filter((t) => t.col === col).sort((a, b) => a.order - b.order);
  const headOf = (col: number) => targets.find((t) => t.col === col && t.head)?.id;
  const heads = targets.filter((t) => t.head).sort((a, b) => a.col - b.col);
  if (layout === "week") {
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const list = inCol(cur.col + (key === "ArrowRight" ? 1 : -1));
      if (!list.length) return undefined;
      if (cur.head) return list.find((t) => t.head)?.id ?? list[0].id;
      const items = list.filter((t) => !t.head);
      if (!items.length) return list.find((t) => t.head)?.id ?? list[0].id;
      return items.reduce((best, t) => (Math.abs(t.order - cur.order) < Math.abs(best.order - cur.order) ? t : best)).id;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      const list = inCol(cur.col);
      return list[list.findIndex((t) => t.id === cur.id) + (key === "ArrowDown" ? 1 : -1)]?.id;
    }
    if (key === "Home") return heads[0]?.id;
    if (key === "End") return heads.at(-1)?.id;
    return undefined;
  }
  // Month
  if (cur.head) {
    const weekStart = cur.col - (cur.col % 7);
    if (key === "ArrowLeft") return headOf(cur.col - 1);
    if (key === "ArrowRight") return headOf(cur.col + 1);
    if (key === "ArrowUp") return headOf(cur.col - 7);
    if (key === "ArrowDown") return headOf(cur.col + 7);
    if (key === "Home") return headOf(weekStart);
    if (key === "End") return headOf(weekStart + 6);
    return undefined;
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const list = inCol(cur.col);
    return list[list.findIndex((t) => t.id === cur.id) + (key === "ArrowDown" ? 1 : -1)]?.id;
  }
  if (key === "ArrowLeft") return headOf(cur.col - 1);
  if (key === "ArrowRight") return headOf(cur.col + 1);
  return undefined;
}

const isTyping = (el: Element | null) => !!el?.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']");
const targetsIn = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-nav]")];

export const CALENDAR_SHORTCUTS = "ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown T Escape";

export interface CalendarKeyboardOptions {
  containerRef: RefObject<HTMLElement | null>;
  layout: NavLayout;
  /** Changes whenever the visible period changes: resets the roving position and returns focus when a key caused it. */
  periodKey: string;
  drawerOpen: boolean;
  onShift(direction: -1 | 1): void;
  onToday(): void;
  onEscape(): void;
}

export function useCalendarKeyboard(options: CalendarKeyboardOptions) {
  const { containerRef, periodKey, drawerOpen } = options;
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<{ periodKey: string; id?: string }>({ periodKey });
  const refocus = useRef(false);
  const activeId = state.periodKey === periodKey ? state.id : undefined;
  // After a keyboard-driven period change the element that had focus is gone: focus the new tab stop.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    containerRef.current?.querySelector<HTMLElement>('[data-nav][tabindex="0"]')?.focus();
  }, [periodKey, containerRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (isTyping(target)) return;
    const o = latest.current;
    if (event.key === "Escape") { if (drawerOpen) { event.preventDefault(); o.onEscape(); } return; }
    const container = containerRef.current;
    const from = target.closest<HTMLElement>("[data-nav]");
    if (!container || !from || !container.contains(from)) return;
    const key = event.key;
    if (key === "PageUp" || key === "PageDown") { event.preventDefault(); refocus.current = true; o.onShift(key === "PageDown" ? 1 : -1); return; }
    if (key === "t" || key === "T") { event.preventDefault(); refocus.current = true; o.onToday(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
    const els = targetsIn(container);
    const targets: NavTarget[] = els.map((el) => ({ id: el.dataset.nav!, col: Number(el.dataset.col), order: Number(el.dataset.order), head: el.dataset.kind === "head" }));
    const next = nextNavTarget(targets, from.dataset.nav!, key, o.layout);
    event.preventDefault();
    if (!next) return;
    setState({ periodKey, id: next });
    els.find((el) => el.dataset.nav === next)?.focus();
  };
  // Clicking or tabbing to an element makes it the tab stop, so Shift+Tab out and back returns to the same place.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-nav]")?.dataset.nav;
    if (id && id !== activeId) setState({ periodKey, id });
  };
  return { activeId, requestFocus: () => { refocus.current = true; }, props: { onKeyDown, onFocus, "aria-keyshortcuts": CALENDAR_SHORTCUTS } };
}
