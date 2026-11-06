// Settings → Calendars: the "Calendar connections" section (design: docs/design/2026-10-18-calendar-connections.md).
//
//   <CalendarConnections product={c.publicProduct} />
//
// Card 1 lists connected accounts (one status line each, needs-action rows first), Card 2 the providers that can still
// be added. Ticks apply instantly (500 ms debounce, flushed on unmount) and only decide what is read; calendar changes
// still go through review elsewhere. `CalendarConnectionsView` is the pure render used by the markup tests.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ChevronRight, CircleAlert, CircleCheck, CircleDashed, ExternalLink, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import type { CalendarAccount, CalendarCoverage, CalendarSource } from "@live-interview/core";
import { Section } from "../ui";
import { publicClient } from "../../lib/public/client";
import { calendarCodeHint } from "../../lib/public/calendarErrors";
import {
  accountState, accountTitle, calendarColor, calendarConnection, calendarGroups, calendarListFooter, defaultTicks, PROVIDER_NAME,
  sortAccounts, stateText, updatedText, type AccountState, type AccountStateKind,
} from "../calendar/connection";
import microsoftLogo from "../assets/brands/microsoft-logo.svg";
import google1x from "../assets/brands/google-g@1x.png";
import google2x from "../assets/brands/google-g@2x.png";
import google3x from "../assets/brands/google-g@3x.png";

export type Provider = CalendarAccount["provider"];
export type SaveStatus = { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };
type RowAction = "openSettings" | "signInAgain" | "connectAgain" | "tryAgain";

const SAVE_DELAY_MS = 500;
const SAVED_SHOWN_MS = 2000;
const SAVE_FAILED = "Couldn’t save your choice. Try again.";
const OPEN_SETTINGS_HINT = "Open System Settings → Privacy & Security → Calendars and turn on Live Interview.";
const SECOND_LINE: Partial<Record<AccountStateKind, string>> = {
  accessWithdrawn: "Your administrator may have restricted access, or a permission was removed.",
  scopeIncomplete: "Leave both boxes ticked when Google asks.",
};
const ACTION: Partial<Record<AccountStateKind, RowAction>> = { accessOff: "openSettings", signInAgain: "signInAgain", accessWithdrawn: "connectAgain", scopeIncomplete: "connectAgain", failed: "tryAgain", listIncomplete: "tryAgain" };
const ACTION_LABEL: Record<RowAction, string> = { openSettings: "Open System Settings", signInAgain: "Sign in again…", connectAgain: "Connect again…", tryAgain: "Try again" };
const NO_LIST = new Set<AccountStateKind>(["accessOff", "accessWithdrawn", "scopeIncomplete"]);
const PLACEHOLDER = (a: CalendarAccount) => a.status === "disconnected";
const COVERAGE_WORD: Record<CalendarCoverage["status"], string> = { ready: "Ready", partial: "Partly loaded", stale: "Out of date", error: "Failed" };

/** The installed Calendar app's icon from macOS, read once per session. Null in the browser preview or on failure. */
let appIconRequest: Promise<string | null> | undefined;
function calendarAppIcon(): Promise<string | null> {
  appIconRequest ??= invoke<string | null>("app_icon", { bundleId: "com.apple.iCal", size: 64 })
    .then((url) => (typeof url === "string" && url.startsWith("data:image/png;base64,") ? url : null))
    .catch(() => null);
  return appIconRequest;
}

// ---- Pure view -----------------------------------------------------------------------------------------------------

