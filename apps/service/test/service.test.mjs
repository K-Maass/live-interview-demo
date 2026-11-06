import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { createService } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { StripeBilling } from "../src/billing.mjs";
import { CommercialProviders } from "../src/providers.mjs";
import { createMonitor } from "../src/monitoring.mjs";
import { ServiceError } from "../src/errors.mjs";

const env = {
  SERVICE_ORIGIN: "https://service.example",
  DATABASE_PATH: ":memory:",
  OIDC_ISSUER: "https://identity.example",
  OIDC_CLIENT_ID: "public-app",
  OIDC_CLIENT_SECRET: "synthetic-test-client-secret",
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_MODE: "test",
  STRIPE_STANDARD_PRICE_ID: "price_standard",
  STRIPE_PREMIUM_PRICE_ID: "price_premium",
  STANDARD_REQUESTS: "10",
  STANDARD_INPUT_TOKENS: "500000",
  STANDARD_OUTPUT_TOKENS: "50000",
  PREMIUM_REQUESTS: "20",
  PREMIUM_INPUT_TOKENS: "1000000",
  PREMIUM_OUTPUT_TOKENS: "100000",
  LUNA_PROVIDER_URL: "https://commercial.example/v1/responses",
  LUNA_API_KEY: "synthetic-luna-key",
  LUNA_MODEL: "luna-commercial",
  SOL_PROVIDER_URL: "https://commercial.example/v1/responses",
  SOL_API_KEY: "synthetic-sol-key",
  SOL_MODEL: "sol-commercial",
  JEV_API_KEY: "synthetic-jev-key",
  PROVIDER_MAX_OUTPUT_TOKENS: "128",
  USER_CONCURRENCY: "1",
  GLOBAL_CONCURRENCY: "4",
};
const basis = {
  snapshot: {
    snapshotId: "snapshot-1",
    meetingId: "meeting-1",
    context: {
      purpose: "Discover needs",
      objectives: ["Find owner"],
      conversation: [],
      sources: [],
      stateRevision: 1,
      indexRevision: 1,
      briefRevision: 0,
      sourceRevisions: {},
    },
    candidates: [],
    createdAtMs: 1,
    transcriptThroughSequence: 0,
  },
  transcriptDeltas: [],
  invalidatedSourceIds: [],
  observationSequence: 0,
  stateRevision: 1,
  profileId: "discovery",
  profileRevision: 1,
};
const job = {
  id: "job-1",
  meetingId: "meeting-1",
  lane: "fast",
  intent: "digDeeper",
  trigger: "requested",
  basis,
  outputSchema: {
    type: "object",
    properties: { say: { type: "string" } },
    required: ["say"],
    additionalProperties: false,
  },
  deadlineMs: Date.now() + 30000,
  toolBudget: 0,
};
const body = { job, prompt: "Return a concise grounded question." };
const output = {
  output: { say: "Who approves this?" },
  model: "luna-commercial",
  provider: "managedFast",
  usage: { input: 25, output: 8 },
};
const questions = {
  gap: { type: "noul", instructions: "Is an approval owner still unknown?" },
};
async function httpFixture(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
async function fixture(t, overrides = {}) {
  let time = Date.now();
  let subscriptionStatus = "none";
  const checkoutSessions = new Map();
  const checkoutKeys = new Map();
  let checkoutCreates = 0,
    checkoutExpires = 0,
    failCheckoutResponse = false;
  let subscriptionFailure = false;
  let forgedCustomer = false;
  let price = "price_standard";
  // Billing period (ms) and latest invoice of the fixture subscription; absent by default.
  let periodStartMs, periodEndMs, latestInvoice;
  let recurring = { interval: "month", interval_count: 1 };
  let subscriptionCalls = 0;
  let subscriptionGate;
  const customers = [];
  const deletedCustomers = new Set();
  let customerDeletes = 0,
    failCustomerDelete = false,
    foreignCustomerOwner = false,
    customerMode = "same"; // "same", "livemode" (visible, wrong mode) or "hidden" (Stripe's other-mode 404)
  const upstream = await httpFixture(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/v1/customers") && req.method === "POST") {
      const id = `cus_${customers.length + 1}`;
      customers.push({
        id,
        owner: form.get("metadata[owner]"),
        key: req.headers["idempotency-key"],
      });
      res.end(JSON.stringify({ id, object: "customer", livemode: false }));
    } else if (/^\/v1\/customers\/cus_\d+$/.test(req.url)) {
      const id = req.url.split("/")[3];
      const known = customers.find((c) => c.id === id);
      if (known && customerMode === "hidden") {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "resource_missing",
              message: `No such customer: '${id}'; a similar object exists in live mode, but a test mode key was used to make this request.`,
            },
          }),
        );
      } else if (!known) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error: { type: "invalid_request_error", code: "resource_missing" },
          }),
        );
      } else if (req.method === "GET") {
        res.end(
          JSON.stringify(
            deletedCustomers.has(id)
              ? { id, object: "customer", deleted: true }
              : {
                  id,
                  object: "customer",
                  livemode: customerMode === "livemode",
                  metadata: {
                    owner: foreignCustomerOwner ? "someone-else" : known.owner,
                  },
                },
          ),
        );
      } else if (req.method === "DELETE") {
        customerDeletes++;
        if (failCustomerDelete) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { message: "synthetic outage" } }));
          return;
        }
        deletedCustomers.add(id);
        res.end(JSON.stringify({ id, object: "customer", deleted: true }));
      } else {
        res.statusCode = 405;
        res.end("{}");
      }
    } else if (req.url.startsWith("/v1/subscriptions")) {
      subscriptionCalls++;
      if (subscriptionGate) await subscriptionGate;
      if (subscriptionFailure) {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: { message: "synthetic private upstream detail" },
          }),
        );
        return;
      }
      const customer = new URL(req.url, "http://fixture").searchParams.get(
        "customer",
      );
      res.end(
        JSON.stringify({
          object: "list",
          has_more: false,
          data:
            subscriptionStatus === "none"
              ? []
              : [
                  {
                    id: `sub_${customer}`,
                    object: "subscription",
                    customer: forgedCustomer ? "cus_victim" : customer,
                    livemode: false,
                    status: subscriptionStatus,
                    ...(latestInvoice ? { latest_invoice: latestInvoice } : {}),
                    items: {
                      data: [
                        {
                          id: "si_1",
                          price: { id: price, recurring },
                          quantity: 1,
                          ...(periodStartMs !== undefined
                            ? {
                                current_period_start: Math.floor(
                                  periodStartMs / 1000,
                                ),
                              }
                            : {}),
                          current_period_end: Math.floor(
                            (periodEndMs ?? time + 86400000) / 1000,
                          ),
                        },
                      ],
                    },
                  },
                ],
        }),
      );
    } else if (req.url === "/v1/checkout/sessions") {
      const expectedCustomer = overrides.expectedCustomer ?? "cus_1";
      assert.ok(
        [expectedCustomer].flat().includes(form.get("customer")),
        "checkout for an expected customer",
      );
      assert.ok(
        ["price_standard", "price_premium"].includes(
          form.get("line_items[0][price]"),
        ),
      );
      assert.equal(form.get("mode"), "subscription");
      assert.equal(
        form.get("success_url"),
        "https://service.example/billing/return",
      );
      const key = req.headers["idempotency-key"];
      let session = key ? checkoutKeys.get(key) : undefined;
      if (!session) {
        checkoutCreates++;
        session = {
          id: `cs_${checkoutCreates}`,
          object: "checkout.session",
          url: `https://checkout.stripe.com/c/pay/fixture_${checkoutCreates}`,
          customer: form.get("customer"),
          mode: "subscription",
          livemode: false,
          status: "open",
          expires_at: Math.floor((time + 1800000) / 1000),
        };
        checkoutSessions.set(session.id, session);
        if (key) checkoutKeys.set(key, session);
      }
      if (failCheckoutResponse) {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify(session));
    } else if (req.url.startsWith("/v1/checkout/sessions/")) {
      const id = req.url.split("/")[4];
      const session = checkoutSessions.get(id);
      if (!session) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      if (req.url.endsWith("/expire")) {
        checkoutExpires++;
        session.status = "expired";
      }
      res.end(JSON.stringify(session));
    } else if (req.url === "/v1/billing_portal/sessions") {
      assert.equal(form.get("customer"), "cus_1");
      res.end(
        JSON.stringify({
          id: "bps_1",
          url: "https://billing.stripe.com/p/session/fixture",
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const stripe = new Stripe("sk_test_fixture", {
    host: "127.0.0.1",
    port: upstream.server.address().port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  const config = loadConfig({ ...env, ...overrides.env });
  const oidc = overrides.oidc ?? {
    async authorizationUrl(flow) {
      return `https://identity.example/authorize?state=${flow.state}`;
    },
    async authenticate() {
      return {
        issuer: "https://identity.example",
        subject: overrides.subject ?? "subject-one",
        email: "person@example.test",
        name: "Fixture Person",
      };
    },
  };
  const provider = overrides.provider ?? {
    async run() {
      return structuredClone(output);
    },
    async decide() {
      return {
        answers: { gap: { type: "noul", noul: 0.8 } },
        model: "jev-latest",
        usage: { input: 15, output: 2 },
      };
    },
  };
  const serviceOptions = {
    config,
    oidc,
    billing: new StripeBilling(config, stripe),
    provider,
    monitor: overrides.monitor,
    now: () => time,
    ...overrides.service,
  };
  let app = createService(serviceOptions);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    app.server.close();
    await once(app.server, "close");
    app.close();
    await upstream.close();
  });
  async function request(path, data, token, headers = {}) {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return { status: response.status, value, headers: response.headers };
  }
  async function start() {
    return (await request("/v1/auth/device", {})).value;
  }
  async function approve(device) {
    const page = await request("/auth/device", { user_code: device.userCode });
    assert.equal(page.status, 200);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const csrf = page.value.match(/name="csrf" value="([^"]+)"/)[1];
    const auth = await request("/auth/device/authorize", { csrf }, undefined, {
      cookie,
    });
    assert.equal(auth.status, 302);
    const state = new URL(auth.headers.get("location")).searchParams.get(
      "state",
    );
    const callback = await request(
      `/auth/callback?code=fixture-code&state=${state}`,
      undefined,
      undefined,
      { cookie },
    );
    assert.equal(callback.status, 200);
    const approvalCsrf = callback.value.match(/name="csrf" value="([^"]+)"/)[1];
    const approval = await request(
      "/auth/device/approve",
      { csrf: approvalCsrf },
      undefined,
      { cookie },
    );
    assert.equal(approval.status, 200);
    return { cookie, state, csrf };
  }
  async function login() {
    const device = await start();
    await approve(device);
    const r = await request("/v1/auth/device/poll", {
      deviceCode: device.deviceCode,
    });
    assert.equal(r.status, 200);
    return r.value.sessionToken;
  }
  async function webhook(id = "evt_1", customer = "cus_1", extra = {}) {
    const raw = JSON.stringify({
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created: Math.floor(time / 1000),
      data: { object: { id: "sub_fixture", customer } },
      ...extra,
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: "whsec_fixture",
    });
    const res = await fetch(base + "/v1/billing/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      body: raw,
    });
    return { status: res.status, value: await res.json() };
  }
  async function subscribe(token) {
    subscriptionStatus = "active";
    assert.equal(
      (await request("/v1/billing/checkout", { plan: "standard" }, token))
        .status,
      200,
    );
    assert.equal((await webhook()).status, 200);
  }
  return {
    get app() {
      return app;
    },
    config,
    get base() {
      return base;
    },
    async restart() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app.close();
      app = createService(serviceOptions);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      base = `http://127.0.0.1:${app.server.address().port}`;
    },
    request,
    start,
    approve,
    login,
    webhook,
    subscribe,
    advance(ms) {
      time += ms;
    },
    now: () => time,
    setSubscription(s) {
      subscriptionStatus = s;
    },
    setSubscriptionFailure(s) {
      subscriptionFailure = s;
    },
    forgeCustomer(s) {
      forgedCustomer = s;
    },
    setPrice(s) {
      price = s;
    },
    /** The subscription's billing period in ms; undefined start leaves it out like a legacy object. */
    setPeriod(start, end) {
      periodStartMs = start;
      periodEndMs = end;
    },
    /** The price's recurring interval as Stripe reports it on the subscription item. */
    setRecurring(r) {
      recurring = r;
    },
    /** The subscription's expanded latest invoice (undefined: not present). */
    setLatestInvoice(invoice) {
      latestInvoice = invoice;
    },
    subscriptionCalls: () => subscriptionCalls,
    /** Holds every Stripe subscription lookup open until the returned function is called. */
    holdSubscriptions() {
      let release;
      subscriptionGate = new Promise((r) => (release = r));
      return () => {
        subscriptionGate = undefined;
        release();
      };
    },
    customerDeletes: () => customerDeletes,
    deletedCustomers,
    setCustomerDeleteFailure(v) {
      failCustomerDelete = v;
    },
    setForeignCustomerOwner(v) {
      foreignCustomerOwner = v;
    },
    setCustomerMode(v) {
      customerMode = v;
    },
    checkoutCreates: () => checkoutCreates,
    checkoutExpires: () => checkoutExpires,
    setCheckoutResponseFailure(v) {
      failCheckoutResponse = v;
    },
    customers,
  };
}

