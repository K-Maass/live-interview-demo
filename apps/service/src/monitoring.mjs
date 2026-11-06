import { createHash, randomBytes } from "node:crypto";
import { ServiceError } from "./errors.mjs";

// Content-free error monitoring.
//
// An event is BUILT from an allow-list of fields, never copied from the error or the request:
// error class, a short identifier-shaped code, scrubbed stack frames (function, repository-relative
// file, line), route template, method, status and a stable fingerprint. Error messages, request
// bodies, prompts, transcripts, headers, tokens, e-mail addresses, query strings and absolute paths
// have no path into the event. A last sweep redacts anything secret-shaped that survived anyway.
// Without ERROR_REPORTING_DSN every call is a no-op.

export const ROUTES = [
  "/health",
  "/ready",
  "/v1/config",
  "/billing/return",
  "/v1/auth/device",
  "/v1/auth/device/poll",
  "/auth/device",
  "/auth/device/authorize",
  "/auth/callback",
  "/auth/device/approve",
  "/v1/auth/logout",
  "/v1/auth/logout-all",
  "/v1/auth/renew",
  "/v1/billing/webhook",
  "/v1/account",
  "/v1/account/export",
  "/v1/account/delete",
  "/v1/billing/checkout",
  "/v1/billing/portal",
  "/v1/reasoning",
  "/v1/reasoning/stream",
  "/v1/decide",
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
// Pseudo routes for events that did not come from a request.
const PSEUDO_ROUTES = ["process", "retention", "unmatched"];

const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,47}$/;
const SERVICE_CODE = /^[a-z][A-Za-z0-9]{0,63}$/;
const SYSTEM_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/;
const FUNCTION_NAME = /^[\w$.<>]{1,80}(?: \[as [\w$]{1,40}\])?$/;
const SEGMENT = /^[\w.-]{1,100}$/;
const MAX_FRAMES = 25;
const MAX_CHAIN = 3;

// Defense in depth for any string that still reaches the event.
const SENSITIVE = [
  /[^\s@"'<>()]+@[^\s@"'<>()]+\.[A-Za-z]{2,}/g, // e-mail address
  /\bBearer\s+\S+/gi,
  /\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_]{6,}/g, // Stripe style keys
  /\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g, // JWT
  /[A-Za-z0-9_=-]{32,}/g, // long opaque token
  /https?:\/\/\S+/gi, // URL, which may carry a query string
];
export function redact(value) {
  let out = String(value);
  for (const pattern of SENSITIVE) out = out.replace(pattern, "[redacted]");
  return out;
}

export const safeRoute = (path) =>
  ROUTES.includes(path) || PSEUDO_ROUTES.includes(path) ? path : "unmatched";
const safeMethod = (method) =>
  METHODS.includes(method) ? method : undefined;
const safeStatus = (status) =>
  Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;

function className(error) {
  if (!(error instanceof Error)) return "NonError";
  // The constructor is code, not data (ServiceError does not set `name`); `name` is a fallback.
  for (const name of [error.constructor?.name, error.name])
    if (typeof name === "string" && CLASS_NAME.test(name)) return name;
  return "Error";
}
function errorCode(error) {
  if (!(error instanceof Error)) return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  // A ServiceError code is one of the service's own camelCase identifiers; library codes are
  // upper or lower snake case. Anything with spaces, punctuation or length is dropped.
  return error instanceof ServiceError && SERVICE_CODE.test(code)
    ? code
    : SYSTEM_CODE.test(code)
      ? code
      : undefined;
}

// Reduce a stack-frame file to a repository-relative or package-relative path. Everything before
// the recognised anchor (home directories, user names, deploy paths) is discarded.
function scrubFile(raw) {
  const file = String(raw).replace(/^file:\/\//, "");
  if (file.startsWith("node:")) {
    const rest = file.slice(5);
    return rest.split("/").every((s) => SEGMENT.test(s))
      ? file
      : "node:internal";
  }
  const modules = file.lastIndexOf("/node_modules/");
  if (modules !== -1) {
    const parts = file.slice(modules + 14).split("/");
    const scoped = parts[0]?.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, scoped).join("/");
    const rest = parts.slice(scoped);
    return parts.every((s) => /^(?:@)?[\w.-]{1,100}$/.test(s)) && rest.length
      ? `node_modules/${name}/${rest.join("/")}`
      : "node_modules/other";
  }
  const own = /\/(src|scripts|test)\/([\w.-]{1,100}\.(?:mjs|js|cjs))$/.exec(
    file,
  );
  return own ? `service/${own[1]}/${own[2]}` : "other";
}