export interface CalendarConnectionsViewProps {
  accounts: CalendarAccount[];
  accountsLoaded: boolean;
  coverage: CalendarCoverage[];
  rangeError?: string;
  sources: Record<string, CalendarSource[] | undefined>;
  sourcesFailed: Record<string, boolean>;
  ticks: Record<string, string[] | undefined>;
  save: Record<string, SaveStatus | undefined>;
  busyId?: string;
  connecting?: Provider;
  connectError: Partial<Record<Provider, string>>;
  rowNote: Record<string, string | undefined>;
  refreshing: boolean;
  expanded: Record<string, boolean | undefined>;
  justConnected: string[];
  confirmId?: string;
  appIcon?: string | null;
  announcement: string;
  now: number;
  setRef?: (key: string) => (el: HTMLElement | null) => void;
  on: {
    refresh(): void;
    toggle(id: string, open: boolean): void;
    tick(id: string, sourceId: string, checked: boolean): void;
    action(account: CalendarAccount, action: RowAction): void;
    connect(provider: Provider): void;
    askDisconnect(id: string): void;
    cancelDisconnect(id: string): void;
    disconnect(account: CalendarAccount): void;
    retry(account: CalendarAccount): void;
  };
}

const noop = () => () => {};
/** The Mac row's title is found as "title:apple" so focus can move to it whatever id the native side uses. */
const titleKey = (a: CalendarAccount) => "title:" + (a.provider === "apple" ? "apple" : a.id);
const isJustConnected = (ids: string[], a: CalendarAccount) => ids.includes(a.id) || (a.provider === "apple" && ids.includes("apple"));

/** One state per account row, plus the state underneath "updating" (for ordering and the kept action button). */
export function rowStates(p: Pick<CalendarConnectionsViewProps, "accounts" | "sources" | "ticks" | "coverage" | "rangeError" | "sourcesFailed" | "busyId">) {
  const rows = p.accounts.filter((a) => !PLACEHOLDER(a));
  const ctx = (a: CalendarAccount) => ({ sources: p.sources[a.id], ticked: p.ticks[a.id], coverage: p.coverage, rangeError: p.rangeError, sourcesFailed: p.sourcesFailed[a.id] });
  const under = new Map(rows.map((a) => [a.id, accountState(a, ctx(a))]));
  const shown = new Map(rows.map((a) => [a.id, accountState(a, { ...ctx(a), busyId: p.busyId, loadingSources: a.status !== "accessOff" && p.sources[a.id] === undefined && !p.sourcesFailed[a.id] })]));
  return { rows: sortAccounts(rows, (a) => under.get(a.id)!.kind), under, shown };
}

export function CalendarConnectionsView(p: CalendarConnectionsViewProps) {
  const setRef = p.setRef ?? noop;
  const { rows, under, shown } = rowStates(p);
  const connected = (provider: Provider) => rows.some((a) => a.provider === provider);
  const addRows: Provider[] = [...(connected("apple") ? [] : ["apple" as const]), "microsoft", "google"];
  const connection = calendarConnection({ enabled: true, accountsLoaded: p.accountsLoaded, accounts: p.accounts, rangeError: p.rangeError });
  const rowSaysFailed = rows.some((a) => under.get(a.id)!.kind === "failed");
  const refresh = rows.length > 0 && p.accountsLoaded ? (
    <button type="button" className="cc-refresh" disabled={p.refreshing} onClick={p.on.refresh}>
      <RefreshCw size={14} aria-hidden className={p.refreshing ? "cc-spin" : undefined} />
      {p.refreshing ? "Refreshing…" : "Refresh"}
    </button>
  ) : undefined;
  return (
    <Section title="Calendar connections" action={refresh} className="cc-section">
      <p className="cc-lead"><ShieldCheck size={15} aria-hidden />Reads only the calendars you tick. Any change to a calendar waits for your review.</p>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{p.announcement}</div>
      {!p.accountsLoaded ? (
        <p className="cc-checking" role="status">Checking calendars…</p>
      ) : rows.length > 0 && (
        <ul className="cc-card" aria-label="Connected calendars">
          {rows.map((a) => <AccountRow key={a.id} {...p} setRef={setRef} account={a} state={shown.get(a.id)!} under={under.get(a.id)!} />)}
        </ul>
      )}
      <p className="cc-group-label" id="cc-add-label">Add calendars</p>
      <ul className="cc-card" aria-label="Add calendars">
        {addRows.map((provider) => (
          <AddProviderRow key={provider} provider={provider} another={provider !== "apple" && connected(provider)} connecting={p.connecting === provider}
            disabled={!p.accountsLoaded || !!p.connecting || p.refreshing} error={p.connectError[provider]} appIcon={p.appIcon} onConnect={() => p.on.connect(provider)} buttonRef={setRef("connect:" + provider)} />
        ))}
      </ul>
      <p className="cc-note">Some work or school accounts need an administrator to approve Live Interview first.</p>
      {connection.kind === "failed" && !rowSaysFailed && (
        <p className="cc-range"><CircleAlert size={16} aria-hidden /><span>{connection.reason}</span><button type="button" disabled={p.refreshing} onClick={p.on.refresh}>Try again</button></p>
      )}
      {rows.length > 0 && <SyncDetails accounts={p.accounts} coverage={p.coverage} now={p.now} />}
    </Section>
  );
}