test("missing production identity configuration fails closed instead of issuing a device credential", async (t) => {
  const f = await fixture(t, { env: { OIDC_CLIENT_SECRET: "" } });
  const r = await f.request("/v1/auth/device", {});
  assert.equal(r.status, 503);
  assert.deepEqual(r.value, { error: { code: "authNotConfigured" } });
});
test("device approval binds provider subject; exchange is one-time; sessions revoke and tokens are hashed", async (t) => {
  const f = await fixture(t);
  const d = await f.start();
  assert.ok(!d.verificationUri.includes(d.deviceCode));
  assert.equal(
    (await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode }))
      .value.status,
    "pending",
  );
  await f.approve(d);
  f.advance(5000);
  const a = await f.request("/v1/auth/device/poll", {
    deviceCode: d.deviceCode,
  });
  assert.equal(a.status, 200);
  assert.ok(a.value.sessionToken.length >= 40);
  const account = await f.request(
    "/v1/account",
    undefined,
    a.value.sessionToken,
  );
  assert.equal(account.value.user.email, "person@example.test");
  assert.equal(account.value.plan, "none");
  assert.equal(account.value.canUseAI, false);
  f.advance(5000);
  assert.equal(
    (await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode }))
      .status,
    400,
  );
  assert.equal(
    (await f.request("/v1/auth/logout", {}, a.value.sessionToken)).status,
    200,
  );
  assert.equal(
    (await f.request("/v1/account", undefined, a.value.sessionToken)).status,
    401,
  );
  assert.equal(
    (await f.request("/v1/auth/device/poll", { userId: "forged" })).status,
    400,
  );
});
test("expired device codes and expired sessions cannot gain access", async (t) => {
  const f = await fixture(t);
  const d = await f.start();
  f.advance(11 * 60000);
  assert.equal(
    (await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode }))
      .status,
    400,
  );
  const token = await f.login();
  f.advance(31 * 86400000);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
});
test("the device page never carries the code: the person types it and sees where the request came from", async (t) => {
  const f = await fixture(t);
  const d = await f.start();
  assert.equal(d.verificationUri, "https://service.example/auth/device");
  assert.match(d.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  // A prefilled link (an attacker's phishing URL) shows only the empty form.
  const prefilled = await f.request(`/auth/device?user_code=${d.userCode}`);
  assert.equal(prefilled.status, 200);
  assert.equal(prefilled.headers.get("set-cookie"), null);
  assert.doesNotMatch(prefilled.value, new RegExp(d.userCode));
  assert.match(prefilled.value, /name="user_code"/);
  assert.match(prefilled.value, /value=""/);
  // Typed codes are normalised: case, spaces and the dash do not matter.
  const typed = d.userCode.toLowerCase().replace("-", " ");
  const page = await f.request("/auth/device", { user_code: typed });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("set-cookie"), /^li_device=/);
  assert.match(page.value, /127\.0\.0\.0\/24/);
  assert.match(page.value, /the same network as this browser/);
  assert.ok(page.value.includes(new Date().toISOString().slice(0, 10)));
  const wrong = await f.request("/auth/device", { user_code: "BCDF-GHJK" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.headers.get("content-type"), /text\/html/);
  const crossSite = await f.request(
    "/auth/device",
    { user_code: d.userCode },
    undefined,
    { origin: "https://attacker.example" },
  );
  assert.equal(crossSite.status, 400);
});
async function fileFixture(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-service-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const f = await fixture(t, { env: { DATABASE_PATH: path, ...env } });
  const rows = (sql) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  return { f, rows };
}
test("the sign-in network prefix is forgotten once the code is approved, exchanged or expired", async (t) => {
  const { f, rows } = await fileFixture(t);
  const origins = () =>
    rows("SELECT origin FROM devices").map((r) => r.origin);
  // Exchanged: the prefix is gone as soon as the Mac has its session.
  await f.login();
  assert.deepEqual(origins(), [null]);
  // Approved but not yet exchanged: gone already.
  const approved = await f.start();
  await f.approve(approved);
  assert.deepEqual(origins(), [null, null]);
  // Expired without use: gone within a minute of expiry, not a day later.
  await f.start();
  assert.deepEqual(origins().filter(Boolean), ["127.0.0.0/24"]);
  f.advance(f.config.deviceTtlMs + 61000);
  await f.request("/v1/config");
  assert.deepEqual(origins().filter(Boolean), []);
  // The rows themselves are still removed a day after expiry, as before.
  assert.equal(rows("SELECT * FROM devices").length, 3);
});
test("rate-limit counters are stored under a keyed hash, not a reversible hash of the IP address", async (t) => {
  const { f, rows } = await fileFixture(t, { RATE_LIMIT_KEY: "k".repeat(32) });
  await f.start();
  const keys = rows("SELECT key FROM rate_limits").map((r) => r.key);
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0], hashOf("device:127.0.0.1"));
  assert.equal(
    keys[0],
    createHmac("sha256", "k".repeat(32)).update("device:127.0.0.1").digest("hex"),
  );
  // Without RATE_LIMIT_KEY the key is derived from the per-install salt: still not the plain hash.
  const derived = await fileFixture(t);
  await derived.f.start();
  const [plain] = derived.rows("SELECT key FROM rate_limits");
  assert.notEqual(plain.key, hashOf("device:127.0.0.1"));
  assert.notEqual(plain.key, keys[0]);
});
test("a RATE_LIMIT_KEY that is too short is named without its value", () => {
  const config = loadConfig({ ...env, RATE_LIMIT_KEY: "short-secret-value" });
  assert.ok(
    config.missing.runtime.includes(
      "RATE_LIMIT_KEY (at least 32 characters when set)",
    ),
  );
  assert.equal(JSON.stringify(config.missing).includes("short-secret-value"), false);
  assert.deepEqual(loadConfig(env).missing.runtime, []);
});
test("a failed identity exchange can be retried from an HTML page and still connects the Mac", async (t) => {
  let failures = 1;
  const f = await fixture(t, {
    oidc: {
      async authorizationUrl(flow) {
        return `https://identity.example/authorize?state=${flow.state}`;
      },
      async authenticate() {
        if (failures-- > 0) throw new Error("synthetic exchange failure");
        return {
          issuer: "https://identity.example",
          subject: "subject-one",
          email: "person@example.test",
        };
      },
    },
  });
  const d = await f.start();
  const page = await f.request("/auth/device", { user_code: d.userCode });
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
  const authorize = async (csrf) => {
    const a = await f.request("/auth/device/authorize", { csrf }, undefined, {
      cookie,
    });
    assert.equal(a.status, 302);
    return new URL(a.headers.get("location")).searchParams.get("state");
  };
  const firstState = await authorize(csrfOf(page.value));
  const failed = await f.request(
    `/auth/callback?code=x&state=${firstState}`,
    undefined,
    undefined,
    { cookie },
  );
  assert.equal(failed.status, 400);
  assert.match(failed.headers.get("content-type"), /text\/html/);
  assert.doesNotMatch(failed.value, /synthetic/);
  const secondState = await authorize(csrfOf(failed.value));
  assert.notEqual(secondState, firstState);
  const callback = await f.request(
    `/auth/callback?code=y&state=${secondState}`,
    undefined,
    undefined,
    { cookie },
  );
  assert.equal(callback.status, 200);
  const approved = await f.request(
    "/auth/device/approve",
    { csrf: csrfOf(callback.value) },
    undefined,
    { cookie },
  );
  assert.equal(approved.status, 200);
  // Any other browser-route failure is an HTML page, not JSON.
  const stale = await f.request("/auth/device/approve", { csrf: "x" }, undefined, {
    cookie,
  });
  assert.equal(stale.status, 400);
  assert.match(stale.headers.get("content-type"), /text\/html/);
  assert.match(stale.value, /invalidBrowserFlow/);
});
test("browser callback rejects swapped state and missing browser binding", async (t) => {
  const f = await fixture(t);
  const d = await f.start();
  const page = await f.request("/auth/device", { user_code: d.userCode });
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const csrf = page.value.match(/name="csrf" value="([^"]+)"/)[1];
  const a = await f.request("/auth/device/authorize", { csrf }, undefined, {
    cookie,
  });
  const state = new URL(a.headers.get("location")).searchParams.get("state");
  assert.equal(
    (await f.request(`/auth/callback?code=x&state=${state}`)).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/auth/callback?code=x&state=swapped",
        undefined,
        undefined,
        { cookie },
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/auth/device/approve", { csrf }, undefined, { cookie }))
      .status,
    400,
  );
});
test("polling too quickly is rate limited without consuming the exchange", async (t) => {
  const f = await fixture(t);
  const d = await f.start();
  await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode });
  assert.equal(
    (await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode }))
      .status,
    429,
  );
  await f.approve(d);
  f.advance(5000);
  assert.ok(
    (await f.request("/v1/auth/device/poll", { deviceCode: d.deviceCode }))
      .value.sessionToken,
  );
});
test("billing price/customer/redirect are server owned and portal uses authenticated owner", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  assert.equal(
    (
      await f.request(
        "/v1/billing/checkout",
        { plan: "standard", customerId: "cus_victim" },
        token,
      )
    ).status,
    400,
  );
  assert.equal((await f.request("/v1/billing/portal", {}, token)).status, 409);
  await f.subscribe(token);
  assert.equal((await f.request("/v1/billing/portal", {}, token)).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.canUseAI,
    true,
  );
});
test("webhook signature, mode and customer ownership are enforced", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.request("/v1/billing/checkout", { plan: "standard" }, token);
  const bad = await fetch(f.base + "/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": "forged" },
    body: "{}",
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await f.webhook("evt_wrong", "cus_1", { livemode: true })).status,
    400,
  );
  assert.equal((await f.webhook("evt_unknown", "cus_other")).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.canUseAI,
    false,
  );
});
test("durable webhook replay does not repeat work; an old event reconciles current canceled state", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  const calls = f.subscriptionCalls();
  await f.webhook();
  assert.equal(f.subscriptionCalls(), calls);
  f.setSubscription("canceled");
  await f.webhook("evt_old");
  const account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.canUseAI, false);
  assert.equal(account.subscriptionStatus, "canceled");
});
test("unauthenticated, inactive, oversized, audio and credential requests never reach text reasoning", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/reasoning", body)).status, 401);
  const token = await f.login();
  assert.equal((await f.request("/v1/reasoning", body, token)).status, 402);
  await f.subscribe(token);
  for (const extra of [
    { audioPath: "/private/audio.wav" },
    { apiKey: "secret" },
    { job: { ...job, basis: { ...basis, audio: { data: "abc" } } } },
    { prompt: "data:audio/wav;base64,AAAA" },
  ]) {
    assert.equal(
      (await f.request("/v1/reasoning", { ...body, ...extra }, token)).status,
      400,
    );
  }
  assert.equal(
    (
      await f.request(
        "/v1/reasoning",
        { ...body, prompt: "x".repeat(300000) },
        token,
      )
    ).status,
    413,
  );
});
test("reasoning preserves immutable job identity/basis and validates schema before returning output", async (t) => {
  let invalid = false;
  const f = await fixture(t, {
    provider: {
      async run() {
        return invalid
          ? { ...output, output: { say: 12 } }
          : structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.value.basis, basis);
  assert.equal(r.value.jobId, "job-1");
  assert.deepEqual(r.value.output, { say: "Who approves this?" });
  invalid = true;
  const bad = await f.request(
    "/v1/reasoning",
    requestJob("invalid-result-job"),
    token,
  );
  assert.equal(bad.status, 502);
  assert.equal(bad.value.error.code, "invalidProviderResult");
});
test("request allowance and concurrency reservations are enforced atomically", async (t) => {
  let release;
  const blocked = new Promise((r) => (release = r));
  const f = await fixture(t, {
    env: { STANDARD_REQUESTS: "1" },
    provider: {
      async run() {
        await blocked;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const first = f.request("/v1/reasoning", body, token);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("parallel-job"), token))
      .status,
    429,
  );
  release();
  assert.equal((await first).status, 200);
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("over-allowance-job"), token))
      .value.error.code,
    "allowanceExceeded",
  );
  const status = (await f.request("/v1/account", undefined, token)).value;
  assert.deepEqual(status.usage, {
    requests: 1,
    inputTokens: 25,
    outputTokens: 8,
  });
});
test("input/output allowances reserve before spending and automatic preparation requires Premium", async (t) => {
  const f = await fixture(t, { env: { STANDARD_INPUT_TOKENS: "1" } });
  const token = await f.login();
  await f.subscribe(token);
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("over-allowance-job"), token))
      .value.error.code,
    "allowanceExceeded",
  );
  assert.equal(
    (
      await f.request(
        "/v1/reasoning",
        {
          ...body,
          job: {
            ...job,
            usageFeature: "automaticPreparation",
            preparation: true,
            trigger: "automatic",
          },
        },
        token,
      )
    ).status,
    403,
  );
});
test("Jev returns validated bounded answers with original basis; invalid answers fail closed", async (t) => {
  let invalid = false;
  const f = await fixture(t, {
    provider: {
      async decide() {
        return {
          answers: { gap: { type: "noul", noul: invalid ? 2 : 0.8 } },
          model: "jev-latest",
          usage: { input: 10, output: 2 },
        };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request(
    "/v1/decide",
    { basis, effectiveContext: basis.snapshot.context, questions },
    token,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.value.basis, basis);
  assert.equal(r.value.answers.gap.noul, 0.8);
  invalid = true;
  assert.equal(
    (
      await f.request(
        "/v1/decide",
        { basis, effectiveContext: basis.snapshot.context, questions },
        token,
      )
    ).status,
    502,
  );
  assert.equal(
    (
      await f.request(
        "/v1/decide",
        { basis, questions: { gap: { type: "unknown" } } },
        token,
      )
    ).status,
    400,
  );
});
test("SQLite stores no bearer/device/provider credentials or customer content and survives reopening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "live-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const f = await fixture(t, { env: { DATABASE_PATH: path } });
  const unapprovedDevice = await f.start();
  const token = await f.login();
  await f.subscribe(token);
  await f.request("/v1/reasoning", body, token);
  const bytes = Buffer.concat([
    readFileSync(path),
    readFileSync(path + "-wal"),
  ]);
  for (const value of [
    token,
    unapprovedDevice.deviceCode,
    body.prompt,
    env.LUNA_API_KEY,
    output.output.say,
    job.id,
  ])
    assert.equal(bytes.includes(Buffer.from(value)), false);
  const second = await fixture(t, { env: { DATABASE_PATH: path } });
  assert.equal(
    (await second.request("/v1/account", undefined, token)).value.user.email,
    "person@example.test",
  );
});
test("Standard live candidate preparation remains available; automatic pre-meeting scheduling is Premium only", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  assert.equal(
    (
      await f.request(
        "/v1/reasoning",
        { ...body, job: { ...job, preparation: true, trigger: "automatic" } },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "/v1/reasoning",
        {
          ...body,
          job: {
            ...job,
            id: "standard-automatic-preparation",
            usageFeature: "automaticPreparation",
          },
        },
        token,
      )
    ).status,
    403,
  );
});
test("different verified subjects sharing an email cannot share billing or usage", async (t) => {
  let subject = "subject-a";
  const f = await fixture(t, {
    oidc: {
      async authorizationUrl(flow) {
        return `https://identity.example/authorize?state=${flow.state}`;
      },
      async authenticate() {
        return {
          issuer: "https://identity.example",
          subject,
          email: "same@example.test",
        };
      },
    },
  });
  const first = await f.login();
  await f.subscribe(first);
  subject = "subject-b";
  const second = await f.login();
  const a = (await f.request("/v1/account", undefined, first)).value,
    b = (await f.request("/v1/account", undefined, second)).value;
  assert.notEqual(a.user.id, b.user.id);
  assert.equal(a.canUseAI, true);
  assert.equal(b.canUseAI, false);
  assert.equal((await f.request("/v1/billing/portal", {}, second)).status, 409);
});
test("Jev Score accepts ordered rubric and probability-weighted intermediate score; choice validates options", async (t) => {
  const qs = {
    priority: {
      type: "score",
      instructions: "Rate priority",
      criteria: ["Low", "Medium", "High"],
    },
    route: {
      type: "choice",
      instructions: "Choose route",
      criteria: { fast: "Simple", deep: "Complex" },
    },
  };
  const f = await fixture(t, {
    provider: {
      async decide() {
        return {
          model: "jev-latest",
          answers: {
            priority: {
              type: "score",
              score: 1.05,
              confidence: 0.92,
              legend: { 0: "Low", 1: "Medium", 2: "High" },
              probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
            },
            route: {
              type: "choice",
              choice: "fast",
              confidence: 0.8,
              probabilities: { fast: 0.9, deep: 0.1 },
            },
          },
          usage: { input: 15, output: 30 },
        };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/decide", { basis, questions: qs }, token);
  assert.equal(r.status, 200);
  assert.equal(r.value.answers.priority.score, 1.05);
});
test("billing refresh failure fails closed while retaining local account identity", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.advance(61000);
  f.setSubscription("unpaid");
  const a = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(a.canUseAI, false);
  assert.equal(a.signedIn, true);
});
test("invalid provider usage cannot become a successful customer result", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run() {
        return { ...output, usage: { input: -1, output: 8 } };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 502);
  assert.equal(r.value.error.code, "invalidProviderResult");
});
test("reported cached input tokens reach the client but never change the metered charge", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run() {
        return { ...output, usage: { input: 25, output: 8, cachedInput: 20 } };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.value.usage, { input: 25, output: 8, cachedInput: 20 });
  assert.deepEqual(
    (await f.request("/v1/account", undefined, token)).value.usage,
    { requests: 1, inputTokens: 25, outputTokens: 8 },
  );
});
test("an impossible cached input count cannot become a successful customer result", async (t) => {
  for (const cachedInput of [-1, 26, 1.5, "3"]) {
    const f = await fixture(t, {
      provider: {
        async run() {
          return { ...output, usage: { input: 25, output: 8, cachedInput } };
        },
      },
    });
    const token = await f.login();
    await f.subscribe(token);
    const r = await f.request("/v1/reasoning", body, token);
    assert.equal(r.status, 502);
    assert.equal(r.value.error.code, "invalidProviderResult");
  }
});
test("Standard on-demand pre-meeting preparation uses the basic fast route", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run(selected) {
        return {
          ...output,
          provider: selected.lane === "deep" ? "managedDeep" : "managedFast",
        };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request(
    "/v1/reasoning",
    { ...body, job: { ...job, lane: "deep", usageFeature: "preparation" } },
    token,
  );
  assert.equal(r.status, 200);
  assert.equal(r.value.provider, "managedFast");
});
test("failed subscription reconciliation is durable and retryable without granting stale access", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.setSubscriptionFailure(true);
  const failed = await f.webhook("evt_revoke");
  assert.equal(failed.status, 503);
  const status = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(status.canUseAI, false);
  assert.equal(status.code, "billingUnavailable");
  assert.equal((await f.request("/v1/reasoning", body, token)).status, 503);
  f.setSubscriptionFailure(false);
  f.setSubscription("unpaid");
  assert.equal((await f.webhook("evt_revoke")).status, 200);
  assert.equal((await f.request("/v1/reasoning", body, token)).status, 402);
});
test("authoritative subscription customer and approved prices are enforced", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.forgeCustomer(true);
  assert.equal((await f.webhook("evt_forged_owner")).status, 503);
  f.forgeCustomer(false);
  f.setPrice("price_unapproved");
  assert.equal((await f.webhook("evt_unknown_price")).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.canUseAI,
    false,
  );
});
test("only an explicitly trusted reverse proxy can supply the client rate-limit address", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  for (let i = 1; i <= 21; i++)
    assert.equal(
      (
        await f.request("/v1/auth/device", {}, undefined, {
          "x-forwarded-for": `203.0.113.${i}`,
        })
      ).status,
      200,
    );
});
test("untrusted forwarded headers cannot evade device authorization rate limits", async (t) => {
  const f = await fixture(t);
  // The production value (200) is checked in "sign-in limits"; a small one keeps this fast.
  const limit = (f.config.signInLimits.deviceStartsPerIp = 20);
  for (let i = 1; i <= limit; i++)
    assert.equal(
      (
        await f.request("/v1/auth/device", {}, undefined, {
          "x-forwarded-for": `203.0.113.${i}`,
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await f.request("/v1/auth/device", {}, undefined, {
        "x-forwarded-for": "203.0.113.99",
      })
    ).status,
    429,
  );
});
test("unexpected binary/sample containers in context cannot bypass the text-only contract", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  for (const context of [
    { ...basis.snapshot.context, samples: [0, 0.5, -0.5] },
    { ...basis.snapshot.context, conversation: [{ unexpected: [0.1, 0.2] }] },
    {
      ...basis.snapshot.context,
      sources: [{ sourceId: "x", samples: [0.1, 0.2] }],
    },
  ])
    assert.equal(
      (
        await f.request(
          "/v1/decide",
          { basis, effectiveContext: context, questions },
          token,
        )
      ).status,
      400,
    );
});

test("model output with forbidden credential/media fields is an upstream validation failure", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run() {
        return { ...output, output: { say: "data:audio/wav;base64,AAAA" } };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 502);
  assert.equal(r.value.error.code, "invalidProviderResult");
});

test("repeated and concurrent same-plan Checkout opens reuse one durable session", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  const first = await f.request(
    "/v1/billing/checkout",
    { plan: "standard" },
    token,
  );
  const again = await Promise.all([
    f.request("/v1/billing/checkout", { plan: "standard" }, token),
    f.request("/v1/billing/checkout", { plan: "standard" }, token),
  ]);
  assert.equal(first.status, 200);
  for (const r of again) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.value, first.value);
  }
  assert.equal(f.checkoutCreates(), 1);
});
test("changing the Checkout plan expires the owned old session before creating another", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  const first = await f.request(
    "/v1/billing/checkout",
    { plan: "standard" },
    token,
  );
  const next = await f.request(
    "/v1/billing/checkout",
    { plan: "premium" },
    token,
  );
  assert.equal(next.status, 200);
  assert.notEqual(next.value.url, first.value.url);
  assert.equal(f.checkoutCreates(), 2);
  assert.equal(f.checkoutExpires(), 1);
});
test("a lost Checkout response retries the persisted operation key without a duplicate session", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  f.setCheckoutResponseFailure(true);
  assert.equal(
    (await f.request("/v1/billing/checkout", { plan: "standard" }, token))
      .status,
    502,
  );
  f.setCheckoutResponseFailure(false);
  assert.equal(
    (await f.request("/v1/billing/checkout", { plan: "standard" }, token))
      .status,
    200,
  );
  assert.equal(f.checkoutCreates(), 1);
});

function requestJob(id, extra = {}) {
  return {
    ...structuredClone(body),
    job: {
      ...structuredClone(job),
      id,
      deadlineMs: Date.now() + 30000,
      ...extra,
    },
  };
}

