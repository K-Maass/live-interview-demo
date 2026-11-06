import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { loadErrorReporting } from "./monitoring.mjs";
const groups = {
  auth: [
    "SERVICE_ORIGIN",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
  ],
  billing: [
    "SERVICE_ORIGIN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_MODE",
    "STRIPE_STANDARD_PRICE_ID",
    "STRIPE_PREMIUM_PRICE_ID",
  ],
  provider: [
    "LUNA_PROVIDER_URL",
    "LUNA_API_KEY",
    "LUNA_MODEL",
    "SOL_PROVIDER_URL",
    "SOL_API_KEY",
    "SOL_MODEL",
  ],
  // Gates /v1/decide only: without it, reasoning keeps working.
  decide: ["JEV_API_KEY"],
  allowances: [
    "STANDARD_REQUESTS",
    "STANDARD_INPUT_TOKENS",
    "STANDARD_OUTPUT_TOKENS",
    "PREMIUM_REQUESTS",
    "PREMIUM_INPUT_TOKENS",
    "PREMIUM_OUTPUT_TOKENS",
  ],
};
// Experiment knob: unset means the payload carries no reasoning setting at all.
const REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
function number(env, key, fallback) {
  const n =
    env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
function https(value, loopback = false) {
  try {
    const u = new URL(value);
    return (
      (u.protocol === "https:" ||
        (loopback &&
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
/**
 * Payment grace (product decision): after a renewal payment fails, Stripe marks the subscription
 * `past_due` and AI assistance continues for this long from the failure, then stops until the
 * invoice is paid. Measured from the latest invoice's creation time (else the billing period start,
 * else the first time the service saw `past_due`), so a late or reordered webhook never extends it.
 * `unpaid`, `canceled` and `incomplete_expired` never get a grace. Not configurable by environment.
 */
export const PAYMENT_GRACE_MS = 3 * 86400000;
export function loadConfig(env = process.env) {
  const missing = { runtime: [] };
  for (const [group, names] of Object.entries(groups))
    missing[group] = names.filter((key) => !env[key]);
  if (
    env.SERVICE_ORIGIN &&
    (!https(env.SERVICE_ORIGIN, env.NODE_ENV !== "production") ||
      new URL(env.SERVICE_ORIGIN).pathname !== "/")
  )
    missing.auth.push("SERVICE_ORIGIN (HTTPS required)");
  if (
    env.SERVICE_ORIGIN &&
    (!https(env.SERVICE_ORIGIN, env.NODE_ENV !== "production") ||
      new URL(env.SERVICE_ORIGIN).pathname !== "/")
  )
    missing.billing.push("SERVICE_ORIGIN (HTTPS required)");
  if (env.OIDC_ISSUER && !https(env.OIDC_ISSUER))
    missing.auth.push("OIDC_ISSUER (HTTPS required)");
  if (env.STRIPE_MODE && !["live", "test"].includes(env.STRIPE_MODE))
    missing.billing.push("STRIPE_MODE (live or test)");
  if (
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_MODE &&
    !env.STRIPE_SECRET_KEY.startsWith(
      env.STRIPE_MODE === "live" ? "sk_live_" : "sk_test_",
    )
  )
    missing.billing.push("STRIPE_SECRET_KEY (mode mismatch)");
  if (
    env.STRIPE_STANDARD_PRICE_ID === env.STRIPE_PREMIUM_PRICE_ID &&
    env.STRIPE_STANDARD_PRICE_ID
  )
    missing.billing.push("STRIPE_PREMIUM_PRICE_ID (must differ)");
  // Optional grandfathered prices: subscribers on them keep their plan after the
  // plan's price ID changes. Checkout always sells the current price.
  const legacyPrices = {};
  for (const plan of ["standard", "premium"])
    legacyPrices[plan] = [
      ...new Set(
        (env[`STRIPE_${plan.toUpperCase()}_LEGACY_PRICE_IDS`] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  for (const [plan, other] of [
    ["standard", "premium"],
    ["premium", "standard"],
  ]) {
    const taken = [
      env[`STRIPE_${other.toUpperCase()}_PRICE_ID`],
      ...legacyPrices[other],
    ];
    if (legacyPrices[plan].some((price) => taken.includes(price)))
      missing.billing.push(
        `STRIPE_${plan.toUpperCase()}_LEGACY_PRICE_IDS (must not name a price of the other plan)`,
      );
  }
  for (const key of ["LUNA_PROVIDER_URL", "SOL_PROVIDER_URL"])
    if (env[key] && !https(env[key]))
      missing.provider.push(`${key} (HTTPS required)`);
  if (env.JEV_PROVIDER_URL && !https(env.JEV_PROVIDER_URL))
    missing.decide.push("JEV_PROVIDER_URL (HTTPS required)");
  const reasoningEffort = {};
  for (const route of ["LUNA", "SOL"]) {
    const key = `${route}_REASONING_EFFORT`,
      value = env[key];
    if (value === undefined || value === "") continue;
    // The rejected value is never echoed.
    if (REASONING_EFFORTS.includes(value)) reasoningEffort[route] = value;
    else missing.provider.push(`${key} (${REASONING_EFFORTS.join(", ")})`);
  }
  const limits = {};
  for (const plan of ["standard", "premium"]) {
    const prefix = plan.toUpperCase();
    limits[plan] = {
      requests: number(env, `${prefix}_REQUESTS`),
      inputTokens: number(env, `${prefix}_INPUT_TOKENS`),
      outputTokens: number(env, `${prefix}_OUTPUT_TOKENS`),
    };
    for (const suffix of ["REQUESTS", "INPUT_TOKENS", "OUTPUT_TOKENS"])
      if (!number(env, `${prefix}_${suffix}`))
        missing.allowances.push(
          `${prefix}_${suffix} (positive integer required)`,
        );
  }
  const port = number(env, "PORT", 8787),
    sessionDays = number(env, "SESSION_TTL_DAYS", 30),
    // Renewal slides a session forward, but never past this many days after
    // the sign-in that started it; then the person signs in again.
    sessionMaxDays = number(env, "SESSION_MAX_DAYS", 90);
  if (!port || port > 65535) missing.runtime.push("PORT (1..65535)");
  if (!sessionDays || sessionDays > 90)
    missing.runtime.push("SESSION_TTL_DAYS (1..90)");
  if (!sessionMaxDays || sessionMaxDays > 365 || sessionMaxDays < (sessionDays ?? 0))
    missing.runtime.push("SESSION_MAX_DAYS (SESSION_TTL_DAYS..365)");
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (trustedProxyIps.some((ip) => !isIP(ip)))
    missing.runtime.push("TRUSTED_PROXY_IPS (exact IP addresses required)");
  // Optional: keys the hashes of rate-limit counters (which contain IP addresses). Unset, a key
  // derived from the per-install deletion-log salt is used. Never echoed.
  const rateLimitKey = env.RATE_LIMIT_KEY || undefined;
  if (rateLimitKey !== undefined && rateLimitKey.length < 32)
    missing.runtime.push("RATE_LIMIT_KEY (at least 32 characters when set)");
  const maxOutput = number(env, "PROVIDER_MAX_OUTPUT_TOKENS", 2048),
    userConcurrency = number(env, "USER_CONCURRENCY", 2),
    globalConcurrency = number(env, "GLOBAL_CONCURRENCY", 32),
    userBackgroundConcurrency = number(env, "USER_BACKGROUND_CONCURRENCY", 1),
    globalLiveReserve = number(env, "GLOBAL_LIVE_RESERVE", 1);
  if (!maxOutput || maxOutput > 16384)
    missing.provider.push("PROVIDER_MAX_OUTPUT_TOKENS (1..16384)");
  if (!userConcurrency || !globalConcurrency)
    missing.allowances.push(
      "USER_CONCURRENCY/GLOBAL_CONCURRENCY (positive integers)",
    );
  if (
    !userBackgroundConcurrency ||
    !globalLiveReserve ||
    globalLiveReserve > globalConcurrency
  )
    missing.allowances.push(
      "USER_BACKGROUND_CONCURRENCY/GLOBAL_LIVE_RESERVE (positive reserve <= GLOBAL_CONCURRENCY required)",
    );
  if (
    env.NODE_ENV === "production" &&
    (!env.DATABASE_PATH ||
      env.DATABASE_PATH === ":memory:" ||
      !isAbsolute(env.DATABASE_PATH))
  )
    missing.billing.push("DATABASE_PATH (persistent file required)");
  const deletionLogPath =
    env.DELETION_LOG_PATH ||
    (env.DATABASE_PATH && env.DATABASE_PATH !== ":memory:"
      ? `${env.DATABASE_PATH}.deletions`
      : undefined);
  if (
    env.NODE_ENV === "production" &&
    env.DELETION_LOG_PATH &&
    !isAbsolute(env.DELETION_LOG_PATH)
  )
    missing.billing.push("DELETION_LOG_PATH (absolute path required)");
  return {
    origin: (env.SERVICE_ORIGIN || "").replace(/\/$/, ""),
    databasePath: env.DATABASE_PATH || ":memory:",
    deletionLogPath,
    rateLimitKey,
    host: env.HOST || "127.0.0.1",
    port,
    trustedProxyIps,
    production: env.NODE_ENV === "production",
    // Optional and never part of readiness: monitoring must not decide whether the service runs.
    errorReporting: loadErrorReporting(env),
    missing,
    authConfigured: missing.auth.length === 0,
    billingConfigured: missing.billing.length === 0,
    providerConfigured:
      missing.provider.length === 0 && missing.allowances.length === 0,
    decideConfigured:
      missing.provider.length === 0 &&
      missing.allowances.length === 0 &&
      missing.decide.length === 0,
    limits,
    maxOutput,
    // A provider route that rejects the Responses API's prompt_cache_key can turn it off.
    promptCacheKey: env.PROVIDER_PROMPT_CACHE_KEY !== "off",
    userConcurrency,
    globalConcurrency,
    userBackgroundConcurrency,
    globalLiveReserve,
    sessionTtlMs: sessionDays * 86400000,
    sessionMaxLifetimeMs: sessionMaxDays * 86400000,
    // A session may be renewed once it is this close to expiry (seven days, or
    // half the lifetime for sessions shorter than two weeks).
    sessionRenewWindowMs: Math.min(7 * 86400000, (sessionDays * 86400000) / 2),
    // After a renewal the previous token keeps working until the new one is
    // first used, and never longer than this: in-flight calls and a retry
    // whose answer was lost still succeed.
    sessionRenewGraceMs: 15 * 60000,
    // Sign-in limits (see README, "Sign-in limits").
    // "PerIp"/"PerClient" limits count one IPv4 address or one IPv6 /64 (one
    // subscriber); see README "Sign-in limits".
    signInLimits: {
      deviceStartsPerIp: 200,
      codeEntriesPerIp: 600,
      wrongCodesPerClient: 120,
      // Consecutive wrong codes from one client before each further one waits:
      // wrongCodeBackoffMs, doubling, at most wrongCodeBackoffMaxMs.
      wrongCodeFreeStreak: 5,
      wrongCodeBackoffMs: 2000,
      wrongCodeBackoffMaxMs: 60000,
      // Wrong codes per hour from one IPv4 /24 (IPv6 /48) that raise an alert and
      // slow that network's wrong answers by wrongCodeNetworkDelayMs. Never a refusal.
      wrongCodesPerNetworkAlert: 600,
      wrongCodeNetworkDelayMs: 2000,
      // Service-wide wrong codes per hour that raise an alert and make clients
      // with earlier failures back off from their next one. Never a refusal for everyone.
      wrongCodesGlobalAlert: 10000,
      entriesPerCode: 5,
    },
    renewalsPerClient: 300,
    deviceTtlMs: 600000,
    pollIntervalMs: 5000,
    billingMaxAgeMs: 300000,
    calendarClients: {
      ...(env.PUBLIC_MICROSOFT_CLIENT_ID
        ? { microsoftClientId: env.PUBLIC_MICROSOFT_CLIENT_ID }
        : {}),
      ...(env.PUBLIC_GOOGLE_CLIENT_ID
        ? { googleClientId: env.PUBLIC_GOOGLE_CLIENT_ID }
        : {}),
    },
    oidc: {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      live: env.STRIPE_MODE === "live",
      prices: {
        standard: env.STRIPE_STANDARD_PRICE_ID,
        premium: env.STRIPE_PREMIUM_PRICE_ID,
      },
      legacyPrices,
    },
    providers: {
      luna: {
        url: env.LUNA_PROVIDER_URL,
        key: env.LUNA_API_KEY,
        model: env.LUNA_MODEL,
        ...(reasoningEffort.LUNA ? { reasoningEffort: reasoningEffort.LUNA } : {}),
      },
      sol: {
        url: env.SOL_PROVIDER_URL,
        key: env.SOL_API_KEY,
        model: env.SOL_MODEL,
        ...(reasoningEffort.SOL ? { reasoningEffort: reasoningEffort.SOL } : {}),
      },
      jev: {
        url: env.JEV_PROVIDER_URL || "https://api.typesafe.ai/v1/systemone",
        key: env.JEV_API_KEY,
        model: "jev-latest",
      },
    },
  };
}
export function readiness(config) {
  return {
    ready:
      config.authConfigured &&
      config.billingConfigured &&
      config.providerConfigured &&
      config.missing.runtime.length === 0,
    missing: [...new Set(Object.values(config.missing).flat())],
  };
}
