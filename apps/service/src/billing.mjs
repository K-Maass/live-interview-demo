import Stripe from "stripe";
import { fail } from "./errors.mjs";
import { PAYMENT_GRACE_MS } from "./config.mjs";
export class StripeBilling {
  constructor(config, stripe) {
    this.config = config;
    this.stripe =
      stripe ??
      (config.billingConfigured
        ? new Stripe(config.stripe.secretKey, {
            maxNetworkRetries: 2,
            timeout: 15000,
          })
        : undefined);
  }
  verify(raw, signature) {
    try {
      const e = this.stripe.webhooks.constructEvent(
        raw,
        signature,
        this.config.stripe.webhookSecret,
        300,
      );
      if (
        e.livemode !== this.config.stripe.live ||
        typeof e.id !== "string" ||
        e.id.length > 200 ||
        typeof e.type !== "string" ||
        e.type.length > 200 ||
        !e.data?.object
      )
        fail(400, "invalidWebhook");
      return e;
    } catch {
      fail(400, "invalidWebhook");
    }
  }
  async customer(user) {
    // The generation counts this account's deleted customers: Stripe replays an
    // idempotency key's first result for 24 hours, which would be the deleted one.
    const generation = user.customer_generation
      ? `-${user.customer_generation}`
      : "";
    const customer = await this.stripe.customers.create(
      {
        metadata: { owner: user.id },
        ...(user.email ? { email: user.email } : {}),
      },
      { idempotencyKey: `live-interview-customer-${user.id}${generation}` },
    );
    if (customer.livemode !== this.config.stripe.live)
      fail(502, "billingModeMismatch");
    return customer.id;
  }
  checkedCheckout(session, user) {
    if (
      typeof session.id !== "string" ||
      session.id.length > 200 ||
      (typeof session.customer === "string"
        ? session.customer
        : session.customer?.id) !== user.customer ||
      session.livemode !== this.config.stripe.live ||
      session.mode !== "subscription" ||
      !["open", "complete", "expired"].includes(session.status) ||
      !Number.isSafeInteger(session.expires_at)
    )
      fail(502, "invalidBillingResult");
    if (
      session.status === "open" &&
      (typeof session.url !== "string" ||
        !session.url.startsWith("https://checkout.stripe.com/"))
    )
      fail(502, "invalidBillingResult");
    return {
      id: session.id,
      status: session.status,
      url: session.url,
      expiresAtMs: session.expires_at * 1000,
    };
  }
  async checkout(user, plan, operationId) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: user.customer,
        line_items: [{ price: this.config.stripe.prices[plan], quantity: 1 }],
        success_url: `${this.config.origin}/billing/return`,
        cancel_url: `${this.config.origin}/billing/return`,
        client_reference_id: user.id,
        subscription_data: { metadata: { owner: user.id } },
      },
      { idempotencyKey: `live-interview-checkout-${operationId}` },
    );
    return this.checkedCheckout(session, user);
  }
  async getCheckout(user, id) {
    return this.checkedCheckout(
      await this.stripe.checkout.sessions.retrieve(id),
      user,
    );
  }
  async expireCheckout(user, id) {
    const expired = this.checkedCheckout(
      await this.stripe.checkout.sessions.expire(id),
      user,
    );
    if (expired.status !== "expired") fail(409, "checkoutPaymentPending");
  }
  async portal(user) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.customer,
      return_url: `${this.config.origin}/billing/return`,
    });
    if (
      typeof session.url !== "string" ||
      !session.url.startsWith("https://billing.stripe.com/")
    )
      fail(502, "invalidBillingResult");
    return { url: session.url };
  }
  /** The account's Stripe customer, or undefined when Stripe deleted it or no longer has it. */
  async existingCustomer(user) {
    let customer;
    try {
      customer = await this.stripe.customers.retrieve(user.customer);
    } catch (e) {
      if (e?.code !== "resource_missing") throw e;
      // Stripe answers "not found" for a customer of the other mode but says so in the message.
      // A deleted customer comes back with deleted:true, so this wording is the only signal; if
      // Stripe ever rewords it, a wrong-mode customer would pass as already gone.
      if (/similar object exists in (live|test) mode/i.test(e.message ?? ""))
        fail(502, "billingModeMismatch");
      return undefined;
    }
    return customer.deleted === true ? undefined : customer;
  }
  /**
   * Deletes the Stripe customer, which also cancels its subscriptions at once.
   * Stripe keeps invoice and payment records of deleted customers. Already
   * deleted or not found (an earlier attempt that did not finish) counts as done.
   * A customer of the other Stripe mode (`billingModeMismatch`) or one this
   * account does not own (`billingOwnershipMismatch`) is never touched and fails
   * the deletion for the operator to resolve by hand.
   */
  async deleteCustomer(user) {
    const customer = await this.existingCustomer(user);
    if (!customer) return;
    if (customer.livemode !== this.config.stripe.live)
      fail(502, "billingModeMismatch");
    if (customer.metadata?.owner !== user.id)
      fail(502, "billingOwnershipMismatch");
    const result = await this.stripe.customers.del(user.customer);
    if (result.deleted !== true) fail(502, "invalidBillingResult");
  }
  /**
   * The account's entitlement from Stripe's current subscriptions. `pastDueSince` is when the
   * service first recorded the current payment failure (0: none); it only ever moves the grace
   * anchor earlier than Stripe's own timing.
   */
  async reconcile(customer, now, { pastDueSince = 0 } = {}) {
    let after,
      seen = 0;
    const subscriptions = [];
    do {
      const page = await this.stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
        // The latest invoice's creation time anchors the payment grace of a past_due subscription.
        expand: ["data.latest_invoice"],
        ...(after ? { starting_after: after } : {}),
      });
      for (const s of page.data) {
        if (
          (typeof s.customer === "string" ? s.customer : s.customer?.id) !==
            customer ||
          s.livemode !== this.config.stripe.live
        )
          fail(502, "billingOwnershipMismatch");
        subscriptions.push(s);
      }
      seen += page.data.length;
      if (seen > 1000 || (page.has_more && !page.data.length))
        fail(502, "billingPaginationLimit");
      after = page.has_more ? page.data.at(-1).id : undefined;
    } while (after);
    const eligible = [];
    // Earliest payment failure among past_due subscriptions; 0 when none is past_due.
    let pastDueAnchor = 0,
      nonMonthlyPrice = false;
    for (const sub of subscriptions) {
      const grace =
        sub.status === "past_due"
          ? paymentFailedAt(sub, pastDueSince, now)
          : undefined;
      if (grace !== undefined)
        pastDueAnchor = pastDueAnchor ? Math.min(pastDueAnchor, grace) : grace;
      for (const item of sub.items?.data ?? []) {
        const plan = Object.entries(this.config.stripe.prices).find(
          ([name, price]) =>
            item.price?.id === price ||
            (this.config.stripe.legacyPrices?.[name] ?? []).includes(
              item.price?.id,
            ),
        )?.[0];
        const end =
          (item.current_period_end ?? sub.current_period_end ?? 0) * 1000;
        // Allowances are monthly: a billing period counts only for a price billed every month.
        // Any other interval (or none reported) keeps the calendar month (see README).
        const monthly =
          item.price?.recurring?.interval === "month" &&
          (item.price.recurring.interval_count ?? 1) === 1;
        if (plan && !monthly) nonMonthlyPrice = true;
        const start = monthly
          ? (item.current_period_start ?? sub.current_period_start ?? 0) * 1000
          : 0;
        if (
          plan &&
          (["active", "trialing"].includes(sub.status) ||
            (grace !== undefined && grace + PAYMENT_GRACE_MS > now)) &&
          end > now &&
          item.quantity === 1
        )
          eligible.push({
            plan,
            status: sub.status,
            // A failed renewal: Stripe already opened the new period, which is not paid.
            unpaidPeriod: grace !== undefined && renewalInvoice(sub),
            end,
            start: Number.isSafeInteger(start) && start > 0 && start < end ? start : 0,
          });
      }
    }
    eligible.sort(
      (a, b) =>
        (b.plan === "premium") - (a.plan === "premium") || b.end - a.end,
    );
    const selected = eligible[0];
    return selected
      ? {
          plan: selected.plan,
          status: selected.status,
          periodStart: selected.start,
          periodEnd: selected.end,
          pastDueSince: pastDueAnchor,
          unpaidPeriod: selected.unpaidPeriod,
          nonMonthlyPrice,
        }
      : {
          plan: "none",
          status:
            subscriptions.find((s) => s.status === "past_due")?.status ??
            subscriptions[0]?.status ??
            "none",
          periodStart: 0,
          periodEnd: 0,
          pastDueSince: pastDueAnchor,
          unpaidPeriod: false,
          nonMonthlyPrice,
        };
  }
}
/**
 * When the payment of a past_due subscription failed: the creation time of its latest invoice when
 * Stripe expanded it, else the start of its current billing period (a failed renewal opens the new
 * period), else the first time the service recorded the failure, else now. Stripe's timing wins
 * over arrival order, and the earliest known instant is used, so a delayed, repeated or reordered
 * webhook never lengthens the grace.
 */
function paymentFailedAt(sub, pastDueSince, now) {
  const seconds = (n) => (Number.isSafeInteger(n) && n > 0 ? n * 1000 : 0);
  const invoice =
    sub.latest_invoice && typeof sub.latest_invoice === "object"
      ? seconds(sub.latest_invoice.created)
      : 0;
  const periodStarts = (sub.items?.data ?? [])
    .map((item) => seconds(item.current_period_start))
    .concat(seconds(sub.current_period_start))
    .filter(Boolean);
  const fromStripe = invoice || (periodStarts.length ? Math.min(...periodStarts) : 0);
  const known = [fromStripe, pastDueSince > 0 ? pastDueSince : 0].filter(Boolean);
  return Math.min(now, ...known);
}
/**
 * True unless the latest invoice is known to be something other than the period's renewal (for
 * example a mid-period upgrade, `subscription_update`): without that knowledge the current period
 * is treated as unpaid, which only ever counts usage against the last paid period.
 */
function renewalInvoice(sub) {
  const invoice =
    sub.latest_invoice && typeof sub.latest_invoice === "object"
      ? sub.latest_invoice
      : undefined;
  return !invoice?.billing_reason || invoice.billing_reason === "subscription_cycle";
}
