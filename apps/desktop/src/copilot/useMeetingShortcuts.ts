import { useEffect, useRef } from "react";
import { ShortcutRegistrar, type GlobalShortcutApi } from "../lib/copilot/shortcutRegistration";
import type { ShortcutAction, Shortcuts } from "../lib/copilot/shortcuts";

/**
 * Global shortcuts exist only while a meeting is live. They are registered when a session starts or is recovered, and
 * every key is released when it stops or is finalised, when this window unmounts, and when the page is hidden for a
 * reload or quit (the plugin keeps keys in the native process across a webview reload). Outside a meeting the app holds
 * no system-wide key. Each change goes through one ShortcutRegistrar, so registrations never overlap.
 */
export function useMeetingShortcuts({
  api,
  enabled,
  live,
  shortcuts,
  onAction,
  onUnavailable,
  onApplied,
}: {
  /** The plugin, or undefined outside the native app. */
  api: GlobalShortcutApi | undefined;
  enabled: boolean;
  live: boolean;
  shortcuts: Shortcuts;
  onAction: (action: ShortcutAction) => void;
  onUnavailable: (keys: string[]) => void;
  onApplied: (unavailable: string[]) => void;
}) {
  const registrar = useRef<ShortcutRegistrar | undefined>(undefined);
  const handlers = useRef({ onAction, onUnavailable, onApplied });
  handlers.current = { onAction, onUnavailable, onApplied };
  const active = enabled && !!api;
  const getRegistrar = () =>
    (registrar.current ??= new ShortcutRegistrar(
      api!,
      (action) => handlers.current.onAction(action),
      (keys) => handlers.current.onUnavailable(keys),
      (keys) => handlers.current.onApplied(keys),
    ));
  useEffect(() => {
    if (!active) return;
    if (live) void getRegistrar().apply(shortcuts);
    else void registrar.current?.clear();
  }, [active, live, shortcuts]);
  useEffect(() => {
    if (!active) return;
    const release = () => void registrar.current?.clear();
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [active]);
}