test("reasoning replays are durable metadata-only conflicts and never dispatch or charge twice", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "live-service-replay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const f = await fixture(t, {
    env: { DATABASE_PATH: join(directory, "service.sqlite") },
    provider: {
      async run() {
        calls++;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const request = requestJob("stable-job");
  assert.equal((await f.request("/v1/reasoning", request, token)).status, 200);
  const repeat = await f.request("/v1/reasoning", request, token);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.value.error.code, "jobAlreadyCompleted");
  await f.restart();
  const afterRestart = await f.request("/v1/reasoning", request, token);
  assert.equal(afterRestart.status, 409);
  assert.equal(afterRestart.value.error.code, "jobAlreadyCompleted");
  const reordered = {
    prompt: request.prompt,
    job: Object.fromEntries(Object.entries(request.job).reverse()),
  };
  assert.equal(
    (await f.request("/v1/reasoning", reordered, token)).value.error.code,
    "jobAlreadyCompleted",
  );
  f.advance(31000);
  assert.equal(
    (await f.request("/v1/reasoning", request, token)).value.error.code,
    "jobAlreadyCompleted",
  );
  const changed = await f.request(
    "/v1/reasoning",
    { ...request, prompt: "A different request with the same identity." },
    token,
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.value.error.code, "jobReplayMismatch");
  assert.equal(calls, 1);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    1,
  );
});

test("concurrent job replay is rejected before another reservation or provider dispatch", async (t) => {
  let release, entered;
  const reached = new Promise((r) => (entered = r));
  const blocked = new Promise((r) => (release = r));
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run() {
        calls++;
        entered();
        await blocked;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const request = requestJob("concurrent-job");
  const first = f.request("/v1/reasoning", request, token);
  await reached;
  try {
    const duplicate = await f.request("/v1/reasoning", request, token);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.value.error.code, "jobInProgress");
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    1,
  );
});

test("a failed dispatched job keeps its charge and cannot execute again under the same ID", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run() {
        calls++;
        throw new Error("synthetic upstream failure");
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const request = requestJob("failed-job");
  assert.equal((await f.request("/v1/reasoning", request, token)).status, 502);
  const repeat = await f.request("/v1/reasoning", request, token);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.value.error.code, "jobAlreadyFailed");
  assert.equal(calls, 1);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    1,
  );
});

test("Premium background preparation leaves the sole interactive user slot available", async (t) => {
  let release, entered;
  const reached = new Promise((r) => (entered = r));
  const blocked = new Promise((r) => (release = r));
  let liveCalls = 0;
  const f = await fixture(t, {
    env: { USER_CONCURRENCY: "1" },
    provider: {
      async run(selected) {
        if (selected.usageFeature === "automaticPreparation") {
          entered();
          await blocked;
        } else liveCalls++;
        return structuredClone(output);
      },
    },
  });
  f.setPrice("price_premium");
  const token = await f.login();
  await f.subscribe(token);
  const background = f.request(
    "/v1/reasoning",
    requestJob("background", {
      usageFeature: "automaticPreparation",
      trigger: "automatic",
    }),
    token,
  );
  await reached;
  try {
    const urgent = await f.request(
      "/v1/reasoning",
      requestJob("urgent-live", { usageFeature: "live" }),
      token,
    );
    assert.equal(urgent.status, 200);
    assert.equal(liveCalls, 1);
    const extra = await f.request(
      "/v1/reasoning",
      requestJob("background-extra", {
        usageFeature: "automaticPreparation",
        trigger: "automatic",
      }),
      token,
    );
    assert.equal(extra.status, 429);
    assert.equal(extra.value.error.code, "backgroundConcurrencyExceeded");
  } finally {
    release();
    assert.equal((await background).status, 200);
  }
});

test("global live reserve blocks background admission without exceeding the hard global cap", async (t) => {
  let release, entered;
  const reached = new Promise((r) => (entered = r));
  const blocked = new Promise((r) => (release = r));
  const calls = [];
  const f = await fixture(t, {
    env: {
      USER_CONCURRENCY: "3",
      USER_BACKGROUND_CONCURRENCY: "3",
      GLOBAL_CONCURRENCY: "2",
      GLOBAL_LIVE_RESERVE: "1",
    },
    provider: {
      async run(selected) {
        calls.push(selected.id);
        if (selected.id === "background-global") entered();
        if (["background-global", "live-global"].includes(selected.id))
          await blocked;
        return structuredClone(output);
      },
    },
  });
  f.setPrice("price_premium");
  const token = await f.login();
  await f.subscribe(token);
  const background = f.request(
    "/v1/reasoning",
    requestJob("background-global", {
      usageFeature: "automaticPreparation",
      trigger: "automatic",
    }),
    token,
  );
  await reached;
  try {
    const extraBackground = await f.request(
      "/v1/reasoning",
      requestJob("background-global-extra", {
        usageFeature: "automaticPreparation",
        trigger: "automatic",
      }),
      token,
    );
    assert.equal(extraBackground.status, 429);
    const live = f.request("/v1/reasoning", requestJob("live-global"), token);
    for (let i = 0; i < 100 && !calls.includes("live-global"); i++)
      await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(calls, ["background-global", "live-global"]);
    const over = await f.request(
      "/v1/reasoning",
      requestJob("live-over-global"),
      token,
    );
    assert.equal(over.status, 429);
    release();
    assert.equal((await live).status, 200);
  } finally {
    release();
    await background;
  }
});

test("a one-slot global service rejects background work while admitting live work", async (t) => {
  const f = await fixture(t, { env: { GLOBAL_CONCURRENCY: "1" } });
  f.setPrice("price_premium");
  const token = await f.login();
  await f.subscribe(token);
  const background = await f.request(
    "/v1/reasoning",
    requestJob("no-background-capacity", {
      usageFeature: "automaticPreparation",
      trigger: "automatic",
    }),
    token,
  );
  assert.equal(background.status, 429);
  assert.equal(background.value.error.code, "backgroundConcurrencyExceeded");
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("one-live-slot"), token))
      .status,
    200,
  );
});

// --- Streaming reasoning (POST /v1/reasoning/stream) ---

function parseSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return { event, data: JSON.parse(data) };
    });
}
async function openStream(f, data, token, signal) {
  const response = await fetch(f.base + "/v1/reasoning/stream", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
  return response;
}
async function streamRequest(f, data, token) {
  const response = await openStream(f, data, token);
  const text = await response.text();
  const sse = response.headers
    .get("content-type")
    ?.startsWith("text/event-stream");
  return {
    status: response.status,
    headers: response.headers,
    text,
    events: sse ? parseSse(text) : undefined,
    value: sse ? undefined : JSON.parse(text),
  };
}
const streamingProvider = (
  fragments,
  after = () => structuredClone(output),
) => ({
  async run(_job, _prompt, signal, onText) {
    for (const fragment of fragments) await onText?.(fragment);
    return after(signal);
  },
});

test("streaming delivers text fragments then the same validated result, metered and one-shot", async (t) => {
  const f = await fixture(t, {
    provider: streamingProvider(['{"say":', '"Who approves this?"}']),
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, body, token);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    r.events.map((e) => e.event),
    ["delta", "delta", "result"],
  );
  assert.deepEqual(r.events[0].data, { text: '{"say":' });
  assert.deepEqual(r.events[2].data, {
    jobId: "job-1",
    provider: "managedFast",
    model: "luna-commercial",
    output: { say: "Who approves this?" },
    basis,
    outcome: "complete",
    usage: { input: 25, output: 8 },
  });
  assert.deepEqual(
    (await f.request("/v1/account", undefined, token)).value.usage,
    {
      requests: 1,
      inputTokens: 25,
      outputTokens: 8,
    },
  );
  // Job identity is shared with /v1/reasoning: neither route can run it again.
  const again = await streamRequest(f, body, token);
  assert.equal(again.status, 409);
  assert.equal(again.value.error.code, "jobAlreadyCompleted");
  const plain = await f.request("/v1/reasoning", body, token);
  assert.equal(plain.status, 409);
  assert.equal(plain.value.error.code, "jobAlreadyCompleted");
});

test("streaming admission failures are the same JSON errors as /v1/reasoning and never reach the provider", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    env: { STANDARD_REQUESTS: "1" },
    provider: {
      async run() {
        calls++;
        return structuredClone(output);
      },
    },
  });
  assert.equal((await streamRequest(f, body)).status, 401);
  const token = await f.login();
  assert.equal((await streamRequest(f, body, token)).status, 402);
  await f.subscribe(token);
  for (const extra of [
    { audioPath: "/private/audio.wav" },
    { apiKey: "secret" },
    { prompt: "data:audio/wav;base64,AAAA" },
  ])
    assert.equal(
      (await streamRequest(f, { ...body, ...extra }, token)).status,
      400,
    );
  assert.equal(
    (await streamRequest(f, { ...body, prompt: "x".repeat(300000) }, token))
      .status,
    413,
  );
  const premium = await streamRequest(
    f,
    requestJob("auto-prep", {
      usageFeature: "automaticPreparation",
      preparation: true,
      trigger: "automatic",
    }),
    token,
  );
  assert.equal(premium.status, 403);
  assert.equal(calls, 0);
  assert.equal(
    (await streamRequest(f, requestJob("first"), token)).status,
    200,
  );
  const over = await streamRequest(f, requestJob("second"), token);
  assert.equal(over.status, 429);
  assert.equal(over.value.error.code, "allowanceExceeded");
  assert.equal(calls, 1);
  const expired = await streamRequest(
    f,
    requestJob("late", { deadlineMs: 1 }),
    token,
  );
  assert.equal(expired.status, 408);
});

test("a provider failure before any text is the ordinary JSON 502, not a stream", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run() {
        throw new Error("synthetic upstream failure secret-detail");
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, body, token);
  assert.equal(r.status, 502);
  assert.deepEqual(r.value, { error: { code: "providerUnavailable" } });
  assert.doesNotMatch(r.text, /secret-detail/);
});

test("a mid-stream provider failure ends with an error code only, keeps the charge and blocks replay", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run(_job, _prompt, _signal, onText) {
        calls++;
        await onText('{"say":"Who');
        throw new Error("synthetic upstream failure secret-detail");
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, body, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.events, [
    { event: "delta", data: { text: '{"say":"Who' } },
    { event: "error", data: { code: "providerUnavailable" } },
  ]);
  assert.doesNotMatch(r.text, /secret-detail|synthetic/);
  const repeat = await streamRequest(f, body, token);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.value.error.code, "jobAlreadyFailed");
  assert.equal(calls, 1);
  const usage = (await f.request("/v1/account", undefined, token)).value.usage;
  assert.equal(usage.requests, 1);
  assert.ok(
    usage.inputTokens > 25,
    "the reservation stays charged after a failed dispatch",
  );
});

test("a deep route that fails after text resets the stream and the fast route finishes the same job once", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run(_job, _prompt, _signal, onText, onReset) {
        calls++;
        await onText('{"say":"Who');
        await onReset();
        await onText('{"say":"Fast');
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, body, token);
  assert.deepEqual(
    r.events.map((e) => e.event),
    ["delta", "reset", "delta", "result"],
  );
  assert.deepEqual(r.events[1].data, {});
  assert.equal(r.events[3].data.outcome, "complete");
  assert.equal(calls, 1);
  const repeat = await streamRequest(f, body, token);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.value.error.code, "jobAlreadyCompleted");
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    1,
  );
});

test("streamed text never becomes a result unless the final output validates and is text only", async (t) => {
  for (const [name, bad, code] of [
    ["schema", { ...output, output: { say: 12 } }, "invalidProviderResult"],
    [
      "forbidden field",
      { ...output, output: { say: "x", apiKey: "k" } },
      "invalidProviderResult",
    ],
    [
      "provenance",
      { ...output, provider: "personal" },
      "invalidProviderResult",
    ],
  ]) {
    const f = await fixture(t, {
      provider: streamingProvider(['{"say":'], () => bad),
    });
    const token = await f.login();
    await f.subscribe(token);
    const r = await streamRequest(f, requestJob(`bad-${name}`), token);
    assert.deepEqual(
      r.events.map((e) => e.event),
      ["delta", "error"],
      name,
    );
    assert.deepEqual(r.events[1].data, { code }, name);
  }
});

test("client cancellation aborts the provider, releases the slot and keeps the job from running again", async (t) => {
  let aborted;
  const sawAbort = new Promise((r) => (aborted = r));
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run(_job, _prompt, signal, onText) {
        calls++;
        if (calls > 1) return structuredClone(output);
        await onText("{");
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        aborted(signal.aborted);
        throw new Error("aborted");
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const cancel = new AbortController();
  const cancelledJob = requestJob("cancelled-job");
  const response = await openStream(f, cancelledJob, token, cancel.signal);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /^event: delta/);
  cancel.abort();
  await reader.read().catch(() => {});
  assert.equal(await sawAbort, true);
  // USER_CONCURRENCY is 1: the slot must come back for the next job.
  let next;
  for (let i = 0; i < 50; i++) {
    next = await streamRequest(f, requestJob("after-cancel"), token);
    if (next.status !== 429) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(next.status, 200);
  const replay = await streamRequest(f, cancelledJob, token);
  assert.equal(replay.status, 409);
  assert.equal(replay.value.error.code, "jobAlreadyFailed");
});

test("a concurrent duplicate of a streaming job is refused while the first is in flight", async (t) => {
  let release, entered;
  const reached = new Promise((r) => (entered = r));
  const blocked = new Promise((r) => (release = r));
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async run(_job, _prompt, _signal, onText) {
        calls++;
        await onText("{");
        entered();
        await blocked;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const duplicate = requestJob("dup");
  const first = streamRequest(f, duplicate, token);
  await reached;
  try {
    const dup = await streamRequest(f, duplicate, token);
    assert.equal(dup.status, 409);
    assert.equal(dup.value.error.code, "jobInProgress");
    assert.equal(calls, 1);
  } finally {
    release();
    assert.equal((await first).status, 200);
  }
});

test("only POST reaches the streaming route and /v1/decide has no stream variant", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  assert.equal(
    (await f.request("/v1/reasoning/stream", undefined, token)).status,
    404,
  );
  assert.equal((await f.request("/v1/decide/stream", {}, token)).status, 404);
});

test("the real provider adapter streams text through the service as it arrives and falls back to the fast route when deep fails before text", async (t) => {
  const events = (...lines) =>
    lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("");
  const completed = (model, say) => ({
    type: "response.completed",
    response: {
      model,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ say }) }],
        },
      ],
      usage: { input_tokens: 30, output_tokens: 9 },
    },
  });
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  const upstream = await httpFixture(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = JSON.parse(Buffer.concat(chunks));
    seen.push({
      model: request.model,
      stream: request.stream,
      store: request.store,
    });
    if (request.model === "sol-commercial" && seen.length === 1) {
      // Deep fails before producing text: the fast route may take over.
      res.statusCode = 503;
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(events({ type: "response.created", response: {} }));
    res.write(events({ type: "response.output_text.delta", delta: '{"say":' }));
    await gate;
    res.write(
      events({ type: "response.output_text.delta", delta: '"Who owns it?"}' }),
    );
    res.end(events(completed(request.model, "Who owns it?")));
  });
  t.after(() => upstream.close());
  const config = loadConfig(env);
  const f = await fixture(t, {
    provider: new CommercialProviders(config, {
      fetch: (url, options) =>
        fetch(upstream.url + new URL(url).pathname, options),
    }),
  });
  const token = await f.login();
  await f.subscribe(token);
  const response = await openStream(
    f,
    // A review: Standard serves digDeeper on the fast lane, reviews keep the deep lane.
    requestJob("real-stream", { lane: "deep", intent: "checkConversation", deadlineMs: Date.now() + 30000 }),
    token,
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  // The first fragment is on the wire while the provider is still mid-answer.
  assert.match(
    new TextDecoder().decode(first.value),
    /event: delta\ndata: {"text":"{\\"say\\":"}/,
  );
  release();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  const parsed = parseSse(new TextDecoder().decode(first.value) + rest);
  assert.equal(parsed.at(-1).event, "result");
  assert.equal(parsed.at(-1).data.provider, "managedFast");
  assert.deepEqual(parsed.at(-1).data.output, { say: "Who owns it?" });
  assert.deepEqual(
    seen.map((s) => [s.model, s.stream, s.store]),
    [
      ["sol-commercial", true, false],
      ["luna-commercial", true, false],
    ],
  );
});

const CONFIRM = { confirm: "delete-account" };
function residue(path, needles) {
  // Every table is scanned, so a new table that keeps account data fails here.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    const left = [];
    for (const table of tables)
      for (const row of db.prepare(`SELECT * FROM ${table}`).all())
        for (const needle of needles)
          if (Object.values(row).some((v) => String(v).includes(needle)))
            left.push(`${table}:${needle}`);
    return left;
  } finally {
    db.close();
  }
}
async function populatedAccount(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-service-delete-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const f = await fixture(t, {
    ...overrides,
    env: { DATABASE_PATH: path, ...overrides.env },
  });
  const token = await f.login();
  await f.subscribe(token);
  assert.equal((await f.request("/v1/reasoning", body, token)).status, 200);
  const second = await f.login();
  const account = (await f.request("/v1/account", undefined, token)).value;
  return { f, path, token, second, account };
}

