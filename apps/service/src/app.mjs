import { createServer } from "node:http";
import { isIP } from "node:net";
import { timingSafeEqual, randomInt } from "node:crypto";
import { Store, hash, secret } from "./store.mjs";
import { loadConfig, PAYMENT_GRACE_MS } from "./config.mjs";
import { ServiceError, fail } from "./errors.mjs";
import {
  exact,
  textOnly,
  reasoningRequest,
  decideRequest,
  decisionResult,
  validateUsage,
} from "./validation.mjs";
import { StripeBilling } from "./billing.mjs";
import { OidcIdentity } from "./oidc.mjs";
import { CommercialProviders } from "./providers.mjs";
import { createMonitor } from "./monitoring.mjs";
import { interruptedCharge } from "./metering.mjs";
import { PROVIDER_BUDGET_MS, SOCKET_TIMEOUT_MS } from "./deadlines.mjs";
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const normalizeIp = (ip) =>
  ip?.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
function clientAddress(req, config) {
  let current = normalizeIp(req.socket.remoteAddress) ?? "unknown";
  const trusted = config.trustedProxyIps ?? [];
  if (!trusted.includes(current)) return current;
  const chain = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((ip) => normalizeIp(ip.trim()))
    .filter(Boolean);
  if (chain.length > 20 || chain.some((ip) => !isIP(ip)))
    fail(400, "invalidProxyHeaders");
  for (const ip of chain.reverse()) {
    if (!trusted.includes(current)) break;
    current = ip;
  }
  return current;
}
function withoutTimeout({ timeoutMs, ...job }) {
  return job;
}
function canonicalRequest(value) {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRequest(value[key])]),
    );
  return value;
}
// Device user codes: eight consonants (no vowels, so no words; no look-alike
// digits), shown as XXXX-XXXX. About 35 bits, against the wrong-code limits in
// `config.signInLimits` (per address and global) and a ten-minute lifetime.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
function newUserCode() {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  const half = () => Array.from({ length: 4 }, pick).join("");
  return `${half()}-${half()}`;
}
/** Case, spaces and dashes do not matter when the code is typed. */
function normalizeUserCode(value) {
  const letters = String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  return letters.length === 8 &&
    [...letters].every((c) => USER_CODE_ALPHABET.includes(c))
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : "";
}
/** The eight groups of an IPv6 address, lower case without leading zeros. */
function ipv6Groups(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  // An embedded IPv4 tail (for example 64:ff9b::192.0.2.1) is two groups.
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  return [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ].map((g) => g.replace(/^0+(?=.)/, ""));
}
/** A coarse network for display: the IPv4 /24 or IPv6 /48, never the address. */
function network(ip) {
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(ip) === 6) return `${ipv6Groups(ip).slice(0, 3).join(":")}::/48`;
  return "unknown";
}
/**
 * One client for rate limits: an IPv4 address, or the IPv6 /64 that one
 * subscriber gets (rotating the low 64 bits must not buy new limits).
 */
function rateClient(ip) {
  if (isIP(ip) === 6) return `${ipv6Groups(ip).slice(0, 4).join(":")}::/64`;
  return ip;
}
const codeForm = () =>
  `<form action="/auth/device" method="post"><label>Enter the code shown in Live Interview <input name="user_code" value="" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="16"></label> <button>Continue</button></form>`;
