import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSection } from "../presentation/types";

// Static markup and source checks (no DOM environment in this package) for Settings as a window over the app.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const noop = () => {};
const controller = ({ live = false, publicProduct = false } = {}) => ({
  publicProduct: { enabled: publicProduct },
  activeMeeting: live ? { id: "m1", purpose: "Customer discovery" } : undefined,
  entry: { detectionStatus: "noVerifiedCall", detectionDiagnostics: undefined },
  modelSetup: { phase: "idle" },
  ready: { recognitionReady: true, translation: { target: "en", appleAvailable: true, installedSources: ["de"], experimentalMedium: false, mediumAssetsReady: false } },
  speechStatus: "Local", retrySpeech: noop, busy: false, status: "Recording locally", frames: {}, captureHealth: {}, records: [],
  assistance: { id: 0, code: "notConnected", severity: "ok", text: "", degraded: false },
  toggleExperimentalMedium: noop, installModels: noop, cancelModelInstall: noop, startReplay: noop,
});
const setup = { active: false, state: { steps: [], ready: true, progress: { done: 0, total: 0 }, requiredRemaining: 0 }, message: "" };
// Rendered during a meeting by default: the sections that wait for the meeting are then only their notice, which keeps
// this stub small. The window itself is the same either way.
const render = (section: SettingsSection, options: { live?: boolean; publicProduct?: boolean } = { live: true }) =>
  renderToStaticMarkup(createElement(SettingsDialog, { controller: controller(options), setup, section, navigate: noop, onClose: noop } as never));

describe("Settings window", () => {
  test("is a modal dialog named after the open section", () => {
    const html = render("diagnostics");
    expect(html).toMatch(/<div[^>]*class="settings-window"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Settings, Diagnostics"/);
    expect(html).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Diagnostics<\/h1>/);
  });
  test("the section list is grouped, the open section is marked, and the version sits at the foot", () => {
    const html = render("speech", { live: true, publicProduct: false });
    const labels = [...html.matchAll(/class="settings-group-label"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["General", "Data", "Support"]);
    expect(html).toMatch(/data-section="speech" class="settings-nav-item selected" aria-current="page"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('class="settings-version"');
    expect(html.indexOf("settings-version")).toBeGreaterThan(html.indexOf('data-section="diagnostics"'));
  });
  test("has a close button and a Back button for the narrow two-step layout", () => {
    const html = render("speech");
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toMatch(/class="link-button settings-back"[^>]*>.*?Settings<\/button>/);
    expect(html).toContain('data-view="section"');
  });
  test("keeps a window drag region over the title bar, outside the panel", () => {
    const html = render("speech");
    expect(html).toMatch(/<div class="settings-drag-strip" data-tauri-drag-region="[^"]*"><\/div><div[^>]*class="settings-window"/);
  });
  test("during a live meeting the sections that wait still explain why, and recording is said to continue", () => {
    for (const section of ["reasoning", "keyboard", "calendars", "sharing"] as const) {
      const html = render(section, { live: true });
      expect(html, section).toContain("Available after this meeting ends. Recording continues.");
    }
    expect(render("speech", { live: true })).not.toContain("Available after this meeting ends");
  });
});

describe("wiring", () => {
  const app = source("../CopilotApplication.tsx");
  test("the app behind (and a welcome under it) is inert while Settings is open", () => {
    expect(app).toContain('<div className="app-root" inert={setup.welcomeOpen || !!nav.settings}>');
    expect(app).toContain('<div className="welcome-layer" inert={!!nav.settings}><WelcomeFlow setup={setup} /></div>');
  });
  test("Settings is no longer a page: it renders as the dialog, over every page", () => {
    expect(app).not.toContain("SettingsPage");
    expect(app).toContain("{nav.settings && <SettingsDialog");
    expect(app).toContain("setNav((old) => navigateTo(old, next));");
  });
  test("closing returns focus to the opener, or to the page when the opener is gone", () => {
    expect(app).toContain("if (target && canReturnFocusTo(target)) target.focus({ preventScroll: true });");
    expect(app).toContain('else document.getElementById("main-content")?.focus({ preventScroll: true });');
  });
  test("the dialog handles Escape, the backdrop and Tab", () => {
    const dialog = source("./SettingsDialog.tsx");
    expect(dialog).toContain("escapeClosesSettings(event,");
    expect(dialog).toContain("backdropCloses(pressedBackdrop.current, event.target === event.currentTarget)");
    expect(dialog).toContain("trappedFocusIndex(items.length,");
  });
});

describe("Settings window styles", () => {
  const css = source("../styles/settings.css");
  test("rounded panel over a dimmed, blurred app, with a plain dim for reduced transparency", () => {
    expect(css).toMatch(/\.settings-window \{[^}]*border-radius:20px/);
    expect(css).toMatch(/\.settings-overlay \{[^}]*backdrop-filter:blur\(5px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency:reduce\),\(prefers-contrast:more\) \{ \.settings-overlay \{[^}]*backdrop-filter:none/);
  });
  test("no animation with reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\) \{ \.settings-overlay,\.settings-window \{ animation:none; \} \}/);
  });
  test("narrow windows: fills the window below 900px, list then section below 620px", () => {
    expect(css).toMatch(/@media \(max-width:900px\) \{[^@]*\.settings-window \{ width:100%; height:100%;/);
    expect(css).toMatch(/@media \(max-width:620px\) \{[^@]*\.settings-window\[data-view="section"\] \.settings-sidebar,\.settings-window\[data-view="list"\] \.settings-main \{ display:none; \}/);
  });
  test("stacks above the welcome", () => {
    const welcome = Number(source("../styles/screens.css").match(/\.welcome-flow \{[^}]*z-index:(\d+)/)?.[1]);
    const settings = Number(css.match(/\.settings-overlay \{[^}]*z-index:(\d+)/)?.[1]);
    expect(settings).toBeGreaterThan(welcome);
  });
});