test("export returns everything stored for the account and nothing secret, authenticated and rate limited", async (t) => {
  const { f, path, token, second, account } = await populatedAccount(t);
  assert.equal((await f.request("/v1/account/export")).status, 401);
  assert.equal(
    (await f.request("/v1/account/export", undefined, "wrong")).status,
    401,
  );
  const other = await fixture(t, { subject: "subject-two" });
  const stranger = await other.login();
  const r = await f.request("/v1/account/export", undefined, token);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const e = r.value;
  assert.equal(e.formatVersion, 1);
  assert.equal(typeof e.exportedAtMs, "number");
  assert.deepEqual(e.account, {
    id: account.user.id,
    issuer: "https://identity.example",
    subject: "subject-one",
    email: "person@example.test",
    name: "Fixture Person",
  });
  assert.equal(e.billing.customerId, "cus_1");
  assert.equal(e.billing.subscriptionStatus, "active");
  assert.equal(e.billing.plan, "standard");
  assert.ok(e.billing.periodEndMs > 0);
  assert.equal(e.usage.length, 1);
  assert.equal(e.usage[0].requests, 1);
  assert.match(e.usage[0].period, /^\d{4}-\d{2}$/);
  assert.equal(e.sessions.length, 2);
  assert.deepEqual(e.sessions.map((s) => s.current).sort(), [false, true]);
  assert.ok(e.sessions.every((s) => s.expiresAtMs > 0 && s.revoked === false));
  assert.ok(e.sessions.every((s) => s.signedInAtMs > 0 && s.signedInAtMs < s.expiresAtMs));
  assert.deepEqual(e.reasoningJobs, [
    { period: e.usage[0].period, status: "complete", count: 1 },
  ]);
  assert.ok(e.billingEvents.some((x) => x.type === "customer.subscription.updated"));
  assert.match(e.outsideThisExport.thisMac, /only on your Mac/);
  assert.match(e.outsideThisExport.stripe, /invoice/i);
  const text = JSON.stringify(e);
  for (const secretValue of [
    token,
    second,
    hashOf(token),
    hashOf(second),
    body.prompt,
    job.id,
    stranger,
    env.STRIPE_SECRET_KEY,
    env.OIDC_CLIENT_SECRET,
  ])
    assert.equal(text.includes(secretValue), false);
  // The other account's export never contains this account.
  const theirs = (await other.request("/v1/account/export", undefined, stranger)).value;
  assert.equal(theirs.account.id === account.user.id, false);
  assert.equal(theirs.usage.length, 0);
  // The export is read-only: the account is unchanged and a second export is identical apart from its timestamp.
  const again = (await f.request("/v1/account/export", undefined, token)).value;
  assert.deepEqual({ ...again, exportedAtMs: 0 }, { ...e, exportedAtMs: 0 });
  // 5 exports per hour per account (two used above).
  for (let i = 0; i < 3; i++)
    assert.equal((await f.request("/v1/account/export", undefined, token)).status, 200);
  const limited = await f.request("/v1/account/export", undefined, token);
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.value, { error: { code: "rateLimited" } });
  f.advance(3600001);
  assert.equal((await f.request("/v1/account/export", undefined, token)).status, 200);
  assert.equal(residue(path, [token, second]).length, 0);
});
function hashOf(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("deletion needs authentication and an exact confirmation and changes nothing without them", async (t) => {
  const { f, path, token, account } = await populatedAccount(t);
  assert.equal((await f.request("/v1/account/delete", CONFIRM)).status, 401);
  for (const bad of [{}, { confirm: true }, { confirm: "yes" }, { confirm: "delete-account", extra: 1 }]) {
    const r = await f.request("/v1/account/delete", bad, token);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(
    (await f.request("/v1/account/delete", { confirm: "yes" }, token)).value.error.code,
    "confirmationRequired",
  );
  assert.equal(f.customerDeletes(), 0);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
  assert.ok(residue(path, [account.user.id]).length > 0);
});

test("deleting the account removes the Stripe customer, revokes every session and erases all stored data", async (t) => {
  const { f, path, token, second, account } = await populatedAccount(t);
  const deviceOnly = await f.start(); // an unapproved device must not block deletion
  const before = residue(path, [account.user.id, "person@example.test", "subject-one", "cus_1"]);
  assert.ok(before.length > 0);
  const r = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(r.status, 200);
  assert.equal(r.value.deleted, true);
  assert.equal(r.value.alreadyDeleted, false);
  assert.equal(r.value.stripeCustomerDeleted, true);
  assert.equal(typeof r.value.deletedAtMs, "number");
  assert.equal(f.customerDeletes(), 1);
  assert.ok(f.deletedCustomers.has("cus_1"));
  for (const t of [token, second])
    assert.equal((await f.request("/v1/account", undefined, t)).status, 401);
  assert.equal((await f.request("/v1/account/export", undefined, second)).status, 401);
  assert.deepEqual(
    residue(path, [account.user.id, "person@example.test", "subject-one", "Fixture Person", "cus_1", token, second]),
    [],
  );
  assert.ok(deviceOnly.userCode);
  // The raw files hold no remnant either (secure_delete + WAL checkpoint).
  const bytes = Buffer.concat([readFileSync(path), readFileSync(path + "-wal")]);
  for (const needle of ["person@example.test", "subject-one", account.user.id, "cus_1"])
    assert.equal(bytes.includes(Buffer.from(needle)), false, needle);
  // Late Stripe events for the deleted customer are acknowledged and ignored.
  assert.equal((await f.webhook("evt_after_delete", "cus_1")).status, 200);
  assert.deepEqual(residue(path, ["cus_1"]), []);
  // The same identity can sign in again, but as a brand new account without history.
  const fresh = await f.login();
  const again = (await f.request("/v1/account", undefined, fresh)).value;
  assert.notEqual(again.user.id, account.user.id);
  assert.equal(again.plan, "none");
  // Only this month's usage counters come back with it (the anti-abuse record), nothing else.
  assert.deepEqual(again.usage, { requests: 1, inputTokens: 25, outputTokens: 8 });
});

test("deletion is idempotent: a retry with the same session and concurrent duplicates all succeed with one Stripe deletion", async (t) => {
  const { f, token, account } = await populatedAccount(t);
  const results = await Promise.all([
    f.request("/v1/account/delete", CONFIRM, token),
    f.request("/v1/account/delete", CONFIRM, token),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.deepEqual(results.map((r) => r.value.deleted), [true, true]);
  assert.equal(results.filter((r) => r.value.alreadyDeleted).length, 1);
  assert.equal(f.customerDeletes(), 1);
  const retry = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.alreadyDeleted, true);
  assert.equal(retry.value.stripeCustomerDeleted, true);
  assert.equal(retry.value.deletedAtMs, results[0].value.deletedAtMs);
  assert.equal(f.customerDeletes(), 1);
  // The receipt only proves the retry; it does not authenticate anything else.
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, "other-token")).status, 401);
  assert.notEqual(account.user.id, undefined);
  // The receipt forgets the token when the session would have expired anyway.
  f.advance(f.config.sessionTtlMs + 2 * 86400000);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 401);
});

test("the deletion receipt keeps only a hash of the session token", async (t) => {
  const { f, path, token, account } = await populatedAccount(t);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 200);
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT * FROM deletion_receipts").all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashOf(token));
  assert.deepEqual(Object.keys(rows[0]).sort(), ["deleted_at", "expires", "had_customer", "token_hash"]);
  assert.equal(JSON.stringify(rows).includes(account.user.id), false);
});

test("a Stripe failure keeps the account and its sessions so the same request can be retried", async (t) => {
  const { f, path, token, account } = await populatedAccount(t);
  f.setCustomerDeleteFailure(true);
  const failed = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.value, { error: { code: "billingUnavailable" } });
  assert.equal(JSON.stringify(failed.value).includes("synthetic outage"), false);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
  assert.ok(residue(path, [account.user.id]).length > 0);
  f.setCustomerDeleteFailure(false);
  const ok = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.value.alreadyDeleted, false);
  assert.deepEqual(residue(path, [account.user.id]), []);
});

test("a customer already deleted at Stripe (interrupted earlier attempt) is not an error", async (t) => {
  const { f, token } = await populatedAccount(t);
  f.deletedCustomers.add("cus_1");
  const r = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(r.status, 200);
  assert.equal(r.value.stripeCustomerDeleted, true);
  assert.equal(f.customerDeletes(), 0);
});

test("a Stripe customer that is not owned by the account is never deleted", async (t) => {
  const { f, path, token, account } = await populatedAccount(t);
  f.setForeignCustomerOwner(true);
  const r = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(r.status, 502);
  assert.equal(r.value.error.code, "billingOwnershipMismatch");
  assert.equal(f.customerDeletes(), 0);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
  assert.ok(residue(path, [account.user.id]).length > 0);
});

for (const [mode, label] of [
  ["livemode", "visible with the other mode's flag"],
  ["hidden", "reported by Stripe as existing only in the other mode"],
])
  test(`a customer from the other Stripe mode (${label}) fails deletion with an operator error and is never reported deleted`, async (t) => {
    const { f, path, token, account } = await populatedAccount(t);
    f.setCustomerMode(mode);
    const r = await f.request("/v1/account/delete", CONFIRM, token);
    assert.equal(r.status, 502);
    assert.deepEqual(r.value, { error: { code: "billingModeMismatch" } });
    assert.equal(f.customerDeletes(), 0);
    assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
    assert.ok(residue(path, [account.user.id]).length > 0);
    // A retry gives the same answer and never claims a deletion; once the operator has fixed it, deletion works.
    assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 502);
    f.setCustomerMode("same");
    const ok = await f.request("/v1/account/delete", CONFIRM, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.value.stripeCustomerDeleted, true);
  });

test("a customer Stripe no longer has at all still counts as already deleted", async (t) => {
  const { f, token } = await populatedAccount(t);
  f.customers.length = 0;
  const r = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(r.status, 200);
  assert.equal(f.customerDeletes(), 0);
});

test("deleting and registering again within the month cannot reset the allowance, and the record ends with the month", async (t) => {
  const { f, path, token, account } = await populatedAccount(t);
  const used = (await f.request("/v1/account", undefined, token)).value.usage;
  assert.equal(used.requests, 1);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 200);
  const db = new DatabaseSync(path, { readOnly: true });
  const holds = db.prepare("SELECT * FROM allowance_holds").all();
  db.close();
  assert.equal(holds.length, 1);
  assert.deepEqual(Object.keys(holds[0]).sort(), ["input_tokens", "output_tokens", "period", "requests", "subject_hash"]);
  assert.deepEqual(residue(path, [account.user.id, "person@example.test", "subject-one", "Fixture Person", "cus_1"]), []);
  const fresh = await f.login();
  const again = (await f.request("/v1/account", undefined, fresh)).value;
  assert.deepEqual(again.usage, used);
  // Consumed: nothing is left once the person is back.
  const after = new DatabaseSync(path, { readOnly: true });
  assert.equal(after.prepare("SELECT count(*) AS n FROM allowance_holds").get().n, 0);
  after.close();
  // Delete again, let the month pass: the record is purged by the service and the next sign-up starts at zero.
  assert.equal((await f.request("/v1/account/delete", CONFIRM, fresh)).status, 200);
  f.advance(32 * 86400000);
  const later = await f.login();
  const reset = (await f.request("/v1/account", undefined, later)).value;
  assert.deepEqual(reset.usage, { requests: 0, inputTokens: 0, outputTokens: 0 });
  const end = new DatabaseSync(path, { readOnly: true });
  assert.equal(end.prepare("SELECT count(*) AS n FROM allowance_holds").get().n, 0);
  end.close();
});

test("a restart re-applies the deletion log without touching an account created after the deletion", async (t) => {
  const { f, token } = await populatedAccount(t);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 200);
  f.advance(1000);
  const fresh = await f.login();
  await f.restart();
  assert.equal((await f.request("/v1/account", undefined, fresh)).status, 200);
});

test("an open Checkout session is expired before the customer is deleted", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  assert.equal(
    (await f.request("/v1/billing/checkout", { plan: "standard" }, token)).status,
    200,
  );
  assert.equal(f.checkoutExpires(), 0);
  assert.equal((await f.request("/v1/account/delete", CONFIRM, token)).status, 200);
  assert.equal(f.checkoutExpires(), 1);
  assert.equal(f.customerDeletes(), 1);
});

test("an account that never started billing is deleted without contacting Stripe, even when billing is not configured", async (t) => {
  const f = await fixture(t, { env: { STRIPE_SECRET_KEY: "" } });
  const token = await f.login();
  const r = await f.request("/v1/account/delete", CONFIRM, token);
  assert.equal(r.status, 200);
  assert.equal(r.value.stripeCustomerDeleted, false);
  assert.equal(f.customerDeletes(), 0);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
});

test("deleting one account leaves every other account's data and sessions intact", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "live-service-two-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const first = await fixture(t, { env: { DATABASE_PATH: path } });
  const a = await first.login();
  await first.subscribe(a);
  const secondService = await fixture(t, { subject: "subject-two", env: { DATABASE_PATH: path } });
  const b = await secondService.login();
  const bid = (await secondService.request("/v1/account", undefined, b)).value.user.id;
  assert.equal((await first.request("/v1/account/delete", CONFIRM, a)).status, 200);
  assert.equal((await secondService.request("/v1/account", undefined, b)).status, 200);
  assert.ok(residue(path, [bid]).length > 0);
});

// Content-free error monitoring: what the service sends to a collector when a request fails.
const collectorSettings = {
  enabled: true,
  endpoint: "https://errors.example/api/1/envelope/",
  publicKey: "k",
  environment: "test",
};
function collector() {
  const sent = [];
  return {
    sent,
    monitor: createMonitor(collectorSettings, {
      transport: async (r) => void sent.push(r),
    }),
    text: () => sent.map((r) => r.body).join("\n"),
    events: () =>
      sent.map((r) => JSON.parse(r.body.trimEnd().split("\n")[2])),
  };
}
const LEAK = {
  transcript:
    "Interviewer: the ACME budget is 4.2 million and Priya Natarajan is leaving",
  email: "priya.natarajan@acme-private.example",
  query: "transcript-in-query-ACME",
  prompt: "Summarise the confidential salary discussion",
};
function leaks(text, ...tokens) {
  return [
    ...Object.values(LEAK),
    "Priya",
    "ACME",
    "salary",
    "/Users/priya",
    "Bearer",
    '"authorization"', // a header key (the stub's function name authorizationUrl is allowed)
    ...tokens,
  ].filter((secret) => secret && text.includes(secret));
}

