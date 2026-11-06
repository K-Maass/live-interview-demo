import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CopilotController } from "../useCopilotController";
import { publicClient as api } from "../../lib/public/client";
import { CalendarConnections } from "../settings/CalendarConnections";
import { Section } from "../ui";
import { AccountDataSettings } from "./AccountData";
import { speechStatusText } from "../../lib/public/speechWarmup";
import {
  SIGNED_OUT_ALL_MESSAGE,
  SIGN_OUT_ALL_CONFIRM,
  sessionNotice,
  signOutAllErrorMessage,
} from "../../lib/public/sessionNotice";
/** True when the signed-in account already has `plan`, so the plan card says so instead of offering it again. */
export function isCurrentPlan(account: { signedIn: boolean; plan: string } | undefined, plan: "standard" | "premium"): boolean {
  return !!account?.signedIn && account.plan === plan;
}
const dayText = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
/** The one plain-text line shown while a failed renewal is inside its payment grace (service-decided). */
export function paymentGraceNotice(
  account: { signedIn: boolean; subscriptionStatus: string; paymentGraceEndsAtMs?: number } | undefined,
): string | undefined {
  if (!account?.signedIn || account.subscriptionStatus !== "past_due" || !account.paymentGraceEndsAtMs) return undefined;
  return `Your last payment didn't go through. AI assistance continues until ${dayText(account.paymentGraceEndsAtMs)}; update your payment method in the billing portal.`;
}
/** When the usage counters start again (the billing period's end, else the next month). */
export function usageResetText(ms: number | undefined): string | undefined {
  return ms ? `Resets ${dayText(ms)}` : undefined;
}
/** Plain words for a rejected account action; sign-in outcomes say what happened instead of blaming configuration. */
export function accountActionMessage(error: unknown): string {
  switch (error) {
    case "signInCancelled":
      return "Sign-in cancelled.";
    case "signInExpired":
      return "The sign-in code expired before it was entered. Start sign-in again.";
    case "browserUnavailable":
      return "Could not open your browser for sign-in. Check your default browser and try again.";
    case "signInAlreadyPending":
      return "A sign-in is already waiting in your browser. Finish it there or cancel it here.";
    case "slowDown":
      return "The service asked to wait a moment. Try again shortly.";
    default:
      return "This account action is unavailable. Check the service configuration or try again. No subscription change was confirmed.";
  }
}
export function PublicAccountSettings({
  controller: c,
}: {
  controller: CopilotController;
}) {
  const p = c.publicProduct;
  const account = p.account;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmingSignOutAll, setConfirmingSignOutAll] = useState(false);
  const signOutAll = async () => {
    setBusy(true);
    setMessage("");
    try {
      await p.signOutAll();
      setMessage(SIGNED_OUT_ALL_MESSAGE);
    } catch (error) {
      setMessage(signOutAllErrorMessage(error));
    } finally {
      setConfirmingSignOutAll(false);
      setBusy(false);
    }
  };
  const notice = account?.signedIn ? sessionNotice(account.session) : undefined;
  // The code to type in the browser while a sign-in is pending; the page is never prefilled.
  const [signInCode, setSignInCode] = useState("");
  useEffect(() => {
    const off = listen<{ userCode: string }>("public-sign-in-code", (e) =>
      setSignInCode(e.payload.userCode),
    ).catch(() => undefined);
    return () => void off.then((stop) => stop?.());
  }, []);
  useEffect(() => {
    if (!busy) setSignInCode("");
  }, [busy]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(accountActionMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const billing = async (plan?: "standard" | "premium") => {
    const { url } = plan ? await api.checkout(plan) : await api.portal();
    if (new URL(url).protocol !== "https:") throw Error("untrustedBillingURL");
    await openUrl(url);
    setMessage(
      "Billing opened in your browser. Use Refresh account after completing or cancelling there.",
    );
  };
  return (
    <>
      <Section title="Account & plan">
        <p className="muted">
          Your subscription provides online text reasoning. Microphone audio,
          recognition, and translation stay on this Mac.
        </p>
        {!account ? (
          <p role="status">Checking product service…</p>
        ) : !account.configured ? (
          <div className="notice" role="status">
            Product service setup is unavailable. Sign-in and subscriptions will
            become available when the publisher configures this build.
            {account.code && <small> {account.code}</small>}
          </div>
        ) : (
          <>
            <div className="readiness-row">
              <span>Signed in</span>
              <strong>
                {account.signedIn
                  ? account.user?.email ||
                    account.user?.name ||
                    "Connected account"
                  : "Not signed in"}
              </strong>
            </div>
            <div className="readiness-row">
              <span>Plan</span>
              <strong>
                {account.plan === "none"
                  ? "No active plan"
                  : account.plan === "premium"
                    ? "Premium"
                    : "Standard"}{" "}
                · {account.subscriptionStatus}
              </strong>
            </div>
            {paymentGraceNotice(account) && (
              <p className="notice" role="status">
                {paymentGraceNotice(account)}
              </p>
            )}
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            {account.signedIn ? (
              <>
                <div className="buttons">
                  <button
                    disabled={busy}
                    onClick={() => void run(() => p.signOut())}
                  >
                    Sign out
                  </button>
                  {!confirmingSignOutAll && (
                    <button
                      disabled={busy}
                      onClick={() => setConfirmingSignOutAll(true)}
                    >
                      Sign out of all Macs…
                    </button>
                  )}
                </div>
                {confirmingSignOutAll && (
                  <div
                    className="notice"
                    role="alertdialog"
                    aria-labelledby="sign-out-all-title"
                  >
                    <strong id="sign-out-all-title">
                      Sign out of all Macs?
                    </strong>
                    <ul>
                      {SIGN_OUT_ALL_CONFIRM.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <div className="buttons">
                      <button disabled={busy} onClick={() => void signOutAll()}>
                        {busy ? "Signing out…" : "Sign out of all Macs"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setConfirmingSignOutAll(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(() => p.signIn())}
              >
                {busy ? "Waiting for browser sign-in…" : "Sign in in browser"}
              </button>
            )}
            {!account?.signedIn && busy && signInCode && (
              <button onClick={() => void p.cancelSignIn().catch(() => undefined)}>
                Cancel sign-in
              </button>
            )}
            {busy && signInCode && (
              <p role="status">
                Enter this code on the sign-in page in your browser:{" "}
                <strong className="sign-in-code">{signInCode}</strong>. Only
                enter it on a page you opened from this app.
              </p>
            )}
          </>
        )}
        <button
          disabled={busy}
          onClick={() => void run(() => p.refreshAccount())}
        >
          Refresh account
        </button>
        <p role="status" className="muted">
          {message}
        </p>
      </Section>
      <Section title="Choose a plan">
        <div className="public-plan-cards">
          <article>
            <h3>Standard</h3>
            <p>
              Local indexing, live guidance, and basic preparation when you
              request it.
            </p>
            {isCurrentPlan(account, "standard") ? (
              <p className="muted">Current plan</p>
            ) : (
              <button
                disabled={busy || !account?.signedIn || !account.billingAvailable}
                onClick={() => void run(() => billing("standard"))}
              >
                Continue with Standard
              </button>
            )}
          </article>
          <article>
            <h3>Premium</h3>
            <p>
              Standard plus opt-in automatic preparation and research before
              scheduled meetings.
            </p>
            {isCurrentPlan(account, "premium") ? (
              <p className="muted">Current plan</p>
            ) : (
              <button
                disabled={busy || !account?.signedIn || !account.billingAvailable}
                onClick={() => void run(() => billing("premium"))}
              >
                Continue with Premium
              </button>
            )}
          </article>
        </div>
        <p className="muted">
          Current prices and terms appear in secure Checkout before you agree.
          Opening Checkout does not activate a subscription.
        </p>
        <button
          disabled={busy || !account?.signedIn || !account.billingAvailable}
          onClick={() => void run(() => billing())}
        >
          Manage billing / cancel subscription
        </button>
        {!account?.billingAvailable && (
          <p className="muted">
            Billing is unavailable for this service configuration.
          </p>
        )}
      </Section>
      {account?.usage && (
        <Section title="Online text usage">
          {usageResetText(account.usageResetsAtMs) && (
            <p className="muted">{usageResetText(account.usageResetsAtMs)}</p>
          )}
          <div className="readiness-row">
            <span>Requests</span>
            <strong>
              {account.usage.requests.toLocaleString()}
              {account.limits
                ? " / " + account.limits.requests.toLocaleString()
                : ""}
            </strong>
          </div>
          <div className="readiness-row">
            <span>Input tokens</span>
            <strong>
              {account.usage.inputTokens.toLocaleString()}
              {account.limits
                ? " / " + account.limits.inputTokens.toLocaleString()
                : ""}
            </strong>
          </div>
          <div className="readiness-row">
            <span>Output tokens</span>
            <strong>
              {account.usage.outputTokens.toLocaleString()}
              {account.limits
                ? " / " + account.limits.outputTokens.toLocaleString()
                : ""}
            </strong>
          </div>
        </Section>
      )}
      <AccountDataSettings controller={c} />
    </>
  );
}
export function PublicReasoningSettings({
  controller: c,
}: {
  controller: CopilotController;
}) {
  const account = c.publicProduct.account;
  return (
    <>
      <Section title="Managed reasoning service">
        <div className="readiness-row">
          <span>Product service</span>
          <strong>
            {!account
              ? "Checking…"
              : !account.configured
                ? "Setup unavailable"
                : account.canUseAI
                  ? "Subscription access available"
                  : account.signedIn
                    ? "Subscription access unavailable"
                    : "Sign-in required"}
          </strong>
        </div>
        <p className="muted">
          Access status is not an inference test. A request reports its actual
          result when you use preparation or live help.
        </p>
        <p>
          Fast reasoning and routing are managed by the app service. Deeper
          Premium preparation uses its managed deep route, with a managed fast
          fallback.
        </p>
        <p className="muted">
          Transcript text and selected relevant document excerpts can be
          processed by the disclosed online AI providers. Audio is never sent.
          Credentials stay in native secure storage.
        </p>
        <button onClick={() => void c.publicProduct.refreshAccount()}>
          Refresh service access
        </button>
      </Section>
      <Section title="Recording independence">
        <p>
          Service, subscription, quota, and assistance failures do not stop
          local recording or transcription.
        </p>
        <p className="muted">Local speech: {speechStatusText(c.speechStatus)}</p>
      </Section>
    </>
  );
}
/** Settings → Calendars. Calendar changes are never made here: they always go through review. */
export function PublicCalendarSettings({
  controller: c,
}: {
  controller: CopilotController;
}) {
  return <CalendarConnections product={c.publicProduct} />;
}