const MAX_STACK_LINES = 200;
const MAX_LINE_CHARS = 300;
// V8 prints the message at the top of the stack, and a message may contain newlines and frame-shaped
// lines. The message is cut out before anything is parsed, and oversized input is skipped, so neither
// forged frames nor a pathological line can get through or slow the caller down.
export function scrubFrames(stack, message) {
  if (typeof stack !== "string") return [];
  let text = stack;
  if (typeof message === "string" && message) {
    const at = text.indexOf(message);
    if (at !== -1) text = text.slice(at + message.length);
  }
  const frames = [];
  for (const line of text.split("\n", MAX_STACK_LINES)) {
    if (line.length > MAX_LINE_CHARS) continue;
    const m =
      /^\s+at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const [, rawFunction, rawFile, lineno, colno] = m;
    const fn =
      rawFunction && FUNCTION_NAME.test(rawFunction.replace(/^new /, ""))
        ? rawFunction
        : undefined;
    const filename = scrubFile(rawFile);
    frames.push({
      ...(fn ? { function: fn } : {}),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: filename.startsWith("service/"),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse(); // Sentry orders the oldest call first
}

function describe(error) {
  const code = errorCode(error);
  return {
    type: className(error),
    ...(code ? { value: code } : {}),
    stacktrace: {
      frames:
        error instanceof Error ? scrubFrames(error.stack, error.message) : [],
    },
  };
}
function chain(error) {
  const out = [error];
  let current = error;
  while (
    out.length < MAX_CHAIN &&
    current instanceof Error &&
    current.cause !== undefined
  ) {
    current = current.cause;
    out.push(current);
  }
  return out;
}

const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildEvent(error, context = {}, settings = {}) {
  const route = safeRoute(context.route);
  const method = safeMethod(context.method);
  const status = safeStatus(context.status);
  const values = chain(error).map(describe);
  const topType = values[0].type;
  const own = (v) =>
    v.stacktrace.frames.filter((f) => f.in_app).slice(-3);
  // Stable across deploys: no line numbers and no message text.
  const fingerprint = sha([
    route,
    status ?? null,
    values.map((v) => [
      v.type,
      v.value ?? null,
      (own(v).length ? own(v) : v.stacktrace.frames.slice(-3)).map(
        (f) => `${f.filename}:${f.function ?? "?"}`,
      ),
    ]),
  ]).slice(0, 16);
  const event = {
    timestamp: (settings.now?.() ?? Date.now()) / 1000,
    platform: "node",
    level: "error",
    logger: "live-interview-service",
    ...(settings.release ? { release: settings.release } : {}),
    ...(settings.environment ? { environment: settings.environment } : {}),
    fingerprint: [fingerprint],
    exception: { values: values.reverse() },
    tags: {
      route,
      ...(method ? { method } : {}),
      ...(status ? { status: String(status) } : {}),
      error_class: topType,
    },
    sdk: { name: "live-interview.error-reporting", version: "1" },
  };
  return { event: sweep(event), fingerprint };
}

function sweep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(sweep);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sweep(v)]),
    );
  return value;
}

