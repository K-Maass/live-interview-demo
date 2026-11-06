// Premium on the meeting page (redesign chunk C).
//
//   <PremiumCard account plan now onAutomaticPreparation onSeePremium onSignIn />
//
// On Premium (`canAutoPrepare` and `plan === "premium"`) a card with a working switch for automatic preparation and
// its status in plain words ("Will prepare by 2:00 PM"; "Available for scheduled meetings" without a time). Anywhere
// else a single teaser line, never a locked card: "✦ Premium can prepare this meeting for you · See Premium", with
// "Sign in" when signed out and no link at all when the account service cannot be reached. Renders nothing until the
// account has loaded, so the line does not flash.
import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import type { PublicAccountStatus, PublicMeetingPlan } from "@live-interview/core";
import { timeText } from "./ui";

/**
 * A Mac-style switch: a real checkbox with `role="switch"`, so it keeps native keyboard, form and screen reader
 * behaviour. The label text sits beside it; `detail` is a second, muted line tied to it with aria-describedby.
 */
export function Switch({ label, detail, id, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role"> & { label: ReactNode; detail?: ReactNode; id: string }) {
  return <div className={"switch-row" + (input.disabled ? " is-disabled" : "")}>
    <input {...input} id={id} type="checkbox" role="switch" className="switch" aria-describedby={detail ? id + "-detail" : undefined} />
    <label htmlFor={id}>{label}{detail && <small id={id + "-detail"}>{detail}</small>}</label>
  </div>;
}

export type PremiumState = "loading" | "premium" | "standard" | "signedOut" | "unavailable";

export function premiumState(account: PublicAccountStatus | undefined): PremiumState {
  if (!account) return "loading";
  if (account.canAutoPrepare && account.plan === "premium") return "premium";
  if (!account.configured) return "unavailable";
  if (!account.signedIn) return "signedOut";
  return "standard";
}

/** What automatic preparation will do for this plan, in one short sentence. */
export function automaticPreparationStatus(plan: Pick<PublicMeetingPlan, "startMs" | "automaticPreparation" | "briefDraft" | "reviewedBrief">, now: number): string {
  if (plan.startMs === undefined) return "Available for scheduled meetings";
  if (plan.startMs <= now) return "This meeting has already started";
  if (!plan.automaticPreparation) return "Off for this meeting";
  if (plan.reviewedBrief || plan.briefDraft.trim()) return "This meeting already has a brief, so nothing will be prepared";
  return "Will prepare by " + timeText(plan.startMs);
}

export function PremiumCard({ account, plan, now, onAutomaticPreparation, onSeePremium, onSignIn }: {
  account: PublicAccountStatus | undefined;
  plan: PublicMeetingPlan | undefined;
  now: number;
  onAutomaticPreparation: (on: boolean) => void;
  onSeePremium: () => void;
  onSignIn: () => void;
}) {
  const id = useId();
  const state = premiumState(account);
  if (state === "loading" || !plan) return null;
  if (state !== "premium") return <p className="premium-teaser">
    <span className="premium-mark" aria-hidden>✦</span>
    <span>Premium can prepare this meeting for you</span>
    <span aria-hidden> · </span>
    {state === "unavailable" ? <span className="muted">Account service unavailable</span>
      : <button type="button" className="link-button" onClick={state === "signedOut" ? onSignIn : onSeePremium}>{state === "signedOut" ? "Sign in" : "See Premium"}</button>}
  </p>;
  const scheduled = plan.startMs !== undefined && plan.startMs > now;
  const status = automaticPreparationStatus(plan, now);
  const will = status.startsWith("Will prepare");
  return <section className="meeting-card premium-card" aria-labelledby={id + "title"}>
    <div className="card-heading"><h2 id={id + "title"}><span className="premium-mark" aria-hidden>✦</span> Premium</h2></div>
    <Switch id={id + "auto"} label="Prepare this meeting automatically" checked={plan.automaticPreparation} disabled={!scheduled}
      onChange={(e) => onAutomaticPreparation(e.target.checked)}
      detail="Runs at most once, within 30 minutes of the start, for a blank draft. It never starts recording." />
    <p className={"card-status" + (will ? " is-good" : "")} role="status">{status}</p>
  </section>;
}
