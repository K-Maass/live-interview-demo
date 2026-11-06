// Restore drill and pre-deploy migration check (deploy/host/li-restore, deploy/host/li-deploy-root).
//
// Run against a COPY of the database, never the live file: it opens the copy exactly as the
// service does at start, so the schema is upgraded and the deletion log is re-applied by the
// service's own code (Store: schema upgrade, then applyDeletionLog), then it reports counts only.
//
//   DATABASE_PATH=/restore/service.sqlite DELETION_LOG_PATH=/restore/service.sqlite.deletions \
//     node scripts/restore-check.mjs [--allow-missing-deletion-log]
//
// Exit 0 when the copy passes SQLite's integrity and foreign-key checks before and after, 1
// otherwise. Output is one JSON line: no account data, only schema version and counts.
//
// A missing deletion log is an error unless explicitly allowed: opening the store would create a
// fresh log with a new salt, and a restore would then silently bring deleted accounts back.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";
import { Store } from "../src/store.mjs";

const allowMissingLog = process.argv.includes("--allow-missing-deletion-log");
const config = loadConfig();
const stop = (code, extra = {}) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code, ...extra })}\n`);
  process.exit(1);
};
if (config.databasePath === ":memory:" || !existsSync(config.databasePath))
  stop("databaseMissing");
if (!allowMissingLog && !existsSync(config.deletionLogPath))
  stop("deletionLogMissing");

function inspect(path) {
  const db = new DatabaseSync(path);
  try {
    const integrity = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    const hasUsers = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='users'")
      .get();
    return {
      integrityOk: integrity.length === 1 && integrity[0] === "ok",
      foreignKeyViolations,
      schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
      users: hasUsers ? db.prepare("SELECT count(*) AS n FROM users").get().n : 0,
    };
  } finally {
    db.close();
  }
}

const before = inspect(config.databasePath);
if (!before.integrityOk || before.foreignKeyViolations)
  stop("integrityCheckFailed", { stage: "before" });
let store;
try {
  store = new Store(config.databasePath, {
    deletionLogPath: config.deletionLogPath,
  });
} catch (error) {
  stop("storeOpenFailed", { reason: String(error?.message ?? error).slice(0, 80) });
}
store.close();
const after = inspect(config.databasePath);
if (!after.integrityOk || after.foreignKeyViolations)
  stop("integrityCheckFailed", { stage: "after" });
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    integrity: "ok",
    schemaVersionBefore: before.schemaVersion,
    schemaVersion: after.schemaVersion,
    usersBefore: before.users,
    usersAfter: after.users,
    erasedByDeletionLog: before.users - after.users,
  })}\n`,
);
