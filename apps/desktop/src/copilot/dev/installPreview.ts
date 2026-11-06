import {revisionEvidenceId} from "../../lib/public/transcript";
import { createMeetingState, SnapshotStore, effectiveContext, type MeetingRecord, type PersonId, type ModelJob, type SourceHit, type GuidanceCard, type ActionProposal, type PublicMeetingPlan, type PublicWorkspace, type PublicArtifact, type PublicAccountStatus, type CalendarAccount } from "@live-interview/core";

type Args = Record<string, any>;
type Callback = (value: any) => void;
type Internals = { invoke: (command: string, args?: Args, options?: unknown) => Promise<any>; transformCallback: (callback: Callback, once?: boolean) => number; unregisterCallback: (id: number) => void; runCallback: (id: number, value: unknown) => void; metadata: { currentWindow: { label: string }; currentWebview: { label: string } } };
type PreviewWindow = Window & { __TAURI_INTERNALS__?: Internals; __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, id: number) => void }; __LIVE_INTERVIEW_PREVIEW__?: Preview };
export interface Preview { currentMeetingId: () => string | undefined; invoke: Internals["invoke"]; actualNative: boolean; commands: Record<string, number>; activeListeners: () => number; registeredShortcuts: () => number; emit: (event: string, payload: unknown) => void; triggerShortcut: (shortcut: string) => void; synthesis: string; diagnostics: string[]; }

export const previewSuggestions = [
  { headline: "Clarify final approval", say: "Who makes the final call when the project team and reviewers disagree about launching?" },
  { headline: "Measure the full handoff", say: "Could we compare working time, review time and waiting time before calling the pilot faster?" },
  { headline: "Clarify evidence requirements", say: "What evidence do reviewers need, and who decides whether it is enough to move forward?" },
];
const synthesis = "The main delay appears to be the handoff between the project team and reviewers. Working time alone will not show whether the pilot is faster.\n\nFinal launch ownership remains unresolved: reviewers were first described as the approver, but the project team was later said to make the final call. Map that handoff and compare review and waiting time with working time.\n\nConfirmed follow-up: the checklist will be shared after this call. Suggested next step: clarify final approval with both groups.";
const clone = <T,>(value: T): T => structuredClone(value);
export function previewInfo(): Preview | undefined { return (window as PreviewWindow).__LIVE_INTERVIEW_PREVIEW__; }

