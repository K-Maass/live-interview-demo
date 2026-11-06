import type { ProfileId } from "./contracts";
export interface CallHint {
  verified: boolean;
  title: string;
  observedAt: number;
  windowId?: string;
  ended?: boolean;
  code?: string;
  candidates?: { title: string; source: string }[];
}
export interface PreparedCall {
  title: string;
  armed: boolean;
  expiresAt: number;
}
export function shouldStartPreparedCall(
  plan: PreparedCall,
  hint: CallHint,
  now: number,
) {
  return (
    plan.armed &&
    plan.expiresAt > now &&
    hint.verified &&
    !hint.ended &&
    now - hint.observedAt < 15000 &&
    hint.title.trim().toLowerCase() === plan.title.trim().toLowerCase()
  );
}
export function offerUnpreparedCall(hint: CallHint, now: number) {
  if (!hint.verified || hint.ended || now - hint.observedAt >= 15000) return;
  return {
    title: hint.title,
    expiresAt: now + 30000,
    recordingStarted: false as const,
  };
}
export function offerAmbiguousCalls(hint: CallHint, now: number) {
  if (
    hint.verified ||
    hint.code !== "ambiguousCalls" ||
    hint.ended ||
    now - hint.observedAt >= 15000 ||
    hint.observedAt > now + 1000
  )
    return [];
  const candidates =
    hint.candidates?.filter(
      (candidate) =>
        candidate.source === "teams-accessibility-controls" &&
        candidate.title.trim(),
    ) ?? [];
  if (candidates.length < 2) return [];
  return candidates.slice(0, 8).map((candidate) => ({
    title: candidate.title,
    expiresAt: now + 30000,
    recordingStarted: false as const,
  }));
}
export function inferProfile(purpose: string): ProfileId {
  if (
    /discovery|potential client|customer discovery|kundengespr[aä]ch/i.test(
      purpose,
    )
  )
    return "discovery";
  if (/presentation|presenting|q&a|pr[aä]sentation/i.test(purpose))
    return "presentationAnswering";
  if (/interview|research interview|befragung/i.test(purpose))
    return "interview";
  return "workClient";
}
