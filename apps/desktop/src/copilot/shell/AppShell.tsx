import { useState, useRef, useLayoutEffect, useEffect, type ReactNode } from "react";
import { CalendarDays, FolderOpen, UsersRound, Settings, Menu, ArrowUpRight, X, Archive, PanelLeft, type LucideIcon } from "lucide-react";
import type { AppLocation, PageLocation, SettingsSection } from "../presentation/types";
import type { CopilotController } from "../useCopilotController";
import { pageTitle, screenKey } from "../presentation/accessibility";
import mark from "../assets/app-mark.png";
// A remembered per-Mac preference only; losing it just shows the full sidebar again.
const storedCollapsed = () => { try { return window.localStorage.getItem("sidebar-collapsed") === "1"; } catch { return false; } };
const storeCollapsed = (value: boolean) => { try { window.localStorage.setItem("sidebar-collapsed", value ? "1" : "0"); } catch { /* storage unavailable */ } };
export function AppShell({ location, settings, navigate, controller: c, children }: { location: PageLocation; settings?: SettingsSection; navigate: (location: AppLocation) => void; controller: CopilotController; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const toggleSidebar = () => setCollapsed((value) => { storeCollapsed(!value); return !value; });
  const main = useRef<HTMLElement>(null);
  const page = JSON.stringify(location);
  useLayoutEffect(() => { main.current?.scrollTo({ top: 0 }); }, [page]);
  const screen = screenKey(location, location.kind === "meeting" && c.activeMeeting?.id === location.id);
  const shown = useRef(screen);
  const meetingTitle = location.kind === "meeting" ? (c.activeMeeting?.id === location.id ? c.activeMeeting.purpose : c.selectedRecord?.id === location.id ? c.selectedRecord.purpose : c.setup.purpose) : undefined;
  useEffect(() => { document.title = pageTitle(settings ? { kind: "settings", section: settings } : location, meetingTitle); }, [page, meetingTitle, settings]);
  // A screen change moves focus to the new heading so a screen reader says where it is. Switching a tab or a settings
  // section keeps focus on the control that was used.
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    const heading = Array.from(main.current?.querySelectorAll<HTMLElement>("h1") ?? []).find((h) => !h.closest("[hidden]"));
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [screen]);
  // Calendar (today onward, as a list, week or month) and Archive (saved meetings) live in the sidebar, so the Meetings page needs no tabs.
  const reviewing = location.kind === "meeting" && c.selectedRecord?.id === location.id && c.activeMeeting?.id !== location.id;
  const active = settings ? "settings" : location.kind === "meetings" ? (location.view === "past" ? "past" : "upcoming") : location.kind === "meeting" ? (reviewing ? "past" : "upcoming") : location.kind;
  const groups: { label?: string; entries: { id: string; label: string; icon: LucideIcon; count?: number; destination: AppLocation }[] }[] = [
    { label: "Meetings", entries: [
      { id: "upcoming", label: "Calendar", icon: CalendarDays, destination: { kind: "meetings", view: "upcoming" } },
      { id: "past", label: "Archive", icon: Archive, count: c.records.length, destination: { kind: "meetings", view: "past" } },
    ] },
    { label: "Library", entries: [
      { id: "people", label: "People", icon: UsersRound, destination: { kind: "people" } },
      { id: "knowledge", label: "Knowledge", icon: FolderOpen, destination: { kind: "knowledge" } },
    ] },
  ];
  const go = (destination: AppLocation) => { navigate(destination); setMenuOpen(false); };
  const item = ({ id, label, icon: Icon, count, destination }: (typeof groups)[number]["entries"][number]) => <button key={id} className={"nav-item " + (active === id ? "selected" : "")} aria-current={active === id ? "page" : undefined} title={compact ? label : undefined} onClick={() => go(destination)}><Icon size={17} aria-hidden /><span>{label}</span>{!!count && <span className="nav-count" aria-label={`${count} ${label.toLowerCase()}`}>{count}</span>}</button>;
  const speechReady = !!c.ready?.recognitionReady;
  const live = location.kind === "meeting" && c.activeMeeting?.id === location.id;
  // The sidebar folds to icons during a live meeting, or whenever the person chose to hide it.
  const compact = live || collapsed;
  return <div className={"app-shell" + (compact ? " sidebar-compact" : "")}>
    <div className="app-titlebar" data-tauri-drag-region><span className="traffic-light-space" data-tauri-drag-region /><button className="icon-button titlebar-toggle" aria-label={collapsed ? "Show sidebar" : "Hide sidebar"} aria-pressed={collapsed} title={collapsed ? "Show sidebar" : "Hide sidebar"} disabled={live} onClick={toggleSidebar}><PanelLeft size={17} /></button></div>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className="mobile-navigation"><button className="icon-button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button><strong>Live Interview</strong></div>
    <aside id="app-sidebar" aria-label="Sidebar" className={"app-sidebar " + (menuOpen ? "is-open" : "")}>
      <div className="app-brand"><img src={mark} alt="" /><strong>Live Interview</strong></div>
      {c.activeMeeting && <button className="active-session-link" title={compact ? "Recording · " + c.activeMeeting.purpose : undefined} onClick={() => go({ kind: "meeting", id: c.activeMeeting!.id, preparationOpen: false, artifact: "overview" })}><span className={"recording-dot " + (c.paused ? "paused" : "")} /><span>{c.sessionKind === "replay" ? "Synthetic replay" : c.paused ? "Recording paused" : "Recording"}<small>{c.activeMeeting.purpose}</small></span><ArrowUpRight size={15} aria-hidden /></button>}
      <nav aria-label="Main navigation">{groups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div>{group.entries.map(item)}</div>)}</nav>
      <div className="sidebar-footer">
        <button className="readiness-card" aria-haspopup="dialog" title={compact ? (speechReady ? "On-device speech ready" : "Speech setup needed") : undefined} onClick={() => go({ kind: "settings", section: "speech" })}><span className={"status-dot " + (speechReady ? "active" : "unavailable")} /><span><strong>{speechReady ? "On-device speech ready" : "Speech setup needed"}</strong></span></button>
        <button className={"nav-item " + (active === "settings" ? "selected" : "")} aria-haspopup="dialog" title={compact ? "Settings" : undefined} onClick={() => go({ kind: "settings", section: "speech" })}><Settings size={17} aria-hidden /><span>Settings</span></button>
      </div>
    </aside>
    <main ref={main} className="app-main" id="main-content" tabIndex={-1}>{children}</main>
  </div>;
}
