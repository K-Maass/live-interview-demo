import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { PublicAccountStatus, PublicCalendarEvent, PublicMeetingPlan } from "@live-interview/core";
import { MeetingSetupPage, MeetingTitle, teamsAutoStartConditions } from "./MeetingSetupPage";
import { PreparationPage } from "./PreparationPage";
import { PublicPreparationEditor, briefActions } from "./PublicPreparationEditor";
import { PremiumCard, automaticPreparationStatus, premiumState } from "../PremiumCard";
import { personLabel, peopleSuggestions } from "../PeoplePicker";

// Static markup (no DOM environment in this package): the one-page meeting layout of the redesign (chunk C).
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();
const NOW = new Date(2026, 9, 21, 9, 0).getTime();
const basePlan = { id: "p1", title: "Client sync", startMs: at(14), endMs: at(14, 30), workspaceId: "default", sourceIds: [], sharedLibraryIds: [], profileId: "workClient", attendees: [], objectives: [], publicResearchTopics: [], briefDraft: "", automaticPreparation: false, revision: 1, updatedAtMs: 0, status: "draft" } as unknown as PublicMeetingPlan;
const account = (patch: Partial<PublicAccountStatus> = {}): PublicAccountStatus => ({ configured: true, signedIn: true, plan: "standard", subscriptionStatus: "active", canUseAI: true, canAutoPrepare: false, billingAvailable: true, ...patch });
const premium = account({ plan: "premium", canAutoPrepare: true });

const noop = () => {};
function controller({ plan = basePlan, acct = account(), ready = true, purpose = plan.title, brief, armed = false, events = [] as PublicCalendarEvent[] }: { plan?: PublicMeetingPlan; acct?: PublicAccountStatus; ready?: boolean; purpose?: string; brief?: unknown; armed?: boolean; events?: PublicCalendarEvent[] } = {}) {
  return {
    calendarRange: undefined, selectUpcoming: noop,
    publicProduct: { enabled: true, current: plan, plans: [], workspaces: [], sources: [], calendarEvents: events, accounts: [{ id: "device", provider: "apple", name: "macOS Calendar", status: "connected", selectedCalendarIds: ["work"] }], accountsLoaded: true, rangeError: undefined,
      coverage: [{ accountId: "device", calendarId: "work", startMs: at(0) - 7 * 86_400_000, endMs: at(0) + 7 * 86_400_000, status: "ready" }], range: { startMs: at(0) - 7 * 86_400_000, endMs: at(0) + 7 * 86_400_000 },
      openPlan: async () => {}, setPlanTimes: async () => true, setMessage: noop,
      calendarMove: { pending: undefined, busy: false, error: "", errorCode: undefined, lastMove: undefined, propose: async () => undefined, proposeRevert: async () => undefined, confirm: async () => undefined, cancel: noop, clearError: noop },
      account: acct, loading: false, preparing: false, dirty: false, message: "", edit: noop, reloadPlan: async () => {}, prepare: async () => {}, save: async () => {}, invalidatePreparationRequest: noop, loadRange: async () => {},
      calendarSave: { writable: [], pending: undefined, busy: false, error: "", refresh: async () => {}, propose: async () => {}, proposeIcs: async () => {}, confirm: async () => {}, cancel: noop } },
    setup: { workspace: "default", purpose, objectives: "Agree scope\n", publicTopics: "", participants: [], brief, inputDevice: "", retain: false, scheduledEndMs: plan.endMs,
      setWorkspace: noop, setPurpose: noop, setObjectives: noop, setPublicTopics: noop, setParticipants: noop, setBrief: noop, setInputDevice: noop, setRetain: noop, setSchedule: noop },
    people: { known: [], name: "", setName: noop },
    entry: { armed, armedUntil: at(10), arm: noop, detectionStatus: "noVerifiedCall" },
    ready: { recognitionReady: ready, translationReady: ready },
    inputDevices: [], inputDeviceAvailability: "ready", speechStatus: "Local", retrySpeech: noop, workspaces: [], profile: "workClient", changeProfile: noop, busy: false, start: async () => {},
  };
}
const page = (c = controller(), extra: object = {}) => renderToStaticMarkup(createElement(MeetingSetupPage, { controller: c, navigate: noop, prepare: noop, ...extra } as never));

