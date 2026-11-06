import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Activity, ChevronLeft, ChevronRight, Database, Keyboard, ListChecks, Mic, Network, RefreshCw, UserRound, CalendarDays, X, type LucideIcon } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation, SettingsSection } from "../presentation/types";
import { settingsTitle } from "../presentation/accessibility";
import { backdropCloses, escapeClosesSettings, settingsGroups, trappedFocusIndex, visibleSection } from "../presentation/settingsOverlay";
import { SettingsSections } from "../screens/SettingsPage";
import type { Setup } from "../useSetup";

const icons: Record<SettingsSection, LucideIcon> = { setup: ListChecks, speech: Mic, reasoning: Network, keyboard: Keyboard, calendars: CalendarDays, account: UserRound, updates: RefreshCw, sharing: Database, diagnostics: Activity };

const focusable = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
/** Controls Tab can reach right now: not in a hidden section, not in a closed <details>, and laid out. */
const reachable = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter((el) => el.getClientRects().length > 0 && !el.closest("[hidden],[inert]") && !(el.closest("details:not([open])") && el.tagName !== "SUMMARY"));

let cachedVersion: string | undefined;

/**
 * Settings as a window over the current page, like a Mac app's settings window: the page behind stays as it was,
 * dimmed and inert, and comes back when this closes (×, Escape or a click on the dimmed area). Nothing here pauses or
 * stops recording; sections that wait for the meeting to end say so.
 *
 * Below 620px the section list and the section are two steps: the list, then the section with a Back button.
 */
export function SettingsDialog({ controller: c, section: requested, navigate, setup, onClose }: { controller: CopilotController; section: SettingsSection; navigate: (location: AppLocation) => void; setup: Setup; onClose: () => void }) {
  const groups = settingsGroups({ setupActive: setup.active, publicProduct: c.publicProduct.enabled });
  const section = visibleSection(requested, groups);
  const title = groups.flatMap((g) => g.items).find((i) => i.id === section)!.label;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  // Narrow windows only: the list of sections, or one section. A deep link opens straight on its section.
  const [view, setView] = useState<"list" | "section">("section");
  const [version, setVersion] = useState(cachedVersion);
  useEffect(() => { if (!cachedVersion) void getVersion().then((v) => { cachedVersion = v; setVersion(v); }).catch(() => {}); }, []);

  const selectedItem = () => panel.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
  const visible = (el?: HTMLElement | null) => !!el && el.getClientRects().length > 0;
  // Focus moves in on open: to the selected section in the list, or to the title when the list is not shown.
  useLayoutEffect(() => {
    const item = selectedItem();
    (visible(item) ? item : heading.current)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [section]);

  const choose = (id: SettingsSection) => {
    navigate({ kind: "settings", section: id });
    // In the two-step layout the list disappears, so focus goes to the section title.
    if (view === "list" || !visible(selectedItem())) { setView("section"); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); }
  };
  const back = () => { setView("list"); requestAnimationFrame(() => selectedItem()?.focus({ preventScroll: true })); };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (escapeClosesSettings(event, !!panel.current?.querySelector('[aria-modal="true"]'))) {
      // Stopped here so a drawer or popover on the page behind does not also close.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = reachable(panel.current);
    const next = trappedFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  };
  const press = (event: PointerEvent<HTMLDivElement>) => { pressedBackdrop.current = event.target === event.currentTarget; };

  const close = <button type="button" className="icon-button settings-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}><X size={17} /></button>;
  return <div className="settings-overlay" onPointerDown={press} onClick={(event) => { if (backdropCloses(pressedBackdrop.current, event.target === event.currentTarget)) onClose(); pressedBackdrop.current = false; }}>
    {/* The title bar area stays a window drag region while the app behind is inert. */}
    <div className="settings-drag-strip" data-tauri-drag-region />
    <div ref={panel} className="settings-window" data-view={view} role="dialog" aria-modal="true" aria-label={settingsTitle(section)} onKeyDown={keys}>
      <nav className="settings-sidebar" aria-label="Settings sections">
        <div className="settings-sidebar-title"><span>Settings</span>{close}</div>
        {groups.map((group) => <div className="settings-group" key={group.label} role="group" aria-labelledby={titleId + group.label}>
          <div className="settings-group-label" id={titleId + group.label}>{group.label}</div>
          {group.items.map(({ id, label }) => { const Icon = icons[id]; return <button key={id} type="button" data-section={id} className={"settings-nav-item" + (section === id ? " selected" : "")} aria-current={section === id ? "page" : undefined} onClick={() => choose(id)}><Icon size={17} aria-hidden /><span>{label}</span><ChevronRight className="settings-nav-chevron" size={15} aria-hidden /></button>; })}
        </div>)}
        <div className="settings-version">{version ? `Live Interview ${version}` : "Live Interview"}</div>
      </nav>
      <div className="settings-main">
        <header className="settings-header">
          <button type="button" className="link-button settings-back" onClick={back}><ChevronLeft size={16} aria-hidden />Settings</button>
          <h1 id={titleId} ref={heading} tabIndex={-1}>{title}</h1>
          {close}
        </header>
        <div ref={scroller} className="settings-scroll" data-section={section}>
          <SettingsSections controller={c} section={section} navigate={navigate} setup={setup} />
        </div>
      </div>
    </div>
  </div>;
}
