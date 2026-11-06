//! Sole writer for reviewed user-file changes and registered internal notes.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
pub struct ActionStore {
    root: PathBuf,
}
/// An approval token is usable once and only for this long after it was minted.
pub const APPROVAL_TTL_MS: u64 = 5 * 60 * 1000;
/// A file or folder chosen in the native picker authorises proposals for this long.
pub const PICKED_TARGET_TTL_MS: u64 = 60 * 60 * 1000;
/// Finished proposals (applied, failed, declined) are kept this long, then removed.
pub const PROPOSAL_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// A finished proposal keeps at most this much of its before/after text.
pub const FINISHED_TEXT_LIMIT: usize = 64 * 1024;
fn now_ms() -> u64 {
    crate::public_domain::now_ms()
}
fn truncated(text: &str) -> String {
    if text.len() <= FINISHED_TEXT_LIMIT {
        return text.to_owned();
    }
    let mut end = FINISHED_TEXT_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}
/// Creates `path`, which must not exist, and writes `bytes` with `write`. If writing fails, the file
/// this call created is removed, so a failure leaves nothing behind and a retry can create it again.
/// A file that already existed is never touched: `create_new` refuses it before anything is written.
fn create_new_with(
    path: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    if let Err(error) = write(&mut file, bytes) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}