export function ProviderTile({ provider, appIcon }: { provider: Provider; appIcon?: string | null }) {
  if (provider === "microsoft") return <span className="cc-tile brand" aria-hidden><img className="cc-ms" src={microsoftLogo} alt="" width={16} height={16} /></span>;
  if (provider === "google") return <span className="cc-tile brand" aria-hidden><span className="cc-g"><img src={google1x} srcSet={`${google1x} 1x, ${google2x} 2x, ${google3x} 3x`} alt="" /></span></span>;
  if (appIcon) return <span className="cc-tile system" aria-hidden><img src={appIcon} alt="" width={32} height={32} /></span>;
  return <span className="cc-tile fallback" aria-hidden><CalendarDays size={20} /></span>;
}

function StatusLine({ id, provider, state, now }: { id: string; provider: Provider; state: AccountState; now: number }) {
  const [first, ...rest] = stateText(state, now);
  const tone = state.kind === "ok" ? "ok" : state.kind === "updating" ? "busy" : state.kind === "nothingChosen" ? "neutral" : "problem";
  const Icon: LucideIcon = state.kind === "ok" ? CircleCheck : state.kind === "updating" ? RefreshCw : state.kind === "nothingChosen" ? CircleDashed : CircleAlert;
  return (
    <p className="cc-status" id={id}>
      {provider !== "apple" && <><span>{PROVIDER_NAME[provider]}</span><span className="sep" aria-hidden /></>}
      <span className={"s " + tone}><Icon size={13} aria-hidden className={state.kind === "updating" ? "cc-spin" : undefined} />{first}</span>
      {rest.map((text) => <Fragment key={text}><span className="sep" aria-hidden /><span>{text}</span></Fragment>)}
    </p>
  );
}

function AccountRow(p: CalendarConnectionsViewProps & { account: CalendarAccount; state: AccountState; under: AccountState; setRef: (key: string) => (el: HTMLElement | null) => void }) {
  const { account: a, state, under } = p;
  const title = accountTitle(a);
  const statusId = "cc-status-" + a.id;
  const sources = p.sources[a.id];
  const listKind = under.kind;
  const hasList = !NO_LIST.has(listKind) && (listKind === "signInAgain" ? !!sources?.length : sources !== undefined);
  const defaultOpen = isJustConnected(p.justConnected, a) || listKind === "nothingChosen" || (a.provider === "apple" && !a.selectionSaved);
  const open = hasList && (p.expanded[a.id] ?? defaultOpen);
  const action = ACTION[listKind];
  const keptForFocus = state.kind === "updating";
  const toggleLabel = (open ? "Hide" : "Show") + (a.provider === "apple" ? " calendars on this Mac" : " calendars for " + title);
  const note = p.rowNote[a.id];
  return (
    <li className="cc-row">
      <div className="cc-head-row">
        <ProviderTile provider={a.provider} appIcon={p.appIcon} />
        <div className={"cc-text" + (hasList ? " clickable" : "")} onClick={hasList ? () => p.on.toggle(a.id, !open) : undefined}>
          <h3 className="cc-title" tabIndex={-1} ref={p.setRef(titleKey(a))}>{title}</h3>
          <StatusLine id={statusId} provider={a.provider} state={state} now={p.now} />
          {note && <p className="cc-second">{note}</p>}
        </div>
        {action && (
          <button type="button" className={"cc-action" + (action === "signInAgain" ? " primary" : "")} aria-describedby={statusId}
            aria-disabled={keptForFocus || undefined} disabled={p.refreshing && !keptForFocus}
            onClick={() => { if (!keptForFocus) p.on.action(a, action); }}>
            {ACTION_LABEL[action]}{action === "openSettings" && <ExternalLink size={13} aria-hidden />}
          </button>
        )}
        {hasList && (
          <button type="button" className="cc-disclose" aria-expanded={open} aria-controls={"cc-body-" + a.id} aria-label={toggleLabel} aria-describedby={statusId} onClick={() => p.on.toggle(a.id, !open)}>
            <ChevronRight size={16} aria-hidden />
          </button>
        )}
      </div>
      {open && <CalendarList {...p} title={title} readOnly={listKind === "signInAgain"} />}
      {p.confirmId === a.id && <DisconnectConfirm account={a} title={title} busy={p.busyId === a.id} setRef={p.setRef} onCancel={() => p.on.cancelDisconnect(a.id)} onConfirm={() => p.on.disconnect(a)} />}
    </li>
  );
}

