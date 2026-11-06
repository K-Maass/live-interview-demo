import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CalendarAccount, CalendarCoverage, CalendarSource } from "@live-interview/core";
import { CalendarConnectionsView, type CalendarConnectionsViewProps } from "./CalendarConnections";

// Acceptance checks of design.md §12 that a static render can prove. Interaction (debounce, focus, Escape) is checked
// in the browser preview; see the report.
const NOW = new Date(2026, 9, 18, 12, 0).getTime();
const mac = (extra: Partial<CalendarAccount> = {}): CalendarAccount => ({ id: "device", provider: "apple", name: "Fictional work calendar", status: "connected", selectedCalendarIds: ["home", "work", "family", "exchange", "holidays"], selectionSaved: false, lastSyncMs: NOW - 2 * 60000, ...extra });
const macSources = (selected = true): CalendarSource[] => [
  { id: "home", accountId: "device", name: "Home", group: "iCloud", color: "#1badf8", read: true, edit: true, selected },
  { id: "work", accountId: "device", name: "Work", group: "iCloud", color: "#63da38", read: true, edit: true, selected },
  { id: "family", accountId: "device", name: "Family", group: "iCloud", color: "#cc73e1", read: true, edit: false, selected },
  { id: "exchange", accountId: "device", name: "Calendar", group: "Exchange", color: "#ff9500", read: true, edit: true, selected },
  { id: "holidays", accountId: "device", name: "Holidays in Germany", group: "Subscribed", color: "#ff2968", read: true, edit: false, selected },
];
const microsoft: CalendarAccount = { id: "ms", provider: "microsoft", name: "Alex Example", email: "alex@contoso.example", status: "connected", code: "calendarReauthenticationRequired", selectedCalendarIds: ["ms-cal"], selectionSaved: true };
const google: CalendarAccount = { id: "g", provider: "google", name: "Alex Example", email: "alex.example@example.com", status: "connected", selectedCalendarIds: [] };
const googleSources: CalendarSource[] = [
  { id: "g1", accountId: "g", name: "Alex Example", color: "#039be5", read: true, edit: false, selected: false },
  { id: "g2", accountId: "g", name: "Team rota", color: "#33b679", read: true, edit: false, selected: false },
  { id: "g3", accountId: "g", name: "Alex’s calendar", read: false, edit: false, selected: false },
];
const noop = () => {};
const props = (extra: Partial<CalendarConnectionsViewProps> = {}): CalendarConnectionsViewProps => ({
  accounts: [], accountsLoaded: true, coverage: [], sources: {}, sourcesFailed: {}, ticks: {}, save: {}, connectError: {}, rowNote: {}, refreshing: false,
  expanded: {}, justConnected: [], appIcon: null, announcement: "", now: NOW,
  on: { refresh: noop, toggle: noop, tick: noop, action: noop, connect: noop, askDisconnect: noop, cancelDisconnect: noop, disconnect: noop, retry: noop },
  ...extra,
});
const render = (extra: Partial<CalendarConnectionsViewProps> = {}) => renderToStaticMarkup(createElement(CalendarConnectionsView, props(extra)));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const card = (html: string, label: string) => html.split(`aria-label="${label}"`)[1]?.split("</ul>")[0] ?? "";
const titles = (html: string) => [...html.matchAll(/<h3 class="cc-title"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
const withoutSyncDetails = (html: string) => html.replace(/<details class="cc-details">[\s\S]*?<\/details>/, "");

describe("Calendar connections: none connected", () => {
  const html = render();
  test("lead line, Card 2 with Mac, Microsoft, Google in that order, and the admin note", () => {
    expect(html).toContain("Reads only the calendars you tick. Any change to a calendar waits for your review.");
    expect(titles(card(html, "Add calendars"))).toEqual(["Calendars on this Mac", "Microsoft", "Google"]);
    expect(html).toContain("iCloud, Exchange and other accounts in Calendar");
    expect(html).toContain("Outlook.com, or a work or school account");
    expect(html).toContain("Some work or school accounts need an administrator to approve Live Interview first.");
    expect(html.match(/>Connect…</g)).toHaveLength(3);
  });
  test("no Refresh, no Sync details, no connected card", () => {
    expect(html).not.toContain("Refresh");
    expect(html).not.toContain("Sync details");
    expect(html).not.toContain('aria-label="Connected calendars"');
  });
});

describe("Calendar connections: Mac connected with the default choice", () => {
  const html = render({ accounts: [mac()], sources: { device: macSources() } });
  test("one Mac row: Connected · All 5 calendars · Updated 2 min ago, list open", () => {
    expect(titles(card(html, "Connected calendars"))).toEqual(["Calendars on this Mac"]);
    expect(text(html)).toContain("ConnectedAll 5 calendarsUpdated 2 min ago");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Hide calendars on this Mac"');
  });
  test("groups iCloud, Exchange, Subscribed with colour dots, and Read only on exactly the read-only calendars", () => {
    expect([...html.matchAll(/<p class="cc-sub"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["iCloud", "Exchange", "Subscribed"]);
    expect(html).toContain('style="background:#1badf8"');
    expect(html.match(/>Read only</g)).toHaveLength(2);
    expect(text(html)).toContain("FamilyRead only");
    expect(text(html)).toContain("Holidays in GermanyRead only");
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(5);
  });
  test("footer explains the default and offers Stop reading; there is no Save button anywhere", () => {
    expect(html).toContain("All calendars are read until you untick one.");
    expect(html).toContain(">Stop reading…<");
    expect(html).not.toMatch(/Save calendar selection|>Save</);
    expect(html).not.toContain("Read available");
    expect(html).not.toContain("Editable with review");
  });
  test("Card 2 offers only Microsoft and Google", () => {
    expect(titles(card(html, "Add calendars"))).toEqual(["Microsoft", "Google"]);
  });
  test("the Mac tile is the outline fallback without a native icon, the system icon with one", () => {
    expect(html).toContain("lucide-calendar-days");
    const withIcon = render({ accounts: [mac()], sources: { device: macSources() }, appIcon: "data:image/png;base64,AAAA" });
    expect(withIcon).toContain('class="cc-tile system"');
    expect(withIcon).toContain('src="data:image/png;base64,AAAA"');
  });
});

describe("Calendar connections: saving a choice", () => {
  test("after unticking Family and saving: 4 of 5, and new calendars start unticked", () => {
    const html = render({ accounts: [mac({ selectionSaved: true })], sources: { device: macSources() }, ticks: { device: ["home", "work", "exchange", "holidays"] }, expanded: { device: true } });
    expect(text(html)).toContain("Connected4 of 5 calendars");
    expect(html).toContain("New calendars on this Mac start unticked.");
  });
  test("Saving… and Saved replace the footer text in a live region", () => {
    expect(render({ accounts: [mac()], sources: { device: macSources() }, save: { device: { kind: "saving" } } })).toContain('<span role="status">Saving…</span>');
    const saved = render({ accounts: [mac()], sources: { device: macSources() }, save: { device: { kind: "saved" } } });
    expect(saved).toContain('<p class="saved"><span role="status">Saved</span></p>');
  });
  test("a failed save says so in red with an icon", () => {
    const html = render({ accounts: [mac()], sources: { device: macSources() }, save: { device: { kind: "error", message: "Couldn’t save your choice. Try again." } } });
    expect(html).toMatch(/<p class="failed"><span role="status"><svg[^>]*lucide-circle-alert[\s\S]*Couldn’t save your choice\. Try again\./);
  });
});

describe("Calendar connections: states", () => {
  test("no calendars chosen is neutral with the dashed icon, and the list is open", () => {
    const html = render({ accounts: [mac({ selectedCalendarIds: [], selectionSaved: true })], sources: { device: macSources(false) } });
    expect(html).toMatch(/class="s neutral"><svg[^>]*lucide-circle-dashed[^>]*>[\s\S]*?No calendars chosen/);
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).not.toContain("Connected");
  });
  test("access off: red with an icon and Open System Settings; no list, no Disconnect, Mac not in Card 2", () => {
    const html = render({ accounts: [{ id: "apple-local", provider: "apple", name: "macOS Calendar", status: "accessOff", code: "calendarPermissionDenied", selectedCalendarIds: [] }], sources: { "apple-local": [] } });
    expect(html).toMatch(/class="s problem"><svg[^>]*lucide-circle-alert[^>]*>[\s\S]*?Access is off in System Settings/);
    expect(html).toContain(">Open System Settings<");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain("Stop reading");
    expect(html).not.toContain("cc-disclose");
    expect(titles(card(html, "Add calendars"))).toEqual(["Microsoft", "Google"]);
  });
  test("a range load refused as a whole: Couldn't update with Try again, never Connected", () => {
    const html = render({ accounts: [mac()], sources: { device: macSources() }, rangeError: "calendarUnavailable" });
    expect(text(html)).toContain("Couldn’t update");
    expect(html).toContain(">Try again<");
    expect(text(html)).not.toContain("Connected");
    // The row already says so: no second section-level line.
    expect(html).not.toContain("cc-range");
  });
  test("stale coverage shows when the meetings shown are from", () => {
    const coverage: CalendarCoverage[] = [
      { accountId: "device", startMs: NOW, endMs: NOW + 1, status: "ready", refreshedAtMs: new Date(2026, 9, 18, 9, 40).getTime() },
      { accountId: "device", startMs: NOW, endMs: NOW + 1, status: "stale", refreshedAtMs: NOW },
    ];
    expect(text(render({ accounts: [mac()], sources: { device: macSources() }, coverage }))).toContain("Couldn’t updateShowing meetings from 9:40");
  });
  test("a whole-range failure with no failed row gets one line with the reason and Try again", () => {
    const html = render({ accounts: [], rangeError: "calendarUnavailable" });
    expect(html).toMatch(/<p class="cc-range"><svg[^>]*lucide-circle-alert[\s\S]*The calendars on this Mac didn’t answer\.[\s\S]*>Try again</);
  });
  test("checking replaces Card 1 with one quiet line and disables Connect", () => {
    const html = render({ accountsLoaded: false });
    expect(html).toContain('<p class="cc-checking" role="status">Checking calendars…</p>');
    expect(html.match(/disabled=""[^>]*>Connect…/g)).toHaveLength(3);
  });
  test("updating: the row says Updating… and its ticks are disabled", () => {
    const html = render({ accounts: [mac()], sources: { device: macSources() }, busyId: "device" });
    expect(text(html)).toContain("Updating…");
    expect(html.match(/type="checkbox"[^>]*disabled=""/g)).toHaveLength(5);
  });
  test("refreshing: the button reads Refreshing… and is disabled; ticks stay usable", () => {
    const html = render({ accounts: [mac()], sources: { device: macSources() }, refreshing: true });
    expect(html).toMatch(/<button[^>]*class="cc-refresh"[^>]*disabled=""[^>]*>[\s\S]*?Refreshing…<\/button>/);
    expect(html).not.toMatch(/type="checkbox"[^>]*disabled=""/);
  });
});

describe("Calendar connections: mixed accounts", () => {
  const html = render({ accounts: [mac({ selectionSaved: true }), microsoft, google], sources: { device: macSources(), ms: [{ id: "ms-cal", accountId: "ms", name: "Calendar", read: true, edit: false, selected: true }], g: googleSources } });
  test("needs-action rows first: Microsoft (sign in again), Google (nothing chosen), then the Mac", () => {
    expect(titles(card(html, "Connected calendars"))).toEqual(["alex@contoso.example", "alex.example@example.com", "Calendars on this Mac"]);
    expect(text(html)).toContain("MicrosoftSign in again to keep reading");
    expect(html).toMatch(/class="cc-action primary"[^>]*>Sign in again…</);
  });
  test("Google's list is open with the hint, and a free/busy calendar is a disabled row", () => {
    expect(html).toContain("Tick the calendars you want Live Interview to read.");
    expect(html).toMatch(/class="cc-cal unreadable"><input type="checkbox"[^>]*disabled=""[\s\S]*?Alex’s calendar<\/span><span class="tag">Free\/busy only</);
    expect(html).toContain("Read only. Live Interview can’t change Google calendars.");
    expect(html).toContain(">Disconnect…<");
  });
  test("Card 2 offers another Microsoft and Google account", () => {
    expect(card(html, "Add calendars").match(/Add another account/g)).toHaveLength(2);
  });
  test("no raw provider ids or codes outside Sync details", () => {
    const coverage: CalendarCoverage[] = [{ accountId: "ms", startMs: NOW, endMs: NOW + 1, status: "error", code: "calendarReauthenticationRequired" }];
    const full = render({ accounts: [mac(), microsoft, google, { id: "apple-local", provider: "apple", name: "macOS Calendar", status: "accessOff", code: "calendarPermissionDenied", selectedCalendarIds: [] }], coverage });
    expect(full).toContain("<small>calendarReauthenticationRequired</small>");
    expect(text(withoutSyncDetails(full))).not.toMatch(/accessOff|calendar[A-Z]\w+|apple ·|\bapple\b|· connected/);
    expect(full).not.toMatch(/amber|notice|badge/);
  });
});

describe("Calendar connections: confirm, connect and icons", () => {
  test("the inline confirm uses the spec's words and a stop button", () => {
    const g = render({ accounts: [google], sources: { g: googleSources }, confirmId: "g" });
    expect(text(g)).toContain("Disconnect alex.example@example.com?Its meetings leave the Calendar. Meeting records and notes you saved stay.");
    expect(g).toMatch(/>Cancel<\/button><button type="button" class="stop">Disconnect</);
    const m = render({ accounts: [mac()], sources: { device: macSources() }, confirmId: "device" });
    expect(text(m)).toContain("Stop reading calendars on this Mac?Their meetings leave the Calendar. Meeting records and notes you saved stay. macOS access stays on; you can turn it off in System Settings.");
    expect(m).toContain('class="stop">Stop reading<');
  });
  test("connecting shows where to finish, and a failed connect says why next to the provider", () => {
    expect(render({ connecting: "google" })).toContain("Finish signing in in your browser…");
    expect(render({ connecting: "apple" })).toContain("Waiting for macOS…");
    expect(render({ connectError: { microsoft: "Couldn’t connect. Try again." } })).toMatch(/class="cc-error" role="status"><svg[\s\S]*Couldn’t connect\. Try again\./);
  });
  test("Microsoft logo and Google G come from the bundled official files", () => {
    const html = render();
    // Vite inlines small assets as data URLs (content unchanged) and links larger ones by file name.
    const ms = html.match(/<img class="cc-ms" src="([^"]+)"/)?.[1] ?? "";
    expect(ms.includes("microsoft-logo") || ["f25022", "7fba00", "00a4ef", "ffb900"].every((c) => ms.includes(c))).toBe(true);
    const set = html.match(/srcSet="([^"]+)"/)?.[1] ?? "";
    expect(set.split(", ").map((s) => s.split(" ").at(-1))).toEqual(["1x", "2x", "3x"]);
  });
});

describe("brand assets", () => {
  const dir = path.resolve(__dirname, "../assets/brands");
  const sha = (file: string) => createHash("sha256").update(readFileSync(path.join(dir, file))).digest("hex");
  test("files are byte-identical to the official downloads recorded in SOURCES.md", () => {
    const sources = readFileSync(path.join(dir, "SOURCES.md"), "utf8");
    for (const file of ["microsoft-logo.svg", "google-g@1x.png", "google-g@2x.png", "google-g@3x.png"]) {
      expect(sources).toContain(sha(file));
      expect(sources).toContain("`" + file + "`");
    }
    expect(sources).toContain("https://learn.microsoft.com/en-us/entra/identity-platform/media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg");
    expect(sources).toContain("https://developers.google.com/static/identity/images/signin-assets.zip");
    expect(sources).toContain("2026-10-18");
  });
  test("no Outlook, Google Calendar or Apple artwork is bundled", () => {
    expect(readdirSync(dir).sort()).toEqual(["SOURCES.md", "google-g@1x.png", "google-g@2x.png", "google-g@3x.png", "microsoft-logo.svg"]);
  });
});