// DSN: https://<public key>@<host>[:port][/<path>]/<project id>, as Sentry and GlitchTip issue them.
export function parseDsn(dsn, { allowLoopbackHttp = false } = {}) {
  try {
    const u = new URL(dsn);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (
      !(
        u.protocol === "https:" ||
        (allowLoopbackHttp && loopback && u.protocol === "http:")
      ) ||
      !u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return undefined;
    // The key travels in a header: refuse anything that is not plainly header-safe.
    if (!/^[\w-]{1,128}$/.test(decodeURIComponent(u.username)))
      return undefined;
    const segments = u.pathname.split("/").filter(Boolean);
    const project = segments.pop();
    if (!project || !/^[\w-]{1,64}$/.test(project)) return undefined;
    if (!segments.every((s) => SEGMENT.test(s))) return undefined;
    const base = `${u.protocol}//${u.host}${segments.map((s) => `/${s}`).join("")}`;
    return {
      endpoint: `${base}/api/${project}/envelope/`,
      publicKey: decodeURIComponent(u.username),
    };
  } catch {
    return undefined;
  }
}

// Reads ERROR_REPORTING_DSN (required to enable), ERROR_REPORTING_ENVIRONMENT and
// ERROR_REPORTING_RELEASE (optional labels). An invalid DSN disables reporting; it never stops the
// service, but the caller can tell it apart from "not configured" through `invalid`.
export function loadErrorReporting(env = process.env) {
  if (!env.ERROR_REPORTING_DSN) return { enabled: false };
  const dsn = parseDsn(env.ERROR_REPORTING_DSN, {
    allowLoopbackHttp: env.NODE_ENV !== "production",
  });
  if (!dsn) return { enabled: false, invalid: true };
  const label = (v) =>
    typeof v === "string" && /^[\w.@+-]{1,64}$/.test(v) ? v : undefined;
  return {
    enabled: true,
    ...dsn,
    environment:
      label(env.ERROR_REPORTING_ENVIRONMENT) ?? env.NODE_ENV ?? "development",
    release: label(env.ERROR_REPORTING_RELEASE),
  };
}

// Default transport: one POST of the envelope with a short timeout. It never throws.
export function fetchTransport({
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  return async ({ url, headers, body }) => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel?.();
    } catch {}
  };
}

const NOOP = Object.freeze({
  enabled: false,
  captureError() {},
  async flush() {},
});

export function createMonitor(
  settings = { enabled: false },
  {
    transport = fetchTransport(),
    now = Date.now,
    windowMs = 60000,
    maxPerMinute = 30,
  } = {},
) {
  if (!settings?.enabled) return NOOP;
  const pending = new Set();
  const seen = new Map(); // fingerprint -> { at, suppressed }
  let minute = { start: 0, count: 0 };
  function send(event, fingerprint) {
    const eventId = randomBytes(16).toString("hex");
    const envelope = [
      { event_id: eventId, sent_at: new Date(now()).toISOString() },
      { type: "event" },
      { ...event, event_id: eventId },
    ]
      .map((part) => JSON.stringify(part))
      .join("\n");
    const task = Promise.resolve()
      .then(() =>
        transport({
          url: settings.endpoint,
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": `Sentry sentry_version=7, sentry_client=live-interview-service/1, sentry_key=${settings.publicKey}`,
          },
          body: `${envelope}\n`,
          fingerprint,
        }),
      )
      .catch(() => {})
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  return {
    enabled: true,
    // Fire and forget. Nothing here throws, awaits or can change a response.
    captureError(error, context = {}) {
      try {
        const { event, fingerprint } = buildEvent(error, context, {
          release: settings.release,
          environment: settings.environment,
          now,
        });
        const at = now();
        const earlier = seen.get(fingerprint);
        if (earlier && at - earlier.at < windowMs) {
          earlier.suppressed++;
          return;
        }
        if (at - minute.start >= 60000) minute = { start: at, count: 0 };
        if (minute.count >= maxPerMinute) return;
        minute.count++;
        if (seen.size > 500)
          for (const [key, value] of seen)
            if (at - value.at >= windowMs) seen.delete(key);
        const suppressed = earlier?.suppressed ?? 0;
        seen.set(fingerprint, { at, suppressed: 0 });
        send(
          suppressed
            ? { ...event, extra: { suppressed_since_last_event: suppressed } }
            : event,
          fingerprint,
        );
      } catch {}
    },
    async flush(timeoutMs = 2000) {
      let timer;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

// An uncaught exception is reported, then the process still exits non-zero as it would have. Only a
// constant code reaches stderr, never the error text.
export function installProcessHandlers(
  monitor,
  { proc = process, exit = (code) => process.exit(code) } = {},
) {
  let handling = false;
  proc.on("uncaughtException", (error) => {
    if (handling) return;
    handling = true;
    proc.stderr.write('{"code":"uncaughtException"}\n');
    monitor.captureError(error, { route: "process", status: 500 });
    monitor.flush(2000).finally(() => exit(1));
  });
}
