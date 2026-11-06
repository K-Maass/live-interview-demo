//! Public device-local records. Renderer supplied paths/content never reach automatic writes.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
pub struct PublicStore {
    root: PathBuf,
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn strings(v: &Value, key: &str, max: usize) -> anyhow::Result<Vec<String>> {
    let a = v[key]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalidList"))?;
    anyhow::ensure!(a.len() <= max, "listTooLarge");
    let values = a
        .iter()
        .map(|s| {
            s.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("invalidList"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        values.iter().collect::<HashSet<_>>().len() == values.len(),
        "duplicateSelection"
    );
    Ok(values)
}
fn id(v: &Value, key: &str) -> anyhow::Result<String> {
    let id = v[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalidId"))?;
    anyhow::ensure!(crate::meeting_records::valid_id(id), "invalidId");
    Ok(id.into())
}
fn canonical(path: &str, directory: bool) -> anyhow::Result<PathBuf> {
    let p = Path::new(path);
    anyhow::ensure!(p.is_absolute(), "absolutePathRequired");
    let mut current = PathBuf::new();
    for part in p.components() {
        current.push(part);
        anyhow::ensure!(
            !fs::symlink_metadata(&current)?.file_type().is_symlink(),
            "symlinkDenied"
        );
    }
    let p = p.canonicalize()?;
    anyhow::ensure!(
        if directory { p.is_dir() } else { p.is_file() },
        "invalidTarget"
    );
    Ok(p)
}
impl PublicStore {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        crate::context_sources::SourceIndex::open(root)?;
        let s = Self { root: root.into() };
        crate::schema::migrate(&mut s.db()?, crate::schema::CONTEXT)?;
        s.migrate_legacy_store()?;
        Ok(s)
    }
    fn db(&self) -> anyhow::Result<Connection> {
        let c = Connection::open(crate::owned_paths::file(
            &self.root,
            &["context.sqlite"],
            true,
        )?)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        // User records: every commit is durable, not only consistent.
        c.execute_batch("PRAGMA synchronous=FULL;")?;
        Ok(c)
    }
    fn migrate_legacy_store(&self) -> anyhow::Result<()> {
        let old_path = self.root.join("public.sqlite");
        if !old_path.exists() {
            return Ok(());
        }
        let old_path = crate::owned_paths::file(&self.root, &["public.sqlite"], false)?;
        let mut current = self.db()?;
        current
            .execute_batch("CREATE TABLE IF NOT EXISTS public_migrations(id TEXT PRIMARY KEY);")?;
        if current.query_row(
            "SELECT EXISTS(SELECT 1 FROM public_migrations WHERE id='single-context-db')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        let old =
            Connection::open_with_flags(old_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let tx = current.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (source, destination, columns) in [
            (
                "workspaces",
                "public_workspaces",
                vec!["id", "revision", "body"],
            ),
            ("plans", "plans", vec!["id", "revision", "body"]),
            (
                "artifacts",
                "artifacts",
                vec!["meeting", "kind", "record_revision", "body"],
            ),
            ("grants", "grants", vec!["workspace", "path", "dev", "ino"]),
            (
                "output_grants",
                "output_grants",
                vec!["workspace", "path", "dev", "ino"],
            ),
            (
                "applied_notes",
                "applied_notes",
                vec!["workspace", "path", "dev", "ino", "meeting"],
            ),
        ] {
            let exists: bool = old.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [source],
                |r| r.get(0),
            )?;
            if !exists {
                continue;
            }
            let mut q = old.prepare(&format!("SELECT {} FROM {source}", columns.join(",")))?;
            let mut rows = q.query([])?;
            while let Some(row) = rows.next()? {
                let values = (0..columns.len())
                    .map(|n| row.get::<_, rusqlite::types::Value>(n))
                    .collect::<Result<Vec<_>, _>>()?;
                let parameters = (1..=columns.len())
                    .map(|n| format!("?{n}"))
                    .collect::<Vec<_>>()
                    .join(",");
                tx.execute(
                    &format!(
                        "INSERT OR IGNORE INTO {destination}({}) VALUES({parameters})",
                        columns.join(",")
                    ),
                    rusqlite::params_from_iter(values),
                )?;
            }
        }
        let workspaces = {
            let mut q = tx.prepare("SELECT body FROM public_workspaces")?;
            let values = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            values
        };
        for raw in workspaces {
            let w: Value = serde_json::from_str(&raw)?;
            let id = id(&w, "id")?;
            let roots = strings(&w, "roots", 20)?;
            let shared = strings(&w, "sharedLibraryIds", 20)?;
            crate::context_sources::SourceIndex::connect_public_transaction(
                &tx, &id, &roots, &shared,
            )?;
        }
        tx.execute(
            "INSERT INTO public_migrations(id) VALUES('single-context-db')",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn list(&self, table: &str) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut q = c.prepare(&format!("SELECT body FROM {table} ORDER BY id"))?;
        let raw = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        raw.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    pub fn list_workspaces(&self) -> anyhow::Result<Vec<Value>> {
        self.list("public_workspaces")
    }
    pub fn list_plans(&self) -> anyhow::Result<Vec<Value>> {
        self.list("plans")
    }
    pub fn get_workspace(&self, id: &str) -> anyhow::Result<Option<Value>> {
        self.get("public_workspaces", id)
    }
    pub fn get_plan(&self, id: &str) -> anyhow::Result<Option<Value>> {
        self.get("plans", id)
    }
    fn get(&self, table: &str, id: &str) -> anyhow::Result<Option<Value>> {
        let raw: Option<String> = self
            .db()?
            .query_row(
                &format!("SELECT body FROM {table} WHERE id=?1"),
                [id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    /// Saves without asking about new access. Only for app-internal callers and tests; the renderer's command
    /// goes through [`Self::save_workspace_confirmed`].
    pub fn save_workspace(&self, w: Value) -> anyhow::Result<Value> {
        self.save_workspace_confirmed(w, |_| Ok(()))
    }
    /// Saves a workspace after `confirm` accepted the access it adds (new roots, output root, append targets).
    /// `confirm` is not called when the save adds nothing; an error from it stops the save before anything is
    /// written. Paths are validated and canonicalised first, so the sheet names exactly what will be granted.
    pub fn save_workspace_confirmed(
        &self,
        mut w: Value,
        confirm: impl FnOnce(&crate::grants::GrantRequest) -> anyhow::Result<()>,
    ) -> anyhow::Result<Value> {
        let id = id(&w, "id")?;
        anyhow::ensure!(id != "default", "reservedWorkspace");
        anyhow::ensure!(
            w["name"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200),
            "invalidWorkspaceName"
        );
        let roots = strings(&w, "roots", 20)?
            .into_iter()
            .map(|p| Ok(canonical(&p, true)?.to_string_lossy().into_owned()))
            .collect::<anyhow::Result<Vec<_>>>()?;
        anyhow::ensure!(!roots.is_empty(), "rootRequired");
        let shared = strings(&w, "sharedLibraryIds", 20)?;
        for s in &shared {
            anyhow::ensure!(
                s != &id && self.get_workspace(s)?.is_some(),
                "sharedScopeDenied"
            );
        }
        let targets = strings(&w, "appendTargets", 100)?
            .into_iter()
            .map(|p| Ok(canonical(&p, false)?.to_string_lossy().into_owned()))
            .collect::<anyhow::Result<Vec<_>>>()?;
        for path in &targets {
            anyhow::ensure!(
                path.ends_with(".md") && roots.iter().any(|r| Path::new(path).starts_with(r)),
                "appendGrantOutsideWorkspace"
            );
            anyhow::ensure!(
                fs::metadata(path)?.len() <= 16_000_000,
                "appendTargetTooLarge"
            );
        }
        if let Some(p) = w["outputRoot"].as_str() {
            w["outputRoot"] = json!(canonical(p, true)?.to_string_lossy());
        }
        w["root"] = json!(roots[0]);
        w["roots"] = json!(roots);
        w["appendTargets"] = json!(targets);
        // The stored revision check below still refuses a save based on an older read.
        let request = crate::grants::new_grants(self.get_workspace(&id)?.as_ref(), &w);
        if !request.is_empty() {
            confirm(&request)?;
        }
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<i64> = tx
            .query_row(
                "SELECT revision FROM public_workspaces WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let expected = w["revision"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?;
        anyhow::ensure!(expected == old.unwrap_or(0), "staleWorkspace");
        w["revision"] = json!(expected
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?);
        tx.execute("INSERT INTO public_workspaces(id,revision,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body",params![id,w["revision"].as_i64(),w.to_string()])?;
        tx.execute("DELETE FROM grants WHERE workspace=?1", [&id])?;
        tx.execute("DELETE FROM output_grants WHERE workspace=?1", [&id])?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Some(path) = w["outputRoot"].as_str() {
                let m = fs::metadata(path)?;
                tx.execute(
                    "INSERT INTO output_grants(workspace,path,dev,ino) VALUES(?1,?2,?3,?4)",
                    params![id, path, m.dev(), m.ino()],
                )?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            for path in &targets {
                let m = fs::metadata(path)?;
                anyhow::ensure!(m.nlink() == 1, "hardlinkDenied");
                tx.execute(
                    "INSERT INTO grants(workspace,path,dev,ino) VALUES(?1,?2,?3,?4)",
                    params![id, path, m.dev(), m.ino()],
                )?;
            }
        }
        crate::context_sources::SourceIndex::connect_public_transaction(&tx, &id, &roots, &shared)?;
        tx.commit()?;
        Ok(w)
    }
    pub fn sources(&self, workspace: &str) -> anyhow::Result<Vec<Value>> {
        if workspace == "default" {
            return Ok(vec![]);
        }
        anyhow::ensure!(
            self.get_workspace(workspace)?.is_some(),
            "workspaceRequired"
        );
        crate::context_sources::SourceIndex::open(&self.root)?.sources(workspace)
    }
    pub fn save_plan(&self, mut p: Value) -> anyhow::Result<Value> {
        let id = id(&p, "id")?;
        let workspace = p["workspaceId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("workspaceRequired"))?;
        let w = if workspace == "default" {
            json!({"sharedLibraryIds":[]})
        } else {
            self.get_workspace(workspace)?
                .ok_or_else(|| anyhow::anyhow!("workspaceRequired"))?
        };
        anyhow::ensure!(
            p["title"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 500),
            "invalidTitle"
        );
        anyhow::ensure!(
            matches!(
                p["status"].as_str(),
                Some("draft" | "prepared" | "cancelled")
            ),
            "invalidStatus"
        );
        anyhow::ensure!(
            matches!(
                p["profileId"].as_str(),
                Some("interview" | "discovery" | "workClient" | "presentationAnswering")
            ),
            "invalidProfile"
        );
        anyhow::ensure!(
            p["briefDraft"].as_str().is_some_and(|s| s.len() <= 100_000)
                && p["automaticPreparation"].is_boolean(),
            "invalidPlan"
        );
        let shared = strings(&p, "sharedLibraryIds", 20)?;
        let allowed = strings(&w, "sharedLibraryIds", 20)?;
        anyhow::ensure!(
            shared.iter().all(|s| allowed.contains(s)),
            "sharedScopeDenied"
        );
        let selected = strings(&p, "sourceIds", 20000)?;
        let sources = self.sources(workspace)?;
        anyhow::ensure!(
            selected
                .iter()
                .all(|id| sources.iter().any(|s| s["sourceId"] == *id
                    && (s["workspaceId"] == workspace
                        || shared.iter().any(|w| s["workspaceId"] == *w)))),
            "sourceScopeDenied"
        );
        anyhow::ensure!(
            p["sourceSelection"].is_null()
                || matches!(
                    p["sourceSelection"].as_str(),
                    Some("workspace" | "selected")
                ),
            "invalidSourceSelection"
        );
        if !p["draftEvidence"].is_null() {
            strings(&p, "draftEvidence", 1000)?;
        }
        if !p["reviewedBrief"].is_null() {
            anyhow::ensure!(
                p["reviewedBrief"].is_object() && p["reviewedBrief"].to_string().len() <= 200_000,
                "invalidBrief"
            );
        }
        strings(&p, "objectives", 100)?;
        strings(&p, "publicResearchTopics", 100)?;
        anyhow::ensure!(
            p["attendees"].as_array().is_some_and(|a| a.len() <= 200
                && a.iter()
                    .all(|v| v["id"].as_str().is_some_and(|s| s.len() <= 500)
                        && v["name"].as_str().is_some_and(|s| s.len() <= 500))),
            "invalidAttendees"
        );
        if !p["startMs"].is_null() || !p["endMs"].is_null() {
            anyhow::ensure!(
                p["startMs"]
                    .as_i64()
                    .zip(p["endMs"].as_i64())
                    .is_some_and(|(s, e)| e > s),
                "invalidRange"
            );
        }
        if let Some(event) = p["eventId"].as_str() {
            anyhow::ensure!(!event.is_empty() && event.len() <= 1000, "invalidEvent");
        }
        if !p["calendarSync"].is_null() {
            let sync = &p["calendarSync"];
            let text = |k: &str| sync[k].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 4096);
            anyhow::ensure!(
                text("nativeEventId")
                    && text("calendarId")
                    && sync["calendarName"].as_str().is_some_and(|s| s.len() <= 1000)
                    && sync["syncedTitle"].as_str().is_some_and(|s| s.len() <= 8192)
                    && (sync["version"].is_null() || text("version"))
                    && sync["syncedStartMs"]
                        .as_i64()
                        .zip(sync["syncedEndMs"].as_i64())
                        .is_some_and(|(s, e)| e > s),
                "invalidCalendarSync"
            );
        }
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<i64> = tx
            .query_row("SELECT revision FROM plans WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()?;
        let rev = p["revision"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?;
        anyhow::ensure!(rev == old.unwrap_or(0), "stalePlan");
        p["revision"] = json!(rev
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?);
        p["updatedAtMs"] = json!(now_ms());
        tx.execute("INSERT INTO plans(id,revision,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body",params![id,p["revision"].as_i64(),p.to_string()])?;
        tx.commit()?;
        Ok(p)
    }
    pub fn get_artifact(
        &self,
        meeting: &str,
        kind: &str,
        revision: u64,
    ) -> anyhow::Result<Option<Value>> {
        let raw: Option<String> = self
            .db()?
            .query_row(
                "SELECT body FROM artifacts WHERE meeting=?1 AND kind=?2 AND record_revision=?3",
                params![meeting, kind, revision],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    /// Newest saved artifact at or before `revision`, so a record correction never hides earlier output.
    pub fn get_latest_artifact(
        &self,
        meeting: &str,
        kind: &str,
        revision: u64,
    ) -> anyhow::Result<Option<Value>> {
        let raw: Option<String> = self
            .db()?
            .query_row(
                "SELECT body FROM artifacts WHERE meeting=?1 AND kind=?2 AND record_revision<=?3 ORDER BY record_revision DESC LIMIT 1",
                params![meeting, kind, revision],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn save_artifact(&self, mut a: Value) -> anyhow::Result<Value> {
        let meeting = id(&a, "meetingId")?;
        let kind = a["kind"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidKind"))?
            .to_owned();
        anyhow::ensure!(
            matches!(kind.as_str(), "synthesis" | "actions" | "notes"),
            "invalidKind"
        );
        let revision = a["recordRevision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?;
        let record = crate::meeting_records::RecordStore::open(&self.root)?.load(&meeting)?;
        anyhow::ensure!(record["revision"].as_u64() == Some(revision), "staleRecord");
        anyhow::ensure!(
            a["humanEdited"].is_boolean()
                && a["text"].as_str().is_some_and(|s| s.len() <= 1_000_000)
                && matches!(a["status"].as_str(), Some("pending" | "ready" | "failed")),
            "invalidArtifact"
        );
        strings(&a, "evidence", 1000)?;
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<String> = tx
            .query_row(
                "SELECT body FROM artifacts WHERE meeting=?1 AND kind=?2 AND record_revision=?3",
                params![meeting, kind, revision],
                |r| r.get(0),
            )
            .optional()?;
        let old: Option<Value> = old.map(|s| serde_json::from_str(&s)).transpose()?;
        let previous = old
            .as_ref()
            .and_then(|o| o["updatedAtMs"].as_u64())
            .unwrap_or(0);
        anyhow::ensure!(a["updatedAtMs"].as_u64() == Some(previous), "staleArtifact");
        if let Some(old) = old {
            anyhow::ensure!(
                old["humanEdited"] != true || a["humanEdited"] == true,
                "humanEditProtected"
            );
        }
        a["updatedAtMs"] = json!(now_ms().max(previous + 1));
        tx.execute("INSERT INTO artifacts(meeting,kind,record_revision,body) VALUES(?1,?2,?3,?4) ON CONFLICT(meeting,kind,record_revision) DO UPDATE SET body=excluded.body",params![meeting,kind,revision,a.to_string()])?;
        tx.commit()?;
        Ok(a)
    }
    pub fn apply_notes(&self, meeting: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(
            crate::meeting_records::valid_id(meeting),
            "invalidMeetingId"
        );
        let record = crate::meeting_records::RecordStore::open(&self.root)?.load(meeting)?;
        let workspace = record["workspaceId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("workspaceRequired"))?;
        if workspace == "default" {
            return Ok(json!({"applied":0,"skipped":0}));
        }
        let w = self
            .get_workspace(workspace)?
            .ok_or_else(|| anyhow::anyhow!("workspaceRequired"))?;
        let record_db = Connection::open_with_flags(
            crate::owned_paths::file(&self.root, &["recording.sqlite"], false)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let status: String =
            record_db.query_row("SELECT status FROM meetings WHERE id=?1", [meeting], |r| {
                r.get(0)
            })?;
        anyhow::ensure!(
            status == "stopped"
                && record["pendingSegments"].as_u64() == Some(0)
                && matches!(
                    record["translationStatus"].as_str(),
                    Some("complete" | "unavailable")
                ),
            "recordProcessing"
        );
        let snapshot =
            crate::owned_paths::file(&self.root, &["records", meeting, "record.json"], false)?;
        let finalized: Value = serde_json::from_slice(&fs::read(snapshot)?)?;
        anyhow::ensure!(
            finalized["revision"] == record["revision"],
            "recordProcessing"
        );
        // Render only immutable journal evidence; model/renderer text and edited files are not append inputs.
        // A passage that can no longer be translated is written in its source language, marked, never guessed.
        let note = english_record_note(&record, record["translationStatus"] == "unavailable")?;
        anyhow::ensure!(note.len() <= 1_000_000, "noteTooLarge");
        let marker = format!("<!-- live-interview:{meeting} -->");
        let content = format!(
            "\n\n{marker}\n## Meeting record\n\n{note}\n<!-- /live-interview:{meeting} -->\n"
        );
        let mut applied = 0;
        let mut skipped = 0;
        let roots = strings(&w, "roots", 20)?;
        let c = self.db()?;
        if let Some(target) = w["outputRoot"].as_str() {
            let (path, dev, ino): (String, u64, u64) = c.query_row(
                "SELECT path,dev,ino FROM output_grants WHERE workspace=?1",
                [workspace],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            anyhow::ensure!(target == path, "outputGrantChanged");
            if export_new(
                Path::new(target),
                dev,
                ino,
                &format!("{meeting}.md"),
                &content,
            )? {
                applied += 1;
            } else {
                skipped += 1;
            }
        }
        // Each granted target is revalidated by path: rename-saving editors replace the file,
        // so the grant follows the path inside the granted root, never a symlink or hard link.
        // One target that fails is reported and the others still receive the note.
        let mut failed = Vec::new();
        for target in strings(&w, "appendTargets", 100)? {
            let outcome = (|| -> anyhow::Result<bool> {
                let granted: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM grants WHERE workspace=?1 AND path=?2)",
                    params![workspace, target],
                    |r| r.get(0),
                )?;
                anyhow::ensure!(granted, "appendGrantMissing");
                let checked = canonical(&target, false).map_err(|e| {
                    if e.to_string() == "symlinkDenied" {
                        anyhow::anyhow!("appendTargetChanged")
                    } else {
                        anyhow::anyhow!("appendTargetUnavailable")
                    }
                })?;
                anyhow::ensure!(
                    checked.to_string_lossy() == target
                        && checked.extension().is_some_and(|e| e == "md")
                        && roots.iter().any(|r| checked.starts_with(r)),
                    "appendGrantOutsideWorkspace"
                );
                let applied_before: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM applied_notes WHERE workspace=?1 AND path=?2 AND meeting=?3)",
                    params![workspace, target, meeting],
                    |r| r.get(0),
                )?;
                if applied_before {
                    return Ok(false);
                }
                let (appended, dev, ino) = append_exact(&checked, &marker, &content)?;
                c.execute("INSERT OR IGNORE INTO applied_notes(workspace,path,dev,ino,meeting) VALUES(?1,?2,?3,?4,?5)",params![workspace,target,dev,ino,meeting])?;
                Ok(appended)
            })();
            match outcome {
                Ok(true) => applied += 1,
                Ok(false) => skipped += 1,
                Err(e) => failed.push(json!({"path":target,"code":error(e)})),
            }
        }
        Ok(json!({"applied":applied,"skipped":skipped,"failed":failed}))
    }
}
const TRANSLATION_UNAVAILABLE: &str = "Translation unavailable on this Mac";
fn english_record_note(record: &Value, untranslatable: bool) -> anyhow::Result<String> {
    let events = record["segments"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalidRecord"))?;
    let mut latest = std::collections::HashMap::<(String, String), &Value>::new();
    for event in events.iter().filter(|e| e["kind"] == "final") {
        let key = (
            event["lane"].as_str().unwrap_or("unknown").to_owned(),
            event["segmentId"].as_str().unwrap_or("").to_owned(),
        );
        if latest.get(&key).is_none_or(|old| {
            old["revision"].as_u64().unwrap_or(0) < event["revision"].as_u64().unwrap_or(0)
        }) {
            latest.insert(key, event);
        }
    }
    let mut sources = latest.into_values().collect::<Vec<_>>();
    sources.sort_by_key(|e| e["startMs"].as_u64().unwrap_or(0));
    let mut note = format!("# {}\n\n", record["purpose"].as_str().unwrap_or("Meeting"));
    let mut kept_in_source = false;
    for source in sources {
        let translation = if source["language"] == "en" {
            Some(source)
        } else {
            events.iter().find(|e| {
                e["kind"] == "translation"
                    && e["sourceSegmentId"] == source["segmentId"]
                    && e["revision"] == source["revision"]
                    && e["lane"] == source["lane"]
            })
        };
        let (text, marker) = match translation {
            Some(english) => (english, ""),
            None if untranslatable => {
                kept_in_source = true;
                (source, " · translation unavailable on this Mac")
            }
            None => anyhow::bail!("recordProcessing"),
        };
        note.push_str(&format!(
            "- [{}ms · {} · source {}{}] {}\n",
            source["startMs"],
            source["lane"].as_str().unwrap_or("unknown"),
            source["language"].as_str().unwrap_or("unknown"),
            marker,
            text["text"].as_str().unwrap_or("")
        ));
    }
    for source in record["importedSegments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["language"] == "en")
    {
        note.push_str(&format!(
            "- [imported · speaker unconfirmed] {}\n",
            source["text"].as_str().unwrap_or("")
        ));
    }
    if kept_in_source {
        note.push_str(&format!(
            "\n{TRANSLATION_UNAVAILABLE}: passages marked above are kept in their source language.\n"
        ));
    }
    note.push_str("\nOriginal-language evidence is retained in the app's source transcript.\n");
    Ok(note)
}
#[cfg(unix)]
fn open_directory(path: &Path) -> anyhow::Result<fs::File> {
    use std::{
        ffi::CString,
        os::unix::{
            ffi::OsStrExt,
            io::{AsRawFd, FromRawFd},
        },
    };
    anyhow::ensure!(path.is_absolute(), "absolutePathRequired");
    let root = CString::new("/")?;
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    anyhow::ensure!(fd >= 0, "appendOpenFailed");
    let mut parent = unsafe { fs::File::from_raw_fd(fd) };
    for component in path.components() {
        let part = match component {
            std::path::Component::Normal(p) => p,
            std::path::Component::RootDir => continue,
            _ => anyhow::bail!("invalidOwnedPath"),
        };
        let name = CString::new(part.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        anyhow::ensure!(fd >= 0, "appendParentChanged");
        parent = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok(parent)
}
#[cfg(unix)]
/// Appends `content` unless `marker` is already present. The path is opened component by
/// component without following symlinks; the opened file must be a regular, single-link file.
/// Returns whether it appended plus the file's identity for the applied-notes log.
fn append_exact(path: &Path, marker: &str, content: &str) -> anyhow::Result<(bool, u64, u64)> {
    use std::{
        ffi::CString,
        io::{Read, Seek, SeekFrom, Write},
        os::unix::{
            ffi::OsStrExt,
            fs::MetadataExt,
            io::{AsRawFd, FromRawFd},
        },
    };
    let parent = open_directory(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("invalidOwnedPath"))?,
    )?;
    let name = CString::new(
        path.file_name()
            .ok_or_else(|| anyhow::anyhow!("invalidOwnedPath"))?
            .as_bytes(),
    )?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    anyhow::ensure!(fd >= 0, "appendTargetChanged");
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    anyhow::ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0,
        "appendLockFailed"
    );
    let m = file.metadata()?;
    anyhow::ensure!(
        m.is_file() && m.nlink() == 1 && m.len() <= 16_000_000,
        "appendTargetChanged"
    );
    let mut old = String::new();
    file.read_to_string(&mut old)?;
    if old.contains(marker) {
        return Ok((false, m.dev(), m.ino()));
    }
    anyhow::ensure!(
        m.len() + content.len() as u64 <= 16_000_000,
        "appendTargetTooLarge"
    );
    file.seek(SeekFrom::End(0))?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok((true, m.dev(), m.ino()))
}
#[cfg(unix)]
fn export_new(root: &Path, dev: u64, ino: u64, name: &str, content: &str) -> anyhow::Result<bool> {
    use std::{
        ffi::CString,
        io::Write,
        os::unix::{
            fs::MetadataExt,
            io::{AsRawFd, FromRawFd},
        },
    };
    let parent = open_directory(root)?;
    let m = parent.metadata()?;
    anyhow::ensure!(m.dev() == dev && m.ino() == ino, "outputGrantChanged");
    let target = CString::new(name)?;
    let temporary = CString::new(format!(".live-interview-{}.tmp", uuid::Uuid::new_v4()))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    anyhow::ensure!(fd >= 0, "outputCreateFailed");
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    let result = (|| -> anyhow::Result<bool> {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        let result = unsafe {
            libc::linkat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
                0,
            )
        };
        if result == 0 {
            parent.sync_all()?;
            return Ok(true);
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            return Ok(false);
        }
        anyhow::bail!("outputCreateFailed")
    })();
    unsafe {
        libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
    };
    result
}
#[cfg(not(unix))]
fn export_new(_: &Path, _: u64, _: u64, _: &str, _: &str) -> anyhow::Result<bool> {
    anyhow::bail!("platformUnsupported")
}
#[cfg(not(unix))]
fn append_exact(_: &Path, _: &str, _: &str) -> anyhow::Result<(bool, u64, u64)> {
    anyhow::bail!("platformUnsupported")
}
fn store() -> Result<PublicStore, String> {
    if !crate::edition::is_public() {
        return Err("publicEditionRequired".into());
    }
    PublicStore::open(&crate::commands::data_root()).map_err(|_| "publicStoreUnavailable".into())
}
fn error(e: anyhow::Error) -> String {
    let code = e.to_string();
    if code.len() <= 80 && !code.contains('/') {
        code
    } else {
        "publicStoreFailed".into()
    }
}
#[tauri::command]
pub async fn public_list_workspaces() -> Result<Vec<Value>, String> {
    crate::commands::blocking("publicStoreFailed", || store()?.list_workspaces().map_err(error)).await
}
#[tauri::command]
pub async fn public_save_workspace(app: tauri::AppHandle, workspace: Value) -> Result<Value, String> {
    use tauri::Emitter;
    let workspace_id = workspace["id"].as_str().unwrap_or("").to_owned();
    let handle = tauri::async_runtime::handle();
    let sheet_app = app.clone();
    let result = crate::commands::blocking("publicStoreFailed", move || {
        store()?
            .save_workspace_confirmed(workspace, |request| {
                // This worker thread waits for the native sheet; the sheet itself runs on the main thread.
                handle
                    .block_on(crate::grants::confirm_request(&sheet_app, request.clone()))
                    .map_err(|code| anyhow::anyhow!(code))
            })
            .map_err(error)
    })
    .await;
    // Revoke cached context after every save attempt; native authority checks fail closed.
    let _ = app.emit(
        "workspace-context-changed",
        json!({"workspaceId":workspace_id}),
    );
    result
}
#[tauri::command]
pub async fn public_workspace_sources(workspace_id: String) -> Result<Vec<Value>, String> {
    crate::commands::blocking("publicStoreFailed", move || store()?.sources(&workspace_id).map_err(error)).await
}
#[tauri::command]
pub async fn public_list_meeting_plans() -> Result<Vec<Value>, String> {
    crate::commands::blocking("publicStoreFailed", || store()?.list_plans().map_err(error)).await
}
#[tauri::command]
pub async fn public_save_meeting_plan(plan: Value) -> Result<Value, String> {
    crate::commands::blocking("publicStoreFailed", move || store()?.save_plan(plan).map_err(error)).await
}
#[tauri::command]
pub async fn public_get_meeting_plan(id: String) -> Result<Option<Value>, String> {
    crate::commands::blocking("publicStoreFailed", move || store()?.get_plan(&id).map_err(error)).await
}
#[tauri::command]
pub async fn public_get_artifact(
    meeting_id: String,
    kind: String,
    record_revision: u64,
) -> Result<Option<Value>, String> {
    crate::commands::blocking("publicStoreFailed", move || {
        store()?
            .get_artifact(&meeting_id, &kind, record_revision)
            .map_err(error)
    })
    .await
}
#[tauri::command]
pub async fn public_get_latest_artifact(
    meeting_id: String,
    kind: String,
    record_revision: u64,
) -> Result<Option<Value>, String> {
    crate::commands::blocking("publicStoreFailed", move || {
        store()?
            .get_latest_artifact(&meeting_id, &kind, record_revision)
            .map_err(error)
    })
    .await
}
#[tauri::command]
pub async fn public_save_artifact(artifact: Value) -> Result<Value, String> {
    crate::commands::blocking("publicStoreFailed", move || store()?.save_artifact(artifact).map_err(error)).await
}
#[tauri::command]
pub async fn public_apply_granted_notes(meeting_id: String) -> Result<Value, String> {
    crate::commands::blocking("publicStoreFailed", move || store()?.apply_notes(&meeting_id).map_err(error)).await
}
