//! Versioned SQLite schemas. Each database file has one ordered list of steps and
//! `PRAGMA user_version` records how many have run, so opening an up-to-date store writes
//! nothing. Steps are append-only: never edit or reorder a released step.
use rusqlite::{Connection, TransactionBehavior};

/// `context.sqlite`, shared by the context index (`SourceIndex`) and the public records
/// (`PublicStore`). Step 1 matches the tables older builds created on every open, so an
/// existing database at version 0 upgrades in place.
pub const CONTEXT: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL);\
     CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,path TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL);\
     CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,workspace UNINDEXED,title,text,locator UNINDEXED,revision UNINDEXED,derived UNINDEXED,tokenize='unicode61');\
     CREATE TABLE IF NOT EXISTS workspace_roots(workspace TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(workspace,root));\
     CREATE TABLE IF NOT EXISTS workspace_scope(workspace TEXT NOT NULL,shared TEXT NOT NULL,PRIMARY KEY(workspace,shared));\
     CREATE TABLE IF NOT EXISTS source_file_metadata(id TEXT PRIMARY KEY,modified_ns TEXT NOT NULL,size INTEGER NOT NULL);\
     CREATE TABLE IF NOT EXISTS source_vectors(source_id TEXT NOT NULL,locator TEXT NOT NULL,revision INTEGER NOT NULL,language TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(source_id,locator));\
     CREATE TABLE IF NOT EXISTS public_workspace_registration(id TEXT PRIMARY KEY);\
     CREATE TABLE IF NOT EXISTS source_revisions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);\
     INSERT INTO source_revisions(id,revision) SELECT id,revision FROM sources WHERE true ON CONFLICT(id) DO UPDATE SET revision=MAX(source_revisions.revision,excluded.revision);\
     INSERT INTO source_revisions(id,revision) SELECT source_id,MAX(revision) FROM source_vectors GROUP BY source_id ON CONFLICT(id) DO UPDATE SET revision=MAX(source_revisions.revision,excluded.revision);",
    "CREATE TABLE IF NOT EXISTS public_workspaces(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);\
     CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);\
     CREATE UNIQUE INDEX IF NOT EXISTS plan_event ON plans(json_extract(body,'$.eventId')) WHERE json_extract(body,'$.eventId') IS NOT NULL;\
     CREATE TABLE IF NOT EXISTS artifacts(meeting TEXT NOT NULL,kind TEXT NOT NULL,record_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(meeting,kind,record_revision));\
     CREATE TABLE IF NOT EXISTS applied_notes(workspace TEXT NOT NULL,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL,meeting TEXT NOT NULL,PRIMARY KEY(workspace,path,dev,ino,meeting));\
     CREATE TABLE IF NOT EXISTS output_grants(workspace TEXT PRIMARY KEY,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL);\
     CREATE TABLE IF NOT EXISTS grants(workspace TEXT NOT NULL,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL,PRIMARY KEY(workspace,path));",
    // Files whose extraction failed, panicked or timed out, by the digest that failed, so they
    // are not parsed again until their bytes change.
    "CREATE TABLE IF NOT EXISTS unreadable_sources(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,digest TEXT NOT NULL);",
];

/// `actions.sqlite`: reviewed proposals and registered internal notes (user records).
pub const ACTIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,approval TEXT);\
     CREATE TABLE IF NOT EXISTS internal_notes(id TEXT PRIMARY KEY,path TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL);",
    // Approval tokens expire and proposals age out; existing rows count as created now.
    "ALTER TABLE proposals ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;\
     ALTER TABLE proposals ADD COLUMN approved_ms INTEGER;\
     UPDATE proposals SET created_ms=CAST(strftime('%s','now') AS INTEGER)*1000;\
     CREATE TABLE IF NOT EXISTS picked_targets(path TEXT NOT NULL,kind TEXT NOT NULL,picked_ms INTEGER NOT NULL,PRIMARY KEY(path,kind));",
];

/// `calendars.sqlite`: connected accounts, calendar selections and the cached events read from them.
pub const CALENDARS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS calendar_settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);\
     CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,body TEXT NOT NULL);\
     CREATE TABLE IF NOT EXISTS calendars(account TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,id));\
     CREATE TABLE IF NOT EXISTS events(account TEXT NOT NULL,calendar TEXT NOT NULL,id TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,calendar,id));\
     CREATE TABLE IF NOT EXISTS coverage(account TEXT NOT NULL,calendar TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,calendar,start_ms,end_ms));",
    "CREATE INDEX IF NOT EXISTS events_end ON events(end_ms);\
     CREATE INDEX IF NOT EXISTS events_start ON events(start_ms);",
];

/// Runs the steps a database has not seen yet in one write transaction. A database written
/// by a newer build fails with `schemaTooNew` instead of being modified.
pub fn migrate(c: &mut Connection, steps: &[&str]) -> anyhow::Result<()> {
    let target = steps.len() as i64;
    let version = |c: &Connection| -> rusqlite::Result<i64> {
        c.query_row("PRAGMA user_version", [], |r| r.get(0))
    };
    let current = version(c)?;
    anyhow::ensure!(current <= target, "schemaTooNew");
    if current == target {
        return Ok(());
    }
    c.execute_batch("PRAGMA journal_mode=WAL;")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = version(&tx)?;
    anyhow::ensure!(current <= target, "schemaTooNew");
    for step in &steps[current as usize..] {
        tx.execute_batch(step)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version={target};"))?;
    tx.commit()?;
    Ok(())
}
