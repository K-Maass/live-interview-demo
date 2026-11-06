// Settings as a window over the current page (pure state, tested without a DOM).
import type { AppLocation, PageLocation, SettingsSection } from "./types";

/** What the main window shows: a page, and optionally Settings open over it on one section. */
export interface Navigation {
  page: PageLocation;
  settings?: SettingsSection;
}

/**
 * Applies a `navigate` call. A settings link opens Settings over the page that is showing (or switches its section)
 * and leaves the page exactly as it was. A page link shows that page and closes Settings, so a link inside Settings
 * such as "Open meeting setup" lands on that page.
 */
export function navigateTo(state: Navigation, next: AppLocation): Navigation {
  if (next.kind === "settings") return state.settings === next.section ? state : { page: state.page, settings: next.section };
  return { page: next };
}

/** Closes Settings; the page underneath was never changed, so it comes back as it was. */
export function closeSettings(state: Navigation): Navigation {
  return state.settings === undefined ? state : { page: state.page };
}

export interface SettingsItem { id: SettingsSection; label: string }
export interface SettingsGroup { label: string; items: SettingsItem[] }

/**
 * The Settings sidebar. "Settings" holds what shapes how the app works; "Account" (or "Data" without the public
 * product) holds what belongs to the person: plan, updates and their records; "Support" ends the list with
 * Diagnostics, which is for checking the app rather than setting it up. Setup appears only while setup is active.
 */
export function settingsGroups({ setupActive, publicProduct }: { setupActive: boolean; publicProduct: boolean }): SettingsGroup[] {
  return [
    { label: "General", items: [
      ...(setupActive ? [{ id: "setup" as const, label: "Setup" }] : []),
      { id: "speech", label: "Local speech" },
      { id: "reasoning", label: "Reasoning" },
      { id: "keyboard", label: "Keyboard shortcuts" },
      { id: "calendars", label: "Calendars" },
    ] },
    { label: publicProduct ? "Account" : "Data", items: [
      ...(publicProduct ? [{ id: "account" as const, label: "Account & plan" }, { id: "updates" as const, label: "Updates" }] : []),
      { id: "sharing", label: "Data & sharing" },
    ] },
    { label: "Support", items: [{ id: "diagnostics", label: "Diagnostics" }] },
  ];
}

/** A section that this edition or state does not show falls back to the first one that is shown. */
export function visibleSection(section: SettingsSection, groups: SettingsGroup[]): SettingsSection {
  const items = groups.flatMap((g) => g.items);
  return items.some((i) => i.id === section) ? section : items[0].id;
}

/** Sections whose controls wait until the meeting ends; their page explains this instead. */
export const unavailableDuringMeeting: readonly SettingsSection[] = ["reasoning", "keyboard", "calendars", "sharing"];

/**
 * Where Tab goes inside the Settings window: past the last control back to the first, and Shift+Tab before the first
 * to the last. `undefined` means the browser's own order is fine. `current` is -1 when focus is outside the controls.
 */
export function trappedFocusIndex(count: number, current: number, backwards: boolean): number | undefined {
  if (count === 0) return undefined;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return undefined;
}

/**
 * Plain Escape closes Settings, unless something inside already handled it (a popover, a confirmation) or a
 * confirmation sheet inside Settings is open: that sheet closes first, on its own.
 */
export function escapeClosesSettings(event: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; defaultPrevented: boolean }, nestedSheetOpen: boolean): boolean {
  return event.key === "Escape" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.defaultPrevented && !nestedSheetOpen;
}

/** A click on the dimmed area closes Settings only when the press also began there (not a text selection dragged out of the panel). */
export const backdropCloses = (pressedOnBackdrop: boolean, releasedOnBackdrop: boolean) => pressedOnBackdrop && releasedOnBackdrop;

/** Focus goes back to the control that opened Settings while it is still on screen and usable; otherwise to the page. */
export function canReturnFocusTo(element: { isConnected: boolean; getClientRects(): { length: number }; closest(selector: string): unknown } | null | undefined): boolean {
  return !!element && element.isConnected && element.getClientRects().length > 0 && !element.closest("[hidden],[inert]");
}
