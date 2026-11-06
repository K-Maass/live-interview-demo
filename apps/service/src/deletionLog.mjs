import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { fail } from "./errors.mjs";
/** Flushes a file, or a directory so a new or renamed entry in it survives power loss. */
function syncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Service backups are kept 30 days; the log outlives the oldest backup by a day. */
export const BACKUP_RETENTION_MS = 30 * 86400000;
export const LOG_RETENTION_MS = BACKUP_RETENTION_MS + 86400000;
/**
 * Append-only record of deleted accounts as keyed hashes, kept outside the
 * database so a restored backup can have its deletions re-applied. Line 1 is
 * the per-install salt, every other line is `{"id":<hash>,"at":<ms>}`. It holds
 * no email, name, subject or account ID; an entry is dropped after
 * LOG_RETENTION_MS, when no backup that predates it can exist any more.
 */
export class DeletionLog {
  constructor(path) {
    this.path = path;
    this.items = [];
    if (!path) {
      this.salt = randomBytes(32).toString("base64url");
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${JSON.stringify({ salt: randomBytes(32).toString("base64url") })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      // A lost salt file would look like a fresh install and drop every logged deletion.
      syncPath(path);
      syncPath(dirname(path));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    chmodSync(path, 0o600);
    this.load();
  }
  /** Reads the file, which another process (the operator erase script) may have appended to. */
  load() {
    const [head, ...rest] = readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean);
    try {
      this.salt = JSON.parse(head).salt;
      this.items = rest.map((line) => JSON.parse(line));
    } catch {
      fail(503, "deletionLogCorrupt");
    }
    if (
      typeof this.salt !== "string" ||
      !this.salt ||
      this.items.some(
        (item) => typeof item?.id !== "string" || !Number.isSafeInteger(item.at),
      )
    )
      fail(503, "deletionLogCorrupt");
  }
  /** Keyed hash of the verified identity; the salt never leaves this file. */
  id(issuer, subject) {
    return createHmac("sha256", this.salt)
      .update(JSON.stringify([issuer, subject]))
      .digest("hex");
  }
  /** Durable before it returns, so an erase that follows can never be lost. */
  record(id, at) {
    this.items.push({ id, at });
    if (!this.path) return;
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ id, at })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Latest deletion time per hashed identity. */
  latest() {
    if (this.path) this.load();
    const latest = new Map();
    for (const { id, at } of this.items)
      if (!(latest.get(id) >= at)) latest.set(id, at);
    return latest;
  }
  prune(now) {
    if (this.path) this.load();
    const kept = this.items.filter((item) => item.at > now - LOG_RETENTION_MS);
    if (kept.length === this.items.length) return;
    this.items = kept;
    if (!this.path) return;
    const lines = [
      JSON.stringify({ salt: this.salt }),
      ...kept.map((item) => JSON.stringify(item)),
    ];
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    syncPath(temporary);
    renameSync(temporary, this.path);
    syncPath(dirname(this.path));
  }
}