export function installPreview() {
  const win = window as PreviewWindow;
  if (win.__LIVE_INTERVIEW_PREVIEW__) return;
  const params = new URLSearchParams(location.search);
  const scene = params.get("state") ?? "normal";
  let modelsInstalled = !scene.startsWith("models-");
  let cancelModels = false;
  let crashPending = scene.startsWith("crash-report");
  if (params.get("text") === "200") document.documentElement.style.fontSize = "32px";
  const dataset = params.get("data") ?? "demo";
  const actual = win.__TAURI_INTERNALS__;
  const actualEvents = win.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const originalInvoke = actual?.invoke;
  const originalUnregisterListener = actualEvents?.unregisterListener;
  const commands: Record<string, number> = {};
  const diagnostics: string[] = [];
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<number, { event: string; handler: number }>();
  const shortcuts = new Map<string, { handler: number; index: number }>();
  let sequence = 1000000;
  let candidate = 0;
  const people = dataset === "empty" ? [] : [
    { id: "a13456d9-5b4a-4c3d-8e2f-1a0b9c8d7e6f" as PersonId, name: dataset === "worst" ? "Aleksandra Wiśniewska-Kowalczyk" : "Alex Morgan" },
    { id: "b23456d9-5b4a-4c3d-8e2f-1a0b9c8d7e6f" as PersonId, name: dataset === "worst" ? "Aleksandra Wiśniewska-Kowalczyk" : "Alex Morgan" },
    { id: "c33456d9-5b4a-4c3d-8e2f-1a0b9c8d7e6f" as PersonId, name: dataset === "worst" ? "Jo" : "Riley Chen" },
  ];
  const at = (offset: number, hour: number, minute = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, minute, 0, 0); return d.getTime(); };
  // Local yyyy-MM-dd of a day offset from today, for the all-day fixtures.
  const dayOf = (offset: number) => { const d = new Date(at(offset, 0)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const record = (id: string, purpose: string, pending = false): MeetingRecord => ({
    id, workspaceId: "product-research", purpose, objectives: ["Understand approval handoffs", "Identify delays before launch"], attendees: [people[0], people[2]].filter(Boolean), profileId: "discovery", profileRevision: 0,
    date: new Date().toISOString(), revision: dataset === "corrected" ? 2 : 1, importedSegments: [], attributions: [], fixtureMode: true, translationStatus: pending ? "pending" : "complete", pendingSegments: pending ? 1 : 0,
    canonicalEnglishPath: "/meetings/" + id + "/english.md",
    segments: [
      { meetingId: id, segmentId: "me-intro", revision: 1, journalSequence: 1, lane: "me", startMs: 0, endMs: 3500, language: "en", text: "How does a pilot move into everyday use?", kind: "final" },
      { meetingId: id, segmentId: "remote-en", revision: 1, journalSequence: 2, lane: "remote", startMs: 5000, endMs: 8000, language: "en", text: "The review team approves every launch.", kind: "final" },
      { meetingId: id, segmentId: "remote-de", revision: 1, journalSequence: 3, lane: "remote", startMs: 10000, endMs: 14000, language: "de", text: dataset === "worst" ? "Das Projektteam entscheidet über den Start. Die Prüfer legen fest, welche Nachweise wir aufbewahren müssen. Die Verantwortungsübergabe zwischen Produktentwicklung, Qualitätssicherung und Betriebsbereitschaft muss nachvollziehbar bleiben." : "Das Projektteam entscheidet über den Start. Die Prüfer legen fest, welche Nachweise wir aufbewahren müssen.", kind: "final" },
      ...(!pending ? [{ meetingId: id, segmentId: "remote-translation", sourceSegmentId: "remote-de", revision: 1, journalSequence: 4, lane: "remote" as const, startMs: 10000, endMs: 14000, language: "en", text: "The project team decides when to launch. The reviewers define what evidence we must keep.", kind: "translation" as const }] : []),
      { meetingId: id, segmentId: "remote-followup", revision: 1, journalSequence: 5, lane: "remote", startMs: 15000, endMs: 19000, language: "en", text: "I will send the review checklist after this call.", kind: "final" },
      // data=corrected: the follow-up was corrected after the saved actions below were created.
      ...(dataset === "corrected" ? [{ meetingId: id, segmentId: "remote-followup", revision: 2, journalSequence: 6, lane: "remote" as const, startMs: 15000, endMs: 19000, language: "en", text: "I will send the review checklist once legal has signed off.", kind: "final" as const }] : []),
    ],
  });
  let records = dataset === "empty" ? [] : [record("customer-discovery", dataset === "worst" ? "Cross-functional product discovery — international release planning and evidence handoff across multiple review teams" : "Customer discovery"), record("project-discussion", "Project discussion", true), record("team-review", "Team review")];
  if (dataset === "one") records = records.slice(0, 1);
  if (dataset === "huge") records = Array.from({ length: 1000 }, (_, i) => record("record-" + i, i % 2 ? "Project discussion " + (i + 1) : "Team review " + (i + 1), i % 5 === 0));
  if (dataset === "huge") {
    records[0].segments = Array.from({ length: 1000 }, (_, i) => ({ meetingId: records[0].id, segmentId: "long-turn-" + i, revision: 1, journalSequence: i + 1, lane: i % 2 ? "remote" : "me", startMs: i * 4000, endMs: i * 4000 + 3000, language: "en", text: "The handoff needs an owner, clear evidence and a shared understanding of the next stage.", kind: "final" }));
  }
  let active = ["live", "pins", "capture-error", "clarification", "live-draft"].includes(scene) ? record("live-demo", records[0]?.purpose ?? "Customer discovery") : undefined;
  let paused = false;
  let experimentalMedium = false;
  // ?mic= and ?audio= start the permission status commands at granted, denied, notDetermined, restricted or unsupported.
  const accessParam = (name: string) => { const value = params.get(name); return value && ["granted", "denied", "notDetermined", "restricted", "unsupported"].includes(value) ? value : undefined; };
  let micAccess = accessParam("mic") ?? "notDetermined";
  let systemAudioAccess = accessParam("audio") ?? "notDetermined";
  // ?ax= starts Teams detection (Accessibility) the same way.
  let accessibilityAccess = accessParam("ax") ?? "notDetermined";
  const health = { me: { code: "captureStarted" }, remote: { code: scene === "capture-error" ? "systemAudioPermissionRequired" : "captureStarted", detail: scene === "capture-error" ? "System audio is unavailable. Microphone recording continues independently." : undefined } };
  const sources = (workspaceId: string): SourceHit[] => dataset === "empty" ? [] : [{
    sourceId: "pilot-notes", workspaceId, kind: "markdown", title: dataset === "worst" ? "Q3 launch review — revised evidence responsibilities and approval checklist v12.md" : "Pilot notes.md", text: "Measure working time, review time and waiting time separately. Approval and evidence responsibilities may differ.", locator: dataset === "worst" ? "/workspaces/international-product-launch/approval-evidence/responsibility-and-evidence-retention-checklist-v12-final-reviewed-by-project-and-review-teams.md" : "/workspaces/product-research/pilot-notes.md", revision: 1, derived: false,
  }];
  const connections = { ibm: { configured: scene !== "disconnected", reachable: scene !== "disconnected", inferenceVerified: scene !== "disconnected" }, jev: { configured: scene !== "disconnected", reachable: scene !== "disconnected", inferenceVerified: scene !== "disconnected" }, codex: { configured: true, reachable: false, inferenceVerified: false }, ibmSolUnavailableUntilMs: scene === "degraded" ? Date.now() + 3600000 : 0 };
  const proposals = new Map<string, ActionProposal>();
  const notes = new Map<string, string>();
  const workspaces = dataset === "empty" ? [] : [{ id: "product-research", root: "/workspaces/product-research" }, { id: "project-documents", root: "/workspaces/project-documents" }];
  // Fictional calendar rows. Attendees use example.test; the demo account's own address is in the list so the UI can show it being left out.
  type FixtureEvent = { id: string; calendarId: string; title: string; startMs: number; endMs: number; isAllDay?: boolean; startDay?: string; endDay?: string; recurring?: boolean; joinUrl?: string; attendees?: { name: string; email?: string }[]; organiser?: string; invitation?: boolean; calendarWritable?: boolean };
  const guests = { own: { name: "Demo User", email: "demo@example.test" }, alex: { name: "Alex Morgan", email: "alex.morgan@example.test" }, riley: { name: "Riley Chen", email: "riley.chen@example.test" }, sam: { name: "Sam Okafor", email: "sam.okafor@example.test" }, jo: { name: "Jo Park", email: "jo.park@example.test" } };
  const timed = (id: string, title: string, start: [number, number, number], end: [number, number, number], extra: Partial<FixtureEvent> = {}): FixtureEvent => ({ id, calendarId: "device-work", title, startMs: at(...start), endMs: at(...end), ...extra });
  const events: FixtureEvent[] = dataset === "empty" ? [] : [
    timed("event-discovery", "Customer discovery", [0, 14, 0], [0, 15, 0], { attendees: [guests.own, guests.alex, guests.riley, guests.sam], joinUrl: "https://meet.example.test/customer-discovery" }),
    timed("event-kickoff", "Project kickoff", [1, 10, 0], [1, 11, 0], { attendees: [guests.own, guests.alex], recurring: true }),
    timed("event-review", "Team review", [4, 11, 0], [4, 12, 0]),
    // For moving events on the day panel: a repeating one (read-only), an invitation someone else organises (movable
    // with the warning) and one from a calendar that does not allow changes.
    timed("event-weekly-sync", "Weekly team sync", [0, 10, 0], [0, 10, 30], { recurring: true, attendees: [guests.own, guests.alex, guests.sam] }),
    timed("event-partner", "Partner briefing", [0, 11, 30], [0, 12, 0], { attendees: [guests.own, guests.riley], organiser: guests.riley.email, invitation: true }),
    timed("event-all-hands", "Company all-hands", [0, 16, 30], [0, 17, 30], { calendarWritable: false }),
    // On the read-only "Family" calendar, so unticking Family in Settings → Calendars visibly removes it.
    timed("event-family", "Family dinner", [2, 19, 0], [2, 20, 30], { calendarId: "device-family" }),
  ];
  // The preview's version of an event: changes whenever its time does, like the native hash.
  const versionOf = (e: FixtureEvent) => `fixture-${e.id}-${e.startMs}-${e.endMs}`;
  const toPublic = (e: FixtureEvent) => ({ ...e, accountId: "device", provider: "apple", sourceEventId: e.id, readOnly: e.calendarWritable === false, calendarWritable: e.calendarWritable !== false, invitation: !!e.invitation, ...(e.organiser ? { organiserIsCurrentUser: !e.invitation } : {}), version: versionOf(e) });
  if (scene === "overlap") { events[1].startMs = events[0].startMs; events[1].endMs = events[0].endMs; }
  // Calendar scenes (#123): ?state=calendar-dense | calendar-allday | calendar-loading | calendar-empty | calendar-partial.
  if (dataset !== "empty" && scene === "calendar-dense") events.splice(0, events.length,
    // Cluster 1 (09:00-10:30): four at once, so a three-column Week shows "+N". The first two have plans.
    timed("event-discovery", "Customer discovery", [0, 9, 0], [0, 10, 0], { attendees: [guests.own, guests.alex, guests.riley], joinUrl: "https://meet.example.test/customer-discovery" }),
    timed("event-standup", "Team stand-up", [0, 9, 0], [0, 9, 30], { recurring: true, attendees: [guests.own, guests.alex, guests.riley, guests.sam, guests.jo] }),
    timed("event-sync", "Design sync", [0, 9, 15], [0, 10, 30], { attendees: [guests.own, guests.sam] }),
    timed("event-triage", "Support triage", [0, 9, 30], [0, 10, 15]),
    // Single meetings with gaps between them.
    timed("event-planning", "Sprint planning", [0, 11, 30], [0, 12, 30], { recurring: true, attendees: [guests.own, guests.alex, guests.jo] }),
    timed("event-lunch", "Lunch with Riley", [0, 12, 45], [0, 13, 15], { attendees: [guests.own, guests.riley] }),
    // Cluster 2 (13:30-14:30): two overlapping.
    timed("event-vendor", "Vendor call", [0, 13, 30], [0, 14, 30], { joinUrl: "https://meet.example.test/vendor" }),
    timed("event-budget", "Budget check", [0, 14, 0], [0, 14, 30], { attendees: [guests.own, guests.sam] }),
    // Cluster 3 (15:00-15:25): three ten-minute meetings that only collide because blocks have a minimum height.
    timed("event-quick-a", "Quick question A", [0, 15, 0], [0, 15, 10]),
    timed("event-quick-b", "Quick question B", [0, 15, 15], [0, 15, 25]),
    timed("event-quick-c", "Quick question C", [0, 15, 20], [0, 15, 30]),
    // Back-to-back, then late in the day.
    timed("event-review-1", "Review: onboarding", [0, 16, 0], [0, 17, 0], { attendees: [guests.own, guests.alex] }),
    timed("event-review-2", "Review: billing", [0, 17, 0], [0, 17, 45], { attendees: [guests.own, guests.jo] }),
    timed("event-retro", "Weekly retro", [0, 18, 30], [0, 19, 30], { recurring: true, attendees: [guests.own, guests.alex, guests.riley, guests.sam] }),
  );
  if (dataset !== "empty" && scene === "calendar-allday") events.push(
    { id: "event-holiday", calendarId: "device-work", title: "Public holiday", startMs: at(0, 0), endMs: at(1, 0), isAllDay: true, startDay: dayOf(0), endDay: dayOf(1) },
    // Spans three days and runs past the end of most weeks, so a bar can continue across the week boundary.
    { id: "event-offsite", calendarId: "device-work", title: "Team offsite", startMs: at(-1, 0), endMs: at(5, 0), isAllDay: true, startDay: dayOf(-1), endDay: dayOf(5), attendees: [guests.own, guests.alex, guests.riley] },
    { id: "event-travel", calendarId: "device-work", title: "Travel: Zurich to Berlin", startMs: at(1, 0), endMs: at(3, 0), isAllDay: true, startDay: dayOf(1), endDay: dayOf(3) },
    { id: "event-birthday", calendarId: "device-work", title: "Jo's birthday", startMs: at(2, 0), endMs: at(3, 0), isAllDay: true, startDay: dayOf(2), endDay: dayOf(3), recurring: true },
    // Overnight (22:00 to 02:00) and a weekly recurring meeting.
    timed("event-oncall", "On-call handover", [0, 22, 0], [1, 2, 0], { attendees: [guests.own, guests.sam] }),
    timed("event-weekly", "Weekly 1:1", [2, 9, 0], [2, 9, 30], { recurring: true, attendees: [guests.own, guests.alex] }),
    // Two meetings that overlap.
    timed("event-overlap-a", "Workshop", [0, 10, 0], [0, 12, 0], { attendees: [guests.own, guests.riley, guests.sam, guests.jo] }),
    timed("event-overlap-b", "Interview debrief", [0, 11, 0], [0, 11, 45], { joinUrl: "https://meet.example.test/debrief" }),
  );
  if (scene === "calendar-empty") events.splice(0, events.length);
  if (dataset === "huge") events.splice(0, events.length, ...Array.from({length:1000}, (_, i) => ({id:"event-"+i,calendarId:"device-work",title:i % 2 ? "Project handoff " + i : "Review check-in " + i,startMs:at(i % 7, 8 + i % 14),endMs:at(i % 7, 9 + i % 14)})));
  // These product fixtures are reachable only through main.tsx's DEV + preview=full gate.
  let publicWorkspaces:PublicWorkspace[]=workspaces.map(w=>({...w,name:w.root.split("/").at(-1)!,roots:[w.root],sharedLibraryIds:[],appendTargets:[],revision:1}));
  const publicPlans=new Map<string,PublicMeetingPlan>(events.slice(0,2).map((event,i)=>{const p:PublicMeetingPlan={id:"00000000-0000-4000-8000-00000000000"+i,eventId:event.id,calendarAccountId:"device",calendarId:event.calendarId,title:event.title,startMs:event.startMs,endMs:event.endMs,workspaceId:"product-research",sourceSelection:"workspace",sourceIds:[],sharedLibraryIds:[],profileId:"discovery",attendees:people.slice(0,1),objectives:["Understand approval handoffs"],publicResearchTopics:[],briefDraft:"",draftEvidence:[],automaticPreparation:false,revision:1,updatedAtMs:Date.now(),status:"draft"};return [p.id,p];}));
  const publicArtifacts=new Map<string,PublicArtifact>();
  if (dataset === "corrected") publicArtifacts.set(JSON.stringify(["customer-discovery", "actions", 1]), { meetingId: "customer-discovery", kind: "actions", recordRevision: 1, status: "ready", humanEdited: false, updatedAtMs: 1, evidence: ["segment:remote-followup@1", "segment:remote-en"], text: JSON.stringify([{ task: "Share the review checklist", inferred: false, owner: null, due: null, evidence: ["segment:remote-followup@1"] }, { task: "Clarify who approves each launch", inferred: true, owner: null, due: null, evidence: ["segment:remote-en"] }, { task: "Compare working and waiting time", inferred: true, owner: null, due: null, evidence: ["segment:remote-en@1"] }]) });
  let account:PublicAccountStatus={configured:scene!=="service-unavailable",signedIn:scene!=="signed-out"&&scene!=="service-unavailable",user:{id:"fictional-user",email:"demo@example.test",name:"Fictional demo account"},plan:scene==="premium"?"premium":scene==="service-unavailable"?"none":"standard",subscriptionStatus:scene==="service-unavailable"?"unavailable":"active",canUseAI:!["service-unavailable","signed-out","disconnected"].includes(scene),canAutoPrepare:scene==="premium",billingAvailable:scene!=="service-unavailable",usage:{requests:8,inputTokens:12000,outputTokens:2000},limits:{requests:200,inputTokens:500000,outputTokens:100000}};
  // Calendar connection scenes: calendar-none (no account), calendar-access-off (macOS refuses access),
  // calendar-none-chosen (connected, the person saved an empty choice), calendar-failed (the whole load is refused),
  // calendar-mixed (Mac fine, Microsoft needs sign-in, Google has nothing chosen), calendar-updating (calendar lists
  // answer after 2.5 s), calendar-save-fails (saving a calendar choice is refused).
  // Calendars on this Mac: five fictional calendars in three macOS accounts; "device-work" stays the id of "Work".
  type FixtureSource = { id: string; name: string; group?: string; color?: string; read: boolean; edit: boolean };
  const macSources: FixtureSource[] = [
    { id: "device-home", name: "Home", group: "iCloud", color: "#1badf8", read: true, edit: true },
    { id: "device-work", name: "Work", group: "iCloud", color: "#63da38", read: true, edit: true },
    { id: "device-family", name: "Family", group: "iCloud", color: "#cc73e1", read: true, edit: false },
    { id: "device-exchange", name: "Calendar", group: "Exchange", color: "#ff9500", read: true, edit: true },
    { id: "device-holidays", name: "Holidays in Germany", group: "Subscribed", color: "#ff2968", read: true, edit: false },
  ];
  const fixtureSources: Record<string, FixtureSource[]> = {
    device: macSources,
    "microsoft-contoso": [{ id: "ms-calendar", name: "Calendar", color: "#3f88e3", read: true, edit: false }, { id: "ms-birthdays", name: "Birthdays", read: true, edit: false }],
    "google-example": [{ id: "g-primary", name: "Alex Example", color: "#039be5", read: true, edit: false }, { id: "g-rota", name: "Team rota", color: "#33b679", read: true, edit: false }, { id: "g-alex", name: "Alex’s calendar", color: "#a79b8e", read: false, edit: false }],
  };
  const connectedSources: FixtureSource[] = [{ id: "fictional-primary", name: "Primary calendar", color: "#039be5", read: true, edit: false }, { id: "fictional-team", name: "Team calendar", color: "#33b679", read: true, edit: false }];
  const macAccount: CalendarAccount = {id:"device",provider:"apple",name:"Fictional work calendar",email:"demo@example.test",status:"connected",selectedCalendarIds:scene==="calendar-none-chosen"?[]:macSources.map(s=>s.id),selectionSaved:scene==="calendar-none-chosen"||scene==="calendar-mixed",lastSyncMs:Date.now()-2*60000};
  let calendarAccounts:CalendarAccount[]=dataset==="empty"||scene==="calendar-none"?[]
    :scene==="calendar-access-off"?[{id:"apple-local",provider:"apple",name:"macOS Calendar",status:"accessOff",code:"calendarPermissionDenied",selectedCalendarIds:[]}]
    :scene==="calendar-mixed"?[macAccount,
      {id:"microsoft-contoso",provider:"microsoft",name:"Alex Example",email:"alex@contoso.example",status:"connected",code:"calendarReauthenticationRequired",selectedCalendarIds:["ms-calendar"],selectionSaved:true,lastSyncMs:Date.now()-3*3600000},
      {id:"google-example",provider:"google",name:"Alex Example",email:"alex.example@example.com",status:"connected",selectedCalendarIds:[],selectionSaved:false,lastSyncMs:Date.now()-60000}]
    :[macAccount];
  const deliver = (id: number, value: unknown) => actual ? actual.runCallback(id, value) : callbacks.get(id)?.(value);
  let audioCheck: { id: number; lane: string; timer: number } | undefined;
  let audioCheckSequence = 0;
  const endAudioCheck = () => { if (!audioCheck) return; window.clearInterval(audioCheck.timer); emitLocal("audio-check-level", { check: audioCheck.id, lane: audioCheck.lane, level: 0, ended: true }); audioCheck = undefined; };
  const emitLocal = (event: string, payload: unknown) => { for (const [id, listener] of listeners) if (listener.event === event) deliver(listener.handler, { event, id, payload }); };
  const channel = new BroadcastChannel("live-interview-widget-preview");
  channel.onmessage = (event) => { if (!actual && event.data?.event?.startsWith("live-widget-")) emitLocal(event.data.event, event.data.payload); };
  const proposal = (operation: ActionProposal["operation"], targetPath: string, content: string) => {
    const value: ActionProposal = { id: crypto.randomUUID(), targetId: targetPath, targetPath, targetVersion: "fixture-version-1", operation, before: "Pilot follow-up notes.", after: operation === "append" ? "Pilot follow-up notes." + content : content, evidence: [], inferred: true, status: "proposed" };
    proposals.set(value.id, value); return clone(value);
  };
  const invoke = async (command: string, rawArgs: Args = {}, options?: unknown): Promise<any> => {
    commands[command] = (commands[command] ?? 0) + 1;
    const args = JSON.parse(JSON.stringify(rawArgs)) as Args;
    // Native preview only passes presentation/window IPC. All business commands
    // remain simulated, including dialogs, providers, recording and writes.
    if (actual && (command === "forward_widget_action" || command.startsWith("plugin:window|") || command.startsWith("plugin:webview|") || (command.startsWith("plugin:event|") && (String(args.event).startsWith("live-widget-") || String(args.event).startsWith("tauri://"))))) return originalInvoke!(command, rawArgs, options);
    if (command === "plugin:event|listen") { const id = sequence++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    if (command === "plugin:event|emit" || command === "plugin:event|emit_to") { emitLocal(args.event, args.payload); if (String(args.event).startsWith("live-widget-")) channel.postMessage({ event: args.event, payload: args.payload }); return; }
    if (command === "plugin:global-shortcut|register") { for (const key of args.shortcuts) shortcuts.set(key, { handler: Number(String(args.handler).split(":").at(-1)), index: 0 }); return; }
    if (command === "plugin:global-shortcut|unregister") { for (const key of args.shortcuts) shortcuts.delete(key); return; }
    if (command === "plugin:global-shortcut|is_registered") return shortcuts.has(args.shortcut);
    // The Settings window shows the app version at the foot of its section list.
    if (command === "plugin:app|version") return "0.1.0";
    if (command === "public_check_update") return {configured:false,available:false};
    if (command === "public_install_update") throw Error("fictionalUpdateNotAvailable");
    // Fictional crash report for ?state=crash-report (sending available) and ?state=crash-report-nosend.
    if (command === "public_pending_crash_report") {
      const sample = { format: 1, id: "11111111-2222-3333-4444-555555555555", kind: "panic", appVersion: "0.1.0", os: "macos 15.4 aarch64", day: "2026-10-15", location: "src-tauri/src/commands.rs:42:9", thread: "tokio-runtime-worker", frames: ["live_interview_lib::commands::start_local_meeting (src-tauri/src/commands.rs:42)", "tokio::runtime::task::core::Core<T,S>::poll (crates/tokio-1.40.0/src/runtime/task/core.rs:331)"] };
      return crashPending ? { report: sample, preview: JSON.stringify(sample, null, 2), sendAvailable: scene === "crash-report" } : { report: null, preview: "", sendAvailable: false };
    }
    if (command === "public_resolve_crash_report") { if (!args.send) { crashPending = false; return { discarded: true }; } crashPending = false; return { sent: true }; }
    if (command === "public_list_workspaces") return clone(publicWorkspaces);
    if (command === "public_save_workspace") { const workspace=args.workspace as PublicWorkspace;const previous=publicWorkspaces.find(w=>w.id===workspace.id);if((previous?.revision??0)!==workspace.revision)throw Error("staleRevision");const saved={...workspace,revision:workspace.revision+1};publicWorkspaces=[saved,...publicWorkspaces.filter(w=>w.id!==saved.id)];emitLocal("workspace-context-changed",{workspaceId:saved.id});return clone(saved); }
    if (command === "public_workspace_sources") return clone(sources(args.workspaceId).map(hit=>({sourceId:hit.sourceId,workspaceId:hit.workspaceId,title:hit.title,path:hit.locator,revision:hit.revision,status:"indexed"})));
    if (command === "public_list_meeting_plans") return clone([...publicPlans.values()]);
    if (command === "public_get_meeting_plan") return clone(publicPlans.get(args.id)??null);
    if (command === "public_save_meeting_plan") {const plan=args.plan as PublicMeetingPlan;const previous=publicPlans.get(plan.id);if((previous?.revision??0)!==plan.revision)throw Error("staleRevision");const saved={...plan,revision:plan.revision+1,updatedAtMs:Date.now()};publicPlans.set(plan.id,saved);return clone(saved);}
    if (command === "public_get_artifact") return clone(publicArtifacts.get(JSON.stringify([args.meetingId,args.kind,args.recordRevision]))??null);
    if (command === "public_get_latest_artifact") return clone([...publicArtifacts.values()].filter(x=>x.meetingId===args.meetingId&&x.kind===args.kind&&x.recordRevision<=(args.recordRevision as number)).sort((x,y)=>y.recordRevision-x.recordRevision)[0]??null);
    if (command === "public_save_artifact") {const artifact=args.artifact as PublicArtifact;const key=JSON.stringify([artifact.meetingId,artifact.kind,artifact.recordRevision]);const previous=publicArtifacts.get(key);if(previous?.humanEdited&&!artifact.humanEdited)throw Error("humanEdited");if((previous?.updatedAtMs??0)!==artifact.updatedAtMs)throw Error("staleArtifact");const saved={...artifact,updatedAtMs:Math.max(Date.now(),(previous?.updatedAtMs??0)+1)};publicArtifacts.set(key,saved);return clone(saved);}
    if (command === "public_apply_granted_notes") return {applied:0,skipped:0};
    if (command === "public_account_status") return clone(account);
    if (command === "public_sign_in") {if(!account.configured)throw Error("serviceUnavailable");account={...account,signedIn:true,canUseAI:true};return clone(account);}
    if (command === "public_sign_out") {account={...account,signedIn:false,canUseAI:false,canAutoPrepare:false};return;}
    if (command === "public_sign_out_all") {if(!account.signedIn)throw Error("unauthenticated");account={...account,signedIn:false,canUseAI:false,canAutoPrepare:false};return {signedOutEverywhere:true};}
    if (command === "public_export_account") {if(!account.signedIn)throw Error("unauthenticated");return {path:"/Users/fictional/Downloads/live-interview-account-export-2026-10-14.json",bytes:2048};}
    if (command === "public_delete_account") {if(!account.signedIn)throw Error("unauthenticated");account={...account,signedIn:false,plan:"none",subscriptionStatus:"signedOut",canUseAI:false,canAutoPrepare:false,user:undefined};return {deleted:true,stripeCustomerDeleted:true};}
    if (command === "public_checkout" || command === "public_billing_portal") {if(!account.configured||!account.signedIn||!account.billingAvailable)throw Error("billingUnavailable");return {url:"https://billing.example.test/fictional"};}
    if (command === "public_calendar_accounts") return clone(calendarAccounts);
    if (command === "public_connect_calendar") {const id=args.provider+"-fictional-"+(calendarAccounts.length+1);const connection:CalendarAccount={id,provider:args.provider,name:"Fictional "+args.provider+" account",email:"fictional."+args.provider+"@example.test",status:"connected",selectedCalendarIds:[],selectionSaved:false,lastSyncMs:Date.now()};fixtureSources[id]=connectedSources;calendarAccounts=[...calendarAccounts.filter(a=>!(a.provider===args.provider&&a.email===connection.email)),connection];return clone(connection);}
    if (command === "public_calendar_sources") {
      if (scene === "calendar-updating") await new Promise((resolve) => setTimeout(resolve, 2500));
      const account = calendarAccounts.find(a=>a.id===args.accountId);
      if (!account || account.status === "accessOff") return [];
      return clone((fixtureSources[args.accountId] ?? connectedSources).map(s=>({...s,accountId:args.accountId,selected:s.read&&account.selectedCalendarIds.includes(s.id)})));
    }
    if (command === "public_select_calendars") {if(scene==="calendar-save-fails")throw "calendarUnavailable";calendarAccounts=calendarAccounts.map(a=>a.id===args.accountId?{...a,selectedCalendarIds:args.calendarIds,selectionSaved:true}:a);return;}
    if (command === "public_disconnect_calendar") {calendarAccounts=calendarAccounts.filter(a=>a.id!==args.accountId);return;}
    // The Mac's Calendar app icon is read from macOS at runtime; the preview has none, so the outline fallback shows.
    if (command === "app_icon") return null;
    if (command === "public_calendar_events") {
      // calendar-loading: the answer arrives late, so the loading state can be looked at.
      if (scene === "calendar-loading") await new Promise((resolve) => setTimeout(resolve, 2500));
      if (scene === "calendar-failed") throw "calendarUnavailable";
      // calendar-partial: the first half of the requested range is ready, the rest is partial. The events spread carries isAllDay, startDay, endDay, recurring, attendees and joinUrl through.
      const half = args.startMs + Math.floor((args.endMs - args.startMs) / 2);
      const coverageFor = (accountId: string, calendarId: string) => scene === "calendar-partial"
        ? [{ accountId, calendarId, startMs: args.startMs, endMs: half, status: "ready", refreshedAtMs: Date.now() }, { accountId, calendarId, startMs: half, endMs: args.endMs, status: "partial", refreshedAtMs: Date.now(), code: "fixturePaginationIncomplete" }]
        : [{ accountId, calendarId, startMs: args.startMs, endMs: args.endMs, status: scene === "disconnected" ? "error" : "ready", refreshedAtMs: Date.now() }];
      return {events:clone(events.filter(e=>e.startMs<args.endMs&&e.endMs>args.startMs&&(calendarAccounts.find(a=>a.id==="device")?.selectedCalendarIds??[]).includes(e.calendarId)).map(toPublic)),coverage:calendarAccounts.filter(a=>a.selectedCalendarIds.length).flatMap(a=>coverageFor(a.id,a.selectedCalendarIds[0]))};
    }
    if (command === "list_input_devices") return ["System microphone", "USB microphone"];
    if (command === "set_experimental_medium_translation") experimentalMedium = !!args.enabled;
    // Fictional model download for the first-run scenes: "models-download" streams progress, "models-disk-full" and "models-offline" fail.
    if (command === "cancel_local_models_setup") { cancelModels = true; return true; }
    if (command === "setup_local_models" && scene.startsWith("models-")) {
      cancelModels = false;
      const total = 3_195_000_000;
      const step = (completedBytes: number, stage = "downloading") => emitLocal("model-setup-progress", { kind: "setupProgress", stage, asset: "recognition", completedBytes, totalBytes: total, resumedBytes: 0, attempt: 1 });
      if (scene === "models-disk-full") { emitLocal("model-setup-progress", { kind: "setupFailed", code: "diskFull", details: { neededBytes: 4_300_000_000, availableBytes: 900_000_000 } }); throw "diskFull"; }
      step(0, "checking");
      for (let done = 0; done <= total * 0.6; done += total * 0.05) { await new Promise((resolve) => setTimeout(resolve, scene === "models-slow" ? 1500 : 400)); if (cancelModels) throw "cancelled"; step(done); }
      if (scene === "models-offline") { emitLocal("model-setup-progress", { kind: "setupFailed", code: "network", details: null }); throw "network"; }
      modelsInstalled = true;
    }
    if (command === "speech_readiness" || command === "setup_local_models" || command === "set_experimental_medium_translation") return { recognitionReady: modelsInstalled, translationReady: scene !== "translation-pending", translation: { target: "en", appleAvailable: true, installedSources: scene !== "translation-pending" ? ["de"] : [], experimentalMedium, mediumAssetsReady: false }, code: "ready" };
    if (command === "microphone_access_status") return micAccess;
    if (command === "system_audio_access_status") return systemAudioAccess;
    if (command === "request_microphone_access") { micAccess = "granted"; return micAccess; }
    if (command === "check_system_audio_access") { systemAudioAccess = "granted"; return systemAudioAccess; }
    if (command === "accessibility_access_status") return accessibilityAccess;
    // As on macOS, the request answers "not yet" at once; the grant arrives later, as if switched on in System Settings.
    if (command === "request_accessibility_access") { const before = accessibilityAccess; window.setTimeout(() => { accessibilityAccess = "granted"; }, 4000); return before; }
    // Setup audio check: fictional levels only. "me" alternates speech and pauses; "remote" stands in for the chime.
    // Rejections are plain strings, as the native command returns them.
    if (command === "start_audio_check") { endAudioCheck(); if (active) throw "meetingActive"; const lane = args.lane as "me" | "remote"; if ((lane === "me" ? micAccess : systemAudioAccess) !== "granted") throw "notGranted"; const id = ++audioCheckSequence; let tick = 0; const timer = window.setInterval(() => { tick++; const level = lane === "me" ? (tick % 24 < 14 ? 0.4 + Math.random() * 0.35 : Math.random() * 0.08) : 0.45 + 0.25 * Math.abs(Math.sin(tick / 3)); emitLocal("audio-check-level", { check: id, lane, level }); if (tick >= 330) endAudioCheck(); }, 60); audioCheck = { id, lane, timer }; return id; }
    if (command === "stop_audio_check") { endAudioCheck(); return null; }
    if (command === "open_privacy_settings") return;
    // ?state=warmup-first-load, or ?warmup=first beside another scene (for example state=live), keeps the one-time model load pending so its status line stays visible.
    const firstLoadWarmup = scene === "warmup-first-load" || params.get("warmup") === "first";
    if (command === "warm_local_speech") return firstLoadWarmup ? new Promise(() => {}) : {};
    if (command === "restart_local_speech") return null;
    if (command === "speech_warmup_state") return firstLoadWarmup ? { firstLoad: true, status: "Preparing local speech (one-time, a few minutes) · recording continues" } : { firstLoad: false, status: "Preparing local speech · recording continues" };
    if (command === "list_meeting_records") return clone(records);
    if (command === "load_meeting_record") return clone(records.find((r) => r.id === args.id) ?? (active?.id === args.id ? active : record(args.id, "Customer discovery")));
    if (command === "instance_state") return { primary: true };
    if (command === "current_local_session") return active ? { ...clone(active), paused, captureHealth: clone(health) } : null;
    if (command === "start_local_meeting") { const started: MeetingRecord = { ...record(args.options.id, args.options.purpose), ...args.options }; active = started; paused = false; setTimeout(() => { if (active?.id !== started.id) return; emitLocal("recording-health", { meetingId: started.id, lane: "me", code: "captureStarted" }); emitLocal("recording-health", { meetingId: started.id, lane: "remote", code: health.remote.code }); emitLocal("recording-frames", { meetingId: started.id, lane: "me", frames: 120 }); }, 50); let tick = 120; const frames = window.setInterval(() => { if (active?.id !== started.id) { window.clearInterval(frames); return; } if (paused) return; tick += 50; emitLocal("recording-frames", { meetingId: started.id, lane: "me", frames: tick }); if (health.remote.code === "captureStarted") emitLocal("recording-frames", { meetingId: started.id, lane: "remote", frames: tick }); }, 500); return started.id; }
    if (command === "stop_local_meeting") { if (!active || active.id !== args.id) throw new Error("wrongMeeting"); const saved = clone(active); records = [saved, ...records.filter((r) => r.id !== saved.id)]; active = undefined; return saved; }
    if (command === "set_local_meeting_paused") { if (active?.id !== args.id) throw new Error("wrongMeeting"); paused = args.paused; return; }
    if (command === "create_synthetic_record") { const saved = record(crypto.randomUUID(), "Synthetic meeting replay"); records.unshift(saved); return clone(saved); }
    if (command === "recover_local_record") { records = records.map((r) => r.id === args.id ? { ...r, translationStatus: "complete", pendingSegments: 0 } : r); emitLocal("recording-finalized", { meetingId: args.id }); return {}; }
    if (command === "save_internal_note") { notes.set(args.meetingId + ":" + (args.kind ?? "derived"), args.text); return { saved: true }; }
    if (command === "read_internal_note") {
      if (args.kind === "pins" && active) {
        const state = createMeetingState(active); state.segments = active.segments; state.observationSequence = 5;
        const store = new SnapshotStore(); store.initialise(state); const basis = store.read(state);
        const pin: GuidanceCard = { ...previewSuggestions[2], id: "saved-evidence", intent: "digDeeper", why: "Clarify evidence requirements before the next stage.", evidence: ["segment:remote-de"], createdAtMs: Date.now(), basis, pinned: true, stale: false, usefulness: .95, relevance: .95, novelty: .95, answerQuality: .95, uncertain: true };
        return { text: JSON.stringify([pin]) };
      }
      return { text: notes.get(args.meetingId + ":" + (args.kind ?? "derived")) ?? "" };
    }
    if (command === "list_workspaces") return clone(workspaces);
    if (command === "connect_workspace") { workspaces.push({ id: args.id, root: args.root }); return { sourceCount: 8, unsupported: [] }; }
    if (command === "import_chatgpt_export") return { imported: 18, skipped: 2 };
    if (command === "list_people") return clone(people);
    if (command === "retrieve_context" || command === "list_sharing_sources") return clone((args.workspaceId==="default"?[]:sources(args.workspaceId ?? "product-research")).filter(source=>!Array.isArray(args.sourceIds)||args.sourceIds.includes(source.sourceId)));
    if (command === "refresh_workspace") return { changedSourceIds: [] };
    if (command === "search_public_text") return [];
    if (command === "set_meeting_profile") return {};
    if (command === "reasoning_status") return clone(connections);
    if (command === "list_ibm_profiles") return [{ account: "fixture-work", label: "Stored work connection" }, { account: "fixture-research", label: "Stored research connection" }];
    if (command === "connect_reasoning") { if (args.provider !== "jev" && args.provider !== "ibm") throw new Error("unknownProvider"); connections[args.provider as "jev" | "ibm"].configured = true; return {}; }
    if (command === "test_reasoning_connection") return { route: args.route, outcome: "complete", elapsedMs: 80, output: { say: "Synthetic connection verified.", why: "Fictional text only. Recording was not started." } };
    if (command === "detect_teams_call" && scene === "call-offer") return { verified: true, title: "Customer discovery", observedAt: Date.now(), code: "verified", diagnostics: {processCount:2,incomplete:false,activation:[{windowsReturned:3,uniqueWindows:2}],windows:[]} };
    if (command === "detect_teams_call" && scene === "call-choices") return { verified: false, title:"", candidates: [{title:"Customer discovery",source:"teams-accessibility-controls"},{title:"Project kickoff",source:"teams-accessibility-controls"}], observedAt: Date.now(), code: "ambiguousCalls" };
    if (command === "detect_teams_call") return { code: "noVerifiedCall", verified: false, diagnostics: { processCount: 2, incomplete: false, activation: [{windowsReturned:3,uniqueWindows:2}], windows: [{hasTitle:true,meetingShapedTitle:false,matched:{leave:false,microphone:false,camera:false},counts:{nodesVisited:120,maxDepthSeen:7,clipped:false,errors:0,foreignWindowButtons:1,unknownWindowButtons:0}}, {hasTitle:true,meetingShapedTitle:true,matched:{leave:false,microphone:true,camera:false},counts:{nodesVisited:84,maxDepthSeen:5,clipped:false,errors:0,foreignWindowButtons:0,unknownWindowButtons:0}}] } };
    if (command === "cancel_reasoning_job" || command === "reasoning_cancel") return {};
    if (command === "jev_decide") {
      if (args.questions?.query) return { answers: { query: { choice: "0" }, needed: { noul: 0 } } };
      return { answers: { intent: { choice: "digDeeper" }, intervene: { noul: .98 }, research: { noul: 0 } } };
    }
    if (command === "reasoning_run") {
      const job = args.job as ModelJob; const properties = (job.outputSchema as { properties?: Args }).properties ?? {};
      // ?state=live-draft streams the start of a requested answer to the provisional draft (#70) and then never finishes,
      // so the draft stays on screen. Fragments are raw JSON text, as the managed service sends them.
      if (scene === "live-draft" && job.trigger === "requested" && typeof args.onDraft === "string") {
        const channelId = Number(args.onDraft.split(":").at(-1));
        ['{"headline":"Map the handoff","say":"Could we separate working, ', "review and waiting time so we can see ", "where the handoff slows"].forEach((delta, index) => deliver(channelId, { message: { delta }, index }));
        await new Promise(() => {});
      }
      diagnostics.push("reasoning_run " + job.intent + " " + job.trigger + " output shape: " + Object.keys(properties).join(","));
      let output: unknown;
      if (properties.items) {const finals=effectiveContext(job.basis).conversation.filter(segment=>segment.kind==="final");const source=finals.find(segment=>segment.language!=="en")??finals[0];const last=finals.at(-1)??source;const cite=(segment?:typeof source)=>segment?[revisionEvidenceId(segment)]:[];output={items:[{kind:"discussed",text:"The main delay appears to be the handoff between the project team and reviewers.",evidence:cite(source)},{kind:"openQuestion",text:"Final launch ownership remains unresolved: reviewers were first described as the approver, but the project team was later said to make the final call.",evidence:cite(source)},{kind:"commitment",text:"The checklist will be shared after this call.",evidence:cite(last)},{kind:"recommendation",text:"Clarify final approval with both groups and compare review and waiting time with working time.",evidence:[]}]};}
      else if (properties.text) {const context=effectiveContext(job.basis);output={text:job.usageFeature==="synthesis"?synthesis:"Objective: map the approval handoff.\n\nAsk how working, review, and waiting time are measured separately. Explore who owns final launch decisions and what evidence reviewers need.\n\nUncertainty: the source describes approval roles but does not establish the final decision owner. Confirm that in the meeting.",evidence:context.conversation.length?[job.usageFeature==="synthesis"?revisionEvidenceId(context.conversation.find(segment=>segment.kind==="final"&&segment.language!=="en")??context.conversation[0]):"segment:"+context.conversation[0].segmentId]:context.sources.slice(0,1).map(source=>source.sourceId)};}
      else if (properties.steps) output = { steps: [{ task: "Clarify final launch ownership", inferred: true, owner: null, due: null, evidence: ["segment:remote-de", "segment:remote-en"] }, { task: "Compare working, review and waiting time", inferred: true, owner: null, due: null, evidence: ["segment:remote-en"] }, { task: "Share the review checklist", inferred: false, owner: null, due: null, evidence: ["segment:remote-followup"] }] };
      else {
        const index = candidate++ % 3; const base = previewSuggestions[index];
        const context = effectiveContext(job.basis);
        const evidence = context.conversation.length ? ["segment:" + (context.conversation.find((segment) => segment.segmentId === "remote-de" || segment.segmentId === "remote-translation") ?? context.conversation.at(-1)!).segmentId] : context.sources.slice(0, 1).map((source) => source.sourceId);
        const card = { ...base, why: "The accounts may describe different decisions. Ask for one concrete handoff example.", evidence, usefulness: .99, relevance: .99, novelty: .99, answerQuality: .99, uncertain: true };
        if (properties.candidates) output = { candidates: previewSuggestions.map((s) => ({ ...card, ...s })) };
        else output = job.intent === "respond" ? { ...card, headline: "Map the handoff", say: "Could we separate working, review and waiting time so we can see where the handoff slows down?" } : card;
      }
      const result = { jobId: job.id, provider: "managedFast", model: "fictional-preview", basis: job.basis, outcome: "complete" as const, output };
      return result;
    }
    // Connect… on the Mac row in Settings asks macOS for access; the preview grants it.
    if (command === "read_upcoming_meetings" && args?.requestPermission && !calendarAccounts.some(a=>a.provider==="apple")) calendarAccounts=[...calendarAccounts,{...macAccount,selectedCalendarIds:macSources.map(s=>s.id),selectionSaved:false}];
    if (command === "read_upcoming_meetings") return { capabilities: [{ id: "device-work", name: "Work", account: "Device calendar", read: true, add: true, edit: true }], events: clone(events.filter((event) => event.startMs < args.endMs && event.endMs > args.startMs)) };
    if (command === "calendar_capabilities") return { kind: "calendarResult", permission: "granted", capabilities: [{ id: "device-work", name: "Work", account: "Device calendar", read: true, add: true, edit: true }] };
    // Same shapes as the native executor: `before` is the event read back (or a new-event marker) and `after` the exact change, both JSON.
    // Moves (?state=move-changed: the event changed meanwhile; ?state=move-refused: the calendar refuses the save).
    if (command === "prepare_calendar_change" && args.change.move) {
      const change = args.change; const e = events.find((event) => event.id === (change.stableId ?? change.eventId));
      if (!e) throw "eventUnavailable";
      if (e.recurring) throw "recurringUnsupported";
      if (e.isAllDay) throw "allDayUnsupported";
      if (e.calendarWritable === false) throw "calendarReadOnly";
      if (scene === "move-changed" || e.startMs !== change.originalStartMs || (change.expectedVersion && change.expectedVersion !== versionOf(e))) throw "eventChanged";
      const p = proposal("calendarEdit", "calendar:" + e.calendarId, JSON.stringify({ ...change, kind: "calendarApply", eventId: e.id, originalStartMs: e.startMs, expectedVersion: versionOf(e) }));
      p.targetId = e.calendarId; p.before = JSON.stringify({ ...e, version: versionOf(e) }); proposals.set(p.id, p);
      return { ...p, move: true, invitation: !!e.invitation, calendar: { id: e.calendarId, name: "Work", account: "Device calendar" } };
    }
    if (command === "apply_calendar_change" && proposals.get(args.proposalId)?.after.includes('"move":true')) {
      const p = proposals.get(args.proposalId)!; if (p.status !== "approved" || args.approval !== "fixture-approval") throw "approvalRequired";
      const change = JSON.parse(p.after); const e = events.find((event) => event.id === change.eventId);
      if (!e) throw "eventUnavailable";
      if (scene === "changed-target" || versionOf(e) !== change.expectedVersion) throw "eventChanged";
      if (scene === "move-refused") throw "eventNotModifiable";
      p.status = "applied"; const before = { startMs: e.startMs, endMs: e.endMs };
      // The same fixture event is edited in place; no second event is added.
      Object.assign(e, { startMs: change.startMs, endMs: change.endMs });
      return { proposalId: p.id, applied: true, moved: true, before, event: { ...e, version: versionOf(e) }, publicEvent: toPublic(e) };
    }
    if (command === "prepare_calendar_change") { const previous = events.find((event) => event.id === args.change.eventId); if (args.change.eventId && !previous) throw new Error("eventUnavailable"); const p = proposal(args.change.eventId ? "calendarEdit" : "calendarAdd", "calendar:" + args.change.calendarId, JSON.stringify({ ...args.change, kind: "calendarApply" })); p.targetId = args.change.calendarId; p.before = previous ? JSON.stringify(previous) : JSON.stringify({ newEvent: true }); proposals.set(p.id, p); return p; }
    if (command === "apply_calendar_change") { const p = proposals.get(args.proposalId); if (!p || p.status !== "approved" || args.approval !== "fixture-approval") throw new Error("approvalRequired"); if (scene === "changed-target") throw new Error("calendarApplyFailedOrTargetChanged"); p.status = "applied"; const change = JSON.parse(p.after); const existing = events.find((event) => event.id === change.eventId); const event = existing ?? { id: "event-" + crypto.randomUUID().slice(0, 8), calendarId: change.calendarId, title: "", startMs: 0, endMs: 0 }; Object.assign(event, { title: change.title, startMs: change.startMs, endMs: change.endMs }); if (!existing) events.push(event); const version = "fixture-" + Date.now(); return { proposalId: p.id, applied: true, event: { ...event, version }, publicEvent: { ...event, accountId: "device", provider: "apple", sourceEventId: event.id, readOnly: false, version } }; }
    if (command === "propose_action") return proposal(args.operation, args.targetPath, args.content);
    if (command === "prepare_filing_link") return proposal("append", "/workspaces/product-research/transcripts/customer-discovery.md", "/meetings/customer-discovery/english.md");
    if (command === "approve_action") { const p = proposals.get(args.proposalId); if (!p) throw new Error("missingProposal"); p.status = "approved"; return "fixture-approval"; }
    if (command === "apply_action" || command === "apply_reviewed_ics") { const p = proposals.get(args.proposalId); if (!p || p.status !== "approved" || args.approval !== "fixture-approval") throw new Error("approvalRequired"); if (scene === "changed-target") throw new Error("targetChanged"); p.status = "applied"; return { applied: true }; }
    if (command === "decline_action") { const p = proposals.get(args.proposalId); if (p) p.status = "declined"; return {}; }
    if (command === "export_workspace_bundle") return { path: "/app-outbox/selected-text.json" };
    if (command === "import_workspace_bundle") return { imported: 3, skipped: 1, conflicts: 1, unresolved: ["source-reference"], errors: [] };
    if (command === "plugin:dialog|open") return args.options?.directory ? "/workspaces/connected-project" : args.options?.filters?.[0]?.extensions?.includes("json") ? "/fixture/text-bundle.json" : "/workspaces/product-research/meeting-notes.md";
    if (command === "plugin:dialog|save") return "/app-outbox/reviewed-calendar.ics";
    if (command === "pick_grant_path") return args.kind === "appendNote" ? "/workspaces/product-research/meeting-notes.md" : args.kind === "chatgptExport" ? "/workspaces/exports/conversations.json" : "/workspaces/connected-project";
    if (command === "pick_action_target") return args.kind === "recordFolder" ? "/workspaces/connected-project" : args.kind === "icsFile" ? "/app-outbox/reviewed-calendar.ics" : "/workspaces/product-research/meeting-notes.md";
    if (command === "plugin:opener|reveal_item_in_dir" || command === "plugin:opener|open_url") return {};
    throw new Error("Preview rejected unknown command: " + command);
  };
  const checkedInvoke = async (command: string, args?: Args, options?: unknown) => { try { return await invoke(command, args, options); } catch (error) { diagnostics.push(command + ": " + (error instanceof Error ? error.message : "failed")); throw error; } };
  const previewInternals: Internals = {
    invoke: checkedInvoke, metadata: actual?.metadata ?? { currentWindow: { label: params.get("window") === "widget" ? "__preview-widget__" : "__preview-main__" }, currentWebview: { label: "preview" } },
    transformCallback: actual?.transformCallback ?? ((callback) => { const id = sequence++; callbacks.set(id, callback); return id; }),
    unregisterCallback: actual?.unregisterCallback ?? ((id) => { callbacks.delete(id); }),
    runCallback: actual?.runCallback ?? ((id, value) => { callbacks.get(id)?.(value); }),
  };
  if (!actual) win.__TAURI_INTERNALS__ = previewInternals;
  const previewEvents = { unregisterListener: (event: string, id: number) => {
    const listener = listeners.get(id);
    if (listener) { listeners.delete(id); win.__TAURI_INTERNALS__!.unregisterCallback(listener.handler); }
    else originalUnregisterListener?.(event, id);
  } };
  if (actualEvents) actualEvents.unregisterListener = previewEvents.unregisterListener; else win.__TAURI_EVENT_PLUGIN_INTERNALS__ = previewEvents;
  win.__LIVE_INTERVIEW_PREVIEW__ = { currentMeetingId: () => active?.id, invoke: checkedInvoke, actualNative: !!actual, commands, synthesis, diagnostics, activeListeners: () => listeners.size, registeredShortcuts: () => shortcuts.size, emit: emitLocal, triggerShortcut: (shortcut) => { const entry = shortcuts.get(shortcut); if (entry) deliver(entry.handler, { message: { shortcut, state: "Pressed" }, index: entry.index++ }); } };
}