fn create_new(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    create_new_with(path, bytes, |file, bytes| {
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()
    })
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn version(path: &Path) -> anyhow::Result<String> {
    if path.exists() {
        anyhow::ensure!(
            !fs::symlink_metadata(path)?.file_type().is_symlink(),
            "symlinkTarget"
        );
        let canonical = path.canonicalize()?;
        anyhow::ensure!(canonical == path, "targetIdentityChanged");
        let bytes = fs::read(path)?;
        anyhow::ensure!(bytes.len() < 8_000_000, "targetTooLarge");
        Ok(digest(&bytes))
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("missingParent"))?
            .canonicalize()?;
        anyhow::ensure!(parent == path.parent().unwrap(), "targetIdentityChanged");
        Ok(format!("missing:{}", parent.display()))
    }
}
impl ActionStore {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(root)?;
        let s = Self {
            root: root.canonicalize()?,
        };
        crate::schema::migrate(&mut s.db()?, crate::schema::ACTIONS)?;
        Ok(s)
    }
    fn db(&self) -> anyhow::Result<Connection> {
        let c = Connection::open(crate::owned_paths::file(
            &self.root,
            &["actions.sqlite"],
            true,
        )?)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(c)
    }
    pub fn propose(&self, path: &Path, operation: &str, content: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(
            matches!(operation, "append" | "rewrite" | "linkRecord"),
            "unsupportedOperation"
        );
        anyhow::ensure!(content.len() < 1_000_000, "proposalTooLarge");
        let path = if path.exists() {
            anyhow::ensure!(
                !fs::symlink_metadata(path)?.file_type().is_symlink(),
                "symlinkTarget"
            );
            path.canonicalize()?
        } else {
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("missingParent"))?
                .canonicalize()?
                .join(
                    path.file_name()
                        .ok_or_else(|| anyhow::anyhow!("missingFilename"))?,
                )
        };
        self.ensure_target_allowed(&path, operation)?;
        let before = if path.exists() {
            anyhow::ensure!(operation != "linkRecord", "existingTarget");
            fs::read_to_string(&path)?
        } else {
            String::new()
        };
        anyhow::ensure!(
            matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("md" | "txt" | "ics")
            ),
            "unsupportedDocumentApply"
        );
        let after = if operation == "append" {
            format!("{before}{content}")
        } else {
            content.to_string()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let body = json!({"id":id,"targetId":path.to_string_lossy(),"targetPath":path.to_string_lossy(),"targetVersion":version(&path)?,"operation":operation,"before":before,"after":after,"evidence":[],"inferred":true,"status":"proposed"});
        self.insert_proposal(&body)?;
        Ok(body)
    }
    fn insert_proposal(&self, body: &Value) -> anyhow::Result<()> {
        let c = self.db()?;
        Self::prune(&c, now_ms())?;
        c.execute(
            "INSERT INTO proposals(id,body,status,created_ms) VALUES(?1,?2,'proposed',?3)",
            params![body["id"].as_str(), body.to_string(), now_ms()],
        )?;
        Ok(())
    }
    /// Removes finished proposals past the retention window, and abandoned ones (never approved,
    /// or interrupted while applying) after the same time.
    fn prune(c: &Connection, now: u64) -> anyhow::Result<()> {
        c.execute(
            "DELETE FROM proposals WHERE created_ms<?1",
            [now.saturating_sub(PROPOSAL_RETENTION_MS)],
        )?;
        Ok(())
    }
    /// Records a terminal state and keeps only a bounded excerpt of the before/after text, which
    /// is no longer needed to apply anything.
    fn finish(c: &Connection, id: &str, status: &str) -> anyhow::Result<()> {
        let body: Option<String> = c
            .query_row("SELECT body FROM proposals WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        let Some(body) = body else { return Ok(()) };
        let mut p: Value = serde_json::from_str(&body)?;
        for key in ["before", "after"] {
            if let Some(text) = p[key].as_str() {
                p[key] = json!(truncated(text));
            }
        }
        p["status"] = json!(status);
        c.execute(
            "UPDATE proposals SET status=?2,approval=NULL,body=?3 WHERE id=?1",
            params![id, status, p.to_string()],
        )?;
        Ok(())
    }
    /// The native file picker recorded this choice; proposals may target it for a while.
    pub fn record_picked(&self, path: &Path, kind: &str) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(
            matches!(kind, "file" | "folder" | "grantRead" | "grantOutput" | "grantAppend" | "grantImport"),
            "invalidPickedTarget"
        );
        let path = if matches!(kind, "folder" | "grantRead" | "grantOutput") {
            path.canonicalize()?
        } else if path.exists() {
            path.canonicalize()?
        } else {
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("missingParent"))?
                .canonicalize()?
                .join(path.file_name().ok_or_else(|| anyhow::anyhow!("missingFilename"))?)
        };
        self.db()?.execute(
            "INSERT INTO picked_targets(path,kind,picked_ms) VALUES(?1,?2,?3) ON CONFLICT(path,kind) DO UPDATE SET picked_ms=excluded.picked_ms",
            params![path.to_string_lossy(), kind, now_ms()],
        )?;
        Ok(path)
    }
    /// Uses up a grant pick of `path` recorded as `kind` within the last `ttl_ms`: true when there was one, and
    /// it is gone afterwards. Grant picks use their own kinds, so choosing a folder to index never authorises a
    /// write proposal, and each pick covers only the grant it was made for, once.
    pub fn consume_picked(&self, path: &Path, kind: &str, ttl_ms: u64) -> anyhow::Result<bool> {
        anyhow::ensure!(kind.starts_with("grant"), "invalidPickedTarget");
        let since = now_ms().saturating_sub(ttl_ms);
        let used = self.db()?.execute(
            "DELETE FROM picked_targets WHERE path=?1 AND kind=?2 AND picked_ms>=?3",
            params![path.to_string_lossy(), kind, since],
        )?;
        Ok(used > 0)
    }
    /// The operation and target of a proposal still awaiting review, for the approval sheet.
    pub fn pending_target(&self, id: &str) -> anyhow::Result<Option<(String, String, String)>> {
        let body: Option<String> = self
            .db()?
            .query_row("SELECT body FROM proposals WHERE id=?1 AND status='proposed'", [id], |r| r.get(0))
            .optional()?;
        let Some(body) = body else { return Ok(None) };
        let p: Value = serde_json::from_str(&body)?;
        let text = |key: &str| p[key].as_str().unwrap_or("").to_owned();
        Ok(Some((text("operation"), text("targetPath"), text("targetVersion"))))
    }
    /// A proposal may only name a file inside a granted workspace root or output folder, or a
    /// file (or, for a record link, a folder) the person chose in the native picker recently.
    /// Renderer-supplied paths alone never authorise a write.
    fn ensure_target_allowed(&self, path: &Path, operation: &str) -> anyhow::Result<()> {
        let c = self.db()?;
        let since = now_ms().saturating_sub(PICKED_TARGET_TTL_MS);
        let picked = |candidate: &Path, kind: &str| -> anyhow::Result<bool> {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM picked_targets WHERE path=?1 AND kind=?2 AND picked_ms>=?3)",
                params![candidate.to_string_lossy(), kind, since],
                |r| r.get(0),
            )?)
        };
        if picked(path, "file")? {
            return Ok(());
        }
        let parent = path.parent().ok_or_else(|| anyhow::anyhow!("missingParent"))?;
        if operation == "linkRecord" && picked(parent, "folder")? {
            return Ok(());
        }
        anyhow::ensure!(
            self.granted_roots()?.iter().any(|root| path.starts_with(root)),
            "targetNotGranted"
        );
        Ok(())
    }
    fn granted_roots(&self) -> anyhow::Result<Vec<PathBuf>> {
        let context = self.root.join("context.sqlite");
        if !context.exists() {
            return Ok(vec![]);
        }
        let c = Connection::open_with_flags(
            crate::owned_paths::file(&self.root, &["context.sqlite"], false)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        let table = |name: &str| -> rusqlite::Result<bool> {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [name],
                |r| r.get(0),
            )
        };
        let mut roots = Vec::new();
        if table("public_workspaces")? {
            let mut q = c.prepare("SELECT body FROM public_workspaces")?;
            for body in q.query_map([], |r| r.get::<_, String>(0))? {
                let w: Value = serde_json::from_str(&body?)?;
                roots.extend(w["roots"].as_array().into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from));
                roots.extend(w["outputRoot"].as_str().map(PathBuf::from));
            }
        }
        if table("workspace_roots")? {
            let mut q = c.prepare("SELECT root FROM workspace_roots UNION SELECT root FROM workspaces")?;
            for root in q.query_map([], |r| r.get::<_, String>(0))? {
                roots.push(PathBuf::from(root?));
            }
        }
        Ok(roots.into_iter().filter(|r| r.is_absolute()).collect())
    }
    /// Mints a one-use approval token for a proposal still awaiting review. A repeated approval (a
    /// double click on Apply) returns the outstanding unexpired token rather than a second one, so
    /// both clicks apply under the same token and only one can write. A proposal that was already
    /// applied, or is being applied, fails with `alreadyApplied` / `applyInProgress`, which a caller
    /// may treat as the earlier click's success.
    pub fn approve(&self, id: &str) -> anyhow::Result<String> {
        let now = now_ms();
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row: Option<(String, Option<String>, Option<i64>)> = tx
            .query_row(
                "SELECT status,approval,approved_ms FROM proposals WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((status, approval, approved_ms)) = row else {
            anyhow::bail!("notReviewable")
        };
        match status.as_str() {
            "proposed" => {}
            "applied" => anyhow::bail!("alreadyApplied"),
            "applying" => anyhow::bail!("applyInProgress"),
            _ => anyhow::bail!("notReviewable"),
        }
        if let (Some(approval), Some(approved_ms)) = (approval, approved_ms) {
            if approved_ms >= now.saturating_sub(APPROVAL_TTL_MS) as i64 {
                return Ok(approval);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE proposals SET approval=?2,approved_ms=?3 WHERE id=?1 AND status='proposed'",
            params![id, token, now],
        )?;
        tx.commit()?;
        Ok(token)
    }
    pub fn decline(&self, id: &str) -> anyhow::Result<()> {
        let c = self.db()?;
        let open: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM proposals WHERE id=?1 AND status='proposed')",
            [id],
            |r| r.get(0),
        )?;
        if open {
            Self::finish(&c, id, "declined")?;
        }
        Ok(())
    }
    /// Consumes an unexpired approval token and marks the proposal `applying`. The token is gone
    /// whatever happens next, so it can never be replayed. A replay of the token while that apply is
    /// still running (a double click on a calendar change, which awaits the helper) fails with
    /// `applyInProgress`, which the caller treats as the earlier click.
    fn take_approved(&self, id: &str, approval: &str, operations: &[&str]) -> anyhow::Result<Value> {
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let text: Option<String> = tx
            .query_row(
                "SELECT body FROM proposals WHERE id=?1 AND approval=?2 AND status='proposed' AND approved_ms>=?3",
                params![id, approval, now_ms().saturating_sub(APPROVAL_TTL_MS)],
                |r| r.get(0),
            )
            .optional()?;
        let Some(text) = text else {
            let applying: Option<String> = tx
                .query_row(
                    "SELECT body FROM proposals WHERE id=?1 AND status='applying'",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let same_token = applying
                .and_then(|b| serde_json::from_str::<Value>(&b).ok())
                .is_some_and(|p| p["approvalDigest"].as_str() == Some(digest(approval.as_bytes()).as_str()));
            anyhow::ensure!(!same_token, "applyInProgress");
            anyhow::bail!("approvalRequired")
        };
        let mut p: Value = serde_json::from_str(&text)?;
        anyhow::ensure!(
            p["operation"].as_str().is_some_and(|o| operations.contains(&o)),
            "unsupportedOperation"
        );
        // Only a digest of the used token is kept, so a replay of it can be recognised (and answered
        // without writing) but the token itself can never be used again.
        p["approvalDigest"] = json!(digest(approval.as_bytes()));
        tx.execute(
            "UPDATE proposals SET status='applying',approval=NULL,body=?2 WHERE id=?1",
            params![id, p.to_string()],
        )?;
        tx.commit()?;
        Ok(p)
    }
    /// Keeps what an apply returned, so a replay of its token can answer with the same result.
    pub fn record_applied_result(&self, id: &str, result: &Value) -> anyhow::Result<()> {
        let c = self.db()?;
        let body: Option<String> = c
            .query_row("SELECT body FROM proposals WHERE id=?1 AND status='applied'", [id], |r| r.get(0))
            .optional()?;
        let Some(body) = body else { return Ok(()) };
        let mut p: Value = serde_json::from_str(&body)?;
        p["appliedResult"] = result.clone();
        c.execute("UPDATE proposals SET body=?2 WHERE id=?1", params![id, p.to_string()])?;
        Ok(())
    }
    /// The earlier result when `approval` is the token an applied proposal was applied with. Nothing
    /// is written again.
    pub fn already_applied(&self, id: &str, approval: &str) -> anyhow::Result<Option<Value>> {
        let body: Option<String> = self
            .db()?
            .query_row(
                "SELECT body FROM proposals WHERE id=?1 AND status='applied'",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(body) = body else { return Ok(None) };
        let p: Value = serde_json::from_str(&body)?;
        if p["approvalDigest"].as_str() != Some(digest(approval.as_bytes()).as_str()) {
            return Ok(None);
        }
        let mut result = match &p["appliedResult"] {
            Value::Object(_) => p["appliedResult"].clone(),
            _ => json!({"proposalId":id,"applied":true,"path":p["targetPath"]}),
        };
        result["alreadyApplied"] = json!(true);
        Ok(Some(result))
    }
    /// A file apply that failed leaves the target as it was: a rewrite or append is an atomic
    /// replace, a new file that could not be fully written is removed again by `create_new_with`,
    /// and a changed target is refused before writing. So the proposal returns to review instead of
    /// ending: the person can approve it again, and the target version check still guards every
    /// attempt.
    fn reopen_after_failure(&self, id: &str, error: &anyhow::Error) -> anyhow::Result<()> {
        let c = self.db()?;
        let body: Option<String> = c
            .query_row(
                "SELECT body FROM proposals WHERE id=?1 AND status='applying'",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(body) = body else { return Ok(()) };
        let mut p: Value = serde_json::from_str(&body)?;
        p["status"] = json!("proposed");
        p["lastError"] = json!(error.to_string());
        c.execute(
            "UPDATE proposals SET status='proposed',approval=NULL,approved_ms=NULL,body=?2 WHERE id=?1 AND status='applying'",
            params![id, p.to_string()],
        )?;
        Ok(())
    }
    /// Records how an approved proposal ended once the writer (or calendar helper) returned.
    pub fn finish_applying(&self, id: &str, applied: bool) -> anyhow::Result<()> {
        let c = self.db()?;
        let applying: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM proposals WHERE id=?1 AND status='applying')",
            [id],
            |r| r.get(0),
        )?;
        if applying {
            Self::finish(&c, id, if applied { "applied" } else { "failed" })?;
        }
        Ok(())
    }
    pub fn apply(&self, id: &str, approval: &str) -> anyhow::Result<Value> {
        if let Some(earlier) = self.already_applied(id, approval)? {
            return Ok(earlier);
        }
        // Nothing is reopened before the write, so a refused token (expired, used, declined or ended proposal)
        // is `approvalRequired`, never the retryable write failure.
        let p = self
            .take_approved(id, approval, &["append", "rewrite", "linkRecord"])
            .map_err(|error| match error.to_string().as_str() {
                "applyInProgress" => error,
                _ => anyhow::anyhow!("approvalRequired"),
            })?;
        match self.write_approved(&p) {
            Ok(path) => {
                self.finish_applying(id, true)?;
                Ok(json!({"proposalId":id,"applied":true,"path":path.to_string_lossy()}))
            }
            Err(error) => {
                // If even this fails the proposal stays `applying`, as after an interruption.
                let _ = self.reopen_after_failure(id, &error);
                Err(error)
            }
        }
    }
    fn write_approved(&self, p: &Value) -> anyhow::Result<PathBuf> {
        let path = PathBuf::from(
            p["targetPath"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalidProposal"))?,
        );
        anyhow::ensure!(
            version(&path)? == p["targetVersion"].as_str().unwrap_or(""),
            "targetChanged"
        );
        let after = p["after"].as_str().unwrap_or("");
        if p["operation"] == "linkRecord" {
            let target = Path::new(after).canonicalize()?;
            let records = self.root.join("records").canonicalize()?;
            anyhow::ensure!(
                target.starts_with(records) && target.is_file(),
                "notAppRecord"
            );
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &path)?;
        } else if path.exists() {
            crate::meeting_records::atomic_write(&path, after.as_bytes())?
        } else {
            create_new(&path, after.as_bytes())?
        }
        Ok(path)
    }
    pub fn save_internal_note(&self, id: &str, text: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(
            crate::meeting_records::valid_id(id) && text.len() < 1_000_000,
            "invalidInternalNote"
        );
        let notes = crate::owned_paths::directory(&self.root, &["notes"], true)?;
        anyhow::ensure!(
            !fs::symlink_metadata(&notes)?.file_type().is_symlink()
                && notes.canonicalize()? == notes,
            "unownedNoteDirectory"
        );
        let path = notes.join(format!("{id}.md"));
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT path,revision,digest FROM internal_notes WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .ok();
        let wanted = digest(text.as_bytes());
        let missing = matches!(fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        let register = |tx: rusqlite::Transaction<'_>, revision: i64| -> anyhow::Result<()> {
            tx.execute("INSERT INTO internal_notes(id,path,revision,digest) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest",params![id,path.to_string_lossy(),revision,wanted])?;
            tx.commit()?;
            Ok(())
        };
        let changed = json!({"id":id,"path":path.to_string_lossy(),"changed":true});
        let with_revision = |mut v: Value, revision: i64| {
            v["expectedRevision"] = json!(revision);
            v
        };
        if let Some((stored, revision, hash)) = existing {
            anyhow::ensure!(stored == path.to_string_lossy(), "internalNoteChanged");
            if missing {
                // Registered but never written (or removed): creating it cannot overwrite anything.
                let revision = if hash == wanted { revision } else { revision + 1 };
                register(tx, revision)?;
                create_new(&path, text.as_bytes())?;
                return Ok(with_revision(changed, revision));
            }
            anyhow::ensure!(version(&path)? == hash, "internalNoteChanged");
            if hash == wanted {
                return Ok(
                    json!({"id":id,"path":stored,"expectedRevision":revision,"changed":false}),
                );
            }
            crate::meeting_records::atomic_write(&path, text.as_bytes())?;
            register(tx, revision + 1)?;
            return Ok(with_revision(changed, revision + 1));
        }
        if !missing {
            // A file without a row: an earlier save created it and stopped before registering.
            // Adopt it only when it holds exactly this text; anything else may be the person's.
            anyhow::ensure!(version(&path)? == wanted, "internalNoteChanged");
            register(tx, 1)?;
            return Ok(with_revision(changed, 1));
        }
        // Register before creating, so an interruption leaves a row whose file is either missing
        // or holds exactly this text; both cases recover on the next save.
        register(tx, 1)?;
        create_new(&path, text.as_bytes())?;
        Ok(with_revision(changed, 1))
    }
}
#[derive(Default)]
pub struct ActionState {
    lock: std::sync::Arc<Mutex<()>>,
}
/// Runs one executor step off the main thread, one at a time, as the lock always did.
async fn serialized<T: Send + 'static>(
    state: &ActionState,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let lock = state.lock.clone();
    crate::commands::blocking("actionBusy", move || {
        let _guard = lock.lock().map_err(|_| "actionBusy")?;
        work()
    })
    .await
}
#[tauri::command]
pub async fn propose_action(
    state: State<'_, ActionState>,
    target_path: String,
    operation: String,
    content: String,
) -> Result<Value, String> {
    serialized(&state, move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.propose(Path::new(&target_path), &operation, &content))
            .map_err(|_| "proposalFailed".into())
    })
    .await
}
/// Opens the native file picker for a reviewed write and records the choice, so a later
/// proposal for exactly that file (or, for a record link, inside that folder) is accepted.
/// It is the same picker the person already used; the renderer only receives the path.
#[tauri::command]
pub async fn pick_action_target(
    app: tauri::AppHandle,
    kind: String,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let send = move |path: Option<tauri_plugin_dialog::FilePath>| {
        let _ = tx.send(path);
    };
    let dialog = app.dialog().file();
    match kind.as_str() {
        "appendNote" => dialog
            .set_title("Choose an existing Markdown note to propose an append")
            .add_filter("Markdown", &["md", "txt"])
            .pick_file(send),
        "recordFolder" => dialog
            .set_title("Choose the transcript folder for a reviewed record link")
            .pick_folder(send),
        "icsFile" => dialog
            .add_filter("Calendar file", &["ics"])
            .set_file_name(default_name.unwrap_or_else(|| "meeting.ics".into()))
            .save_file(send),
        _ => return Err("invalidPickedTarget".into()),
    }
    let Some(picked) = rx.await.map_err(|_| "pickFailed")? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "pickFailed")?;
    let recorded = ActionStore::open(&crate::commands::data_root())
        .and_then(|s| s.record_picked(&path, if kind == "recordFolder" { "folder" } else { "file" }))
        .map_err(|_| "pickFailed")?;
    Ok(Some(recorded.to_string_lossy().into_owned()))
}
#[tauri::command]
pub async fn approve_action(
    app: tauri::AppHandle,
    state: State<'_, ActionState>,
    proposal_id: String,
) -> Result<String, String> {
    // A rewrite replaces the person's existing file, so the approval needs a native confirmation naming it.
    // Appends, new files, record links and calendar changes keep their existing review.
    let id = proposal_id.clone();
    let pending = serialized(&state, move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.pending_target(&id))
            .map_err(|_| "approvalFailed".to_owned())
    })
    .await?;
    if let Some((operation, path, version)) = pending {
        if crate::grants::approval_needs_confirmation(&operation, &version) {
            crate::grants::confirm(
                &app,
                "Replace this file?",
                format!("The approved text will replace the current contents of:\n\n{path}\n\nThe rest of your files are not changed."),
                "Replace",
            )
            .await?;
        }
    }
    serialized(&state, move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.approve(&proposal_id))
            .map_err(|e| match e.to_string().as_str() {
                // The earlier click applied (or is applying) this proposal; the caller treats it as done.
                code @ ("alreadyApplied" | "applyInProgress") => code.to_owned(),
                _ => "approvalFailed".into(),
            })
    })
    .await
}
#[tauri::command]
pub async fn apply_action(
    state: State<'_, ActionState>,
    proposal_id: String,
    approval: String,
) -> Result<Value, String> {
    serialized(&state, move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.apply(&proposal_id, &approval))
            .map_err(|error| apply_error_code(&error))
    })
    .await
}
/// The code `apply_action` returns. Only a failed write reopens the proposal, so only it is the retryable
/// `applyFailedOrTargetChanged`; a refused approval asks for a fresh proposal, and `applyInProgress` is the
/// earlier click still applying.
pub fn apply_error_code(error: &anyhow::Error) -> String {
    match error.to_string().as_str() {
        code @ ("approvalRequired" | "applyInProgress") => code.to_owned(),
        _ => "applyFailedOrTargetChanged".into(),
    }
}
#[tauri::command]
pub async fn decline_action(state: State<'_, ActionState>, proposal_id: String) -> Result<(), String> {
    serialized(&state, move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.decline(&proposal_id))
            .map_err(|_| "declineFailed".into())
    })
    .await
}
#[tauri::command]
pub async fn save_internal_note(
    state: State<'_, ActionState>,
    meeting_id: String,
    text: String,
    kind: Option<String>,
) -> Result<Value, String> {
    serialized(&state, move || {
        crate::meeting_records::RecordStore::open(&crate::commands::data_root())
            .and_then(|s| s.load(&meeting_id))
            .map_err(|_| "unknownMeeting")?;
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| {
                s.save_internal_note(
                    &format!(
                        "{}-{}",
                        meeting_id,
                        match kind.as_deref() {
                            Some("pins") => "pins",
                            Some("pilot") => "pilot",
                            _ => "actions",
                        }
                    ),
                    &text,
                )
            })
            .map_err(|_| "internalNoteRequiresReview".into())
    })
    .await
}