test("a failing provider is reported by class, route, status and fingerprint with no request or error content", async (t) => {
  const c = collector();
  const f = await fixture(t, {
    monitor: c.monitor,
    provider: {
      async run() {
        const error = new RangeError(
          `provider echoed ${LEAK.transcript} for ${LEAK.email}`,
        );
        error.stack = `RangeError: ${LEAK.transcript}\n    at handler (/Users/priya/${LEAK.email}/apps/service/src/providers.mjs:12:9)\n    at ${LEAK.email}.run (/Users/priya/x.mjs:1:1)`;
        error.headers = { authorization: "Bearer provider-key-should-not-leave" };
        throw error;
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request(
    `/v1/reasoning?transcript=${LEAK.query}`,
    { ...body, prompt: LEAK.prompt },
    token,
    { "x-custom": LEAK.email },
  );
  assert.equal(r.status, 502);
  assert.deepEqual(r.value, { error: { code: "providerUnavailable" } });
  await c.monitor.flush();
  assert.equal(c.sent.length, 1);
  assert.deepEqual(leaks(c.text(), token), []);
  assert.doesNotMatch(c.text(), /provider-key-should-not-leave/);
  const [event] = c.events();
  assert.equal(event.tags.route, "/v1/reasoning");
  assert.equal(event.tags.method, "POST");
  assert.equal(event.tags.status, "502");
  assert.deepEqual(
    event.exception.values.map((v) => [v.type, v.value]),
    [
      ["RangeError", undefined],
      ["ServiceError", "providerUnavailable"],
    ],
  );
  assert.match(event.fingerprint[0], /^[0-9a-f]{16}$/);
});

test("an unexpected server error is reported without content, client errors are not", async (t) => {
  const c = collector();
  const f = await fixture(t, {
    monitor: c.monitor,
    oidc: {
      async authorizationUrl() {
        throw new TypeError(`bug while handling ${LEAK.transcript}`);
      },
      async authenticate() {
        throw new Error("unused");
      },
    },
  });
  const device = await f.start();
  const page = await f.request("/auth/device", { user_code: device.userCode });
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const csrf = page.value.match(/name="csrf" value="([^"]+)"/)[1];
  const crash = await f.request("/auth/device/authorize", { csrf }, undefined, {
    cookie,
  });
  assert.equal(crash.status, 500);
  // A browser route: a readable page with the code only.
  assert.match(crash.value, /\(internalError\)/);
  assert.doesNotMatch(crash.value, new RegExp(LEAK.transcript));
  // Client errors are normal traffic, not faults.
  assert.equal((await f.request("/v1/account")).status, 401);
  assert.equal((await f.request(`/${LEAK.query}`)).status, 404);
  await c.monitor.flush();
  const events = c.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].tags.route, "/auth/device/authorize");
  assert.equal(events[0].tags.status, "500");
  assert.equal(events[0].exception.values.at(-1).type, "TypeError");
  assert.deepEqual(leaks(c.text(), cookie.split("=")[1], csrf), []);
});

test("a mid-stream failure is reported as a provider failure without provider text", async (t) => {
  const c = collector();
  const f = await fixture(t, {
    monitor: c.monitor,
    provider: {
      async run(_job, _prompt, _signal, onText) {
        await onText('{"say":"Who');
        throw new Error(`upstream ${LEAK.transcript} ${LEAK.email}`);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, body, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.at(-1), {
    event: "error",
    data: { code: "providerUnavailable" },
  });
  await c.monitor.flush();
  const [event] = c.events();
  assert.equal(event.tags.route, "/v1/reasoning/stream");
  assert.equal(event.tags.status, "502");
  assert.equal(event.exception.values.at(-1).value, "providerUnavailable");
  assert.deepEqual(leaks(c.text(), token), []);
});

test("the real provider adapter reports the class of an upstream failure, not its text", async (t) => {
  const c = collector();
  const config = loadConfig(env);
  const f = await fixture(t, {
    monitor: c.monitor,
    provider: new CommercialProviders(config, {
      fetch: async () => {
        throw new TypeError(`fetch failed for ${LEAK.transcript} ${LEAK.email}`);
      },
    }),
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 502);
  assert.deepEqual(r.value, { error: { code: "providerUnavailable" } });
  await c.monitor.flush();
  const [event] = c.events();
  assert.deepEqual(
    event.exception.values.map((v) => v.type),
    ["TypeError", "ServiceError"],
  );
  assert.deepEqual(leaks(c.text(), token), []);
});

test("a monitor whose transport fails changes neither the response nor the service", async (t) => {
  const monitor = createMonitor(collectorSettings, {
    transport: () => {
      throw new Error("collector down");
    },
  });
  const f = await fixture(t, {
    monitor,
    provider: {
      async run() {
        throw new Error("provider down");
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", body, token);
  assert.equal(r.status, 502);
  assert.deepEqual(r.value, { error: { code: "providerUnavailable" } });
  assert.equal((await f.request("/health")).status, 200);
});

test("without a DSN the service has no monitor to build events or reach a collector", async (t) => {
  const f = await fixture(t, {
    provider: {
      async run() {
        throw new Error(LEAK.transcript);
      },
    },
  });
  assert.equal(f.config.errorReporting.enabled, false);
  const token = await f.login();
  await f.subscribe(token);
  assert.equal((await f.request("/v1/reasoning", body, token)).status, 502);
});

// --- Metering of cancelled and failed calls (issue #96) ---

const sentBytesOf = (data) =>
  Buffer.byteLength(data.prompt) + Buffer.byteLength(JSON.stringify(data.job.outputSchema));
const reservedInputOf = (data) => Buffer.byteLength(JSON.stringify(data)) + 2048;
const meterEnv = { PROVIDER_MAX_OUTPUT_TOKENS: "2048" };
const usageOf = async (f, token) => (await f.request("/v1/account", undefined, token)).value.usage;
async function waitForUsage(f, token, expected) {
  let usage;
  for (let i = 0; i < 100; i++) {
    usage = await usageOf(f, token);
    if (Object.entries(expected).every(([k, v]) => usage[k] === v)) return usage;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(usage, expected);
}
/**
 * A provider that streams `text`, reports itself ready, then holds the call
 * open until the service aborts it, and records what a real provider would
 * have billed: the tokens it generated plus `inFlight` more while the abort
 * travelled.
 */
function holdingProvider({ text = "", inFlight = 40, tokensPerByte = 0.25 } = {}) {
  const state = { dispatches: 0, running: 0, maxRunning: 0, billedOutput: 0, waiters: [] };
  const provider = {
    async run(_job, _prompt, signal, onText) {
      state.dispatches++;
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        if (text) await onText(text);
        state.billedOutput += Math.ceil(Buffer.byteLength(text) * tokensPerByte) + inFlight;
        state.waiters.shift()?.();
        await new Promise((resolve) =>
          signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
        );
        throw new Error("aborted");
      } finally {
        state.running--;
      }
    },
  };
  return {
    state,
    provider,
    /** Resolves the next time a dispatch has streamed its text and is waiting for the abort. */
    ready: () => new Promise((resolve) => state.waiters.push(resolve)),
  };
}
/** Starts a streaming (or plain) request, waits until the provider is mid-call, then hangs up. */
async function cancelMidCall(f, holding, data, token, path = "/v1/reasoning/stream") {
  const controller = new AbortController();
  const ready = holding.ready();
  const pending = fetch(f.base + path, {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  }).then((r) => r.text(), () => undefined);
  await ready;
  controller.abort();
  await pending;
}

test("a normal streamed call is charged exactly what the provider reported", async (t) => {
  const f = await fixture(t, { env: meterEnv, provider: streamingProvider(['{"say":"', 'x"}']) });
  const token = await f.login();
  await f.subscribe(token);
  const r = await streamRequest(f, requestJob("normal"), token);
  assert.equal(r.events.at(-1).event, "result");
  assert.deepEqual(await usageOf(f, token), { requests: 1, inputTokens: 25, outputTokens: 8 });
});

test("a call cancelled after N streamed bytes is charged for the input it sent and the output it received", async (t) => {
  const text = "x".repeat(1200);
  const holding = holdingProvider({ text });
  const f = await fixture(t, { env: meterEnv, provider: holding.provider });
  const token = await f.login();
  await f.subscribe(token);
  const data = requestJob("cancel-after-text");
  await cancelMidCall(f, holding, data, token);
  // 1,200 bytes / 2 + 64 slack output; sent bytes / 2 + 512 overhead input.
  const expected = {
    requests: 1,
    inputTokens: Math.ceil(sentBytesOf(data) / 2) + 512,
    outputTokens: 664,
  };
  assert.ok(expected.inputTokens < reservedInputOf(data));
  await waitForUsage(f, token, expected);
  // What the provider billed is covered by the charge.
  assert.ok(holding.state.billedOutput <= expected.outputTokens);
  // The job cannot run again, and replays change nothing.
  for (let i = 0; i < 3; i++) {
    const replay = await streamRequest(f, data, token);
    assert.equal(replay.status, 409);
    assert.equal(replay.value.error.code, "jobAlreadyFailed");
  }
  assert.equal((await f.request("/v1/reasoning", data, token)).value.error.code, "jobAlreadyFailed");
  assert.deepEqual(await usageOf(f, token), expected);
  assert.equal(holding.state.dispatches, 1);
});

test("a call cancelled after one token pays a quarter of the output reservation, not all of it", async (t) => {
  const holding = holdingProvider({ text: "{" });
  const f = await fixture(t, { env: meterEnv, provider: holding.provider });
  const token = await f.login();
  await f.subscribe(token);
  await cancelMidCall(f, holding, requestJob("one-token"), token);
  const usage = await waitForUsage(f, token, { requests: 1, outputTokens: 512 });
  assert.ok(usage.outputTokens < 2048);
});

test("a call cancelled before any token keeps the whole reservation, streaming or not", async (t) => {
  const holding = holdingProvider();
  const f = await fixture(t, { env: meterEnv, provider: holding.provider });
  const token = await f.login();
  await f.subscribe(token);
  const streamed = requestJob("cancel-before-token");
  await cancelMidCall(f, holding, streamed, token);
  await waitForUsage(f, token, {
    requests: 1,
    inputTokens: reservedInputOf(streamed),
    outputTokens: 2048,
  });
  // A non-streaming call can never show progress, so it keeps the reservation too.
  const plain = requestJob("cancel-plain");
  await cancelMidCall(f, holding, plain, token, "/v1/reasoning");
  await waitForUsage(f, token, {
    requests: 2,
    inputTokens: reservedInputOf(streamed) + reservedInputOf(plain),
    outputTokens: 4096,
  });
});

test("a failed call is priced by what it streamed first, and keeps the reservation when it streamed nothing", async (t) => {
  const failing = (text) => ({
    async run(_job, _prompt, _signal, onText) {
      if (text) await onText(text);
      throw new Error("synthetic upstream failure");
    },
  });
  const partial = await fixture(t, { env: meterEnv, provider: failing('{"say":"Who') });
  const token = await partial.login();
  await partial.subscribe(token);
  const data = requestJob("failed-after-text");
  await streamRequest(partial, data, token);
  assert.deepEqual(await usageOf(partial, token), {
    requests: 1,
    inputTokens: Math.ceil(sentBytesOf(data) / 2) + 512,
    outputTokens: 512,
  });
  const silent = await fixture(t, { env: meterEnv, provider: failing("") });
  const other = await silent.login();
  await silent.subscribe(other);
  const bare = requestJob("failed-silent");
  assert.equal((await streamRequest(silent, bare, other)).status, 502);
  assert.deepEqual(await usageOf(silent, other), {
    requests: 1,
    inputTokens: reservedInputOf(bare),
    outputTokens: 2048,
  });
});

test("a result the service rejects after streaming is charged the provider's report, or the estimate without one", async (t) => {
  const reject = async (name, usage, expected) => {
    const bad = { ...output, output: { say: 12 } };
    if (usage) bad.usage = usage;
    else delete bad.usage;
    const f = await fixture(t, {
      env: meterEnv,
      provider: streamingProvider(["x".repeat(1000)], () => bad),
    });
    const token = await f.login();
    await f.subscribe(token);
    const data = requestJob(`rejected-${name}`);
    const r = await streamRequest(f, data, token);
    assert.equal(r.events.at(-1).data.code, "invalidProviderResult", name);
    const charged = await usageOf(f, token);
    assert.deepEqual(
      { input: charged.inputTokens, output: charged.outputTokens },
      expected(data),
      name,
    );
  };
  // The provider reported 300 in / 2,000 out for a result that was then rejected: that is what it spent.
  await reject("reported", { input: 300, output: 2000 }, () => ({ input: 300, output: 2000 }));
  // No report: 1,000 bytes received -> 500 + 64 tokens.
  await reject("estimated", undefined, (d) => ({
    input: Math.ceil(sentBytesOf(d) / 2) + 512,
    output: 564,
  }));
  // A report above the reservation is not trusted and not used to lower the charge.
  await reject("overreported", { input: 300, output: 999999 }, (d) => ({
    input: reservedInputOf(d),
    output: 2048,
  }));
});

test("on the deep lane the minimum and the input estimate double, and a silent deep cancel keeps the doubled reservation", async (t) => {
  const holding = holdingProvider({ text: "{" });
  const f = await fixture(t, { env: meterEnv, provider: holding.provider });
  const token = await f.login();
  await f.subscribe(token);
  const data = requestJob("deep-cancel", { lane: "deep", intent: "checkConversation" });
  await cancelMidCall(f, holding, data, token);
  await waitForUsage(f, token, {
    requests: 1,
    inputTokens: (Math.ceil(sentBytesOf(data) / 2) + 512) * 2,
    outputTokens: 1024,
  });
  const silent = holdingProvider();
  const g = await fixture(t, { env: meterEnv, provider: silent.provider });
  const other = await g.login();
  await g.subscribe(other);
  await cancelMidCall(g, silent, requestJob("deep-silent", { lane: "deep", intent: "checkConversation" }), other);
  await waitForUsage(g, other, { requests: 1, outputTokens: 4096 });
});

test("a client that hangs up before dispatch reserves and charges nothing", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    env: meterEnv,
    provider: {
      async run() {
        calls++;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  // Past the grace period the next request has to reconcile billing first; hold that open
  // and hang up meanwhile.
  f.advance(f.config.billingMaxAgeMs + 1000);
  const release = f.holdSubscriptions();
  const before = f.subscriptionCalls();
  const controller = new AbortController();
  const pending = fetch(f.base + "/v1/reasoning/stream", {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(requestJob("hung-up", { deadlineMs: f.now() + 30000 })),
  }).catch(() => undefined);
  for (let i = 0; i < 100 && f.subscriptionCalls() === before; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(f.subscriptionCalls() > before, "the request reached billing reconciliation");
  controller.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 50));
  release();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls, 0, "no provider call for a client that is gone");
  assert.equal((await usageOf(f, token)).requests, 0);
  // Not a tombstone: the same job id can still be run by a client that stays.
  assert.equal((await streamRequest(f, requestJob("hung-up", { deadlineMs: f.now() + 30000 }), token)).status, 200);
  assert.equal(calls, 1);
});

/** One streaming attempt: resolves when the provider is mid-call (hang up with `hangUp`) or admission refuses. */
async function attempt(f, token, holding, data) {
  const controller = new AbortController();
  const ready = holding.ready();
  const refusal = fetch(f.base + "/v1/reasoning/stream", {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  }).then(
    async (r) => (r.status === 200 ? new Promise(() => {}) : { status: r.status, value: await r.json() }),
    () => new Promise(() => {}),
  );
  const outcome = await Promise.race([ready.then(() => "dispatched"), refusal]);
  if (outcome === "dispatched") return { dispatched: true, hangUp: () => controller.abort() };
  holding.state.waiters.pop();
  return { dispatched: false, refusal: outcome };
}

test("a cancel loop is bounded by the allowance whatever the cancel timing", async (t) => {
  // Cancel just after the first token: each call is charged at least 512 output tokens, so the
  // output allowance admits a bounded number of calls and covers everything the provider billed.
  const early = holdingProvider({ text: "{" });
  const f = await fixture(t, {
    env: { ...meterEnv, STANDARD_REQUESTS: "1000", STANDARD_OUTPUT_TOKENS: "8192" },
    provider: early.provider,
  });
  const token = await f.login();
  await f.subscribe(token);
  let refused;
  for (let i = 0; i < 60 && !refused; i++) {
    const a = await attempt(f, token, early, requestJob(`loop-early-${i}`));
    if (!a.dispatched) refused = a.refusal;
    else {
      a.hangUp();
      await waitForUsage(f, token, { requests: i + 1, outputTokens: 512 * (i + 1) });
    }
  }
  // Admission needs the full output cap free (2,048): 512 * (n - 1) + 2,048 <= 8,192 gives n = 13.
  assert.equal(refused?.value.error.code, "allowanceExceeded");
  assert.equal(early.state.dispatches, 13);
  const usage = await usageOf(f, token);
  assert.equal(usage.outputTokens, 13 * 512);
  assert.ok(usage.outputTokens <= 8192);
  assert.ok(early.state.billedOutput <= usage.outputTokens, "provider spend stays inside the charge");

  // Cancel before any token: the whole reservation is charged, so the loop ends after 4 calls.
  const late = holdingProvider();
  const g = await fixture(t, {
    env: { ...meterEnv, STANDARD_REQUESTS: "1000", STANDARD_OUTPUT_TOKENS: "8192" },
    provider: late.provider,
  });
  const second = await g.login();
  await g.subscribe(second);
  let done;
  for (let i = 0; i < 10 && !done; i++) {
    const a = await attempt(g, second, late, requestJob(`loop-late-${i}`));
    if (!a.dispatched) done = a.refusal;
    else {
      a.hangUp();
      await waitForUsage(g, second, { requests: i + 1, outputTokens: 2048 * (i + 1) });
    }
  }
  assert.equal(done?.value.error.code, "allowanceExceeded");
  assert.equal(late.state.dispatches, 4);
});

test("a burst of cancelled streams never runs more provider calls than the concurrency limits", async (t) => {
  const holding = holdingProvider({ text: "{" });
  const f = await fixture(t, {
    env: { ...meterEnv, USER_CONCURRENCY: "2", GLOBAL_CONCURRENCY: "2", STANDARD_REQUESTS: "30" },
    provider: holding.provider,
  });
  const token = await f.login();
  await f.subscribe(token);
  const controllers = [];
  const results = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(f.base + "/v1/reasoning/stream", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(requestJob(`burst-${i}`)),
      }).catch(() => undefined);
      if (response?.status === 200) {
        // Hang up as soon as the first event arrives.
        await response.body.getReader().read().catch(() => {});
        controller.abort();
        return "cancelled";
      }
      return response?.status;
    }),
  );
  assert.ok(results.includes(429), "excess calls are refused while the slots are full");
  assert.ok(holding.state.maxRunning <= 2, `at most 2 provider calls at once, saw ${holding.state.maxRunning}`);
  assert.ok(holding.state.dispatches <= 12);
  // Everything that was dispatched is charged at least the minimum, none free.
  const usage = await waitForUsage(f, token, { requests: holding.state.dispatches, outputTokens: 512 * holding.state.dispatches });
  assert.ok(usage.requests <= 30);
});

test("cancelled calls are metered but never reported to error monitoring as server errors", async (t) => {
  const c = collector();
  const holding = holdingProvider({ text: "{" });
  const f = await fixture(t, { env: meterEnv, monitor: c.monitor, provider: holding.provider });
  const token = await f.login();
  await f.subscribe(token);
  // Streamed cancel after text, streamed cancel before any text (provider silent), non-streaming cancel.
  await cancelMidCall(f, holding, requestJob("monitor-text"), token);
  await waitForUsage(f, token, { requests: 1, outputTokens: 512 });
  const silent = holdingProvider();
  const g = await fixture(t, { env: meterEnv, monitor: c.monitor, provider: silent.provider });
  const other = await g.login();
  await g.subscribe(other);
  await cancelMidCall(g, silent, requestJob("monitor-silent"), other);
  await waitForUsage(g, other, { requests: 1, outputTokens: 2048 });
  await cancelMidCall(g, silent, requestJob("monitor-plain"), other, "/v1/reasoning");
  await waitForUsage(g, other, { requests: 2, outputTokens: 4096 });
  await c.monitor.flush();
  assert.equal(c.sent.length, 0, "a client leaving is not a fault");
});

// --- Retention of usage, job and Stripe event rows (issue #96) ---

function retentionDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "live-service-retention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "service.sqlite");
  const side = () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  };
  return { path, side };
}
const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(label);
};
async function signedWebhook(f, id, timestamp) {
  const raw = JSON.stringify({
    id,
    object: "event",
    type: "customer.subscription.updated",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_fixture", customer: "cus_1" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: "whsec_fixture",
    ...(timestamp ? { timestamp } : {}),
  });
  const res = await fetch(f.base + "/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: raw,
  });
  return { status: res.status, value: await res.json() };
}