describe("meeting page layout", () => {
  test("one page: no Plan/Brief tabs, no separate Title field, and the cards in order", () => {
    const html = page();
    expect(html).not.toContain("artifact-tabs");
    expect(html).not.toContain(">Plan<");
    expect(html).not.toContain('id="meeting-title"');
    const order = ["Who &amp; why", "Brief", "Context", "Recording"].map((t) => html.indexOf(">" + t + "</h2>"));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("You are responsible for telling participants about recording and assistance.");
  });
  test("Start meeting is always present and is the only filled button", () => {
    for (const c of [controller(), controller({ ready: false }), controller({ plan: { ...basePlan, startMs: undefined, endMs: undefined, title: "Untitled meeting" }, purpose: "" }), controller({ plan: { ...basePlan, eventId: "google:1" } })]) {
      const html = page(c);
      expect(html).toMatch(/<button[^>]*class="primary start-meeting"[^>]*>.*?Start meeting<\/button>/);
      expect(html.match(/class="primary/g)).toHaveLength(1);
    }
  });
  test("without local speech Start says why, next to it", () => {
    const html = page(controller({ ready: false }));
    expect(html).toMatch(/aria-describedby="[^"]+"[^>]*disabled=""[^>]*>.*?Start meeting/);
    expect(html).toContain("Start needs local speech.");
  });
  test("the header shows the when line, the calendar status as coloured text and the saved state", () => {
    const html = page();
    expect(html).toMatch(/class="meeting-when-link"[^>]*>[^<]*· 30 min<\/button>/);
    expect(html).toContain('class="calendar-status">Only in this app');
    expect(html).toContain("Saved on this Mac");
    expect(html).toContain(">Reload saved</button>");
    // Said once, in the header: the day panel does not repeat it.
    expect(page(controller({ plan: { ...basePlan, eventId: "google:1" } })).match(/From your calendar/g)).toHaveLength(1);
  });
  test("Type is a group of pills (radio buttons) and People is one field with suggestions", () => {
    const html = page();
    expect(html).toMatch(/role="radiogroup"/);
    expect(html.match(/class="type-pill/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/class="type-pill is-selected"><input type="radio"[^>]*checked=""/);
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain("Add as a new person");
    expect(html).not.toContain("Reuse existing person");
  });
  test("the day slot holds the day panel, with this meeting's time, length and calendar row as its footer", () => {
    // The fixture is on 21 Oct 2026; a past day is locked, so render as if it were that morning.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const html = page();
    vi.useRealTimers();
    expect(html).toContain('data-slot="meeting-day-panel"');
    expect(html).toMatch(/<aside class="meeting-day-slot has-day-panel"[^>]*>.*<section class="dp"/);
    expect(html).not.toContain(">Date &amp; time<");
    expect(html).toMatch(/class="dp-meeting is-this is-movable[ "]/);
    expect(html).toMatch(/<footer class="dp-footer">.*class="length-choices segmented-control".*Add to calendar/);
    expect(source("./MeetingSetupPage.tsx")).not.toContain(".chosen-block");
  });
  test("context is edited only once on the page", () => {
    const html = page();
    expect(html.match(/Meeting workspace/g)).toHaveLength(1);
    expect(html.match(/aria-label="Source scope"/g)).toHaveLength(1);
  });
});

describe("meeting title", () => {
  const input = (el: ReactNode): ReactElement<{ value: string; onChange: (e: unknown) => void; onKeyDown: (e: unknown) => void }> => {
    const h1 = el as ReactElement<{ children: ReactNode }>;
    const child = h1.props.children;
    if (!isValidElement(child)) throw new Error("no input");
    return child as never;
  };
  test("edits in place and saves each change", () => {
    const save = vi.fn();
    const field = input(MeetingTitle({ value: "Client sync", onChange: save }));
    expect(field.props.value).toBe("Client sync");
    field.props.onChange({ target: { value: "Client sync with Acme" } });
    expect(save).toHaveBeenCalledWith("Client sync with Acme");
  });
  test("an untitled meeting shows an empty field with a placeholder, and Enter finishes editing", () => {
    const field = input(MeetingTitle({ value: "Untitled meeting", onChange: noop }));
    expect(field.props.value).toBe("");
    const blur = vi.fn();
    field.props.onKeyDown({ key: "Enter", currentTarget: { blur } });
    expect(blur).toHaveBeenCalled();
    expect(renderToStaticMarkup(MeetingTitle({ value: "Untitled meeting", onChange: noop }))).toContain('placeholder="Name this meeting"');
  });
});

describe("Teams auto-start", () => {
  test("its conditions are shown in plain words, with what is still missing", () => {
    const html = page();
    expect(html).toContain("Start recording when this Teams call begins");
    expect(html).toContain("Needs a brief in use (see Brief above)");
    expect(html).toContain("The Teams call is titled “Client sync”, matching exactly");
    expect(html).toContain("Stays on for one hour after you turn it on.");
    expect(html).toContain("Calendar timing alone never starts capture; unprepared calls ask first.");
    expect(html).toMatch(/<input disabled=""[^>]*role="switch"[^>]*\/><label[^>]*>Start recording when this Teams call begins/);
  });
  test("is a switch that can be turned on once a brief is in use and the meeting has a title", () => {
    expect(teamsAutoStartConditions({ hasBrief: true, title: "Client sync", armed: false, armedUntil: 0 }).ready).toBe(true);
    expect(teamsAutoStartConditions({ hasBrief: true, title: "Untitled meeting", armed: false, armedUntil: 0 }).ready).toBe(false);
    expect(teamsAutoStartConditions({ hasBrief: false, title: "Client sync", armed: false, armedUntil: 0 }).ready).toBe(false);
    const armed = teamsAutoStartConditions({ hasBrief: true, title: "Client sync", armed: true, armedUntil: at(10) });
    expect(armed.duration).toMatch(/^On until .+, then it turns itself off\.$/);
  });
});

describe("Brief card and its in-place editor", () => {
  test("without a brief: Write a brief, and Draft with AI on any paid plan", () => {
    const html = page();
    expect(html).toContain(">Optional</span>");
    expect(html).toContain(">Write a brief</button>");
    expect(html).toMatch(/<button type="button">.*?Draft with AI<\/button>/);
  });
  test("without a subscription Draft with AI says so, with a way to the plans", () => {
    const html = page(controller({ acct: account({ plan: "none", canUseAI: false }) }));
    expect(html).toContain("Needs a subscription");
    expect(html).toContain(">See plans</button>");
    expect(html).not.toMatch(/<button[^>]*>.*?Draft with AI<\/button>/);
  });
  test("an AI draft stays marked as a draft until it is used", () => {
    const draft = { ...basePlan, briefDraft: "Ask about the budget.", draftEvidence: ["s1"] } as PublicMeetingPlan;
    expect(page(controller({ plan: draft }))).toContain("AI draft · not in use yet");
    expect(page(controller({ plan: { ...draft, status: "prepared" } as PublicMeetingPlan }))).toContain("In use for live assistance");
  });
  test("the editor offers drafting, writing, using and closing, and no context controls", () => {
    const c = controller({ plan: { ...basePlan, briefDraft: "Ask about the budget." } as PublicMeetingPlan });
    const html = renderToStaticMarkup(createElement(PublicPreparationEditor, { controller: c, onClose: noop, onSeePlans: noop } as never));
    expect(html).toContain("Improve with AI");
    expect(html).toContain("<textarea");
    expect(html).toContain(">Use this brief</button>");
    expect(html).toContain(">Done</button>");
    expect(html).not.toContain("Source scope");
    expect(html).not.toContain("class=\"primary");
  });
  test("brief actions follow the plan and the account", () => {
    expect(briefActions({ briefDraft: "", status: "draft" }, account(), false)).toMatchObject({ canDraftWithAI: true, aiLabel: "Draft with AI", canUse: false, needsSubscription: false });
    expect(briefActions({ briefDraft: "x", status: "draft" }, account(), false)).toMatchObject({ aiLabel: "Improve with AI", canUse: true });
    expect(briefActions({ briefDraft: "x", status: "prepared" }, account(), false)).toMatchObject({ canUse: false, inUse: true });
    expect(briefActions({ briefDraft: "x", status: "draft" }, account({ canUseAI: false }), false)).toMatchObject({ canDraftWithAI: false, needsSubscription: true });
    expect(briefActions({ briefDraft: "x", status: "draft" }, account(), true)).toMatchObject({ canDraftWithAI: false, canUse: false });
  });
  test("the Preparation route still works: it shows the meeting page with the brief editor open", () => {
    const html = renderToStaticMarkup(createElement(PreparationPage, { controller: controller(), navigate: noop, back: noop } as never));
    expect(html).toContain("Start meeting");
    expect(html).toContain('class="meeting-card brief-card is-editing"');
    expect(html).toContain("<textarea");
    const app = source("../CopilotApplication.tsx");
    expect(app).toMatch(/stage !== "preparation"\}><PreparationPage /);
  });
});

describe("Premium", () => {
  const render = (acct: PublicAccountStatus | undefined, plan: PublicMeetingPlan = basePlan) => renderToStaticMarkup(createElement(PremiumCard, { account: acct, plan, now: NOW, onAutomaticPreparation: noop, onSeePremium: noop, onSignIn: noop }));
  test("on Premium: a card with a working switch and when it will prepare", () => {
    const html = render(premium, { ...basePlan, automaticPreparation: true });
    expect(html).toContain('class="meeting-card premium-card"');
    expect(html).toMatch(/role="switch"[^>]*checked=""/);
    expect(html).not.toMatch(/<input disabled=""[^>]*role="switch"/);
    expect(html).toContain("Will prepare by");
    expect(html).not.toMatch(/badge|amber/);
  });
  test("on Premium without a time: available for scheduled meetings, and the switch waits", () => {
    const html = render(premium, { ...basePlan, startMs: undefined, endMs: undefined });
    expect(html).toContain("Available for scheduled meetings");
    expect(html).toMatch(/<input disabled=""[^>]*role="switch"/);
  });
  test("on Standard: one teaser line, never a locked card", () => {
    const html = render(account());
    expect(html).toMatch(/^<p class="premium-teaser">/);
    expect(html).toContain("Premium can prepare this meeting for you");
    expect(html).toContain(">See Premium</button>");
    expect(html).not.toContain("switch");
    expect(html).not.toContain("(Premium)");
  });
  test("signed out: the teaser offers Sign in", () => {
    const html = render(account({ signedIn: false, plan: "none", canUseAI: false }));
    expect(html).toContain(">Sign in</button>");
    expect(html).not.toContain("See Premium");
  });
  test("service unavailable: the teaser says so and offers nothing that cannot work", () => {
    const html = render(account({ configured: false, signedIn: false, plan: "none", canUseAI: false, subscriptionStatus: "unavailable" }));
    expect(html).toContain("Account service unavailable");
    expect(html).not.toContain("<button");
  });
  test("nothing while the account is loading", () => {
    expect(render(undefined)).toBe("");
    expect(premiumState(undefined)).toBe("loading");
  });
  test("status words", () => {
    expect(automaticPreparationStatus({ ...basePlan, automaticPreparation: false }, NOW)).toBe("Off for this meeting");
    expect(automaticPreparationStatus({ ...basePlan, automaticPreparation: true, briefDraft: "notes" }, NOW)).toMatch(/already has a brief/);
    expect(automaticPreparationStatus({ ...basePlan, automaticPreparation: true }, at(15))).toBe("This meeting has already started");
  });
  test("on the page: the card on Premium, the teaser otherwise", () => {
    expect(page(controller({ acct: premium }))).toContain("premium-card");
    expect(page(controller())).toContain("premium-teaser");
  });
});

describe("people suggestions", () => {
  const alex = { id: "a1", name: "Alex Morgan" }, otherAlex = { id: "a2", name: "Alex Morgan" }, riley = { id: "r1", name: "Riley Chen" };
  test("saved people first, then always a new person, even when the name matches a saved one", () => {
    const s = peopleSuggestions([alex, otherAlex, riley] as never, [], "alex morgan");
    expect(s.existing.map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(s.newName).toBe("alex morgan");
  });
  test("people already in the meeting are not suggested again", () => {
    expect(peopleSuggestions([alex, riley] as never, [alex] as never, "").existing.map((p) => p.id)).toEqual(["r1"]);
  });
  test("two people with the same name are told apart by a number, never by an internal ID", () => {
    const everyone = [alex, otherAlex, riley] as never;
    expect(personLabel(alex as never, everyone)).toBe("Alex Morgan (1)");
    expect(personLabel(otherAlex as never, everyone)).toBe("Alex Morgan (2)");
    expect(personLabel(riley as never, everyone)).toBe("Riley Chen");
    expect(personLabel(alex as never, [alex, riley] as never)).toBe("Alex Morgan");
  });
});

describe("styles", () => {
  const css = source("../styles/screens.css");
  test("cards are rounded and the switch track keeps a 3:1 outline", () => {
    expect(css).toMatch(/\.meeting-card \{[^}]*border-radius:var\(--radius-lg\)/);
    expect(css).toMatch(/input\.switch \{[^}]*box-shadow:inset 0 0 0 1px var\(--control-border\)/);
  });
  test("widths: day beside from 1100 px, a drawer below, full width under 820 px", () => {
    expect(source("./MeetingSetupPage.tsx")).toContain('DAY_PANEL_BESIDE = "(min-width: 1100px)"');
    expect(css).toMatch(/@media\(max-width:819px\)\{ \.guidance-drawer\.meeting-day-drawer\{width:100vw/);
  });
  test("statuses are plain coloured text with no amber", () => {
    const block = css.slice(css.indexOf("/* ---- Meeting page"));
    expect(block).not.toMatch(/--amber|#b77|#8a5a12/);
  });
});