function CalendarList(p: CalendarConnectionsViewProps & { account: CalendarAccount; state: AccountState; title: string; readOnly: boolean; setRef: (key: string) => (el: HTMLElement | null) => void }) {
  const { account: a } = p;
  const sources = p.sources[a.id] ?? [];
  const ticked = p.ticks[a.id] ?? defaultTicks(a, sources);
  const disabled = p.state.kind === "updating" || p.readOnly;
  const save = p.save[a.id];
  const nothing = !sources.some((s) => s.read && ticked.includes(s.id));
  let first = true;
  return (
    <div className="cc-body" id={"cc-body-" + a.id}>
      {a.provider !== "apple" && nothing && sources.length > 0 && !p.readOnly && <p className="cc-hint">Tick the calendars you want Live Interview to read.</p>}
      {sources.length === 0 ? (
        <p className="cc-empty">No calendars found in this account.<button type="button" className="link-button" onClick={() => p.on.retry(a)}>Try again</button></p>
      ) : (
        <fieldset className="cc-list">
          <legend className="visually-hidden">{a.provider === "apple" ? "Calendars to read from this Mac" : "Calendars to read from " + p.title}</legend>
          {calendarGroups(a.provider, sources).map((g, gi) => (
            <div key={g.group ?? "#" + gi} role={g.group ? "group" : undefined} aria-label={g.group}>
              {g.group && <p className="cc-sub" aria-hidden>{g.group}</p>}
              {g.sources.map((s) => {
                const color = calendarColor(s.color);
                const ref = s.read && first ? p.setRef("first:" + a.id) : undefined;
                if (s.read && first) first = false;
                return (
                  <label key={s.id} className={"cc-cal" + (s.read ? "" : " unreadable")}>
                    <input type="checkbox" name={"calendars-" + a.id} value={s.id} ref={ref} checked={s.read && ticked.includes(s.id)} disabled={disabled || !s.read}
                      onChange={(e) => p.on.tick(a.id, s.id, e.target.checked)} />
                    {color ? <span className="cc-dot" style={{ background: color }} aria-hidden /> : <span className="cc-dot none" aria-hidden />}
                    <span className="name">{s.label}</span>
                    {!s.read ? <span className="tag">Free/busy only</span> : a.provider === "apple" && !s.edit ? <span className="tag">Read only</span> : null}
                  </label>
                );
              })}
            </div>
          ))}
        </fieldset>
      )}
      <div className="cc-foot">
        <p className={save?.kind === "saved" ? "saved" : save?.kind === "error" ? "failed" : undefined}>
          <span role="status">{save?.kind === "saving" ? "Saving…" : save?.kind === "saved" ? "Saved" : save?.kind === "error" ? <><CircleAlert size={13} aria-hidden />{save.message}</> : ""}</span>
          {!save && calendarListFooter(a)}
        </p>
        <button type="button" className="link-button quiet" ref={p.setRef("foot:" + a.id)} disabled={p.refreshing} aria-expanded={p.confirmId === a.id} onClick={() => p.on.askDisconnect(a.id)}>
          {a.provider === "apple" ? "Stop reading…" : "Disconnect…"}
        </button>
      </div>
    </div>
  );
}

