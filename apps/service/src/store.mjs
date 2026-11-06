import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "./errors.mjs";
import { DeletionLog } from "./deletionLog.mjs";
import { RESERVATION_TTL_MS } from "./deadlines.mjs";
const month = (now) => new Date(now).toISOString().slice(0, 7);
/**
 * Usage counter key of a Stripe billing period: its start as UTC ISO seconds ("2026-10-20T09:15:00Z").
 * Calendar-month keys ("2026-10") remain the fallback; both sort chronologically as strings, so
 * retention compares them with the same `period<month` cutoff.
 */
const billingPeriod = (startMs) =>
  new Date(startMs).toISOString().slice(0, 19) + "Z";
const DAY = 86400000;
/** Usage periods and job records are kept for the current month and the 13 before it. */
export const USAGE_RETENTION_MONTHS = 13;
/**
 * Stripe event ids only deduplicate redelivery. Per Stripe's public documentation (not
 * confirmed against the account) a failed live-mode delivery is retried for up to three days
 * and events are listed for 30 days (the window in which one can be resent), so an id older
 * than 35 days should not be redelivered by Stripe. A redelivery after pruning is harmless:
 * processing it reconciles the current subscription state from Stripe.
 */
export const STRIPE_EVENT_RETENTION_DAYS = 35;
/** First instant of the month `months` before the month of `now`. */
const monthsAgo = (now, months) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1);
};
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export class Store {
  constructor(path, { deletionLogPath, now = Date.now, rateLimitKey } = {}) {
    this.log = new DeletionLog(deletionLogPath);
    // Rate-limit keys contain IP addresses, which an unkeyed hash would not hide (every IPv4
    // address can be tried). They are keyed with RATE_LIMIT_KEY or, when unset, a key derived
    // from the per-install deletion-log salt, which never leaves the server.
    this.rateKey =
      rateLimitKey ??
      createHmac("sha256", this.log.salt).update("live-interview rate-limit key v1").digest();
    // Derives a renewed session token from the one it replaces, so a retried
    // renewal returns the same token without the service storing it.
    this.renewalKey = createHmac("sha256", this.rateKey)
      .update("live-interview session renewal v1")
      .digest();
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (this.db.prepare("PRAGMA user_version").get().user_version > 2) {
      this.db.close();
      fail(503, "databaseSchemaUnsupported");
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA secure_delete=ON;",
    );
    try {
      this.transaction(() => {
        this.db
          .exec(` CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,name TEXT,customer TEXT UNIQUE,plan TEXT NOT NULL DEFAULT 'none',subscription_status TEXT NOT NULL DEFAULT 'none',period_end INTEGER NOT NULL DEFAULT 0,reconciled_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT 0,UNIQUE(issuer,subject));
 CREATE TABLE IF NOT EXISTS devices(code_hash TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,last_poll INTEGER NOT NULL DEFAULT 0,user_id TEXT REFERENCES users(id),consumed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS flows(cookie_hash TEXT PRIMARY KEY,device_hash TEXT NOT NULL REFERENCES devices(code_hash),csrf_hash TEXT NOT NULL,state TEXT NOT NULL,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL,stage TEXT NOT NULL,identity TEXT);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS checkouts(user_id TEXT PRIMARY KEY REFERENCES users(id),request_id TEXT NOT NULL,plan TEXT NOT NULL,session_id TEXT,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS webhooks(id TEXT PRIMARY KEY,type TEXT NOT NULL,customer TEXT,status TEXT NOT NULL,received_at INTEGER NOT NULL,completed_at INTEGER);
 CREATE TABLE IF NOT EXISTS usage(user_id TEXT NOT NULL REFERENCES users(id),period TEXT NOT NULL,requests INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,PRIMARY KEY(user_id,period));
 CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,period TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,expires INTEGER NOT NULL,work_class TEXT NOT NULL DEFAULT 'interactive' CHECK(work_class IN('interactive','background')));
 CREATE TABLE IF NOT EXISTS job_dispatches(user_id TEXT NOT NULL REFERENCES users(id),job_key TEXT NOT NULL,request_digest TEXT NOT NULL,status TEXT NOT NULL,reservation_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,job_key));
 CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sign_in_backoff(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,retry_at INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS deletion_receipts(token_hash TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL,had_customer INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS readiness(id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS session_renewals(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,signed_in_at INTEGER NOT NULL,predecessor TEXT,successor TEXT);
 CREATE TABLE IF NOT EXISTS allowance_holds(subject_hash TEXT PRIMARY KEY,period TEXT NOT NULL,requests INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL);
`);
        if (
          !this.db
            .prepare("PRAGMA table_info(users)")
            .all()
            .some((column) => column.name === "created_at")
        )
          this.db.exec(
            "ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
          );
        // How many Stripe customers of this account were deleted: part of the
        // idempotency key, so a new customer is never the deleted one replayed.
        if (
          !this.db
            .prepare("PRAGMA table_info(users)")
            .all()
            .some((column) => column.name === "customer_generation")
        )
          this.db.exec(
            "ALTER TABLE users ADD COLUMN customer_generation INTEGER NOT NULL DEFAULT 0",
          );
        // The Stripe billing period start (usage resets with it) and when the current payment
        // failure began (anchors the past_due grace). 0 when unknown or not past_due.
        for (const column of ["period_start", "past_due_since"])
          if (
            !this.db
              .prepare("PRAGMA table_info(users)")
              .all()
              .some((c) => c.name === column)
          )
            this.db.exec(
              `ALTER TABLE users ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
            );
        // When and from which coarse network a device sign-in was started (shown on the approval pages).
        const deviceColumns = this.db
          .prepare("PRAGMA table_info(devices)")
          .all()
          .map((column) => column.name);
        if (!deviceColumns.includes("created_at"))
          this.db.exec(
            "ALTER TABLE devices ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
          );
        if (!deviceColumns.includes("origin"))
          this.db.exec("ALTER TABLE devices ADD COLUMN origin TEXT");
        if (!deviceColumns.includes("client_hash"))
          this.db.exec("ALTER TABLE devices ADD COLUMN client_hash TEXT");
        if (
          !this.db
            .prepare("PRAGMA table_info(reservations)")
            .all()
            .some((column) => column.name === "work_class")
        )
          this.db.exec(
            "ALTER TABLE reservations ADD COLUMN work_class TEXT NOT NULL DEFAULT 'interactive' CHECK(work_class IN('interactive','background'))",
          );
        this.db.exec("PRAGMA user_version=2;");
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    try {
      this.expireDeletionRecords(now());
      this.applyDeletionLog(now());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Readiness: a read and a committed one-row write. Throws when either fails. */
  ready(now) {
    this.get("SELECT count(*) AS n FROM users");
    this.run(
      "INSERT INTO readiness(id,checked_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at",
      now,
    );
  }
  /** Keyed hash under which a rate-limit counter is stored. */
  rateKeyHash(key) {
    return createHmac("sha256", this.rateKey).update(key).digest("hex");
  }
  /** True when the counter `key` has reached `limit` in its current window; counts nothing. */
  rateExceeded(key, limit, now) {
    const old = this.get(
      "SELECT * FROM rate_limits WHERE key=?",
      this.rateKeyHash(key),
    );
    return !!old && old.expires > now && old.count >= limit;
  }
  /** Counts one event under `key`; 429 once `limit` is reached in the window. Returns the new count. */
  rate(key, limit, window, now) {
    const keyHash = this.rateKeyHash(key);
    return this.transaction(() => {
      const old = this.get("SELECT * FROM rate_limits WHERE key=?", keyHash);
      if (old && old.expires > now) {
        if (old.count >= limit) fail(429, "rateLimited");
        this.run("UPDATE rate_limits SET count=count+1 WHERE key=?", keyHash);
        return old.count + 1;
      }
      this.run(
        "INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)",
        keyHash,
        1,
        now + window,
      );
      return 1;
    });
  }
  /** When `key` may next fail without waiting (0 when it need not wait). */
  backoffUntil(key, now) {
    const row = this.get(
      "SELECT retry_at FROM sign_in_backoff WHERE key=? AND expires>?",
      this.rateKeyHash(key),
      now,
    );
    return row && row.retry_at > now ? row.retry_at : 0;
  }
  /**
   * Records one more consecutive failure for `key`. Past `free` failures each
   * further one waits `base`, doubling, at most `max`. The streak is forgotten
   * `window` after the last failure. Returns the new streak length.
   */
  recordFailure(key, now, { free, base, max, window }) {
    const keyHash = this.rateKeyHash(key);
    return this.transaction(() => {
      const old = this.get(
        "SELECT failures FROM sign_in_backoff WHERE key=? AND expires>?",
        keyHash,
        now,
      );
      const failures = (old?.failures ?? 0) + 1;
      const over = failures - free;
      const delay = over > 0 ? Math.min(base * 2 ** Math.min(over - 1, 40), max) : 0;
      this.run(
        "INSERT OR REPLACE INTO sign_in_backoff VALUES(?,?,?,?)",
        keyHash,
        failures,
        now + delay,
        now + window,
      );
      return failures;
    });
  }
  clearFailures(key) {
    this.run("DELETE FROM sign_in_backoff WHERE key=?", this.rateKeyHash(key));
  }
  /**
   * The network prefix shown on the approval page is only needed while the code can still be
   * approved: forget it once the code has expired, been approved or been exchanged. The row
   * itself stays until `cleanup` removes it a day after expiry.
   */
  forgetDeviceOrigins(now) {
    this.run(
      "UPDATE devices SET origin=NULL,client_hash=NULL WHERE (origin IS NOT NULL OR client_hash IS NOT NULL) AND (expires<=? OR consumed=1 OR user_id IS NOT NULL)",
      now,
    );
  }
  cleanup(now) {
    this.forgetDeviceOrigins(now);
    this.run("DELETE FROM flows WHERE expires<?", now);
    this.run("DELETE FROM devices WHERE expires<?", now - 86400000);
    this.run("DELETE FROM sessions WHERE expires<?", now - 86400000);
    this.run(
      "DELETE FROM session_renewals WHERE token_hash NOT IN (SELECT token_hash FROM sessions)",
    );
    this.run("DELETE FROM rate_limits WHERE expires<?", now);
    this.run("DELETE FROM sign_in_backoff WHERE expires<?", now);
    this.run("DELETE FROM deletion_receipts WHERE expires<?", now);
    this.transaction(() => this.expireReservations(now));
    this.expireDeletionRecords(now);
  }
  /**
   * Deletes rows past their retention, at most `limit` per table per call so that no
   * single call holds the (synchronous) database for long. Returns how many rows each
   * table lost and whether another call could find more. `allowance_holds`, the
   * deletion receipts and the deletion log are not touched here.
   *
   * - `usage` rows of a period before the 13 months preceding the current month.
   * - `job_dispatches` created before the start of that same month. A job id cannot
   *   be replayed after its deadline (at most two minutes after the request), so
   *   forgetting a job only ever releases its hash.
   * - `webhooks` (Stripe event ids) received more than 35 days ago.
   */
  pruneRetention(now, limit = 500) {
    const cutoff = monthsAgo(now, USAGE_RETENTION_MONTHS);
    const prune = (sql, ...args) =>
      this.transaction(() => this.run(sql, ...args, limit).changes);
    const deleted = {
      usage: prune(
        "DELETE FROM usage WHERE rowid IN (SELECT rowid FROM usage WHERE period<? LIMIT ?)",
        month(cutoff),
      ),
      jobs: prune(
        "DELETE FROM job_dispatches WHERE rowid IN (SELECT rowid FROM job_dispatches WHERE created_at<? LIMIT ?)",
        cutoff,
      ),
      events: prune(
        "DELETE FROM webhooks WHERE rowid IN (SELECT rowid FROM webhooks WHERE received_at<? LIMIT ?)",
        now - STRIPE_EVENT_RETENTION_DAYS * DAY,
      ),
    };
    return {
      deleted,
      more: Object.values(deleted).some((n) => n >= limit),
    };
  }
  /** The anti-abuse record lives only until the month it counts ends. */
  expireDeletionRecords(now) {
    this.run("DELETE FROM allowance_holds WHERE period<>?", month(now));
    this.log.prune(now);
  }
  /** Call inside a transaction. */
  user(identity, now = Date.now()) {
    const current = this.get(
      "SELECT * FROM users WHERE issuer=? AND subject=?",
      identity.issuer,
      identity.subject,
    );
    const id = current?.id ?? secret();
    this.run(
      "INSERT INTO users(id,issuer,subject,email,name,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email,name=excluded.name",
      id,
      identity.issuer,
      identity.subject,
      identity.email ?? null,
      identity.name ?? null,
      now,
    );
    if (!current) this.releaseHold(id, identity, now);
    return id;
  }
  /**
   * A person who deleted an account and signs up again within the same month
   * gets this month's usage back, so deleting cannot reset the allowance.
   */
  releaseHold(userId, identity, now) {
    const key = this.log.id(identity.issuer, identity.subject);
    const held = this.get(
      "SELECT * FROM allowance_holds WHERE subject_hash=? AND period=?",
      key,
      month(now),
    );
    if (held)
      this.run(
        "INSERT INTO usage VALUES(?,?,?,?,?)",
        userId,
        held.period,
        held.requests,
        held.input_tokens,
        held.output_tokens,
      );
    this.run("DELETE FROM allowance_holds WHERE subject_hash=?", key);
  }
  session(token, now) {
    if (typeof token !== "string" || token.length > 256)
      fail(401, "unauthenticated");
    const tokenHash = hash(token);
    const row = this.get(
      "SELECT users.*,sessions.expires AS session_expires FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND revoked=0 AND expires>?",
      tokenHash,
      now,
    );
    if (!row) fail(401, "unauthenticated");
    // The first use of a renewed token proves the app holds it: the token it
    // replaced stops working now instead of at the end of its grace period.
    const renewed = this.get(
      "SELECT predecessor FROM session_renewals WHERE token_hash=? AND predecessor IS NOT NULL",
      tokenHash,
    );
    if (renewed)
      this.transaction(() => {
        this.run(
          "UPDATE sessions SET revoked=1 WHERE token_hash=?",
          renewed.predecessor,
        );
        this.run(
          "UPDATE session_renewals SET predecessor=NULL WHERE token_hash=?",
          tokenHash,
        );
      });
    return row;
  }
  /** Records a new sign-in's session. Call inside a transaction. */
  createSession(token, userId, expires, now) {
    this.run(
      "INSERT INTO sessions(token_hash,user_id,expires,revoked) VALUES(?,?,?,0)",
      hash(token),
      userId,
      expires,
    );
    this.run(
      "INSERT INTO session_renewals(token_hash,user_id,signed_in_at) VALUES(?,?,?)",
      hash(token),
      userId,
      now,
    );
  }
  /** The token that renewing `token` issues: the same one on every retry. */
  successorToken(token) {
    return createHmac("sha256", this.renewalKey)
      .update(token)
      .digest("base64url");
  }
  /**
   * Sliding renewal. Inside `window` of its expiry a session is replaced by a
   * new token that lasts `ttl`, but never past `max` after the original
   * sign-in. The old token keeps working until the new one is first used, at
   * most `grace` longer. A retry (or a concurrent call) with the old token
   * returns the same new token. Earlier than `window`, or once the lifetime
   * cap is reached, nothing changes and `renewed` is false.
   */
  renewSession(token, now, { ttl, max, window, grace }) {
    if (typeof token !== "string" || token.length > 256)
      fail(401, "unauthenticated");
    const oldHash = hash(token);
    return this.transaction(() => {
      const old = this.get(
        "SELECT * FROM sessions WHERE token_hash=? AND revoked=0 AND expires>?",
        oldHash,
        now,
      );
      if (!old) fail(401, "unauthenticated");
      const line = this.get(
        "SELECT * FROM session_renewals WHERE token_hash=?",
        oldHash,
      );
      // Sessions from before renewal existed: assume they started a full lifetime before expiry.
      const signedInAt = line?.signed_in_at ?? old.expires - ttl;
      const signInRequiredAtMs = signedInAt + max;
      // Using this token proves the app no longer needs the one it replaced.
      if (line?.predecessor) {
        this.run(
          "UPDATE sessions SET revoked=1 WHERE token_hash=?",
          line.predecessor,
        );
        this.run(
          "UPDATE session_renewals SET predecessor=NULL WHERE token_hash=?",
          oldHash,
        );
      }
      if (line?.successor) {
        const next = this.get(
          "SELECT expires FROM sessions WHERE token_hash=? AND revoked=0 AND expires>?",
          line.successor,
          now,
        );
        if (!next) fail(401, "unauthenticated");
        const sessionToken = this.successorToken(token);
        // The renewal key changed since the successor was issued: this token
        // cannot be re-derived. Say so instead of returning one that does not
        // exist; the old token works until its grace ends, then sign in again.
        if (hash(sessionToken) !== line.successor)
          return {
            renewed: false,
            expiresAtMs: old.expires,
            signInRequiredAtMs: old.expires,
          };
        return {
          renewed: true,
          sessionToken,
          expiresAtMs: next.expires,
          signInRequiredAtMs,
        };
      }
      const expiresAtMs = Math.min(now + ttl, signInRequiredAtMs);
      if (old.expires - now > window || expiresAtMs <= old.expires)
        return { renewed: false, expiresAtMs: old.expires, signInRequiredAtMs };
      const next = this.successorToken(token),
        nextHash = hash(next);
      this.run(
        "INSERT INTO sessions(token_hash,user_id,expires,revoked) VALUES(?,?,?,0)",
        nextHash,
        old.user_id,
        expiresAtMs,
      );
      this.run(
        "INSERT INTO session_renewals(token_hash,user_id,signed_in_at,predecessor) VALUES(?,?,?,?)",
        nextHash,
        old.user_id,
        signedInAt,
        oldHash,
      );
      this.run(
        "INSERT INTO session_renewals(token_hash,user_id,signed_in_at,successor) VALUES(?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET successor=excluded.successor",
        oldHash,
        old.user_id,
        signedInAt,
        nextHash,
      );
      this.run(
        "UPDATE sessions SET expires=MIN(expires,?) WHERE token_hash=?",
        now + grace,
        oldHash,
      );
      return { renewed: true, sessionToken: next, expiresAtMs, signInRequiredAtMs };
    });
  }
  /** Signs out one Mac: its token and the tokens a renewal linked to it. */
  revokeSession(token) {
    const tokenHash = hash(token);
    this.transaction(() => {
      const line = this.get(
        "SELECT predecessor,successor FROM session_renewals WHERE token_hash=?",
        tokenHash,
      );
      for (const h of [tokenHash, line?.predecessor, line?.successor])
        if (h) this.run("UPDATE sessions SET revoked=1 WHERE token_hash=?", h);
    });
  }
  /** Everything stored for one account, without secrets, hashes or other accounts' rows. */
  exportAccount(user, tokenHash, now) {
    const id = user.id;
    const month = (column) =>
      `strftime('%Y-%m', ${column}/1000, 'unixepoch')`;
    const checkout = this.get("SELECT * FROM checkouts WHERE user_id=?", id);
    return {
      formatVersion: 1,
      exportedAtMs: now,
      account: {
        id,
        issuer: user.issuer,
        subject: user.subject,
        email: user.email ?? null,
        name: user.name ?? null,
      },
      billing: {
        customerId: user.customer ?? null,
        plan: user.plan,
        subscriptionStatus: user.subscription_status,
        periodStartMs: user.period_start || null,
        periodEndMs: user.period_end,
        pastDueSinceMs: user.past_due_since || null,
        lastReconciledAtMs: user.reconciled_at,
        pendingCheckout: checkout
          ? {
              plan: checkout.plan,
              sessionId: checkout.session_id ?? null,
              expiresAtMs: checkout.expires,
            }
          : null,
      },
      usage: this.db
        .prepare(
          "SELECT period,requests,input_tokens,output_tokens FROM usage WHERE user_id=? ORDER BY period",
        )
        .all(id)
        .map((r) => ({
          period: r.period,
          requests: r.requests,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
        })),
      sessions: this.db
        .prepare(
          "SELECT sessions.token_hash,expires,revoked,signed_in_at FROM sessions LEFT JOIN session_renewals USING(token_hash) WHERE sessions.user_id=? ORDER BY expires",
        )
        .all(id)
        .map((r) => ({
          expiresAtMs: r.expires,
          revoked: r.revoked === 1,
          current: r.token_hash === tokenHash,
          ...(r.signed_in_at ? { signedInAtMs: r.signed_in_at } : {}),
        })),
      deviceAuthorizations: this.db
        .prepare("SELECT expires,consumed FROM devices WHERE user_id=? ORDER BY expires")
        .all(id)
        .map((r) => ({ expiresAtMs: r.expires, consumed: r.consumed === 1 })),
      reasoningJobs: this.db
        .prepare(
          `SELECT ${month("created_at")} AS period,status,count(*) AS count FROM job_dispatches WHERE user_id=? GROUP BY period,status ORDER BY period,status`,
        )
        .all(id)
        .map((r) => ({ period: r.period, status: r.status, count: r.count })),
      billingEvents: user.customer
        ? this.db
            .prepare(
              "SELECT type,status,count(*) AS count,min(received_at) AS first,max(received_at) AS last FROM webhooks WHERE customer=? GROUP BY type,status ORDER BY type,status",
            )
            .all(user.customer)
            .map((r) => ({
              type: r.type,
              status: r.status,
              count: r.count,
              firstReceivedAtMs: r.first,
              lastReceivedAtMs: r.last,
            }))
        : [],
      outsideThisExport: {
        thisMac:
          "Transcripts, audio, notes, meeting plans and indexed documents are stored only on your Mac. The service never receives them, so they are not part of this export.",
        stripe:
          "Stripe holds your payment details, invoices and receipts as the payment processor. View them in the billing portal in the app, or ask Stripe.",
      },
    };
  }
  deletionReceipt(tokenHash, now) {
    return this.get(
      "SELECT * FROM deletion_receipts WHERE token_hash=? AND expires>?",
      tokenHash,
      now,
    );
  }
  /**
   * Erases the account and everything keyed to it in one transaction. Only a
   * hash of the deleting session's token remains, until that session would have
   * expired, so a retry whose response was lost still gets its answer; with no
   * token (an operator erasure) no receipt is kept. The deletion is logged
   * first, so a crash in between is finished by the next start.
   */
  deleteAccount(user, tokenHash, sessionExpires, now) {
    try {
      this.log.record(this.log.id(user.issuer, user.subject), now);
    } catch {
      fail(503, "deletionLogUnavailable");
    }
    this.transaction(() => {
      this.erase(user, now);
      if (tokenHash)
        this.run(
          "INSERT OR REPLACE INTO deletion_receipts VALUES(?,?,?,?)",
          tokenHash,
          now,
          user.customer ? 1 : 0,
          Math.max(sessionExpires, now + 86400000),
        );
    });
    this.truncateLog();
  }
  /** Deleted pages are zeroed (secure_delete); truncate the log so old copies of the rows go too. */
  truncateLog() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }
  /**
   * Call inside a transaction. Besides erasing, keeps one anti-abuse record: the
   * keyed hash of the identity and this month's usage counters, nothing else,
   * until the month ends (see `cleanup`) or the person signs up again.
   */
  erase(user, now) {
    const id = user.id,
      period = month(now);
    // The counters the allowance checks right now (billing period plus any uncarried calendar
    // month), held under the calendar month: a sign-up again this month starts from them and
    // carries them into its first billing period (see `reserve`).
    const used = this.counted(id, now);
    this.run(
      "DELETE FROM flows WHERE device_hash IN(SELECT code_hash FROM devices WHERE user_id=?)",
      id,
    );
    // A sign-in that was verified but not yet approved holds the identity with no user_id.
    this.run(
      "DELETE FROM flows WHERE json_extract(identity,'$.issuer')=? AND json_extract(identity,'$.subject')=?",
      user.issuer,
      user.subject,
    );
    for (const table of [
      "devices",
      "sessions",
      "session_renewals",
      "checkouts",
      "usage",
      "job_dispatches",
      "reservations",
    ])
      this.run(`DELETE FROM ${table} WHERE user_id=?`, id);
    if (user.customer)
      this.run("DELETE FROM webhooks WHERE customer=?", user.customer);
    this.run("DELETE FROM users WHERE id=?", id);
    if (used.found)
      this.run(
        "INSERT OR REPLACE INTO allowance_holds VALUES(?,?,?,?,?)",
        this.log.id(user.issuer, user.subject),
        period,
        used.requests,
        used.inputTokens,
        used.outputTokens,
      );
  }
  /**
   * After a restore the database may hold accounts that were deleted later.
   * Erases every account whose identity is in the log with a deletion newer
   * than the account itself, so a person who signed up again is left alone.
   */
  applyDeletionLog(now) {
    const latest = this.log.latest();
    if (!latest.size) return 0;
    let erased = 0;
    for (const user of this.db.prepare("SELECT * FROM users").all()) {
      const at = latest.get(this.log.id(user.issuer, user.subject));
      if (at === undefined || user.created_at >= at) continue;
      this.transaction(() => this.erase(user, now));
      erased++;
    }
    if (erased) this.truncateLog();
    return erased;
  }
  /**
   * The key usage is counted under at `now`: the account's Stripe billing period while `now` lies
   * inside it, otherwise (no subscription period known, e.g. legacy rows before the next
   * reconcile) the UTC calendar month.
   */
  usagePeriod(userId, now) {
    const u = this.get(
      "SELECT period_start,period_end FROM users WHERE id=?",
      userId,
    );
    return u && u.period_start > 0 && u.period_start <= now && now < u.period_end
      ? billingPeriod(u.period_start)
      : month(now);
  }
  /**
   * Start of the account's last billing period that began before `before` (the unpaid one): the
   * recorded period when it is older, else the newest billing-period usage counter older than it.
   * 0 when neither is known; usage then counts in the calendar month. Call inside a transaction.
   */
  lastPaidPeriodStart(userId, before) {
    if (!(before > 0)) return 0;
    const stored =
      this.get("SELECT period_start FROM users WHERE id=?", userId)?.period_start ?? 0;
    const counter = this.get(
      "SELECT max(period) AS p FROM usage WHERE user_id=? AND period LIKE '____-__-__T%' AND period<?",
      userId,
      billingPeriod(before),
    )?.p;
    const fromCounter = counter ? Date.parse(counter) : 0;
    const candidates = [stored, fromCounter].filter((n) => n > 0 && n < before);
    return candidates.length ? Math.max(...candidates) : 0;
  }
  /**
   * The counters the allowance checks. In a billing period these include the counter of the
   * current calendar month when it is still separate: that is usage counted before the switch to
   * billing periods (or restored after a deletion) and must not be forgiven. `reserve` folds it
   * into the period on the next request.
   */
  counted(userId, now) {
    const period = this.usagePeriod(userId, now),
      legacy = month(now);
    const rows = this.db
      .prepare(
        "SELECT * FROM usage WHERE user_id=? AND period IN (?,?)",
      )
      .all(userId, period, legacy);
    return rows.reduce(
      (sum, r) => ({
        found: true,
        requests: sum.requests + r.requests,
        inputTokens: sum.inputTokens + r.input_tokens,
        outputTokens: sum.outputTokens + r.output_tokens,
      }),
      { found: false, requests: 0, inputTokens: 0, outputTokens: 0 },
    );
  }
  usage(userId, now) {
    const { requests, inputTokens, outputTokens } = this.counted(userId, now);
    return { requests, inputTokens, outputTokens };
  }
  /** Moves the calendar-month counter into the billing period it is counted in. Call inside a transaction. */
  carryMonth(userId, period, now) {
    const legacy = month(now);
    if (period === legacy) return;
    const row = this.get(
      "SELECT * FROM usage WHERE user_id=? AND period=?",
      userId,
      legacy,
    );
    if (!row) return;
    this.run(
      "INSERT INTO usage VALUES(?,?,?,?,?) ON CONFLICT(user_id,period) DO UPDATE SET requests=requests+excluded.requests,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens",
      userId,
      period,
      row.requests,
      row.input_tokens,
      row.output_tokens,
    );
    this.run("DELETE FROM usage WHERE user_id=? AND period=?", userId, legacy);
    // A lease taken under the month settles against the period that now holds its charge.
    this.run(
      "UPDATE reservations SET period=? WHERE user_id=? AND period=?",
      period,
      userId,
      legacy,
    );
  }
  expireReservations(now) {
    this.run(
      "UPDATE job_dispatches SET status='indeterminate',updated_at=? WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM reservations WHERE reservations.id=job_dispatches.reservation_id AND reservations.expires>?)",
      now,
      now,
    );
    this.run("DELETE FROM reservations WHERE expires<=?", now);
  }
  assertFreshJob(userId, identity) {
    if (!identity?.jobKey) return;
    const old = this.get(
      "SELECT * FROM job_dispatches WHERE user_id=? AND job_key=?",
      userId,
      identity.jobKey,
    );
    if (!old) return;
    if (old.request_digest !== identity.digest) fail(409, "jobReplayMismatch");
    const codes = {
      pending: "jobInProgress",
      complete: "jobAlreadyCompleted",
      failed: "jobAlreadyFailed",
      indeterminate: "jobDispatchUnknown",
    };
    fail(409, codes[old.status] ?? "jobDispatchUnknown");
  }
  reserve(userId, limits, input, output, config, now, identity) {
    return this.transaction(() => {
      this.expireReservations(now);
      this.assertFreshJob(userId, identity);
      const workClass = identity?.workClass ?? "interactive";
      const total = this.get("SELECT count(*) AS n FROM reservations").n;
      const occupied = this.get(
        "SELECT count(*) AS n FROM reservations WHERE user_id=? AND work_class=?",
        userId,
        workClass,
      ).n;
      if (workClass === "background") {
        if (
          occupied >= config.userBackgroundConcurrency ||
          total >= config.globalConcurrency - config.globalLiveReserve
        )
          fail(429, "backgroundConcurrencyExceeded");
      } else if (
        occupied >=
          // Automatic interactive work leaves one slot for requested cards.
          (identity?.automatic && config.userConcurrency > 1
            ? config.userConcurrency - 1
            : config.userConcurrency) ||
        total >= config.globalConcurrency
      )
        fail(429, "concurrencyExceeded");
      const period = this.usagePeriod(userId, now);
      this.carryMonth(userId, period, now);
      const usage = this.usage(userId, now);
      if (
        usage.requests + 1 > limits.requests ||
        usage.inputTokens + input > limits.inputTokens ||
        usage.outputTokens + output > limits.outputTokens
      )
        fail(429, "allowanceExceeded");
      const id = secret();
      this.run(
        "INSERT INTO usage VALUES(?,?,?,?,?) ON CONFLICT(user_id,period) DO UPDATE SET requests=requests+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens",
        userId,
        period,
        1,
        input,
        output,
      );
      this.run(
        "INSERT INTO reservations(id,user_id,period,input,output,expires,work_class) VALUES(?,?,?,?,?,?,?)",
        id,
        userId,
        period,
        input,
        output,
        now + RESERVATION_TTL_MS,
        workClass,
      );
      if (identity?.jobKey)
        this.run(
          "INSERT INTO job_dispatches VALUES(?,?,?,'pending',?,?,?)",
          userId,
          identity.jobKey,
          identity.digest,
          id,
          now,
          now,
        );
      return id;
    });
  }
  /**
   * `refundRequest` also gives back the request counted at admission; it is
   * for calls the provider refused before running (see providers.mjs).
   */
  settle(id, actual, outcome = "failed", now = Date.now(), { refundRequest = false } = {}) {
    this.transaction(() => {
      this.run(
        "UPDATE job_dispatches SET status=?,updated_at=? WHERE reservation_id=? AND status='pending'",
        outcome,
        now,
        id,
      );
      const row = this.get("SELECT * FROM reservations WHERE id=?", id);
      if (!row) return;
      if (
        actual &&
        Number.isSafeInteger(actual.input) &&
        Number.isSafeInteger(actual.output) &&
        actual.input >= 0 &&
        actual.output >= 0 &&
        actual.input <= row.input &&
        actual.output <= row.output
      )
        this.run(
          "UPDATE usage SET input_tokens=input_tokens-?,output_tokens=output_tokens-? WHERE user_id=? AND period=?",
          row.input - actual.input,
          row.output - actual.output,
          row.user_id,
          row.period,
        );
      if (refundRequest)
        this.run(
          "UPDATE usage SET requests=MAX(requests-1,0) WHERE user_id=? AND period=?",
          row.user_id,
          row.period,
        );
      this.run("DELETE FROM reservations WHERE id=?", id);
    });
  }
}