test("a replayed Stripe event is deduplicated inside the 35-day window, and after pruning it only reconciles current state", async (t) => {
  const db = retentionDb(t);
  const f = await fixture(t, { env: { DATABASE_PATH: db.path }, service: { retentionIntervalMs: 3600000 } });
  const token = await f.login();
  await f.subscribe(token);
  const side = db.side();
  t.after(() => side.close());
  const calls = f.subscriptionCalls();
  // Inside the window: the stored id answers the replay without asking Stripe again.
  await f.app.prune();
  assert.equal((await f.webhook("evt_1")).status, 200);
  assert.equal(f.subscriptionCalls(), calls);
  assert.equal(side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_1'").get().n, 1);
  // The subscription is cancelled at Stripe. The stored id ages past the window and is pruned.
  f.setSubscription("canceled");
  side.prepare("UPDATE webhooks SET received_at=? WHERE id='evt_1'").run(Date.now() - 36 * 86400000);
  await f.app.prune();
  assert.equal(side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_1'").get().n, 0);
  // A redelivery of that old event is processed again, and what it does is reconcile the current
  // state: the cancelled subscription is not resurrected by the stale event.
  assert.equal((await signedWebhook(f, "evt_1")).status, 200);
  assert.equal(f.subscriptionCalls(), calls + 1);
  const account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.plan, "none");
  assert.equal(account.canUseAI, false);
  // A captured request replayed later fails on the signature timestamp whatever is stored.
  const stale = await signedWebhook(f, "evt_1", Math.floor(Date.now() / 1000) - 600);
  assert.equal(stale.status, 400);
  assert.equal(stale.value.error.code, "invalidWebhook");
});

test("a job id cannot run again after its record is pruned, because its deadline has passed", async (t) => {
  const db = retentionDb(t);
  let calls = 0;
  const f = await fixture(t, {
    env: { DATABASE_PATH: db.path },
    provider: {
      async run() {
        calls++;
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const side = db.side();
  t.after(() => side.close());
  const request = requestJob("old-job");
  assert.equal((await f.request("/v1/reasoning", request, token)).status, 200);
  assert.equal((await f.request("/v1/reasoning", request, token)).value.error.code, "jobAlreadyCompleted");
  f.advance(31000);
  side.prepare("UPDATE job_dispatches SET created_at=? WHERE job_key<>''").run(Date.UTC(2024, 0, 1));
  await f.app.prune();
  assert.equal(side.prepare("SELECT count(*) AS n FROM job_dispatches").get().n, 0);
  const replay = await f.request("/v1/reasoning", request, token);
  assert.equal(replay.status, 408);
  assert.equal(replay.value.error.code, "jobExpired");
  assert.equal(calls, 1);
});

test("the startup pass and the periodic pass prune without a request, and the allowance holds stay", async (t) => {
  const db = retentionDb(t);
  const f = await fixture(t, { env: { DATABASE_PATH: db.path }, service: { retentionIntervalMs: 25 } });
  const token = await f.login();
  const userId = (await f.request("/v1/account", undefined, token)).value.user.id;
  const side = db.side();
  t.after(() => side.close());
  const old = (id) =>
    side.prepare("INSERT INTO webhooks(id,type,customer,status,received_at) VALUES(?,?,?,?,?)").run(id, "x", null, "complete", Date.now() - 40 * 86400000);
  side.prepare("INSERT INTO usage VALUES(?,?,?,?,?)").run(userId, "2020-01", 1, 1, 1);
  side.prepare("INSERT INTO allowance_holds VALUES(?,?,?,?,?)").run("hash", new Date().toISOString().slice(0, 7), 1, 1, 1);
  old("evt_periodic");
  // The 25 ms timer finds them with no request in between.
  await waitFor(
    () => side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_periodic'").get().n === 0,
    "periodic pass pruned the event",
  );
  assert.equal(side.prepare("SELECT count(*) AS n FROM usage WHERE period='2020-01'").get().n, 0);
  assert.equal(side.prepare("SELECT count(*) AS n FROM allowance_holds").get().n, 1);
  // Startup: rows already present when the service starts are gone shortly after, without any request.
  old("evt_startup");
  await f.restart();
  await waitFor(
    () => side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_startup'").get().n === 0,
    "startup pass pruned the event",
  );
});

test("a large backlog is pruned in batches while requests are still answered", async (t) => {
  const db = retentionDb(t);
  const f = await fixture(t, {
    env: { DATABASE_PATH: db.path },
    service: { retentionIntervalMs: 3600000, retentionBatch: 1 },
  });
  await f.login();
  const side = db.side();
  t.after(() => side.close());
  const insert = side.prepare("INSERT INTO webhooks(id,type,customer,status,received_at) VALUES(?,?,?,?,?)");
  side.exec("BEGIN");
  for (let i = 0; i < 3000; i++) insert.run(`backlog-${i}`, "x", null, "complete", Date.now() - 40 * 86400000);
  side.exec("COMMIT");
  let finishedAt = 0;
  const pass = f.app.prune().then(() => (finishedAt = performance.now()));
  const health = await fetch(f.base + "/health").then(async (r) => ({ status: r.status, at: performance.now() }));
  assert.equal(health.status, 200);
  assert.equal(finishedAt, 0, "the health check was answered while the pass was still running");
  await pass;
  assert.equal(side.prepare("SELECT count(*) AS n FROM webhooks").get().n, 0);
  // A second caller during a pass shares it instead of starting another.
  const one = f.app.prune();
  assert.equal(f.app.prune(), one);
  await one;
});

test("a failed retention pass reports only a constant code, never rejects, and the next pass catches up", async (t) => {
  const db = retentionDb(t);
  let broken = false;
  const real = Date.now;
  const c = collector();
  const f = await fixture(t, {
    env: { DATABASE_PATH: db.path },
    monitor: c.monitor,
    service: {
      retentionIntervalMs: 3600000,
      now: () => {
        if (broken) throw new Error("synthetic clock failure with private detail");
        return real();
      },
    },
  });
  await f.login();
  const side = db.side();
  t.after(() => side.close());
  side.prepare("INSERT INTO webhooks(id,type,customer,status,received_at) VALUES(?,?,?,?,?)").run("evt_late", "x", null, "complete", real() - 40 * 86400000);
  const written = [];
  t.mock.method(process.stderr, "write", (chunk) => (written.push(String(chunk)), true));
  broken = true;
  await f.app.prune();
  broken = false;
  t.mock.restoreAll();
  assert.deepEqual(written, ['{"code":"retentionPassFailed"}\n']);
  // Monitoring gets one event with the route, and none of the error's content.
  await c.monitor.flush();
  assert.equal(c.sent.length, 1);
  assert.equal(c.events()[0].tags.route, "retention");
  assert.doesNotMatch(c.text(), /private detail|synthetic clock/);
  assert.equal(side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_late'").get().n, 1);
  await f.app.prune();
  assert.equal(side.prepare("SELECT count(*) AS n FROM webhooks WHERE id='evt_late'").get().n, 0);
});

test("a provider refusal before any body refunds the request and its tokens", async (t) => {
  const refused = () =>
    Object.assign(new ServiceError(502, "providerUnavailable"), {
      providerNotAccepted: true,
    });
  const f = await fixture(t, {
    provider: {
      async run() {
        throw refused();
      },
      async decide() {
        throw refused();
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", requestJob("refused-1"), token);
  assert.equal(r.status, 502);
  assert.deepEqual(r.value, { error: { code: "providerUnavailable" } });
  const s = await streamRequest(f, requestJob("refused-2"), token);
  assert.equal(s.status, 502);
  const d = await f.request("/v1/decide", { basis, questions }, token);
  assert.equal(d.status, 502);
  assert.deepEqual(
    (await f.request("/v1/account", undefined, token)).value.usage,
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  );
  // The job is settled, not left pending: a replay is a conflict, never a second dispatch.
  const replay = await f.request("/v1/reasoning", requestJob("refused-1"), token);
  assert.equal(replay.status, 409);
});

test("/ready proves the database answers and takes writes; /health stays plain liveness", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "live-service-ready-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "service.sqlite");
  const f = await fixture(t, { env: { DATABASE_PATH: path } });
  const ready = await f.request("/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.value, { ready: true });
  // Another writer holds the database: not ready, but still alive.
  const other = new DatabaseSync(path);
  t.after(() => other.close());
  other.exec("BEGIN EXCLUSIVE");
  try {
    const blocked = await f.request("/ready");
    assert.equal(blocked.status, 503);
    assert.deepEqual(blocked.value, { ready: false });
  } finally {
    other.exec("ROLLBACK");
  }
  assert.equal((await f.request("/health")).status, 200);
  assert.equal((await f.request("/ready")).status, 200);
});

test("without a decision key, reasoning still works and only /v1/decide is unavailable", async (t) => {
  const config = loadConfig({ ...env, JEV_API_KEY: "" });
  assert.equal(config.providerConfigured, true);
  assert.equal(config.decideConfigured, false);
  assert.ok(config.missing.decide.includes("JEV_API_KEY"));
  const f = await fixture(t, { env: { JEV_API_KEY: "" } });
  const token = await f.login();
  await f.subscribe(token);
  const account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.canUseAI, true);
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("no-jev"), token)).status,
    200,
  );
  const d = await f.request("/v1/decide", { basis, questions }, token);
  assert.equal(d.status, 503);
  assert.equal(d.value.error.code, "decisionNotConfigured");
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    1,
  );
});

test("a job deadline beyond the provider budget is refused before any charge", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  const far = await f.request(
    "/v1/reasoning",
    requestJob("far", { deadlineMs: Date.now() + 100000 }),
    token,
  );
  assert.equal(far.status, 400);
  assert.equal(far.value.error.code, "invalidJob");
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.usage.requests,
    0,
  );
});

test("automatic guidance and decisions leave one slot free for a requested card", async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  let started;
  const running = new Promise((r) => (started = r));
  const f = await fixture(t, {
    env: { USER_CONCURRENCY: "2" },
    provider: {
      async run(job) {
        if (job.id === "auto-held") {
          started();
          await held;
        }
        return structuredClone(output);
      },
      async decide() {
        return {
          answers: { gap: { type: "noul", noul: 0.8 } },
          model: "jev-latest",
        };
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const pending = f.request(
    "/v1/reasoning",
    requestJob("auto-held", { trigger: "automatic" }),
    token,
  );
  await running;
  const second = await f.request(
    "/v1/reasoning",
    requestJob("auto-2", { trigger: "automatic" }),
    token,
  );
  assert.equal(second.status, 429);
  assert.equal(second.value.error.code, "concurrencyExceeded");
  const decision = await f.request("/v1/decide", { basis, questions }, token);
  assert.equal(decision.status, 429);
  const requested = await f.request("/v1/reasoning", requestJob("hotkey"), token);
  assert.equal(requested.status, 200);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(
    (await f.request("/v1/decide", { basis, questions }, token)).status,
    200,
  );
});

// Billing resilience: entitlement cache, customer lifecycle, price changes, sign-out everywhere.
async function until(check) {
  for (let i = 0; i < 300 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
}
const jobAt = (f, id) => requestJob(id, { deadlineMs: f.now() + 30000 });

test("a Stripe failure inside the grace period serves the cached plan, refreshes in the background and is reported without content", async (t) => {
  const c = collector();
  const f = await fixture(t, { monitor: c.monitor });
  const token = await f.login();
  await f.subscribe(token);
  f.advance(61000);
  f.setSubscriptionFailure(true);
  const before = f.subscriptionCalls();
  const r = await f.request("/v1/reasoning", jobAt(f, "grace-1"), token);
  assert.equal(r.status, 200);
  await until(() => f.subscriptionCalls() > before);
  await new Promise((r) => setTimeout(r, 50));
  // The failed refresh did not wipe the cached entitlement.
  const again = await f.request("/v1/reasoning", jobAt(f, "grace-2"), token);
  assert.equal(again.status, 200);
  const account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.canUseAI, true);
  assert.equal(account.plan, "standard");
  assert.equal(account.code, "billingUnavailable");
  await c.monitor.flush();
  assert.ok(
    c
      .events()
      .some((e) => e.tags.route === "/v1/reasoning" && e.tags.status === "503"),
    "the background refresh failure is reported",
  );
  assert.deepEqual(
    leaks(c.text(), token, "synthetic private upstream detail"),
    [],
  );
});

test("once the grace period has passed a Stripe failure fails closed", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.advance(f.config.billingMaxAgeMs + 1000);
  f.setSubscriptionFailure(true);
  const r = await f.request("/v1/reasoning", jobAt(f, "late-1"), token);
  assert.equal(r.status, 503);
  assert.deepEqual(r.value, { error: { code: "billingUnavailable" } });
  const account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.canUseAI, false);
  f.setSubscriptionFailure(false);
  assert.equal(
    (await f.request("/v1/reasoning", jobAt(f, "late-2"), token)).status,
    200,
  );
});

test("a background refresh picks up a cancellation for the next request", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.advance(61000);
  f.setSubscription("canceled");
  const before = f.subscriptionCalls();
  assert.equal(
    (await f.request("/v1/reasoning", jobAt(f, "cancel-1"), token)).status,
    200,
  );
  await until(() => f.subscriptionCalls() > before);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    (await f.request("/v1/reasoning", jobAt(f, "cancel-2"), token)).status,
    402,
  );
});

test("concurrent stale requests ask Stripe once, whether they wait for the refresh or not", async (t) => {
  const f = await fixture(t, { env: { USER_CONCURRENCY: "4" } });
  const token = await f.login();
  await f.subscribe(token);
  // Inside the grace period: answered at once from the cache, one background refresh.
  f.advance(61000);
  let release = f.holdSubscriptions();
  let before = f.subscriptionCalls();
  const answers = await Promise.all(
    ["q-1", "q-2", "q-3"].map((id) =>
      f.request("/v1/reasoning", jobAt(f, id), token),
    ),
  );
  assert.deepEqual(
    answers.map((a) => a.status),
    [200, 200, 200],
  );
  await until(() => f.subscriptionCalls() > before);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.subscriptionCalls() - before, 1);
  // Waiting refreshes queue behind the first and reuse its result.
  f.advance(61000);
  release = f.holdSubscriptions();
  before = f.subscriptionCalls();
  const pending = Promise.all(
    [1, 2, 3].map(() => f.request("/v1/account", undefined, token)),
  );
  await until(() => f.subscriptionCalls() > before);
  release();
  const accounts = await pending;
  assert.ok(accounts.every((a) => a.value.canUseAI === true));
  assert.equal(f.subscriptionCalls() - before, 1);
});

test("customer.deleted forgets the customer and its pending Checkout; the next Checkout creates a new customer", async (t) => {
  const f = await fixture(t, { expectedCustomer: ["cus_1", "cus_2"] });
  const token = await f.login();
  assert.equal(
    (await f.request("/v1/billing/checkout", { plan: "standard" }, token))
      .status,
    200,
  );
  f.deletedCustomers.add("cus_1");
  const deleted = await f.webhook("evt_customer_deleted", undefined, {
    type: "customer.deleted",
    data: { object: { id: "cus_1", object: "customer", deleted: true } },
  });
  assert.equal(deleted.status, 200);
  const exported = (await f.request("/v1/account/export", undefined, token))
    .value;
  assert.equal(JSON.stringify(exported).includes("cus_1"), false);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.plan,
    "none",
  );
  const again = await f.request(
    "/v1/billing/checkout",
    { plan: "standard" },
    token,
  );
  assert.equal(again.status, 200);
  assert.deepEqual(
    f.customers.map((c) => c.id),
    ["cus_1", "cus_2"],
  );
  assert.notEqual(f.customers[0].key, f.customers[1].key);
  assert.equal(f.checkoutCreates(), 2);
});

test("Checkout replaces a customer deleted at Stripe whose deletion event never arrived", async (t) => {
  const f = await fixture(t, { expectedCustomer: ["cus_1", "cus_2"] });
  const token = await f.login();
  assert.equal(
    (await f.request("/v1/billing/checkout", { plan: "standard" }, token))
      .status,
    200,
  );
  f.deletedCustomers.add("cus_1");
  const again = await f.request(
    "/v1/billing/checkout",
    { plan: "premium" },
    token,
  );
  assert.equal(again.status, 200);
  assert.deepEqual(
    f.customers.map((c) => c.id),
    ["cus_1", "cus_2"],
  );
  assert.notEqual(f.customers[0].key, f.customers[1].key);
  f.setSubscription("active");
  assert.equal((await f.webhook("evt_new_customer", "cus_2")).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.canUseAI,
    true,
  );
});

test("subscribers on a grandfathered price keep their plan after the price changes", async (t) => {
  const f = await fixture(t, {
    env: {
      STRIPE_STANDARD_LEGACY_PRICE_IDS:
        "price_standard_2025, price_standard_2024",
      STRIPE_PREMIUM_LEGACY_PRICE_IDS: "price_premium_2025",
    },
  });
  const token = await f.login();
  f.setPrice("price_standard_2024");
  await f.subscribe(token);
  let account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.plan, "standard");
  assert.equal(account.canUseAI, true);
  f.setPrice("price_premium_2025");
  assert.equal((await f.webhook("evt_legacy_premium")).status, 200);
  account = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(account.plan, "premium");
  f.setPrice("price_unlisted");
  assert.equal((await f.webhook("evt_unlisted")).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.canUseAI,
    false,
  );
});

test("a grandfathered price may not name another plan's price, and the value is not echoed", () => {
  const config = loadConfig({
    ...env,
    STRIPE_STANDARD_LEGACY_PRICE_IDS: "price_premium",
  });
  assert.equal(config.billingConfigured, false);
  assert.ok(
    config.missing.billing.some((m) =>
      m.startsWith("STRIPE_STANDARD_LEGACY_PRICE_IDS"),
    ),
  );
  assert.ok(!JSON.stringify(config.missing).includes("price_premium"));
  const overlap = loadConfig({
    ...env,
    STRIPE_STANDARD_LEGACY_PRICE_IDS: "price_old",
    STRIPE_PREMIUM_LEGACY_PRICE_IDS: "price_old",
  });
  assert.equal(overlap.billingConfigured, false);
  assert.deepEqual(loadConfig(env).stripe.legacyPrices, {
    standard: [],
    premium: [],
  });
});

test("an identity provider failure on the callback is reported without content; a cancelled sign-in is not", async (t) => {
  const c = collector();
  let failure;
  const f = await fixture(t, {
    monitor: c.monitor,
    oidc: {
      async authorizationUrl(flow) {
        return `https://identity.example/authorize?state=${flow.state}`;
      },
      async authenticate() {
        throw failure();
      },
    },
  });
  const d = await f.start();
  const page = await f.request("/auth/device", { user_code: d.userCode });
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
  const callback = async (csrf) => {
    const a = await f.request("/auth/device/authorize", { csrf }, undefined, {
      cookie,
    });
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    return f.request(
      `/auth/callback?code=x&state=${state}`,
      undefined,
      undefined,
      { cookie },
    );
  };
  // The person cancelled at the identity provider, or the code expired: normal traffic.
  failure = () =>
    Object.assign(new Error(`access denied for ${LEAK.email}`), {
      code: "OAUTH_AUTHORIZATION_RESPONSE_ERROR",
      error: "access_denied",
    });
  let r = await callback(csrfOf(page.value));
  assert.equal(r.status, 400);
  failure = () =>
    Object.assign(new Error("expired"), {
      code: "OAUTH_RESPONSE_BODY_ERROR",
      error: "invalid_grant",
    });
  r = await callback(csrfOf(r.value));
  assert.equal(r.status, 400);
  await c.monitor.flush();
  assert.equal(c.sent.length, 0);
  // The identity provider or its keys are broken: an operator problem.
  failure = () =>
    new TypeError(`fetch failed for ${LEAK.email} ${LEAK.transcript}`);
  r = await callback(csrfOf(r.value));
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.value, /fetch failed/);
  await c.monitor.flush();
  assert.equal(c.sent.length, 1);
  assert.deepEqual(leaks(c.text()), []);
  const [event] = c.events();
  assert.equal(event.tags.route, "/auth/callback");
  assert.deepEqual(
    event.exception.values.map((v) => [v.type, v.value]),
    [
      ["TypeError", undefined],
      ["ServiceError", "identityExchangeFailed"],
    ],
  );
});

