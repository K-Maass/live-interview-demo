import { ArrowLeft, ArrowRight, FileText, ListChecks, NotebookPen, Info, LayoutList } from "lucide-react";
import { processingClass, processingLabel, processingState } from "../presentation/processing";
import { meetingProfiles } from "@live-interview/core";
import type { CopilotController } from "../useCopilotController";
import type { AppLocation, ReviewArtifact } from "../presentation/types";
import { PageHeading, Section, StubPanel, dayText } from "../ui";
import { TranscriptView } from "../live/TranscriptView";
import { AfterMeeting } from "../AfterMeeting";
import { FilingReview } from "../FilingReview";
import { PublicSynthesis } from "./PublicSynthesis";
import { PilotFeedback } from "../PilotFeedback";
import { PinnedTopicsReview } from "../PinnedTopicsReview";
import { accountSelfName } from "../../lib/public/capture";
import { attentionNotices, type AttentionNotice } from "../../lib/copilot/recordAttention";
import { describeStatus, recoveryStatus } from "../../lib/copilot/status";
import { useLiveEvents } from "../liveStore";
export function ReviewMeetingPage({ controller: c, artifact, navigate, synthesis }: { controller: CopilotController; artifact: ReviewArtifact; navigate: (location: AppLocation) => void; synthesis?: string }) {
  const events = useLiveEvents(c);
  const record = c.selectedRecord;
  if (!record) return null;
  const select = (value: ReviewArtifact) => navigate({ kind: "meeting", id: record.id, preparationOpen: false, artifact: value });
  const tabs = [{ id: "overview", label: "Overview", icon: LayoutList }, { id: "transcript", label: "Transcript", icon: FileText }, { id: "actions", label: "Actions", icon: ListChecks }, { id: "notes", label: "Notes", icon: NotebookPen }, { id: "details", label: "Details", icon: Info }] as const;
  const processing = processingState(record);
  const pending = processing === "pending";
  const unavailable = processing === "translationUnavailable";
  const recovery = recoveryStatus(record.recovery);
  const recovering = record.recovery?.state === "recovering";
  return <div className="screen-frame review-page">
    <PageHeading eyebrow={<button onClick={() => navigate({ kind: "meetings", view: "past" })}><ArrowLeft size={15} />Meetings</button>} title={record.purpose} subtitle={<>{pending ? "Saved · processing pending" : processing === "translationUnavailable" ? "Saved · translation unavailable" : "Completed"} · {dayText(record.date)}{record.attendees.length > 0 && <div>{record.attendees.map((p) => p.name).join(" · ")} · Attendees</div>}</>} actions={<span className={processingClass[processing]}>{pending ? "Source saved · translation pending" : unavailable ? "Source saved · translation unavailable" : "Source and English record saved"}</span>} />
    <nav className="artifact-tabs" aria-label="Meeting artifacts">{tabs.map(({ id, label, icon: Icon }) => <button key={id} aria-current={artifact === id ? "page" : undefined} className={artifact === id ? "selected" : ""} onClick={() => select(id)}><Icon size={17} aria-hidden />{label}</button>)}</nav>
    {recovery && <p className="notice recovery-notice">{describeStatus(recovery, 0).text}</p>}
    {pending && !recovering && <div className="notice processing-notice">Local processing is pending. Source text remains available. <button onClick={() => void c.recover(record.id)}>Retry processing</button></div>}
    {record.summary ? <div className="page-body"><p className="muted record-loading" role="status">Opening the saved meeting…</p></div> : <div className="page-body">
      <div hidden={artifact !== "overview"} className="overview-layout"><div><AttentionNotices notices={attentionNotices(c.recordAttention[record.id])} onAction={(notice) => notice.action === "openKnowledge" ? navigate({ kind: "knowledge" }) : void c.retryAttention(record, notice.kind)} onDismiss={(notice) => c.dismissAttention(record.id, notice.kind)} />{c.publicProduct.enabled ? <PublicSynthesis record={record} canUseAI={!!c.publicProduct.account?.canUseAI}/> : <><div className="synthesis-heading"><h2>Meeting synthesis</h2><small>Planned{synthesis ? " · illustrative sample" : ""}</small></div>{synthesis ? <div className="meeting-synthesis">{synthesis.split("\n\n").map((paragraph, i) => <p key={i}>{paragraph}</p>)}</div> : <div className="synthesis-empty"><h3>The meeting record is saved.</h3><p>Inspect the source transcript and the existing grounded next steps. A coherent synthesis generator is not implemented yet.</p></div>}</>}<div className="overview-links"><button className="link-button" onClick={() => select("actions")}>Review actions <ArrowRight size={16} /></button><button className="link-button" onClick={() => select("transcript")}>Open transcript <ArrowRight size={16} /></button></div><PinnedTopicsReview meetingId={record.id} /></div><aside className="record-meta"><h3>Meeting details</h3><dl><dt>Type</dt><dd>{meetingProfiles[record.profileId]?.label ?? "Meeting"}</dd><dt>Workspace</dt><dd>{c.workspaces.find((w) => w.id === record.workspaceId)?.root.split("/").at(-1) ?? (record.workspaceId === "default" ? "Conversation only" : record.workspaceId)}</dd><dt>Saved</dt><dd>Locally</dd></dl></aside></div>
      <div hidden={artifact !== "transcript"} className="review-transcript-layout"><TranscriptView events={events} english={c.english} onEnglish={c.setEnglish} /><aside className="record-meta"><h3>Record details</h3><p>Source text saved</p><p>{pending ? "English translation pending" : unavailable ? "English translation unavailable on this Mac; the source language is kept" : "English translation available"}</p><button className="link-button" onClick={() => select("details")}>Open record details <ArrowRight size={16} /></button><p className="muted">{record.canonicalEnglishPath}</p></aside></div>
      <div hidden={artifact !== "actions" && artifact !== "notes"} className={artifact === "notes" ? "notes-artifact" : "actions-artifact"}><AfterMeeting record={record} selfName={accountSelfName(c.publicProduct.account)} onStatus={c.setAssistanceStatus} autoDerive={!c.publicProduct.enabled} artifact={artifact === "notes" ? "notes" : "actions"} />{artifact === "actions" && <aside className="actions-about"><h3>About these actions</h3><p>Explicit commitments and inferred opportunities are labelled separately. Open supporting conversation to inspect their evidence.</p><p>Owners and dates appear only when supported by the saved record.</p></aside>}{artifact === "notes" && !c.publicProduct.enabled && <StubPanel title="Live notes editor" description="Live scratch-note persistence is not implemented." />}</div>
      <div hidden={artifact !== "details"} className="details-layout"><div><Section title="Record details"><dl className="details-list"><dt>ID</dt><dd>{record.id}</dd><dt>Type</dt><dd>{meetingProfiles[record.profileId]?.label ?? record.profileId}</dd><dt>Source record</dt><dd>{(record.pendingSegments ?? 0) > 0 ? "Processing pending" : "Saved locally"}</dd><dt>English record</dt><dd>{processingLabel[processing]}</dd><dt>Audio retention</dt><dd>{record.audioReference ? "Retained locally" : "Not retained"}</dd></dl></Section><FilingReview record={record} onStatus={c.setAssistanceStatus} /><button className="link-button" onClick={() => navigate({ kind: "settings", section: "sharing" })}>Open Data & sharing <ArrowRight size={16} /></button></div><PilotFeedback record={record} onStatus={c.setAssistanceStatus} /></div>
    </div>}
  </div>;
}

/** What still needs the person after the meeting was saved: one action each, and a way to set the notice aside. */
export function AttentionNotices({ notices, onAction, onDismiss }: { notices: AttentionNotice[]; onAction: (notice: AttentionNotice) => void; onDismiss: (notice: AttentionNotice) => void }) {
  return <>{notices.map((notice) => <div className="attention-notice" key={notice.kind}>{notice.text} <button onClick={() => onAction(notice)}>{notice.actionLabel}</button> <button className="link-button" onClick={() => onDismiss(notice)}>Dismiss</button></div>)}</>;
}