function DisconnectConfirm({ account: a, title, busy, setRef, onCancel, onConfirm }: { account: CalendarAccount; title: string; busy: boolean; setRef: (key: string) => (el: HTMLElement | null) => void; onCancel(): void; onConfirm(): void }) {
  const mac = a.provider === "apple";
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
  return (
    <div className="cc-confirm" role="group" aria-labelledby={"cc-confirm-" + a.id} onKeyDown={onKeyDown}>
      <p><strong id={"cc-confirm-" + a.id}>{mac ? "Stop reading calendars on this Mac?" : "Disconnect " + title + "?"}</strong><br />
        {mac ? "Their meetings leave the Calendar. Meeting records and notes you saved stay. macOS access stays on; you can turn it off in System Settings." : "Its meetings leave the Calendar. Meeting records and notes you saved stay."}</p>
      <div>
        <button type="button" ref={setRef("cancel:" + a.id)} onClick={onCancel}>Cancel</button>
        <button type="button" className="stop" disabled={busy} onClick={onConfirm}>{mac ? "Stop reading" : "Disconnect"}</button>
      </div>
    </div>
  );
}

const ADD_SUBTITLE: Record<Provider, string> = { apple: "iCloud, Exchange and other accounts in Calendar", microsoft: "Outlook.com, or a work or school account", google: "Google Calendar" };
function AddProviderRow({ provider, another, connecting, disabled, error, appIcon, onConnect, buttonRef }: { provider: Provider; another: boolean; connecting: boolean; disabled: boolean; error?: string; appIcon?: string | null; onConnect(): void; buttonRef: (el: HTMLElement | null) => void }) {
  const subtitle = connecting ? (provider === "apple" ? "Waiting for macOS…" : "Finish signing in in your browser…") : another ? "Add another account" : ADD_SUBTITLE[provider];
  const id = "cc-add-" + provider;
  return (
    <li className="cc-row">
      <div className="cc-head-row add">
        <ProviderTile provider={provider} appIcon={appIcon} />
        <div className="cc-text">
          <h3 className="cc-title">{PROVIDER_NAME[provider]}</h3>
          <p className={"cc-status" + (connecting ? " busy" : "")} id={id}>{subtitle}</p>
          {error && <p className="cc-error" role="status"><CircleAlert size={13} aria-hidden />{error}</p>}
        </div>
        <button type="button" className="cc-action" ref={buttonRef} disabled={disabled} aria-describedby={id} onClick={onConnect}>Connect…</button>
      </div>
    </li>
  );
}

function SyncDetails({ accounts, coverage, now }: { accounts: CalendarAccount[]; coverage: CalendarCoverage[]; now: number }) {
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
  const name = (id: string) => { const a = accounts.find((x) => x.id === id); return a ? accountTitle(a) : "Removed account"; };
  return (
    <details className="cc-details">
      <summary>Sync details</summary>
      {coverage.length ? (
        <ul>
          {coverage.map((row, i) => (
            <li key={i}>
              {name(row.accountId)} · {COVERAGE_WORD[row.status]} · {day.format(row.startMs)} – {day.format(row.endMs)}
              {row.refreshedAtMs ? " · Refreshed " + updatedText(row.refreshedAtMs, now) : ""}
              {row.code && <> <small>{row.code}</small></>}
            </li>
          ))}
        </ul>
      ) : <p className="muted">Nothing loaded yet.</p>}
    </details>
  );
}