test("a webhook for an erased account's customer never stores that customer id again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "live-service-erase-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const f = await fixture(t, { env: { DATABASE_PATH: path } });
  const token = await f.login();
  await f.subscribe(token);
  assert.equal(
    (
      await f.request(
        "/v1/account/delete",
        { confirm: "delete-account" },
        token,
      )
    ).status,
    200,
  );
  assert.equal((await f.webhook("evt_after_erase")).status, 200);
  assert.equal(
    (
      await f.webhook("evt_deleted_after_erase", undefined, {
        type: "customer.deleted",
        data: { object: { id: "cus_1", object: "customer", deleted: true } },
      })
    ).status,
    200,
  );
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM webhooks WHERE customer='cus_1'")
      .get().n,
    0,
  );
});

test("signing out everywhere revokes every session and every approved sign-in not yet collected", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  f.advance(5000);
  const second = await f.login();
  f.advance(5000);
  const waiting = await f.start();
  await f.approve(waiting);
  assert.equal((await f.request("/v1/auth/logout-all", {})).status, 401);
  assert.equal(
    (await f.request("/v1/auth/logout-all", { all: true }, first)).status,
    400,
  );
  const r = await f.request("/v1/auth/logout-all", {}, first);
  assert.equal(r.status, 200);
  assert.deepEqual(r.value, { ok: true });
  for (const token of [first, second])
    assert.equal(
      (await f.request("/v1/account", undefined, token)).status,
      401,
    );
  f.advance(5000);
  assert.equal(
    (
      await f.request("/v1/auth/device/poll", {
        deviceCode: waiting.deviceCode,
      })
    ).status,
    400,
  );
  // Signing in again afterwards works as usual.
  f.advance(5000);
  const fresh = await f.login();
  assert.equal(
    (await f.request("/v1/account", undefined, fresh)).status,
    200,
  );
});

// Session renewal (S4): sliding, rotating, idempotent and capped.
const DAY_MS = 86400000;
const renew = (f, token, data = {}) => f.request("/v1/auth/renew", data, token);
test("a session far from expiry is not renewed; one near expiry is rotated to a new token", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  const signedInAt = f.now();
  const early = await renew(f, token);
  assert.equal(early.status, 200);
  assert.deepEqual(early.value, {
    renewed: false,
    expiresAtMs: signedInAt + f.config.sessionTtlMs,
    signInRequiredAtMs: signedInAt + f.config.sessionMaxLifetimeMs,
  });
  assert.equal((await renew(f, undefined)).status, 401);
  assert.equal((await renew(f, token, { extend: true })).status, 400);
  f.advance(24 * DAY_MS);
  const r = await renew(f, token);
  assert.equal(r.status, 200);
  assert.equal(r.value.renewed, true);
  assert.notEqual(r.value.sessionToken, token);
  assert.ok(r.value.sessionToken.length >= 40);
  assert.equal(r.value.expiresAtMs, f.now() + f.config.sessionTtlMs);
  assert.equal(r.value.signInRequiredAtMs, signedInAt + f.config.sessionMaxLifetimeMs);
  // The old token still answers (calls in flight, a lost response) until the new one is used.
  assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
  assert.equal((await f.request("/v1/account", undefined, r.value.sessionToken)).status, 200);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
  // The new session lasts its full lifetime from the renewal.
  f.advance(29 * DAY_MS);
  assert.equal((await f.request("/v1/account", undefined, r.value.sessionToken)).status, 200);
});
test("renewal retries and concurrent renewals return the same new token", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  f.advance(25 * DAY_MS);
  const [a, b] = await Promise.all([renew(f, token), renew(f, token)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.value.sessionToken, b.value.sessionToken);
  // A retry after a lost response, before the new token was used.
  f.advance(60000);
  const retry = await renew(f, token);
  assert.deepEqual(retry.value, a.value);
  // Renewing the new token right away changes nothing: it is far from expiry.
  const next = await renew(f, a.value.sessionToken);
  assert.equal(next.value.renewed, false);
  assert.equal((await renew(f, token)).status, 401);
});
test("an unused old token stops working after the renewal grace period", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  f.advance(25 * DAY_MS);
  const r = await renew(f, token);
  f.advance(f.config.sessionRenewGraceMs + 1000);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
  assert.equal((await f.request("/v1/account", undefined, r.value.sessionToken)).status, 200);
});
test("renewal never extends a session past the absolute lifetime after sign-in", async (t) => {
  const f = await fixture(t);
  let token = await f.login();
  const cap = f.now() + f.config.sessionMaxLifetimeMs;
  let renewals = 0,
    expires = f.now() + f.config.sessionTtlMs;
  for (;;) {
    f.advance(expires - f.now() - 6 * DAY_MS);
    const r = await renew(f, token);
    assert.equal(r.status, 200);
    assert.equal(r.value.signInRequiredAtMs, cap);
    assert.ok(r.value.expiresAtMs <= cap);
    if (!r.value.renewed) {
      assert.equal(r.value.expiresAtMs, cap);
      break;
    }
    token = r.value.sessionToken;
    expires = r.value.expiresAtMs;
    renewals++;
    assert.ok(renewals < 10);
  }
  assert.ok(renewals >= 2);
  f.advance(cap - f.now() - 1000);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 200);
  f.advance(2000);
  assert.equal((await f.request("/v1/account", undefined, token)).status, 401);
  assert.equal((await renew(f, token)).status, 401);
});
test("signing out after a renewal revokes both tokens; signing out everywhere revokes renewed sessions", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  f.advance(25 * DAY_MS);
  const r = await renew(f, token);
  assert.equal((await f.request("/v1/auth/logout", {}, r.value.sessionToken)).status, 200);
  for (const t of [token, r.value.sessionToken])
    assert.equal((await f.request("/v1/account", undefined, t)).status, 401);
  // The old token, still unused-new, cannot renew into a revoked successor.
  assert.equal((await renew(f, token)).status, 401);
  const other = await f.login();
  f.advance(25 * DAY_MS);
  const renewed = await renew(f, other);
  assert.equal((await f.request("/v1/auth/logout-all", {}, other)).status, 200);
  for (const t of [other, renewed.value.sessionToken])
    assert.equal((await f.request("/v1/account", undefined, t)).status, 401);
});
test("unauthenticated renewal calls are capped per client and never add per-token counters", async (t) => {
  const { f, rows } = await fileFixture(t, { TRUSTED_PROXY_IPS: "127.0.0.1" });
  const before = rows("SELECT key FROM rate_limits").length;
  const client = { "x-forwarded-for": "2001:db8:5:6::1" };
  for (let i = 0; i < 40; i++) {
    const r = await f.request("/v1/auth/renew", {}, `bogus-${i}-${"x".repeat(40)}`, {
      "x-forwarded-for": `2001:db8:5:6::${(i + 1).toString(16)}`,
    });
    assert.equal(r.status, 401);
  }
  // One counter for the client's /64, none per unknown token.
  assert.equal(rows("SELECT key FROM rate_limits").length, before + 1);
  for (let i = 40; i < f.config.renewalsPerClient; i++)
    await f.request("/v1/auth/renew", {}, `bogus-${i}-${"x".repeat(40)}`, client);
  const limited = await f.request("/v1/auth/renew", {}, `bogus-last-${"x".repeat(40)}`, client);
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.value, { error: { code: "rateLimited" } });
  // A known token from another client still has its own per-token limit.
  const token = await f.login();
  const signedIn = rows("SELECT key FROM rate_limits").length;
  assert.equal((await renew(f, token)).status, 200);
  // This client's renewal counter, then the token's own once the session was found.
  assert.equal(rows("SELECT key FROM rate_limits").length, signedIn + 2);
});
test("renewal keeps only token hashes and account deletion removes its records", async (t) => {
  const { f, rows } = await fileFixture(t);
  const token = await f.login();
  f.advance(25 * DAY_MS);
  const r = await renew(f, token);
  const stored = JSON.stringify(rows("SELECT * FROM session_renewals")) +
    JSON.stringify(rows("SELECT * FROM sessions"));
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(r.value.sessionToken), false);
  assert.ok(stored.includes(hashOf(r.value.sessionToken)));
  assert.equal(
    (await f.request("/v1/account/delete", { confirm: "delete-account" }, r.value.sessionToken)).status,
    200,
  );
  assert.equal(rows("SELECT * FROM session_renewals").length, 0);
});
test("sessions from before renewal existed renew as if signed in a full lifetime before expiry", async (t) => {
  const { f, rows } = await fileFixture(t);
  const token = await f.login();
  const signedInAt = f.now();
  assert.equal(rows("SELECT * FROM session_renewals").length, 1);
  // An older service never wrote the lineage row.
  const raw = new DatabaseSync(f.config.databasePath);
  raw.prepare("DELETE FROM session_renewals").run();
  raw.close();
  f.advance(25 * DAY_MS);
  const r = await renew(f, token);
  assert.equal(r.value.renewed, true);
  assert.equal(r.value.signInRequiredAtMs, signedInAt + f.config.sessionMaxLifetimeMs);
});

// Relative job timeouts (S8): the service's own clock decides.
test("a relative timeout is measured on the service's clock and preferred over an absolute deadline", async (t) => {
  const seen = [];
  const f = await fixture(t, {
    provider: {
      async run(job) {
        seen.push(job);
        return structuredClone(output);
      },
    },
  });
  const token = await f.login();
  await f.subscribe(token);
  const relative = (id, extra = {}) => {
    const r = requestJob(id, { timeoutMs: 30000, ...extra });
    if (!("deadlineMs" in extra)) delete r.job.deadlineMs;
    return r;
  };
  const before = Date.now();
  const ok = await f.request("/v1/reasoning", relative("relative-1"), token);
  assert.equal(ok.status, 200, JSON.stringify(ok.value));
  assert.equal("timeoutMs" in seen[0], false);
  assert.ok(seen[0].deadlineMs >= before + 30000 && seen[0].deadlineMs <= Date.now() + 30000);
  // A Mac clock far off: the stale absolute deadline is ignored when a timeout is sent.
  const skewed = await f.request(
    "/v1/reasoning",
    relative("relative-2", { deadlineMs: Date.now() - 600000 }),
    token,
  );
  assert.equal(skewed.status, 200, JSON.stringify(skewed.value));
  // Without a timeout the absolute deadline still decides (older apps).
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("absolute-late", { deadlineMs: 1 }), token)).value.error.code,
    "jobExpired",
  );
  for (const timeoutMs of [0, -5, 1.5, 90001, "30000"])
    assert.equal(
      (await f.request("/v1/reasoning", relative(`bad-${String(timeoutMs)}`, { timeoutMs }), token)).value.error.code,
      "invalidJob",
    );
  const neither = requestJob("neither");
  delete neither.job.deadlineMs;
  assert.equal((await f.request("/v1/reasoning", neither, token)).value.error.code, "invalidJob");
  // A retry with a fresh timeout is the same job, not a different request.
  const retried = await f.request("/v1/reasoning", relative("relative-1", { timeoutMs: 12000 }), token);
  assert.equal(retried.value.error.code, "jobAlreadyCompleted");
});

// Sign-in limits (S9): offices behind one address, brute force still bounded.
const enter = (f, user_code, ip = "198.51.100.7") =>
  f.request("/auth/device", { user_code }, undefined, { "x-forwarded-for": ip });
test("an office behind one address can start many sign-ins and enter their codes", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  assert.deepEqual(f.config.signInLimits, {
    deviceStartsPerIp: 200,
    codeEntriesPerIp: 600,
    wrongCodesPerClient: 120,
    wrongCodeFreeStreak: 5,
    wrongCodeBackoffMs: 2000,
    wrongCodeBackoffMaxMs: 60000,
    wrongCodesPerNetworkAlert: 600,
    wrongCodeNetworkDelayMs: 2000,
    wrongCodesGlobalAlert: 10000,
    entriesPerCode: 5,
  });
  const office = { "x-forwarded-for": "198.51.100.7" };
  // More than the old limit of 20 sign-ins an hour from one address.
  for (let i = 0; i < 30; i++) {
    const d = (await f.request("/v1/auth/device", {}, undefined, office)).value;
    assert.ok(d.userCode, `sign-in ${i}`);
    assert.equal((await enter(f, d.userCode)).status, 200, `code ${i}`);
  }
});
test("one valid code opens at most five browser flows", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const limits = f.config.signInLimits;
  const d = (await f.request("/v1/auth/device", {}, undefined, { "x-forwarded-for": "198.51.100.1" })).value;
  for (let i = 0; i < limits.entriesPerCode; i++)
    assert.equal((await enter(f, d.userCode, `203.0.113.${i + 1}`)).status, 200);
  const burnt = await enter(f, d.userCode, "192.0.2.9");
  assert.equal(burnt.status, 429);
  assert.match(burnt.value, /Start signing in again/);
});
const startFrom = async (f, ip) =>
  (await f.request("/v1/auth/device", {}, undefined, { "x-forwarded-for": ip })).value;