impl ActionStore {
    pub fn store_calendar(&self, proposal: &Value) -> anyhow::Result<()> {
        self.insert_proposal(proposal)
    }
    pub fn take_approved_calendar(&self, id: &str, approval: &str) -> anyhow::Result<Value> {
        self.take_approved(id, approval, &["calendarAdd", "calendarEdit"])
    }
}

impl ActionStore {
    pub fn read_internal_note(&self, id: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(crate::meeting_records::valid_id(id), "invalidInternalNote");
        let (path, revision, expected): (String, i64, String) = self.db()?.query_row(
            "SELECT path,revision,digest FROM internal_notes WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let owned = self.root.join("notes").join(format!("{id}.md"));
        anyhow::ensure!(
            owned.to_string_lossy() == path && version(&owned)? == expected,
            "internalNoteChanged"
        );
        Ok(json!({"text":fs::read_to_string(owned)?,"revision":revision}))
    }
}
#[tauri::command]
pub async fn read_internal_note(meeting_id: String, kind: String) -> Result<Value, String> {
    if !matches!(kind.as_str(), "pins" | "pilot" | "actions") {
        return Err("unknownNoteKind".into());
    }
    crate::commands::blocking("noteUnavailable", move || {
        ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.read_internal_note(&format!("{meeting_id}-{kind}")))
            .map_err(|_| "noteUnavailable".into())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("live-create-new-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn a_failed_write_removes_the_file_this_call_created() {
        let d = dir();
        let path = d.join("new.ics");
        let failed = create_new_with(&path, b"BEGIN:VCALENDAR", |file, bytes| {
            use std::io::Write;
            file.write_all(&bytes[..5])?;
            Err(std::io::Error::other("disk full"))
        });
        assert!(failed.is_err());
        assert!(!path.exists(), "no partial file is left behind, so a retry can create it");
        create_new_with(&path, b"BEGIN:VCALENDAR", |file, bytes| {
            use std::io::Write;
            file.write_all(bytes)?;
            file.sync_all()
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "BEGIN:VCALENDAR");
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn a_file_that_already_exists_is_never_removed() {
        let d = dir();
        let path = d.join("existing.md");
        fs::write(&path, "The user's file").unwrap();
        assert!(create_new_with(&path, b"x", |_, _| Ok(())).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "The user's file");
        fs::remove_dir_all(d).unwrap();
    }
}