// ---- Container -----------------------------------------------------------------------------------------------------

export interface CalendarProduct {
  accounts: CalendarAccount[];
  accountsLoaded: boolean;
  coverage: CalendarCoverage[];
  rangeError?: string;
  range?: { startMs: number; endMs: number };
  refreshAccounts(): Promise<void>;
  loadRange(startMs: number, endMs: number): Promise<void>;
}
export interface CalendarApi {
  calendars(accountId: string): Promise<CalendarSource[]>;
  selectCalendars(accountId: string, ids: string[]): Promise<void>;
  connectCalendar(provider: "microsoft" | "google"): Promise<CalendarAccount>;
  disconnectCalendar(accountId: string): Promise<void>;
}

const codeOf = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "");

export function CalendarConnections({ product: p, api = publicClient }: { product: CalendarProduct; api?: CalendarApi }) {
  const [sources, setSources] = useState<Record<string, CalendarSource[] | undefined>>({});
  const [sourcesFailed, setSourcesFailed] = useState<Record<string, boolean>>({});
  const [ticks, setTicks] = useState<Record<string, string[] | undefined>>({});
  const [save, setSave] = useState<Record<string, SaveStatus | undefined>>({});
  const [busyId, setBusyId] = useState<string>();
  const [connecting, setConnecting] = useState<Provider>();
  const [connectError, setConnectError] = useState<Partial<Record<Provider, string>>>({});
  const [rowNote, setRowNote] = useState<Record<string, string | undefined>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean | undefined>>({});
  const [justConnected, setJustConnected] = useState<string[]>([]);
  const [confirmId, setConfirmId] = useState<string>();
  const [appIcon, setAppIcon] = useState<string | null>();
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const refs = useRef(new Map<string, HTMLElement>());
  const setRef = useCallback((key: string) => (el: HTMLElement | null) => { if (el) refs.current.set(key, el); else refs.current.delete(key); }, []);
  const pendingFocus = useRef<{ key: string; until: number } | undefined>(undefined);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const savedRef = useRef<Record<string, string[]>>({});
  const timers = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const savedTimers = useRef(new Map<string, number>());
  const productRef = useRef(p);
  productRef.current = p;
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => { void calendarAppIcon().then(setAppIcon); }, []);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);

  const announce = (text: string) => { setAnnouncement(""); window.setTimeout(() => setAnnouncement(text), 60); };

  /** Loads one account's calendars. Local ticks are kept while a save for that account is pending or in flight. */
  const loadSources = useCallback(async (account: CalendarAccount) => {
    try {
      const rows = await apiRef.current.calendars(account.id);
      setSources((old) => ({ ...old, [account.id]: rows }));
      setSourcesFailed((old) => ({ ...old, [account.id]: false }));
      if (!timers.current.has(account.id) && !inFlight.current.has(account.id)) {
        const initial = defaultTicks(account, rows);
        savedRef.current[account.id] = initial;
        setTicks((old) => ({ ...old, [account.id]: initial }));
      }
      return true;
    } catch {
      setSourcesFailed((old) => ({ ...old, [account.id]: true }));
      setSources((old) => ({ ...old, [account.id]: old[account.id] }));
      return false;
    }
  }, []);

  useEffect(() => {
    for (const a of p.accounts) if (a.status !== "disconnected" && a.status !== "accessOff") void loadSources(a);
  }, [p.accounts, loadSources]);

  const refreshEverything = async () => {
    const product = productRef.current;
    await product.refreshAccounts();
    if (product.range) await product.loadRange(product.range.startMs, product.range.endMs);
  };

  const flush = useCallback(async (id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    const ids = ticksRef.current[id] ?? [];
    inFlight.current.add(id);
    setSave((old) => ({ ...old, [id]: { kind: "saving" } }));
    try {
      await apiRef.current.selectCalendars(id, ids);
      savedRef.current[id] = ids;
      setSave((old) => ({ ...old, [id]: { kind: "saved" } }));
      window.clearTimeout(savedTimers.current.get(id));
      savedTimers.current.set(id, window.setTimeout(() => setSave((old) => (old[id]?.kind === "saved" ? { ...old, [id]: undefined } : old)), SAVED_SHOWN_MS));
      inFlight.current.delete(id);
      void refreshEverything().catch(() => {});
    } catch (error) {
      inFlight.current.delete(id);
      const last = savedRef.current[id] ?? [];
      setTicks((old) => ({ ...old, [id]: last }));
      setSave((old) => ({ ...old, [id]: { kind: "error", message: calendarCodeHint(codeOf(error)) ?? SAVE_FAILED } }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving Settings (unmount) sends a choice still waiting for its delay instead of dropping it.
  useEffect(() => () => {
    for (const [id, timer] of timers.current) {
      window.clearTimeout(timer);
      void apiRef.current.selectCalendars(id, ticksRef.current[id] ?? []).catch(() => {});
    }
    timers.current.clear();
    for (const t of savedTimers.current.values()) window.clearTimeout(t);
  }, []);

  const tick = (id: string, sourceId: string, checked: boolean) => {
    setTicks((old) => {
      const current = old[id] ?? [];
      const next = checked ? [...new Set([...current, sourceId])] : current.filter((x) => x !== sourceId);
      ticksRef.current = { ...old, [id]: next };
      return ticksRef.current;
    });
    setSave((old) => ({ ...old, [id]: undefined }));
    window.clearTimeout(timers.current.get(id));
    timers.current.set(id, window.setTimeout(() => void flush(id), SAVE_DELAY_MS));
  };

  // Focus moves once the target exists (a new row or list appears a render or a load later); a target that never
  // appears is dropped after a few seconds so it cannot steal focus later.
  const focusLater = (key: string) => { pendingFocus.current = { key, until: Date.now() + 5000 }; };
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (Date.now() > pending.until) { pendingFocus.current = undefined; return; }
    const el = refs.current.get(pending.key);
    if (el) { el.focus(); pendingFocus.current = undefined; }
  });

  const connect = async (provider: Provider) => {
    setConnecting(provider);
    setConnectError((old) => ({ ...old, [provider]: undefined }));
    try {
      if (provider === "apple") {
        // Granted: the Mac row appears in Card 1, expanded. Denied: it appears there as "access off". Either way
        // focus moves to its title once it is shown.
        setJustConnected((old) => [...old, "apple"]);
        focusLater("title:apple");
        const startMs = Date.now();
        try {
          await invoke("read_upcoming_meetings", { startMs, endMs: startMs + 604800000, requestPermission: true });
        } finally {
          await refreshEverything().catch(() => {});
        }
      } else {
        const account = await apiRef.current.connectCalendar(provider);
        setJustConnected((old) => [...old, account.id]);
        setExpanded((old) => ({ ...old, [account.id]: true }));
        focusLater("first:" + account.id);
        await refreshEverything().catch(() => {});
      }
    } catch (error) {
      const code = codeOf(error);
      // A macOS denial is shown by the Mac row itself ("Access is off in System Settings"), not as a connect error.
      if (!(provider === "apple" && (code === "calendarPermissionDenied" || code === "calendarPermissionRequired")))
        setConnectError((old) => ({ ...old, [provider]: calendarCodeHint(code) ?? "Couldn’t connect. Try again." }));
    } finally {
      setConnecting(undefined);
    }
  };

  const retry = async (account: CalendarAccount) => {
    setBusyId(account.id);
    setRowNote((old) => ({ ...old, [account.id]: undefined }));
    try {
      await loadSources(account);
      await refreshEverything().catch(() => {});
    } finally {
      setBusyId(undefined);
    }
  };

  const action = async (account: CalendarAccount, kind: RowAction) => {
    if (kind === "tryAgain") return retry(account);
    if (kind === "openSettings") {
      try { await invoke("open_privacy_settings", { pane: "calendars" }); }
      catch { setRowNote((old) => ({ ...old, [account.id]: OPEN_SETTINGS_HINT })); }
      return;
    }
    // Sign in again / Connect again: the same flow as Connect; the native side keeps the saved selection.
    if (account.provider === "apple") return;
    const before = rowStates({ accounts: [account], sources, ticks, coverage: p.coverage, rangeError: p.rangeError, sourcesFailed, busyId: undefined }).under.get(account.id)!.kind;
    setBusyId(account.id);
    try {
      await apiRef.current.connectCalendar(account.provider);
      await refreshEverything().catch(() => {});
      await loadSources(account);
    } catch (error) {
      const second = SECOND_LINE[before] ?? calendarCodeHint(codeOf(error));
      if (second) setRowNote((old) => ({ ...old, [account.id]: second }));
    } finally {
      setBusyId(undefined);
    }
  };

  // When access is off, coming back to the window (from System Settings) re-checks once; no "Check again" button.
  const accessOff = p.accounts.some((a) => a.status === "accessOff");
  useEffect(() => {
    if (!accessOff) return;
    const onFocus = () => void refreshEverything().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessOff]);

  const refresh = async () => {
    setRefreshing(true);
    let ok = true;
    try {
      await productRef.current.refreshAccounts().catch(() => { ok = false; });
      const results = await Promise.all(productRef.current.accounts.filter((a) => a.status !== "disconnected" && a.status !== "accessOff").map(loadSources));
      if (results.includes(false)) ok = false;
      const range = productRef.current.range;
      if (range) await productRef.current.loadRange(range.startMs, range.endMs);
    } finally {
      setRefreshing(false);
      announce(ok ? "Calendars refreshed" : "Some calendars couldn’t refresh");
    }
  };

  const disconnect = async (account: CalendarAccount) => {
    setBusyId(account.id);
    try {
      await apiRef.current.disconnectCalendar(account.id);
      setConfirmId(undefined);
      announce(accountTitle(account) + " disconnected. Saved meeting records are kept.");
      focusLater("connect:" + account.provider);
      await refreshEverything().catch(() => {});
    } catch (error) {
      setRowNote((old) => ({ ...old, [account.id]: calendarCodeHint(codeOf(error)) ?? "Couldn’t disconnect. Try again." }));
    } finally {
      setBusyId(undefined);
    }
  };

  // Lists shown by default stay open for the session once shown, so saving a choice never collapses them.
  const view: CalendarConnectionsViewProps = {
    accounts: p.accounts, accountsLoaded: p.accountsLoaded, coverage: p.coverage, rangeError: p.rangeError,
    sources, sourcesFailed, ticks, save, busyId, connecting, connectError, rowNote, refreshing, expanded, justConnected, confirmId, appIcon, announcement, now, setRef,
    on: {
      refresh: () => void refresh(),
      toggle: (id, open) => setExpanded((old) => ({ ...old, [id]: open })),
      tick,
      action: (a, kind) => void action(a, kind),
      connect: (provider) => void connect(provider),
      askDisconnect: (id) => { setConfirmId(id); focusLater("cancel:" + id); },
      cancelDisconnect: (id) => { setConfirmId(undefined); focusLater("foot:" + id); },
      disconnect: (a) => void disconnect(a),
      retry: (a) => void retry(a),
    },
  };
  const { rows } = useMemo(() => rowStates(view), [p.accounts, sources, ticks, p.coverage, p.rangeError, sourcesFailed, busyId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const opened: Record<string, boolean> = {};
    for (const a of rows) {
      if (expanded[a.id] !== undefined || sources[a.id] === undefined) continue;
      const kind = accountState(a, { sources: sources[a.id], ticked: ticks[a.id] }).kind;
      if (isJustConnected(justConnected, a) || kind === "nothingChosen" || (a.provider === "apple" && !a.selectionSaved)) opened[a.id] = true;
    }
    if (Object.keys(opened).length) setExpanded((old) => ({ ...opened, ...old }));
  }, [rows, expanded, sources, ticks, justConnected]);
  return <CalendarConnectionsView {...view} />;
}
