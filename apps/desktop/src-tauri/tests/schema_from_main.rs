//! Databases written by the build on `main` (before versioned schemas; commit 0fbca9b) are at
//! `user_version` 0. Opening them with this build must migrate them in place with every row intact.
//! The fixture statements below are copied verbatim from that build's `open` functions.
use live_interview_lib::{
    actions::ActionStore, context_sources::SourceIndex, public_connectors::CalendarStore,
    public_domain::PublicStore, schema,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::path::Path;

/// actions.rs `ActionStore::open` at 0fbca9b.
const MAIN_ACTIONS: &str = "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,approval TEXT);CREATE TABLE IF NOT EXISTS internal_notes(id TEXT PRIMARY KEY,path TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL);";
/// public_connectors.rs `CalendarStore::open` at 0fbca9b.
const MAIN_CALENDARS: &str = "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS calendar_settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS calendars(account TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,id));CREATE TABLE IF NOT EXISTS events(account TEXT NOT NULL,calendar TEXT NOT NULL,id TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,calendar,id));CREATE TABLE IF NOT EXISTS coverage(account TEXT NOT NULL,calendar TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,calendar,start_ms,end_ms));";
/// context_sources.rs `SourceIndex::open` then public_domain.rs `PublicStore::open` at 0fbca9b.
const MAIN_CONTEXT: &[&str] = &[
    "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,path TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL);CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,workspace UNINDEXED,title,text,locator UNINDEXED,revision UNINDEXED,derived UNINDEXED,tokenize='unicode61');",
    "CREATE TABLE IF NOT EXISTS workspace_roots(workspace TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(workspace,root));CREATE TABLE IF NOT EXISTS workspace_scope(workspace TEXT NOT NULL,shared TEXT NOT NULL,PRIMARY KEY(workspace,shared));CREATE TABLE IF NOT EXISTS source_file_metadata(id TEXT PRIMARY KEY,modified_ns TEXT NOT NULL,size INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS source_vectors(source_id TEXT NOT NULL,locator TEXT NOT NULL,revision INTEGER NOT NULL,language TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(source_id,locator));",
    "CREATE TABLE IF NOT EXISTS public_workspace_registration(id TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS source_revisions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);INSERT INTO source_revisions(id,revision) SELECT id,revision FROM sources WHERE true ON CONFLICT(id) DO UPDATE SET revision=MAX(source_revisions.revision,excluded.revision);INSERT INTO source_revisions(id,revision) SELECT source_id,MAX(revision) FROM source_vectors GROUP BY source_id ON CONFLICT(id) DO UPDATE SET revision=MAX(source_revisions.revision,excluded.revision);",
    "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS public_workspaces(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS plan_event ON plans(json_extract(body,'$.eventId')) WHERE json_extract(body,'$.eventId') IS NOT NULL;CREATE TABLE IF NOT EXISTS artifacts(meeting TEXT NOT NULL,kind TEXT NOT NULL,record_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(meeting,kind,record_revision));CREATE TABLE IF NOT EXISTS applied_notes(workspace TEXT NOT NULL,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL,meeting TEXT NOT NULL,PRIMARY KEY(workspace,path,dev,ino,meeting));CREATE TABLE IF NOT EXISTS output_grants(workspace TEXT PRIMARY KEY,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS grants(workspace TEXT NOT NULL,path TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL,PRIMARY KEY(workspace,path));",
];

fn strings(c: &Connection, sql: &str) -> Vec<String> {
    c.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
}
/// A table's rows as text over `columns`, in a stable order.
fn rows(c: &Connection, table: &str, columns: &[String]) -> Vec<String> {
    let select = columns.iter().map(|c| format!("quote({c})")).collect::<Vec<_>>().join("||'|'||");
    strings(c, &format!("SELECT {select} FROM {table} ORDER BY 1"))
}
/// Every user table with its columns and rows (FTS shadow tables are covered by `source_fts` itself).
#[derive(Debug, PartialEq)]
struct Table {
    name: String,
    columns: Vec<String>,
    rows: Vec<String>,
}
fn dump(path: &Path) -> Vec<Table> {
    let c = Connection::open(path).unwrap();
    strings(&c, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'source_fts_%' ORDER BY name")
        .into_iter()
        .map(|name| {
            let columns = strings(&c, &format!("SELECT name FROM pragma_table_info('{name}')"));
            let rows = rows(&c, &name, &columns);
            Table { name, columns, rows }
        })
        .collect()
}
/// Every table in `before` still exists and holds the same rows over the columns it had then.
fn assert_intact(path: &Path, before: &[Table]) {
    let c = Connection::open(path).unwrap();
    for table in before {
        assert_eq!(rows(&c, &table.name, &table.columns), table.rows, "{} in {}", table.name, path.display());
    }
}
fn version(path: &Path) -> i64 {
    Connection::open(path).unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

#[test]
fn databases_written_by_main_migrate_with_every_row_intact() {
    let root = std::env::temp_dir().join(format!("live-schema-main-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let note = root.join("note.md");
    std::fs::write(&note, "original").unwrap();
    let note_version = format!("{:x}", Sha256::digest(b"original"));

    // actions.sqlite: an open proposal holding a token minted by main, an applied one, a registered note.
    let actions = root.join("actions.sqlite");
    let c = Connection::open(&actions).unwrap();
    c.execute_batch(MAIN_ACTIONS).unwrap();
    let open_body = serde_json::json!({"id":"open","targetId":note,"targetPath":note,"targetVersion":note_version,"operation":"append","before":"original","after":"original\nreviewed","evidence":[],"inferred":true,"status":"proposed"});
    c.execute("INSERT INTO proposals(id,body,status,approval) VALUES('open',?1,'proposed','main-token')", [open_body.to_string()]).unwrap();
    c.execute("INSERT INTO proposals(id,body,status,approval) VALUES('done','{\"id\":\"done\",\"status\":\"applied\"}','applied',NULL)", []).unwrap();
    c.execute("INSERT INTO internal_notes(id,path,revision,digest) VALUES('m-actions','/notes/m-actions.md',3,'abc')", []).unwrap();
    drop(c);

    // calendars.sqlite: a setting, an account, a calendar, a cached event and its coverage.
    let calendars = root.join("calendars.sqlite");
    let c = Connection::open(&calendars).unwrap();
    c.execute_batch(MAIN_CALENDARS).unwrap();
    c.execute("INSERT INTO calendar_settings(key,value) VALUES('appleDisabled',0)", []).unwrap();
    c.execute("INSERT INTO accounts(id,body) VALUES('a','{\"id\":\"a\",\"provider\":\"google\"}')", []).unwrap();
    c.execute("INSERT INTO calendars(account,id,body) VALUES('a','primary','{\"id\":\"primary\",\"selected\":true}')", []).unwrap();
    c.execute("INSERT INTO events(account,calendar,id,start_ms,end_ms,body) VALUES('a','primary','e1',?1,?2,?3)", rusqlite::params![now, now + 3_600_000, serde_json::json!({"id":"e1","startMs":now,"endMs":now + 3_600_000}).to_string()]).unwrap();
    c.execute("INSERT INTO coverage(account,calendar,start_ms,end_ms,body) VALUES('a','primary',?1,?2,'{\"status\":\"ready\"}')", rusqlite::params![now - 86_400_000, now + 86_400_000]).unwrap();
    drop(c);

    // context.sqlite: the context index and the public records.
    let context = root.join("context.sqlite");
    let c = Connection::open(&context).unwrap();
    for step in MAIN_CONTEXT {
        c.execute_batch(step).unwrap();
    }
    c.execute_batch(&format!(
        "INSERT INTO workspaces(id,root) VALUES('w','{r}');\
         INSERT INTO workspace_roots(workspace,root) VALUES('w','{r}');\
         INSERT INTO workspace_scope(workspace,shared) VALUES('w','lib');\
         INSERT INTO sources(id,workspace,path,digest,revision) VALUES('s','w','{r}/a.md','d',2);\
         INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES('s','w','A','Quarterly plan','a.md#1',2,0);\
         INSERT INTO source_file_metadata(id,modified_ns,size) VALUES('s','1',10);\
         INSERT INTO source_vectors(source_id,locator,revision,language,vector) VALUES('s','a.md#1',2,'en','[0.1]');\
         INSERT INTO source_revisions(id,revision) VALUES('s',2);\
         INSERT INTO public_workspace_registration(id) VALUES('w');\
         INSERT INTO public_workspaces(id,revision,body) VALUES('w',1,'{{\"id\":\"w\",\"name\":\"Main\",\"roots\":[\"{r}\"],\"revision\":1}}');\
         INSERT INTO plans(id,revision,body) VALUES('p',4,'{{\"id\":\"p\",\"eventId\":\"e1\",\"revision\":4}}');\
         INSERT INTO artifacts(meeting,kind,record_revision,body) VALUES('m','synthesis',2,'{{\"kind\":\"synthesis\"}}');\
         INSERT INTO applied_notes(workspace,path,dev,ino,meeting) VALUES('w','{r}/a.md',1,2,'m');\
         INSERT INTO output_grants(workspace,path,dev,ino) VALUES('w','{r}',1,3);\
         INSERT INTO grants(workspace,path,dev,ino) VALUES('w','{r}/a.md',1,2);",
        r = root.display()
    ))
    .unwrap();
    drop(c);

    let before: Vec<_> = [&actions, &calendars, &context].iter().map(|p| (p.to_path_buf(), dump(p))).collect();
    for (path, _) in &before {
        assert_eq!(version(path), 0);
    }

    // This build opens them.
    let store = ActionStore::open(&root).unwrap();
    let calendar = CalendarStore::open(&root).unwrap();
    SourceIndex::open(&root).unwrap();
    let public = PublicStore::open(&root).unwrap();

    assert_eq!(version(&actions), schema::ACTIONS.len() as i64);
    assert_eq!(version(&calendars), schema::CALENDARS.len() as i64);
    assert_eq!(version(&context), schema::CONTEXT.len() as i64);
    // Every row is intact over the columns it had; added columns (created_ms, approved_ms) are additions.
    for (path, tables) in &before {
        assert!(tables.iter().all(|t| !t.rows.is_empty() || t.name == "public_workspace_registration"));
        assert_intact(path, tables);
    }
    let c = Connection::open(&actions).unwrap();
    let created: i64 = c.query_row("SELECT MIN(created_ms) FROM proposals", [], |r| r.get(0)).unwrap();
    assert!(created > 0, "existing proposals count as created now, so they are not pruned at once");

    // The stores read the migrated rows.
    assert_eq!(calendar.accounts().unwrap().len(), 1);
    assert_eq!(calendar.cached("a", "primary", now - 1, now + 1).unwrap()[0]["id"], "e1");
    assert_eq!(public.list_workspaces().unwrap()[0]["name"], "Main");
    assert_eq!(public.list_plans().unwrap()[0]["eventId"], "e1");

    // Intended: a token minted by main has no approval time, so it cannot apply anything. The open
    // proposal must be approved again, and then applies normally.
    assert!(store.apply("open", "main-token").is_err());
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original");
    let token = store.approve("open").unwrap();
    assert_ne!(token, "main-token");
    store.apply("open", &token).unwrap();
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original\nreviewed");
    // An applied proposal stays applied.
    assert_eq!(store.approve("done").unwrap_err().to_string(), "alreadyApplied");

    // Opening again changes nothing.
    let settled = dump(&calendars);
    CalendarStore::open(&root).unwrap();
    assert_eq!(dump(&calendars), settled);
    std::fs::remove_dir_all(root).unwrap();
}