test("wrong codes are capped per IPv4 address and IPv6 /64", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const limits = f.config.signInLimits;
  limits.wrongCodesPerClient = 6;
  limits.wrongCodeFreeStreak = 100; // no backoff in this test
  for (let i = 0; i < 6; i++)
    assert.equal((await enter(f, "BCDF-GHJK", "198.51.100.2")).status, 400);
  assert.equal((await enter(f, "BCDF-GHJK", "198.51.100.2")).status, 429);
  // A neighbour in the same /24 is not refused.
  assert.equal((await enter(f, "BCDF-GHJK", "198.51.100.3")).status, 400);
  // Rotating the interface identifier stays in one /64 (any spelling of it).
  for (let i = 0; i < 6; i++)
    assert.equal((await enter(f, "BCDF-GHJK", `2001:db8:1:2::${(i + 1).toString(16)}`)).status, 400);
  assert.equal((await enter(f, "BCDF-GHJK", "2001:0db8:0001:0002:ffff:eeee:dddd:cccc")).status, 429);
  assert.equal((await enter(f, "BCDF-GHJK", "2001:db8:1:3::1")).status, 400);
});
test("consecutive wrong codes from one client back off exponentially, capped at a minute, and reset on success", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const limits = f.config.signInLimits;
  assert.equal(limits.wrongCodeBackoffMaxMs, 60000);
  limits.wrongCodeFreeStreak = 3;
  limits.wrongCodeBackoffMs = 1000;
  limits.wrongCodeBackoffMaxMs = 4000;
  const ip = "198.51.100.7";
  for (let i = 0; i < 3; i++) assert.equal((await enter(f, "BCDF-GHJK", ip)).status, 400);
  const waits = [];
  for (let i = 0; i < 5; i++) {
    assert.equal((await enter(f, "BCDF-GHJK", ip)).status, 400, `wrong ${i}`);
    const held = await enter(f, "BCDF-GHJK", ip);
    assert.equal(held.status, 429);
    assert.match(held.value, /Wait \d+ seconds?/);
    const after = Number(held.headers.get("retry-after"));
    waits.push(after);
    f.advance(after * 1000 - 1);
    assert.equal((await enter(f, "BCDF-GHJK", ip)).status, 429, "still waiting");
    f.advance(1);
  }
  assert.deepEqual(waits, [1, 2, 4, 4, 4]);
  // A neighbour in the same /24 never waits for this client.
  assert.equal((await enter(f, "BCDF-GHJK", "198.51.100.8")).status, 400);
  // A valid code from the client resets its streak.
  f.advance(4000);
  const d = await startFrom(f, ip);
  assert.equal((await enter(f, d.userCode, ip)).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await enter(f, "BCDF-GHJK", ip)).status, 400);
  assert.equal((await enter(f, "BCDF-GHJK", ip)).status, 400);
  assert.equal(Number((await enter(f, "BCDF-GHJK", ip)).headers.get("retry-after")), 1);
});
test("a 4-wrong-1-valid loop neither escapes the hourly cap nor locks a neighbour in the /24", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const limits = f.config.signInLimits;
  limits.wrongCodesPerClient = 12;
  const attacker = "198.51.100.66";
  let refused = 0;
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 4; i++)
      if ((await enter(f, "BCDF-GHJK", attacker)).status === 429) refused++;
    const own = await startFrom(f, attacker);
    // Its own valid code still opens a flow: the cap refuses only other people's codes.
    assert.equal((await enter(f, own.userCode, attacker)).status, 200);
  }
  // The valid codes reset the back-off streak, never the hourly cap.
  assert.equal(refused, 24 - limits.wrongCodesPerClient);
  const victim = "198.51.100.7";
  const d = await startFrom(f, victim);
  assert.equal((await enter(f, d.userCode, victim)).status, 200);
});
test("a slow drip of wrong codes keeps only its own address waiting, never a neighbour", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const attacker = "198.51.100.66";
  // Enough wrong codes to reach the longest wait, then one every five minutes for hours.
  for (let i = 0; i < 12; i++) {
    await enter(f, "BCDF-GHJK", attacker);
    f.advance(61000);
  }
  for (let i = 0; i < 24; i++) {
    f.advance(300000);
    assert.equal((await enter(f, "BCDF-GHJK", attacker)).status, 400);
    const r = await enter(f, "BCDF-GHJK", attacker);
    assert.equal(r.status, 429, "the attacker itself waits");
    assert.ok(Number(r.headers.get("retry-after")) <= 60);
  }
  // Right now the attacker is waiting; a neighbour in its /24 is not.
  const victim = "198.51.100.7";
  const d = await startFrom(f, victim);
  assert.equal((await enter(f, d.userCode, victim)).status, 200);
  assert.equal((await enter(f, "BCDF-GHJK", victim)).status, 400, "a typo is not refused");
});
test("behind one shared address, a code started from that address still gets through while it is held", async (t) => {
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" } });
  const limits = f.config.signInLimits;
  limits.wrongCodesPerClient = 8;
  limits.wrongCodeFreeStreak = 2;
  const nat = "198.51.100.7";
  const elsewhere = await startFrom(f, "203.0.113.9");
  for (let i = 0; i < 3; i++) await enter(f, "BCDF-GHJK", nat);
  // Back-off: a code started behind the same address opens a flow ...
  const held = await enter(f, "BCDF-GHJK", nat);
  assert.equal(held.status, 429);
  const colleague = await startFrom(f, nat);
  assert.equal((await enter(f, colleague.userCode, nat)).status, 200);
  // ... while a valid code started elsewhere gets exactly the wrong-code answer.
  for (let i = 0; i < 3; i++) await enter(f, "BCDF-GHJK", nat);
  const other = await enter(f, elsewhere.userCode, nat);
  const wrong = await enter(f, "BCDF-GHJK", nat);
  assert.equal(other.status, 429);
  assert.equal(other.value, wrong.value.replace(/Wait \d+/, other.value.match(/Wait \d+/)[0]));
  // Hourly cap reached: the same holds.
  for (let i = 0; i < 10; i++) await enter(f, "BCDF-GHJK", nat);
  f.advance(61000);
  const capped = await enter(f, "BCDF-GHJK", nat);
  assert.equal(capped.status, 429);
  assert.equal((await enter(f, elsewhere.userCode, nat)).value, capped.value);
  const late = await startFrom(f, nat);
  assert.equal((await enter(f, late.userCode, nat)).status, 200);
});
test("many wrong codes from one /24 raise the alert and slow wrong answers there, never refusing", async (t) => {
  const c = collector();
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" }, monitor: c.monitor });
  const limits = f.config.signInLimits;
  assert.ok(limits.wrongCodeNetworkDelayMs > 0 && limits.wrongCodeNetworkDelayMs <= 5000);
  limits.wrongCodesPerNetworkAlert = 4;
  limits.wrongCodeNetworkDelayMs = 150;
  for (let i = 0; i < 4; i++)
    assert.equal((await enter(f, "BCDF-GHJK", `198.51.100.${i + 1}`)).status, 400);
  await c.monitor.flush();
  assert.equal(c.sent.length, 1);
  assert.match(JSON.stringify(c.events()[0]), /signInGuessingSuspected/);
  assert.doesNotMatch(c.text(), /198\.51\.100/);
  const started = Date.now();
  assert.equal((await enter(f, "BCDF-GHJK", "198.51.100.50")).status, 400);
  assert.ok(Date.now() - started >= 140, "wrong answers in the network are slowed");
  const d = await startFrom(f, "198.51.100.60");
  const quick = Date.now();
  assert.equal((await enter(f, d.userCode, "198.51.100.60")).status, 200);
  assert.ok(Date.now() - quick < 140, "valid codes are not slowed");
});
test("many wrong codes across the service raise a content-free alert and never refuse everyone", async (t) => {
  const c = collector();
  const f = await fixture(t, { env: { TRUSTED_PROXY_IPS: "127.0.0.1" }, monitor: c.monitor });
  const limits = f.config.signInLimits;
  limits.wrongCodesGlobalAlert = 5;
  limits.wrongCodeFreeStreak = 3;
  limits.wrongCodeBackoffMs = 1000;
  // A network with one earlier failure, before the service-wide rate is elevated.
  assert.equal((await enter(f, "BCDF-GHJK", "192.0.2.1")).status, 400);
  for (let i = 0; i < 6; i++)
    assert.equal((await enter(f, "BCDF-GHJK", `10.${i}.0.1`)).status, 400);
  await c.monitor.flush();
  assert.equal(c.sent.length, 1);
  const [event] = c.events();
  assert.equal(event.tags.route, "/auth/device");
  assert.match(JSON.stringify(event), /signInGuessingSuspected/);
  assert.doesNotMatch(c.text(), /10\.\d\.0\.1|192\.0\.2|BCDF/);
  // Nobody is refused outright: a fresh network signs in, and still gets a free wrong code.
  const d = (await f.request("/v1/auth/device", {}, undefined, { "x-forwarded-for": "203.0.113.1" })).value;
  assert.equal((await enter(f, d.userCode, "203.0.113.1")).status, 200);
  assert.equal((await enter(f, "BCDF-GHJK", "198.18.0.1")).status, 400);
  // Networks that already failed back off from their next wrong code.
  assert.equal((await enter(f, "BCDF-GHJK", "192.0.2.1")).status, 400);
  const held = await enter(f, "BCDF-GHJK", "192.0.2.1");
  assert.equal(held.status, 429);
  assert.ok(Number(held.headers.get("retry-after")) >= 1);
  await c.monitor.flush();
  assert.equal(c.sent.length, 1, "one alert per window");
});

const routeEcho = {
  async run(selected) {
    return {
      ...output,
      provider: selected.lane === "deep" ? "managedDeep" : "managedFast",
    };
  },
};
const deepDig = () => requestJob("dig-deep", { lane: "deep" });
test("Standard: a requested digDeeper sent on the deep lane is served by the fast route", async (t) => {
  const f = await fixture(t, { provider: routeEcho });
  const token = await f.login();
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", deepDig(), token);
  assert.equal(r.status, 200);
  assert.equal(r.value.provider, "managedFast");
  assert.equal(r.value.jobId, "dig-deep");
  // The reviews keep their deep lane on Standard.
  const review = await f.request(
    "/v1/reasoning",
    requestJob("review-1", { lane: "deep", intent: "checkConversation" }),
    token,
  );
  assert.equal(review.value.provider, "managedDeep");
});
test("Premium: a requested digDeeper keeps the deep route", async (t) => {
  const f = await fixture(t, { provider: routeEcho });
  const token = await f.login();
  f.setPrice("price_premium");
  await f.subscribe(token);
  assert.equal((await f.request("/v1/account", undefined, token)).value.plan, "premium");
  const r = await f.request("/v1/reasoning", deepDig(), token);
  assert.equal(r.status, 200);
  assert.equal(r.value.provider, "managedDeep");
});

const GRACE = 3 * 86400000;
test("past_due keeps AI for three days from the failed invoice, then stops", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  const failedAt = f.now() - 3600000;
  f.setPeriod(failedAt, f.now() + 30 * 86400000);
  f.setLatestInvoice({ id: "in_1", object: "invoice", created: Math.floor(failedAt / 1000), status: "open" });
  f.setSubscription("past_due");
  assert.equal((await f.webhook("evt_past_due")).status, 200);
  const during = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(during.subscriptionStatus, "past_due");
  assert.equal(during.plan, "standard");
  assert.equal(during.canUseAI, true);
  assert.equal(during.paymentGraceEndsAtMs, Math.floor(failedAt / 1000) * 1000 + GRACE);
  assert.equal((await f.request("/v1/reasoning", requestJob(`r-${f.now()}`), token)).status, 200);
  f.advance(GRACE - 3600000 + 1000);
  const after = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(after.canUseAI, false);
  assert.equal(after.plan, "none");
  assert.equal(after.subscriptionStatus, "past_due");
  assert.equal(after.paymentGraceEndsAtMs, undefined);
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("late"), token)).status,
    402,
  );
});
test("the grace is anchored to Stripe's failure time, not to when a late webhook arrives", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  // The renewal failed two days ago; the event is only processed now. No invoice expanded: the period start anchors.
  const renewal = f.now() - 2 * 86400000;
  f.setPeriod(renewal, renewal + 30 * 86400000);
  f.setSubscription("past_due");
  assert.equal((await f.webhook("evt_late")).status, 200);
  const a = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(a.canUseAI, true);
  assert.equal(a.paymentGraceEndsAtMs, Math.floor(renewal / 1000) * 1000 + GRACE);
  f.advance(86400000 + 1000);
  assert.equal((await f.request("/v1/account", undefined, token)).value.canUseAI, false);
});
test("without Stripe timing the first time the service saw past_due anchors the grace, across reconciles", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  await f.subscribe(token);
  f.setSubscription("past_due");
  const firstSeen = f.now();
  assert.equal((await f.webhook("evt_pd_1")).status, 200);
  f.advance(2 * 86400000);
  assert.equal((await f.webhook("evt_pd_2")).status, 200);
  const a = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(a.canUseAI, true);
  assert.equal(a.paymentGraceEndsAtMs, firstSeen + GRACE);
  f.advance(86400000 + 1);
  assert.equal((await f.request("/v1/account", undefined, token)).value.canUseAI, false);
  // Paying again restores access and forgets the failure; a later failure gets its own grace.
  f.setSubscription("active");
  assert.equal((await f.webhook("evt_paid")).status, 200);
  const paid = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(paid.canUseAI, true);
  assert.equal(paid.paymentGraceEndsAtMs, undefined);
  f.setSubscription("past_due");
  const second = f.now();
  assert.equal((await f.webhook("evt_pd_3")).status, 200);
  assert.equal(
    (await f.request("/v1/account", undefined, token)).value.paymentGraceEndsAtMs,
    second + GRACE,
  );
});
test("unpaid, canceled and incomplete_expired get no grace even right after the failed invoice", async (t) => {
  for (const status of ["unpaid", "canceled", "incomplete_expired"]) {
    const f = await fixture(t);
    const token = await f.login();
    await f.subscribe(token);
    f.setLatestInvoice({ id: "in_1", object: "invoice", created: Math.floor(f.now() / 1000), status: "open" });
    f.setSubscription(status);
    assert.equal((await f.webhook(`evt_${status}`)).status, 200);
    const a = (await f.request("/v1/account", undefined, token)).value;
    assert.equal(a.canUseAI, false, status);
    assert.equal(a.paymentGraceEndsAtMs, undefined, status);
    assert.equal((await f.request("/v1/reasoning", requestJob(`r-${f.now()}`), token)).status, 402, status);
  }
});

test("usage resets with the Stripe billing period and carries this month's legacy counter over once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "live-service-period-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sqlite");
  const f = await fixture(t, { env: { DATABASE_PATH: path } });
  const token = await f.login();
  await f.subscribe(token);
  // Before the switch-over the subscription carries no period start: the calendar month counts.
  assert.equal((await f.request("/v1/reasoning", requestJob(`r-${f.now()}`), token)).status, 200);
  const legacy = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(legacy.usage.requests, 1);
  // The period started before this month and runs past it.
  const start = Date.UTC(new Date(f.now()).getUTCFullYear(), new Date(f.now()).getUTCMonth(), 1) - 5 * 86400000;
  const end = f.now() + 10 * 86400000;
  f.setPeriod(start, end);
  assert.equal((await f.webhook("evt_period")).status, 200);
  const switched = (await f.request("/v1/account", undefined, token)).value;
  // No fresh allowance at the switch-over: this month's counter still counts.
  assert.equal(switched.usage.requests, 1);
  assert.equal(switched.usageResetsAtMs, Math.floor(end / 1000) * 1000);
  assert.equal(
    (await f.request("/v1/reasoning", requestJob("in-period"), token)).status,
    200,
  );
  assert.equal((await f.request("/v1/account", undefined, token)).value.usage.requests, 2);
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT period,requests FROM usage").all();
  db.close();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ period: new Date(Math.floor(start / 1000) * 1000).toISOString().slice(0, 19) + "Z", requests: 2 }],
  );
  const e = (await f.request("/v1/account/export", undefined, token)).value;
  assert.equal(e.usage.length, 1);
  assert.equal(e.usage[0].requests, 2);
  assert.equal(e.billing.periodStartMs, Math.floor(start / 1000) * 1000);
  // The next billing period starts at zero, whatever the calendar month.
  f.advance(end - f.now() + 1000);
  f.setPeriod(end, end + 30 * 86400000);
  assert.equal((await f.webhook("evt_renewed")).status, 200);
  const renewed = (await f.request("/v1/account", undefined, token)).value;
  assert.deepEqual(renewed.usage, { requests: 0, inputTokens: 0, outputTokens: 0 });
});

test("Standard: only the reviews may use the deep lane; any other intent sent deep is served fast", async (t) => {
  const f = await fixture(t, { provider: routeEcho });
  const token = await f.login();
  await f.subscribe(token);
  for (const intent of ["respond", "contribute", "digDeeper"]) {
    const r = await f.request("/v1/reasoning", requestJob(`relabel-${intent}`, { lane: "deep", intent }), token);
    assert.equal(r.status, 200, intent);
    assert.equal(r.value.provider, "managedFast", intent);
  }
  for (const intent of ["checkConversation", "checkObjectives"]) {
    const r = await f.request("/v1/reasoning", requestJob(`review-${intent}`, { lane: "deep", intent }), token);
    assert.equal(r.value.provider, "managedDeep", intent);
  }
  // A synthesis or preparation job labelled as a review still runs fast.
  for (const usageFeature of ["synthesis", "preparation"]) {
    const r = await f.request(
      "/v1/reasoning",
      requestJob(`feature-${usageFeature}`, { lane: "deep", intent: "checkConversation", usageFeature }),
      token,
    );
    assert.equal(r.value.provider, "managedFast", usageFeature);
  }
});
test("Premium keeps the lane the app declares", async (t) => {
  const f = await fixture(t, { provider: routeEcho });
  const token = await f.login();
  f.setPrice("price_premium");
  await f.subscribe(token);
  const r = await f.request("/v1/reasoning", requestJob("premium-respond", { lane: "deep", intent: "respond" }), token);
  assert.equal(r.value.provider, "managedDeep");
});

// Relative timeouts: these tests move the service clock by days.
const rel = { deadlineMs: undefined, timeoutMs: 30000 };
/** A Standard account (10 requests) in a paid billing period with `used` requests spent. */
async function paidPeriod(t, used) {
  const f = await fixture(t);
  const token = await f.login();
  const start = f.now() - 20 * 86400000,
    end = f.now() + 10 * 86400000;
  f.setPeriod(start, end);
  await f.subscribe(token);
  for (let i = 0; i < used; i++)
    assert.equal((await f.request("/v1/reasoning", requestJob(`paid-${i}`, rel), token)).status, 200);
  return { f, token, start, end };
}
const renewalFails = async (f, end) => {
  f.advance(end - f.now() + 3600000);
  f.setPeriod(end, end + 30 * 86400000);
  f.setLatestInvoice({ id: "in_renew", object: "invoice", created: Math.floor(end / 1000), status: "open", billing_reason: "subscription_cycle" });
  f.setSubscription("past_due");
  assert.equal((await f.webhook("evt_renewal_failed")).status, 200);
};
test("a failed renewal's grace keeps counting in the last paid period, so it grants no fresh allowance", async (t) => {
  const { f, token, end } = await paidPeriod(t, 8);
  await renewalFails(f, end);
  const grace = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(grace.canUseAI, true);
  assert.equal(grace.usage.requests, 8);
  assert.equal((await f.request("/v1/reasoning", requestJob("grace-1", rel), token)).status, 200);
  assert.equal((await f.request("/v1/reasoning", requestJob("grace-2", rel), token)).status, 200);
  const over = await f.request("/v1/reasoning", requestJob("grace-3", rel), token);
  assert.equal(over.status, 429);
  assert.equal(over.value.error.code, "allowanceExceeded");
  // Paying starts the new period normally.
  f.setSubscription("active");
  f.setLatestInvoice({ id: "in_renew", object: "invoice", created: Math.floor(end / 1000), status: "paid", billing_reason: "subscription_cycle" });
  assert.equal((await f.webhook("evt_renewal_paid")).status, 200);
  const paid = (await f.request("/v1/account", undefined, token)).value;
  assert.deepEqual(paid.usage, { requests: 0, inputTokens: 0, outputTokens: 0 });
  assert.equal((await f.request("/v1/reasoning", requestJob("new-period", rel), token)).status, 200);
});
test("the grace still counts in the last paid period when a reconcile saw the new period before the failure", async (t) => {
  const { f, token, end } = await paidPeriod(t, 9);
  f.advance(end - f.now() + 60000);
  f.setPeriod(end, end + 30 * 86400000);
  assert.equal((await f.webhook("evt_new_period_active")).status, 200);
  f.advance(3600000);
  f.setLatestInvoice({ id: "in_renew", object: "invoice", created: Math.floor(end / 1000), status: "open", billing_reason: "subscription_cycle" });
  f.setSubscription("past_due");
  assert.equal((await f.webhook("evt_renewal_failed")).status, 200);
  assert.equal((await f.request("/v1/account", undefined, token)).value.usage.requests, 9);
  assert.equal((await f.request("/v1/reasoning", requestJob("grace-1", rel), token)).status, 200);
  assert.equal((await f.request("/v1/reasoning", requestJob("grace-2", rel), token)).status, 429);
});
test("a failed mid-period invoice leaves the paid current period counting", async (t) => {
  const { f, token, start } = await paidPeriod(t, 3);
  f.setLatestInvoice({ id: "in_upgrade", object: "invoice", created: Math.floor(f.now() / 1000), status: "open", billing_reason: "subscription_update" });
  f.setSubscription("past_due");
  assert.equal((await f.webhook("evt_update_failed")).status, 200);
  const a = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(a.canUseAI, true);
  assert.equal(a.usage.requests, 3);
  const e = (await f.request("/v1/account/export", undefined, token)).value;
  assert.equal(e.billing.periodStartMs, Math.floor(start / 1000) * 1000);
});
test("a price that is not billed monthly keeps the allowance per calendar month", async (t) => {
  const f = await fixture(t);
  const token = await f.login();
  f.setRecurring({ interval: "year", interval_count: 1 });
  f.setPeriod(f.now() - 86400000, f.now() + 300 * 86400000);
  await f.subscribe(token);
  const a = (await f.request("/v1/account", undefined, token)).value;
  assert.equal(a.canUseAI, true);
  const d = new Date(f.now());
  assert.equal(a.usageResetsAtMs, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const e = (await f.request("/v1/account/export", undefined, token)).value;
  assert.equal(e.billing.periodStartMs, null);
});