/** When and from where the sign-in was started, so a stranger's request stands out. */
function requestOrigin(device, ip) {
  const when = device.created_at
    ? `${new Date(device.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "an unknown time";
  const from = device.origin ?? "unknown";
  const same =
    from !== "unknown" && from === network(ip)
      ? "the same network as this browser"
      : "a different network from this browser";
  return `<p>This sign-in was started at <strong>${escape(when)}</strong> from network <strong>${escape(from)}</strong> (${same}).</p><p>Continue only if you started signing in to Live Interview yourself just now and the app shows this code. If someone sent you a link or a code, stop here.</p>`;
}
const html = (content) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Live Interview</title><body><main><h1>Live Interview</h1>${content}</main></body></html>`;
export function createService({
  config = loadConfig(),
  oidc = new OidcIdentity(config),
  billing = new StripeBilling(config),
  provider = new CommercialProviders(config),
  monitor = createMonitor(config.errorReporting),
  now = Date.now,
  retentionIntervalMs = 6 * 3600000,
  retentionBatch = 500,
} = {}) {
  const store = new Store(config.databasePath, {
      deletionLogPath: config.deletionLogPath,
      rateLimitKey: config.rateLimitKey,
      now,
    }),
    locks = new Map();
  let lastCleanup = 0;
  async function locked(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }
  // Entitlement older than this is refreshed from Stripe; within billingMaxAgeMs
  // it is still served (reasoning routes refresh it behind the request).
  const billingRefreshMs = 60000;
  /** Intents Standard may run on the deep lane (product decision 2026-11: the reviews, not digDeeper). */
  const STANDARD_DEEP_INTENTS = ["checkConversation", "checkObjectives"];
  /**
   * Replaces the cached entitlement with Stripe's. A webhook always asks Stripe.
   * With `maxAgeMs`, freshness is checked again inside the lock, so requests
   * queued behind a refresh reuse its result instead of asking Stripe again.
   * Only a webhook failure clears the cache (the event says something changed);
   * a failed read-path refresh keeps it, and the grace period decides access.
   */
  async function reconcile(user, event, { maxAgeMs } = {}) {
    return locked(`billing:${user.id}`, async () => {
      if (maxAgeMs !== undefined) {
        const latest = store.get("SELECT * FROM users WHERE id=?", user.id);
        if (!latest) return user;
        if (!latest.customer || latest.reconciled_at + maxAgeMs > now())
          return latest;
        user = latest;
      }
      let state;
      try {
        // Read again: a concurrent reconcile may have recorded the payment failure meanwhile.
        const pastDueSince =
          store.get("SELECT past_due_since FROM users WHERE id=?", user.id)
            ?.past_due_since ?? 0;
        state = await billing.reconcile(user.customer, now(), {
          pastDueSince,
        });
      } catch (e) {
        if (event)
          store.run("UPDATE users SET reconciled_at=0 WHERE id=?", user.id);
        throw e;
      }
      if (state.nonMonthlyPrice)
        // Content-free: the operator configured a price that is not billed monthly.
        monitor.captureError(new ServiceError(500, "billingPriceNotMonthly"), {
          route: "billing",
          status: 200,
        });
      store.transaction(() => {
        // In a failed renewal's grace usage keeps counting in the last paid period: the new
        // period is not paid, and counting it from zero would grant a fresh allowance.
        const periodStart =
          state.status === "past_due" && state.unpaidPeriod
            ? store.lastPaidPeriodStart(user.id, state.periodStart ?? 0)
            : (state.periodStart ?? 0);
        store.run(
          "UPDATE users SET plan=?,subscription_status=?,period_start=?,period_end=?,past_due_since=?,reconciled_at=? WHERE id=?",
          state.plan,
          state.status,
          periodStart,
          state.periodEnd,
          state.pastDueSince ?? 0,
          now(),
          user.id,
        );
        if (event)
          store.run(
            "UPDATE webhooks SET status='complete',completed_at=? WHERE id=?",
            now(),
            event.id,
          );
      });
      return store.get("SELECT * FROM users WHERE id=?", user.id);
    });
  }
  const refreshes = new Map();
  /** One background refresh per user at a time; its failure is reported, never thrown. */
  function refreshInBackground(user, where) {
    if (refreshes.has(user.id)) return;
    const task = reconcile(user, undefined, { maxAgeMs: billingRefreshMs })
      .catch((e) =>
        monitor.captureError(
          e instanceof ServiceError
            ? e
            : new ServiceError(503, "billingUnavailable", e),
          { ...where, status: 503 },
        ),
      )
      .finally(() => refreshes.delete(user.id));
    refreshes.set(user.id, task);
  }
  /**
   * Stripe deleted the account's customer, which cancels its subscriptions: the
   * account forgets it and its pending Checkout, and the next Checkout creates a
   * new customer under the next idempotency generation. Run inside a transaction.
   */
  function forgetCustomer(userId, customer) {
    store.run(
      "UPDATE users SET customer=NULL,customer_generation=customer_generation+1,plan='none',subscription_status='canceled',period_start=0,period_end=0,past_due_since=0,reconciled_at=? WHERE id=? AND customer=?",
      now(),
      userId,
      customer,
    );
    store.run("DELETE FROM checkouts WHERE user_id=?", userId);
  }
  async function checkoutSession(user, plan) {
    const pending = store.get(
      "SELECT * FROM checkouts WHERE user_id=?",
      user.id,
    );
    if (pending) {
      const previous = pending.session_id
        ? await billing.getCheckout(user, pending.session_id)
        : await billing.checkout(user, pending.plan, pending.request_id);
      store.run(
        "UPDATE checkouts SET session_id=?,expires=? WHERE user_id=?",
        previous.id,
        previous.expiresAtMs,
        user.id,
      );
      if (previous.status === "open") {
        if (pending.plan === plan && previous.expiresAtMs > now())
          return { url: previous.url };
        await billing.expireCheckout(user, previous.id);
      } else if (
        previous.status === "complete" &&
        !["canceled", "incomplete_expired"].includes(user.subscription_status)
      )
        fail(409, "checkoutPaymentPending");
      store.run("DELETE FROM checkouts WHERE user_id=?", user.id);
    }
    const operation = secret();
    store.run(
      "INSERT INTO checkouts VALUES(?,?,?,NULL,?)",
      user.id,
      operation,
      plan,
      now() + 86400000,
    );
    const session = await billing.checkout(user, plan, operation);
    store.run(
      "UPDATE checkouts SET session_id=?,expires=? WHERE user_id=?",
      session.id,
      session.expiresAtMs,
      user.id,
    );
    if (session.status !== "open") fail(409, "checkoutPaymentPending");
    return { url: session.url };
  }
  /** End of the payment grace of a past_due account (see PAYMENT_GRACE_MS), 0 when none applies. */
  function paymentGraceEnd(user) {
    return user.subscription_status === "past_due" && user.past_due_since > 0
      ? user.past_due_since + PAYMENT_GRACE_MS
      : 0;
  }
  /**
   * The lane a job runs on, decided here and never trusted from the app. Standard runs everything on
   * the fast lane except the live reviews (STANDARD_DEEP_INTENTS), and those only as live work: a
   * preparation, automatic preparation or synthesis job labelled as a review still runs fast.
   * Premium runs the lane the app declares.
   */
  function servedLane(plan, job) {
    if (plan !== "standard") return job.lane;
    const live = job.usageFeature === undefined || job.usageFeature === "live";
    return live && STANDARD_DEEP_INTENTS.includes(job.intent) ? job.lane : "fast";
  }
  function account(user) {
    const graceEnd = paymentGraceEnd(user);
    const subscribed =
      (["active", "trialing"].includes(user.subscription_status) ||
        graceEnd > now()) &&
      user.period_end > now() &&
      user.reconciled_at + config.billingMaxAgeMs > now();
    const period = store.usagePeriod(user.id, now());
    const d = new Date(now());
    return {
      configured: config.authConfigured,
      signedIn: true,
      user: {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
        ...(user.name ? { name: user.name } : {}),
      },
      plan: subscribed ? user.plan : "none",
      subscriptionStatus: user.subscription_status,
      canUseAI:
        subscribed &&
        config.authConfigured &&
        config.providerConfigured &&
        config.billingConfigured,
      canAutoPrepare:
        subscribed &&
        config.authConfigured &&
        user.plan === "premium" &&
        config.providerConfigured &&
        config.billingConfigured,
      usage: store.usage(user.id, now()),
      // When the counters start again: the billing period's end, else the next UTC month.
      usageResetsAtMs: /^\d{4}-\d{2}$/.test(period)
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
        : user.period_end,
      ...(subscribed ? { limits: config.limits[user.plan] } : {}),
      // A failed renewal inside its grace: AI continues until this instant unless the invoice is paid.
      ...(subscribed && graceEnd ? { paymentGraceEndsAtMs: graceEnd } : {}),
      billingAvailable: config.billingConfigured,
      ...(!config.providerConfigured
        ? { code: "providerNotConfigured" }
        : !config.billingConfigured
          ? { code: "billingNotConfigured" }
          : {}),
    };
  }
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const json = (status, value) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    const page = (content, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html(content));
    };
    const redirect = (url) => {
      res.writeHead(302, { location: String(url) });
      res.end();
    };
    // Error monitoring sees only the route, method and status, never the request itself.
    let where = { route: "unmatched" };
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const url = new URL(req.url, config.origin || "http://localhost"),
        path = url.pathname,
        method = req.method,
        // Parsed first on every route: the deploy smoke test relies on /health
        // refusing forged forwarding headers.
        ip = clientAddress(req, config),
        client = rateClient(ip);
      where = { route: path, method };
      // Liveness: the process answers. It never touches the database.
      if (method === "GET" && path === "/health")
        return json(200, { ok: true });
      // Readiness: the database answers a read and commits a write. Content-free either way.
      if (method === "GET" && path === "/ready") {
        try {
          store.ready(now());
          return json(200, { ready: true });
        } catch {
          return json(503, { ready: false });
        }
      }
      if (now() - lastCleanup > 60000) {
        store.cleanup(now());
        lastCleanup = now();
      }
      if (method === "GET" && path === "/v1/config")
        return json(200, {
          serviceName: "Live Interview",
          authConfigured: config.authConfigured,
          billingConfigured: config.billingConfigured,
          calendarClients: config.calendarClients,
        });
      if (method === "GET" && path === "/billing/return")
        return page(
          "<p>Return to Live Interview to refresh your account. Subscription access is confirmed by the billing service.</p>",
        );
      async function raw(limit = 262144) {
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > limit) fail(413, "requestTooLarge");
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) fail(413, "requestTooLarge");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
      async function body() {
        const buffer = await raw();
        if (
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        )
          fail(415, "jsonRequired");
        try {
          return JSON.parse(buffer.toString("utf8"));
        } catch {
          fail(400, "invalidJson");
        }
      }
      async function form() {
        if (
          String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        )
          return body();
        const buffer = await raw(8192);
        if (
          !String(req.headers["content-type"] || "").startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          fail(415, "formRequired");
        return Object.fromEntries(new URLSearchParams(buffer.toString()));
      }
      function authenticated() {
        const h = req.headers.authorization;
        if (!h || !h.startsWith("Bearer ")) fail(401, "unauthenticated");
        return { user: store.session(h.slice(7), now()), token: h.slice(7) };
      }
      function authReady() {
        if (!config.authConfigured) fail(503, "authNotConfigured");
      }
      function flow() {
        const cookie = String(req.headers.cookie || "")
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("li_device="))
          ?.slice(10);
        if (!cookie || cookie.length > 100) fail(400, "invalidBrowserFlow");
        const f = store.get(
          "SELECT * FROM flows WHERE cookie_hash=? AND expires>?",
          hash(cookie),
          now(),
        );
        if (!f) fail(400, "invalidBrowserFlow");
        return f;
      }
      function csrf(f, b) {
        exact(b, ["csrf"]);
        if (typeof b.csrf !== "string" || !equal(hash(b.csrf), f.csrf_hash))
          fail(400, "invalidBrowserFlow");
        if (req.headers.origin && req.headers.origin !== config.origin)
          fail(400, "invalidBrowserFlow");
      }
      if (method === "POST" && path === "/v1/auth/device") {
        authReady();
        store.rate(
          `device:${client}`,
          config.signInLimits.deviceStartsPerIp,
          3600000,
          now(),
        );
        const b = await body();
        exact(b, []);
        const deviceCode = secret(),
          userCode = newUserCode(),
          expiresAtMs = now() + config.deviceTtlMs;
        store.run(
          "INSERT INTO devices(code_hash,user_code,expires,created_at,origin,client_hash) VALUES(?,?,?,?,?,?)",
          hash(deviceCode),
          userCode,
          expiresAtMs,
          now(),
          network(ip),
          // Keyed hash of the starting client, so a held client can still use its own codes.
          store.rateKeyHash(`device-client:${client}`),
        );
        // The person types the code shown in the app: a link that carries it
        // (RFC 8628 verification_uri_complete) would let a phishing link skip
        // the one check that ties the browser to the right Mac.
        return json(200, {
          deviceCode,
          userCode,
          verificationUri: `${config.origin}/auth/device`,
          pollIntervalSeconds: config.pollIntervalMs / 1000,
          expiresAtMs,
        });
      }
      if (method === "POST" && path === "/v1/auth/device/poll") {
        authReady();
        const b = await body();
        exact(b, ["deviceCode"]);
        if (typeof b.deviceCode !== "string" || b.deviceCode.length > 100)
          fail(400, "invalidDeviceCode");
        store.rate(`poll:${client}`, 1000, 3600000, now());
        const result = store.transaction(() => {
          const d = store.get(
            "SELECT * FROM devices WHERE code_hash=?",
            hash(b.deviceCode),
          );
          if (!d || d.expires <= now() || d.consumed)
            fail(400, "invalidDeviceCode");
          if (d.last_poll && d.last_poll + config.pollIntervalMs > now())
            fail(429, "slowDown");
          store.run(
            "UPDATE devices SET last_poll=? WHERE code_hash=?",
            now(),
            d.code_hash,
          );
          if (!d.user_id) return { status: "pending" };
          const sessionToken = secret(),
            expiresAtMs = now() + config.sessionTtlMs;
          store.createSession(sessionToken, d.user_id, expiresAtMs, now());
          store.run(
            "UPDATE devices SET consumed=1,origin=NULL WHERE code_hash=?",
            d.code_hash,
          );
          store.run("DELETE FROM flows WHERE device_hash=?", d.code_hash);
          return { sessionToken, expiresAtMs };
        });
        return json(200, result);
      }
      // Never prefilled, whatever the query says: the person types the code
      // their own app shows.
      if (method === "GET" && path === "/auth/device") {
        authReady();
        return page(codeForm());
      }
      if (method === "POST" && path === "/auth/device") {
        authReady();
        const limits = config.signInLimits;
        store.rate(`browser:${client}`, limits.codeEntriesPerIp, 3600000, now());
        // Guessing needs wrong codes. Refusals are per client (an IPv4 address
        // or IPv6 /64): an hourly cap, and a wait after several in a row. A
        // client that is held may still use a code started from that same
        // client (a colleague behind the same NAT); every other code, right or
        // wrong, gets the same refusal, so being held reveals nothing. The
        // /24 (IPv6 /48) and the whole service are only watched: past a
        // threshold they raise a content-free alert and the /24 answers wrong
        // codes a little slower. Neither ever refuses anyone.
        const guess = `wrong-code:${client}`;
        const retryAt = store.backoffUntil(guess, now());
        const capped = store.rateExceeded(guess, limits.wrongCodesPerClient, now());
        if (req.headers.origin && req.headers.origin !== config.origin)
          fail(400, "invalidBrowserFlow");
        const b = await form();
        exact(b, ["user_code"]);
        const code = normalizeUserCode(b.user_code);
        const d = code
          ? store.get(
              "SELECT * FROM devices WHERE user_code=? AND expires>? AND consumed=0 AND user_id IS NULL",
              code,
              now(),
            )
          : undefined;
        const held = retryAt || capped;
        const ownCode =
          d?.client_hash && d.client_hash === store.rateKeyHash(`device-client:${client}`);
        if (!d || (held && !ownCode)) {
          store.rate(guess, Infinity, 3600000, now());
          const area = store.rate(`wrong-code-network:${network(ip)}`, Infinity, 3600000, now());
          const global = store.rate("wrong-code", Infinity, 3600000, now());
          if (
            area === limits.wrongCodesPerNetworkAlert ||
            global === limits.wrongCodesGlobalAlert
          )
            monitor.captureError(new ServiceError(429, "signInGuessingSuspected"), {
              route: "/auth/device",
              method: "POST",
              status: 429,
            });
          if (retryAt) {
            const seconds = Math.max(1, Math.ceil((retryAt - now()) / 1000));
            res.setHeader("Retry-After", String(seconds));
            return page(
              `<p>Too many wrong codes from this address. Wait ${seconds} second${seconds === 1 ? "" : "s"}, then enter the code shown in Live Interview again.</p>`,
              429,
            );
          }
          if (capped) fail(429, "rateLimited");
          // While the service-wide rate is elevated, a client's first wrong
          // code is still free but every later consecutive one waits.
          const elevated = global >= limits.wrongCodesGlobalAlert;
          store.recordFailure(guess, now(), {
            free: elevated ? 1 : limits.wrongCodeFreeStreak,
            base: limits.wrongCodeBackoffMs,
            max: limits.wrongCodeBackoffMaxMs,
            window: 3600000,
          });
          if (area >= limits.wrongCodesPerNetworkAlert && limits.wrongCodeNetworkDelayMs > 0)
            await new Promise((resolve) =>
              setTimeout(resolve, limits.wrongCodeNetworkDelayMs),
            );
          return page(
            `<p>That code is not valid or has expired. Check the code in Live Interview and try again.</p>${codeForm()}`,
            400,
          );
        }
        // A valid entry ends this client's streak of wrong codes, never its hourly cap.
        store.clearFailures(guess);
        // One code opens a bounded number of browser flows, wherever they come from.
        try {
          store.rate(
            `code-entry:${d.code_hash}`,
            limits.entriesPerCode,
            config.deviceTtlMs,
            now(),
          );
        } catch (e) {
          if (e?.code !== "rateLimited") throw e;
          return page(
            "<p>This code has been entered too many times. Start signing in again from Live Interview to get a new code.</p>",
            429,
          );
        }
        const cookie = secret(),
          csrfToken = secret(),
          f = { state: secret(), nonce: secret(), verifier: secret() };
        store.run(
          "INSERT INTO flows VALUES(?,?,?,?,?,?,?,?,?)",
          hash(cookie),
          d.code_hash,
          hash(csrfToken),
          f.state,
          f.nonce,
          f.verifier,
          d.expires,
          "new",
          null,
        );
        res.setHeader(
          "Set-Cookie",
          `li_device=${cookie}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${config.origin.startsWith("https:") ? "; Secure" : ""}`,
        );
        return page(
          `<p>Connect a Mac with code <strong>${escape(d.user_code)}</strong>.</p>${requestOrigin(d, ip)}<form action="/auth/device/authorize" method="post"><input type="hidden" name="csrf" value="${csrfToken}"><button>Sign in to continue</button></form>`,
        );
      }
      if (method === "POST" && path === "/auth/device/authorize") {
        authReady();
        const f = flow(),
          b = await form();
        csrf(f, b);
        if (f.stage !== "new") fail(400, "invalidBrowserFlow");
        store.run(
          "UPDATE flows SET stage='authorizing' WHERE cookie_hash=?",
          f.cookie_hash,
        );
        return redirect(await oidc.authorizationUrl(f));
      }
      if (method === "GET" && path === "/auth/callback") {
        authReady();
        const f = flow();
        if (
          f.stage !== "authorizing" ||
          !equal(url.searchParams.get("state"), f.state)
        )
          fail(400, "invalidBrowserFlow");
        store.run(
          "UPDATE flows SET stage='exchanging' WHERE cookie_hash=?",
          f.cookie_hash,
        );
        let identity;
        try {
          identity = await oidc.authenticate(url, f);
        } catch (e) {
          identity = undefined;
          // The person cancelled or was refused at the identity provider, or the
          // code expired or was already used: normal traffic. Anything else (the
          // provider unreachable, its keys or tokens wrong) is an operator problem,
          // reported by class only.
          const personal =
            e?.code === "OAUTH_AUTHORIZATION_RESPONSE_ERROR" ||
            (e?.code === "OAUTH_RESPONSE_BODY_ERROR" &&
              e?.error === "invalid_grant");
          if (!personal)
            monitor.captureError(
              new ServiceError(502, "identityExchangeFailed", e),
              { ...where, status: 400 },
            );
        }
        if (
          !identity ||
          identity.issuer !== config.oidc.issuer ||
          typeof identity.subject !== "string" ||
          !identity.subject ||
          identity.subject.length > 500
        ) {
          // Back to the start of this browser flow with fresh one-time values,
          // so the person can retry without a new code from the app.
          const retry = secret();
          store.run(
            "UPDATE flows SET stage='new',csrf_hash=?,state=?,nonce=?,verifier=?,identity=NULL WHERE cookie_hash=?",
            hash(retry),
            secret(),
            secret(),
            secret(),
            f.cookie_hash,
          );
          return page(
            `<p>Sign-in did not complete, so no Mac was connected.</p><form action="/auth/device/authorize" method="post"><input type="hidden" name="csrf" value="${retry}"><button>Try signing in again</button></form>`,
            400,
          );
        }
        const csrfToken = secret();
        store.run(
          "UPDATE flows SET stage='verified',identity=?,csrf_hash=? WHERE cookie_hash=?",
          JSON.stringify(identity),
          hash(csrfToken),
          f.cookie_hash,
        );
        const d = store.get(
          "SELECT user_code,created_at,origin FROM devices WHERE code_hash=?",
          f.device_hash,
        );
        return page(
          `<p>Signed in as ${escape(identity.email ?? identity.name ?? "your account")}.</p><p>Approve the Mac displaying code <strong>${escape(d.user_code)}</strong>.</p>${requestOrigin(d, ip)}<form action="/auth/device/approve" method="post"><input type="hidden" name="csrf" value="${csrfToken}"><button>Connect this Mac</button></form>`,
        );
      }
      if (method === "POST" && path === "/auth/device/approve") {
        authReady();
        const f = flow(),
          b = await form();
        csrf(f, b);
        if (f.stage !== "verified") fail(400, "invalidBrowserFlow");
        store.transaction(() => {
          const d = store.get(
            "SELECT * FROM devices WHERE code_hash=? AND expires>? AND consumed=0 AND user_id IS NULL",
            f.device_hash,
            now(),
          );
          if (!d) fail(400, "invalidDeviceCode");
          const id = store.user(JSON.parse(f.identity), now());
          store.run(
            "UPDATE devices SET user_id=?,origin=NULL WHERE code_hash=?",
            id,
            f.device_hash,
          );
          store.run("DELETE FROM flows WHERE device_hash=?", f.device_hash);
        });
        res.setHeader(
          "Set-Cookie",
          "li_device=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0",
        );
        return page(
          "<p>Connected. You can close this page and return to Live Interview.</p>",
        );
      }
      if (method === "POST" && path === "/v1/auth/logout") {
        const { token } = authenticated();
        exact(await body(), []);
        store.revokeSession(token);
        return json(200, { ok: true });
      }
      // Sliding renewal: near expiry the app trades its session for a new one
      // (see Store.renewSession). Retries and concurrent calls get the same token.
      if (method === "POST" && path === "/v1/auth/renew") {
        const h = req.headers.authorization;
        if (!h || !h.startsWith("Bearer ") || h.length > 263)
          fail(401, "unauthenticated");
        const token = h.slice(7);
        // Per client first, so unknown tokens cannot each create a counter.
        store.rate(`renew-client:${client}`, config.renewalsPerClient, 3600000, now());
        exact(await body(), []);
        store.session(token, now());
        store.rate(`renew:${hash(token)}`, 30, 3600000, now());
        return json(
          200,
          store.renewSession(token, now(), {
            ttl: config.sessionTtlMs,
            max: config.sessionMaxLifetimeMs,
            window: config.sessionRenewWindowMs,
            grace: config.sessionRenewGraceMs,
          }),
        );
      }
      // Signs out every Mac of the account: all its sessions, and any sign-in
      // already approved in a browser but not yet collected by the app.
      if (method === "POST" && path === "/v1/auth/logout-all") {
        const { user } = authenticated();
        exact(await body(), []);
        store.transaction(() => {
          store.run("UPDATE sessions SET revoked=1 WHERE user_id=?", user.id);
          store.run(
            "UPDATE devices SET consumed=1,origin=NULL WHERE user_id=? AND consumed=0",
            user.id,
          );
        });
        return json(200, { ok: true });
      }
      if (method === "POST" && path === "/v1/billing/webhook") {
        if (!config.billingConfigured) fail(503, "billingNotConfigured");
        const event = billing.verify(
          await raw(1048576),
          req.headers["stripe-signature"],
        );
        return await locked(`event:${event.id}`, async () => {
          const old = store.get("SELECT * FROM webhooks WHERE id=?", event.id);
          if (old?.status === "complete") return json(200, { received: true });
          const object = event.data?.object;
          // A customer event's object is the customer itself; others name it.
          const customer =
            object?.object === "customer"
              ? object.id
              : typeof object?.customer === "string"
                ? object.customer
                : object?.customer?.id;
          // Events of a customer with no account (for example one just deleted) keep no customer id.
          // Lookup and insert commit together, so an account erased in between is never re-linked.
          const owner = store.transaction(() => {
            const found =
              typeof customer === "string"
                ? store.get("SELECT * FROM users WHERE customer=?", customer)
                : undefined;
            store.run(
              "INSERT OR IGNORE INTO webhooks(id,type,customer,status,received_at) VALUES(?,?,?,'pending',?)",
              event.id,
              event.type,
              found ? customer : null,
              now(),
            );
            return found;
          });
          if (event.type === "customer.deleted" && owner) {
            await locked(`billing:${owner.id}`, async () =>
              store.transaction(() => {
                forgetCustomer(owner.id, customer);
                store.run(
                  "UPDATE webhooks SET status='complete',completed_at=? WHERE id=?",
                  now(),
                  event.id,
                );
              }),
            );
            return json(200, { received: true });
          }
          const relevant =
            event.type.startsWith("customer.subscription.") ||
            event.type.startsWith("checkout.session.") ||
            [
              "invoice.paid",
              "invoice.payment_failed",
              "invoice.payment_action_required",
            ].includes(event.type);
          const user = relevant ? owner : undefined;
          if (user) {
            try {
              await reconcile(user, event);
            } catch (e) {
              fail(503, "billingReconciliationFailed", e);
            }
          } else
            store.run(
              "UPDATE webhooks SET status='complete',completed_at=? WHERE id=?",
              now(),
              event.id,
            );
          return json(200, { received: true });
        });
      }
      if (path === "/v1/account" && method === "GET") {
        const { user } = authenticated();
        let latest = user;
        if (
          config.billingConfigured &&
          user.customer &&
          user.reconciled_at + billingRefreshMs <= now()
        ) {
          try {
            latest = await reconcile(user, undefined, {
              maxAgeMs: billingRefreshMs,
            });
          } catch (e) {
            monitor.captureError(e, { ...where, status: 200 });
            // The cached entitlement still counts until billingMaxAgeMs runs out.
            return json(200, {
              ...account(user),
              code: "billingUnavailable",
            });
          }
        }
        return json(200, account(latest));
      }
      if (path === "/v1/account/export" && method === "GET") {
        const { user, token } = authenticated();
        store.rate(`account-export:${user.id}`, 5, 3600000, now());
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="live-interview-account-export.json"',
        );
        return json(200, store.exportAccount(user, hash(token), now()));
      }
      if (path === "/v1/account/delete" && method === "POST") {
        const header = req.headers.authorization;
        if (!header?.startsWith("Bearer ") || header.length > 263)
          fail(401, "unauthenticated");
        const tokenHash = hash(header.slice(7));
        store.rate(`account-delete:${client}`, 30, 3600000, now());
        const b = await body();
        exact(b, ["confirm"]);
        if (b.confirm !== "delete-account") fail(400, "confirmationRequired");
        const result = (receipt, alreadyDeleted) =>
          json(200, {
            deleted: true,
            alreadyDeleted,
            deletedAtMs: receipt.deleted_at,
            stripeCustomerDeleted: receipt.had_customer === 1,
          });
        // A retry after a lost response: the account is gone but the receipt still answers.
        const earlier = store.deletionReceipt(tokenHash, now());
        if (earlier) return result(earlier, true);
        const { user, token } = authenticated();
        store.rate(`account-delete:${user.id}`, 5, 3600000, now());
        return await locked(`checkout:${user.id}`, async () => {
          const current = store.get("SELECT * FROM users WHERE id=?", user.id);
          if (!current) {
            const receipt = store.deletionReceipt(tokenHash, now());
            if (!receipt) fail(401, "unauthenticated");
            return result(receipt, true);
          }
          if (current.customer) {
            if (!config.billingConfigured) fail(503, "billingNotConfigured");
            try {
              const pending = store.get(
                "SELECT * FROM checkouts WHERE user_id=?",
                current.id,
              );
              if (pending?.session_id)
                await billing
                  .expireCheckout(current, pending.session_id)
                  .catch(() => {});
              await billing.deleteCustomer(current);
            } catch (e) {
              if (e instanceof ServiceError) throw e;
              fail(502, "billingUnavailable", e);
            }
          }
          store.deleteAccount(current, hash(token), user.session_expires, now());
          return result(store.deletionReceipt(hash(token), now()), false);
        });
      }
      if (
        method === "POST" &&
        ["/v1/billing/checkout", "/v1/billing/portal"].includes(path)
      ) {
        const { user } = authenticated();
        if (!config.billingConfigured) fail(503, "billingNotConfigured");
        store.rate(`billing-action:${user.id}`, 10, 3600000, now());
        const b = await body();
        try {
          if (path.endsWith("checkout")) {
            exact(b, ["plan"]);
            if (!["standard", "premium"].includes(b.plan))
              fail(400, "invalidPlan");
            return await locked(`checkout:${user.id}`, async () => {
              let current = store.get(
                "SELECT * FROM users WHERE id=?",
                user.id,
              );
              // A customer deleted at Stripe whose customer.deleted event was missed.
              if (
                current.customer &&
                !(await billing.existingCustomer(current))
              ) {
                await locked(`billing:${user.id}`, async () =>
                  store.transaction(() =>
                    forgetCustomer(user.id, current.customer),
                  ),
                );
                current = store.get("SELECT * FROM users WHERE id=?", user.id);
              }
              if (current.customer) {
                current = await reconcile(current);
                if (
                  [
                    "active",
                    "trialing",
                    "past_due",
                    "incomplete",
                    "unpaid",
                    "paused",
                  ].includes(current.subscription_status)
                )
                  fail(409, "useBillingPortal");
              } else {
                const customer = await billing.customer(current);
                store.run(
                  "UPDATE users SET customer=? WHERE id=?",
                  customer,
                  user.id,
                );
                current = { ...current, customer };
              }
              return json(200, await checkoutSession(current, b.plan));
            });
          }
          exact(b, []);
          if (!user.customer) fail(409, "billingCustomerUnavailable");
          return json(200, await billing.portal(user));
        } catch (e) {
          if (e instanceof ServiceError) throw e;
          fail(502, "billingUnavailable", e);
        }
      }
      if (
        method === "POST" &&
        ["/v1/reasoning", "/v1/reasoning/stream", "/v1/decide"].includes(path)
      ) {
        // The streaming route runs the same admission, metering and
        // validation as /v1/reasoning; only the response is delivered as
        // server-sent events once the provider has produced its first text.
        const streaming = path === "/v1/reasoning/stream";
        // A relative timeout is measured from here, on the service's own clock.
        const receivedAt = Date.now();
        const { user } = authenticated();
        const b = await body();
        const validate =
          path === "/v1/decide"
            ? (decideRequest(b), null)
            : reasoningRequest(b);
        const workClass =
          b.job &&
          (b.job.usageFeature === "automaticPreparation" ||
            (b.job.usageFeature === "synthesis" &&
              b.job.trigger === "automatic"))
            ? "background"
            : "interactive";
        // Automatic live guidance and decisions are interactive work, but they
        // may not take the last of the user's slots: a hotkey card
        // (trigger "requested") must never wait behind them.
        const automatic = !b.job || b.job.trigger === "automatic";
        const jobIdentity = b.job
          ? {
              jobKey: hash(b.job.id),
              // Timing is not part of what a job asks: a retry with a fresh
              // timeout or deadline is the same request.
              digest: hash(
                JSON.stringify(
                  canonicalRequest({
                    ...b,
                    job: { ...b.job, deadlineMs: undefined, timeoutMs: undefined },
                  }),
                ),
              ),
              workClass,
              automatic,
            }
          : { workClass, automatic };
        store.assertFreshJob(user.id, jobIdentity);
        let current = user;
        if (
          config.billingConfigured &&
          user.customer &&
          user.reconciled_at + billingRefreshMs <= now()
        ) {
          // Inside the grace period the cached entitlement answers at once and
          // Stripe is asked behind the request: a Stripe blip never blocks a
          // paying user. Past it, access waits for (and needs) a fresh answer.
          if (user.reconciled_at + config.billingMaxAgeMs > now())
            refreshInBackground(user, where);
          else
            try {
              current = await reconcile(user, undefined, {
                maxAgeMs: billingRefreshMs,
              });
            } catch (e) {
              fail(503, "billingUnavailable", e);
            }
        }
        const status = account(current);
        if (!config.providerConfigured) fail(503, "providerNotConfigured");
        if (!b.job && !config.decideConfigured)
          fail(503, "decisionNotConfigured");
        if (!status.canUseAI) fail(402, "subscriptionRequired");
        if (
          b.job?.usageFeature === "automaticPreparation" &&
          !status.canAutoPrepare
        )
          fail(403, "premiumRequired");
        // `timeoutMs` (relative, preferred) or the older absolute `deadlineMs`,
        // which breaks when the Mac's clock and the service's disagree.
        const relative = b.job?.timeoutMs !== undefined;
        if (relative) {
          if (receivedAt + b.job.timeoutMs <= Date.now()) fail(408, "jobExpired");
        } else if (b.job) {
          if (b.job.deadlineMs <= now()) fail(408, "jobExpired");
          if (b.job.deadlineMs > now() + PROVIDER_BUDGET_MS)
            fail(400, "invalidJob");
        }
        const selectedJob = b.job
          ? {
              ...withoutTimeout(b.job),
              // The provider runs until this instant of the service's clock.
              deadlineMs: relative
                ? receivedAt + b.job.timeoutMs
                : b.job.deadlineMs,
              lane: servedLane(status.plan, b.job),
            }
          : undefined;
        const multiplier = selectedJob?.lane === "deep" ? 2 : 1;
        const input =
          Buffer.byteLength(JSON.stringify(b)) * multiplier + 2048 * multiplier;
        const decisionBound = b.questions
          ? Buffer.byteLength(JSON.stringify(b.questions)) +
            Object.values(b.questions).reduce(
              (sum, q) =>
                sum + 256 + 128 * Object.keys(q.criteria ?? {}).length,
              512,
            )
          : 0;
        const output = b.questions
          ? decisionBound
          : config.maxOutput * multiplier;
        // The client is already gone (it hung up during sign-in checks or billing
        // reconciliation): nothing was dispatched, so nothing is reserved or charged.
        if (abort.signal.aborted) return;
        const reservation = store.reserve(
          user.id,
          config.limits[status.plan],
          input,
          output,
          config,
          now(),
          jobIdentity,
        );
        let usage,
          dispatchOutcome = "failed",
          streamStarted = false,
          receivedBytes = 0,
          // A complete provider response whose usage was kept out of `usage`
          // because the result was then rejected: undefined when there was none.
          reported,
          // The provider refused the call before running it (non-2xx, no body).
          refused = false;
        // Bytes the provider is asked to read; the metering rule prices an
        // interrupted streamed call from these and from the text received.
        const sentBytes = b.job
          ? Buffer.byteLength(b.prompt) +
            Buffer.byteLength(JSON.stringify(b.job.outputSchema))
          : 0;
        // Headers go out with the first event, so every failure before the
        // first text is still an ordinary JSON error with its own status.
        const send = async (event, data) => {
          if (!streamStarted) {
            streamStarted = true;
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "x-accel-buffering": "no",
            });
          }
          if (res.destroyed) throw new Error("clientClosed");
          if (res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            return;
          await new Promise((resolve, reject) => {
            const closed = () => {
              res.off("drain", drained);
              reject(new Error("clientClosed"));
            };
            const drained = () => {
              res.off("close", closed);
              resolve();
            };
            res.once("drain", drained);
            res.once("close", closed);
          });
        };
        try {
          if (validate) {
            const result = await provider.run(
              selectedJob,
              b.prompt,
              abort.signal,
              streaming
                ? (text) => {
                    // Counted when the provider produced it, even if the client is gone.
                    receivedBytes += Buffer.byteLength(text);
                    return send("delta", { text });
                  }
                : undefined,
              streaming ? () => send("reset", {}) : undefined,
            );
            reported = result?.usage;
            if (
              !result ||
              !validate(result.output) ||
              typeof result.model !== "string" ||
              !["managedFast", "managedDeep"].includes(result.provider)
            )
              fail(502, "invalidProviderResult");
            try {
              textOnly(result.output);
            } catch {
              fail(502, "invalidProviderResult");
            }
            validateUsage(result.usage, input, output);
            usage = result.usage;
            dispatchOutcome = "complete";
            const payload = {
              jobId: b.job.id,
              provider: result.provider,
              model: result.model,
              output: result.output,
              basis: b.job.basis,
              outcome: "complete",
              ...(usage ? { usage } : {}),
            };
            if (!streaming) return json(200, payload);
            await send("result", payload);
            return res.end();
          }
          const result = await provider.decide(
            b.basis,
            b.effectiveContext ?? b.basis.snapshot.context,
            b.questions,
            abort.signal,
          );
          reported = result?.usage;
          decisionResult(result, b.questions);
          validateUsage(result.usage, input, output);
          usage = result.usage;
          dispatchOutcome = "complete";
          return json(200, {
            basis: b.basis,
            answers: result.answers,
            model: result.model,
            ...(usage ? { usage } : {}),
          });
        } catch (e) {
          refused = e?.providerNotAccepted === true && receivedBytes === 0;
          if (streamStarted) {
            if (!abort.signal.aborted && e?.message !== "clientClosed")
              monitor.captureError(
                e instanceof ServiceError
                  ? e
                  : new ServiceError(502, "providerUnavailable", e),
                {
                  ...where,
                  status: e instanceof ServiceError ? e.status : 502,
                },
              );
            // The 200 status is already sent: report a code, never provider text.
            if (!res.writableEnded && !res.destroyed)
              res.end(
                `event: error\ndata: ${JSON.stringify({
                  code:
                    e instanceof ServiceError
                      ? e.code
                      : abort.signal.aborted
                        ? "requestCancelled"
                        : "providerUnavailable",
                })}\n\n`,
              );
            return;
          }
          if (e instanceof ServiceError) throw e;
          fail(
            502,
            abort.signal.aborted ? "requestCancelled" : "providerUnavailable",
            e,
          );
        } finally {
          // A completed call settles to the provider's report. A response the
          // service then rejected still carries the provider's own report:
          // use it when it fits the reservation, and keep the whole
          // reservation when it does not. With no report at all, a cancelled
          // or failed call keeps the whole reservation unless streamed text
          // shows how far the provider got (see metering.mjs). A call the
          // provider refused before running is refunded, request included.
          let charge = usage;
          if (refused) charge = { input: 0, output: 0 };
          else if (!charge && dispatchOutcome !== "complete") {
            if (reported === undefined || reported === null)
              charge = interruptedCharge({
                sentBytes,
                receivedBytes,
                multiplier,
                reserved: { input, output },
              });
            else
              try {
                validateUsage(reported, input, output);
                charge = reported;
              } catch {}
          }
          store.settle(reservation, charge, dispatchOutcome, now(), {
            refundRequest: refused,
          });
        }
      }
      fail(404, "notFound");
    } catch (e) {
      const status = e instanceof ServiceError ? e.status : 500;
      // Server-side failures only. Client errors, quota and entitlement refusals are normal traffic.
      // A cancelled request is the client leaving, not a fault.
      if (status >= 500 && e?.code !== "requestCancelled")
        monitor.captureError(e, { ...where, status });
      const code = e instanceof ServiceError ? e.code : "internalError";
      if (!res.headersSent && !res.destroyed) {
        // Browser routes answer with a page a person can read, never raw JSON.
        if (where.route.startsWith("/auth/"))
          page(
            `<p>This sign-in step could not be completed (${escape(code)}). Start signing in again from Live Interview.</p>`,
            status,
          );
        else json(status, { error: { code } });
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.maxHeadersCount = 50;
  // An idle service still ends the month: the usage records of deleted accounts must not wait for traffic.
  const monthEnd = setInterval(() => {
    try {
      store.expireDeletionRecords(now());
    } catch {}
  }, 3600000);
  monthEnd.unref();
  // An idle service also forgets the network prefix of expired sign-in codes within a minute.
  const deviceOrigins = setInterval(() => {
    try {
      store.forgetDeviceOrigins(now());
    } catch {}
  }, 60000);
  deviceOrigins.unref();
  // Retention: usage and job rows after 13 months, Stripe event ids after 35 days. The
  // database is synchronous, so the pass deletes a bounded batch at a time and gives the
  // event loop back in between; requests are served while it runs. It starts after
  // startup returns and then repeats, and a failure only means the next pass tries again.
  let closed = false,
    pruning;
  const retentionPass = async () => {
    try {
      let removed = false;
      for (;;) {
        if (closed) return;
        const { deleted, more } = store.pruneRetention(now(), retentionBatch);
        removed ||= Object.values(deleted).some((n) => n > 0);
        if (!more) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (removed && !closed) store.truncateLog();
    } catch (error) {
      // Constant code and a content-free monitoring event; the next pass simply tries again.
      process.stderr.write('{"code":"retentionPassFailed"}\n');
      monitor.captureError(error, { route: "retention", status: 500 });
    }
  };
  const prune = () =>
    pruning ?? (pruning = retentionPass().finally(() => (pruning = undefined)));
  const startup = setImmediate(prune);
  const retention = setInterval(prune, retentionIntervalMs);
  retention.unref();
  return {
    server,
    /** Runs one retention pass now (also used by the timers); resolves when it has finished. */
    prune,
    close() {
      closed = true;
      clearImmediate(startup);
      clearInterval(retention);
      clearInterval(monthEnd);
      clearInterval(deviceOrigins);
      store.close();
    },
  };
}
