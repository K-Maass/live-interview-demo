use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::State;
pub struct SourceIndex {
    root: PathBuf,
}
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
impl SourceIndex {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(root)?;
        let s = Self { root: root.into() };
        crate::schema::migrate(&mut s.db()?, crate::schema::CONTEXT)?;
        Ok(s)
    }
    fn db(&self) -> anyhow::Result<Connection> {
        let c = Connection::open(crate::owned_paths::file(
            &self.root,
            &["context.sqlite"],
            true,
        )?)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(c)
    }
    pub fn connect(&self, id: &str, root: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(crate::meeting_records::valid_id(id), "invalidWorkspace");
        let registered: bool = self.db()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM public_workspace_registration WHERE id=?1)",
            [id],
            |r| r.get(0),
        )?;
        anyhow::ensure!(!registered, "publicWorkspaceUpdateRequired");
        let canonical = root.canonicalize()?;
        anyhow::ensure!(canonical.is_dir(), "notDirectory");
        self.db()?.execute("INSERT INTO workspaces(id,root) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET root=excluded.root",params![id,canonical.to_string_lossy()])?;
        self.db()?
            .execute("DELETE FROM workspace_roots WHERE workspace=?1", [id])?;
        self.db()?
            .execute("DELETE FROM workspace_scope WHERE workspace=?1", [id])?;
        Ok(())
    }
    pub fn connect_public(
        &self,
        id: &str,
        roots: &[String],
        shared: &[String],
    ) -> anyhow::Result<()> {
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::connect_public_transaction(&tx, id, roots, shared)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn connect_public_transaction(
        tx: &rusqlite::Transaction<'_>,
        id: &str,
        roots: &[String],
        shared: &[String],
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            crate::meeting_records::valid_id(id) && !roots.is_empty(),
            "invalidWorkspace"
        );
        tx.execute(
            "INSERT OR IGNORE INTO public_workspace_registration(id) VALUES(?1)",
            [id],
        )?;
        tx.execute("INSERT INTO workspaces(id,root) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET root=excluded.root",params![id,roots[0]])?;
        tx.execute("DELETE FROM workspace_roots WHERE workspace=?1", [id])?;
        tx.execute("DELETE FROM workspace_scope WHERE workspace=?1", [id])?;
        for root in roots {
            tx.execute(
                "INSERT INTO workspace_roots(workspace,root) VALUES(?1,?2)",
                params![id, root],
            )?;
        }
        for library in shared {
            tx.execute(
                "INSERT INTO workspace_scope(workspace,shared) VALUES(?1,?2)",
                params![id, library],
            )?;
        }
        // Revoke filesystem evidence immediately when roots change, before any later refresh.
        let obsolete = {
            let mut q = tx.prepare("SELECT id,path FROM sources WHERE workspace=?1")?;
            let rows = q
                .query_map([id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .filter(|(_, path)| {
                    Path::new(path).is_absolute()
                        && !roots.iter().any(|root| Path::new(path).starts_with(root))
                })
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        };
        for source in obsolete {
            Self::delete_source(tx, &source)?;
        }
        Ok(())
    }
    fn assert_workspace_consistent(c: &Connection, workspace: &str) -> anyhow::Result<()> {
        let registered: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM public_workspace_registration WHERE id=?1)",
            [workspace],
            |r| r.get(0),
        )?;
        if !registered {
            return Ok(());
        }
        let has_authority:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_workspaces')",[],|r|r.get(0))?;
        anyhow::ensure!(has_authority, "workspaceAuthorityMismatch");
        let raw: Option<String> = c
            .query_row(
                "SELECT body FROM public_workspaces WHERE id=?1",
                [workspace],
                |r| r.get(0),
            )
            .optional()?;
        let raw = raw.ok_or_else(|| anyhow::anyhow!("workspaceAuthorityMismatch"))?;
        let w: Value = serde_json::from_str(&raw)?;
        let primary: String = c.query_row(
            "SELECT root FROM workspaces WHERE id=?1",
            [workspace],
            |r| r.get(0),
        )?;
        let mut roots = {
            let mut q =
                c.prepare("SELECT root FROM workspace_roots WHERE workspace=?1 ORDER BY root")?;
            let rows = q
                .query_map([workspace], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut shared = {
            let mut q =
                c.prepare("SELECT shared FROM workspace_scope WHERE workspace=?1 ORDER BY shared")?;
            let rows = q
                .query_map([workspace], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut permitted_roots = w["roots"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("workspaceAuthorityMismatch"))?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("workspaceAuthorityMismatch"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut permitted_shared = w["sharedLibraryIds"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("workspaceAuthorityMismatch"))?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("workspaceAuthorityMismatch"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        anyhow::ensure!(
            w["id"] == workspace
                && w["root"] == primary
                && permitted_roots.first() == Some(&primary),
            "workspaceAuthorityMismatch"
        );
        roots.sort();
        shared.sort();
        permitted_roots.sort();
        permitted_shared.sort();
        anyhow::ensure!(
            roots == permitted_roots && shared == permitted_shared,
            "workspaceAuthorityMismatch"
        );
        Ok(())
    }
    fn delete_source(c: &Connection, id: &str) -> anyhow::Result<bool> {
        c.execute("INSERT INTO source_revisions(id,revision) SELECT id,revision FROM sources WHERE id=?1 ON CONFLICT(id) DO UPDATE SET revision=MAX(source_revisions.revision,excluded.revision)",[id])?;
        let changed = c.execute("DELETE FROM sources WHERE id=?1", [id])? > 0;
        c.execute("DELETE FROM source_fts WHERE source_id=?1", [id])?;
        c.execute("DELETE FROM source_vectors WHERE source_id=?1", [id])?;
        c.execute("DELETE FROM source_file_metadata WHERE id=?1", [id])?;
        c.execute("DELETE FROM unreadable_sources WHERE id=?1", [id])?;
        Ok(changed)
    }
    fn next_source_revision(c: &Connection, id: &str) -> anyhow::Result<i64> {
        let revision: Option<i64> = c
            .query_row(
                "SELECT revision FROM source_revisions WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let next = revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))?;
        c.execute("INSERT INTO source_revisions(id,revision) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",params![id,next])?;
        Ok(next)
    }
    pub fn scope_ids(&self, workspace: &str) -> anyhow::Result<Vec<String>> {
        let c = self.db()?;
        Self::assert_workspace_consistent(&c, workspace)?;
        let mut q =
            c.prepare("SELECT shared FROM workspace_scope WHERE workspace=?1 ORDER BY shared")?;
        let mut ids = vec![workspace.to_owned()];
        ids.extend(
            q.query_map([workspace], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
        for id in &ids {
            Self::assert_workspace_consistent(&c, id)?;
        }
        Ok(ids)
    }
    pub fn sources(&self, workspace: &str) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut result = vec![];
        for scope in self.scope_ids(workspace)? {
            let mut q =
                c.prepare("SELECT id,path,revision FROM sources WHERE workspace=?1 ORDER BY path")?;
            result.extend(q.query_map([&scope],|r|{let path:String=r.get(1)?;Ok(json!({"sourceId":r.get::<_,String>(0)?,"workspaceId":scope,"title":Path::new(&path).file_name().unwrap_or_default().to_string_lossy(),"path":path,"revision":r.get::<_,i64>(2)?,"status":"indexed"}))})?.collect::<Result<Vec<_>,_>>()?);
        }
        Ok(result)
    }
    pub fn list(&self) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut q = c.prepare("SELECT id,root FROM workspaces")?;
        let results = q
            .query_map([], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"root":r.get::<_,String>(1)?}))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for result in &results {
            Self::assert_workspace_consistent(&c, result["id"].as_str().unwrap_or(""))?;
        }
        Ok(results)
    }
    pub fn refresh_scoped(
        &self,
        workspace: &str,
        shared_ids: Option<&[String]>,
    ) -> anyhow::Result<Value> {
        let allowed = self.scope_ids(workspace)?;
        let mut ids = vec![workspace.to_owned()];
        if let Some(shared) = shared_ids {
            anyhow::ensure!(
                shared.len() <= 20 && shared.iter().all(|s| s != workspace && allowed.contains(s)),
                "sharedScopeDenied"
            );
            ids.extend(shared.iter().cloned());
        }
        let mut changed = vec![];
        let mut unsupported = vec![];
        let mut partial = false;
        let mut skipped = vec![];
        let mut truncated_sources = vec![];
        let mut count = 0u64;
        for id in ids {
            let result = if id == "default" {
                json!({"changedSourceIds":[],"unsupported":[],"sourceCount":0})
            } else {
                self.refresh(&id)?
            };
            changed.extend(
                result["changedSourceIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            changed.extend(
                self.refresh_app_records(&id)?
                    .into_iter()
                    .map(Value::String),
            );
            unsupported.extend(
                result["unsupported"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            partial |= result["truncated"] == true || result["status"] == "partial";
            skipped.extend(
                result["skipped"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            truncated_sources.extend(
                result["truncatedSources"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            count += result["sourceCount"].as_u64().unwrap_or(0);
        }
        Ok(
            json!({"changedSourceIds":changed,"unsupported":unsupported,"skipped":skipped,"truncatedSources":truncated_sources,"sourceCount":count,"truncated":partial,"status":if partial{"partial"}else{"ready"}}),
        )
    }
    pub fn refresh(&self, workspace: &str) -> anyhow::Result<Value> {
        self.refresh_with_limit(workspace, 20000)
    }
    /// Scans the workspace roots and indexes changed files. Each file commits in its own short
    /// write transaction after its bytes are read and extracted, so a large folder never holds
    /// the shared database lock. An entry that vanishes or cannot be read is skipped and reported,
    /// the refresh is marked partial, and the evidence indexed so far is kept.
    pub fn refresh_with_limit(&self, workspace: &str, limit: usize) -> anyhow::Result<Value> {
        let limit = limit.clamp(1, 20000);
        let mut c = self.db()?;
        Self::assert_workspace_consistent(&c, workspace)?;
        let root: String = c.query_row(
            "SELECT root FROM workspaces WHERE id=?1",
            [workspace],
            |r| r.get(0),
        )?;
        let roots = {
            let mut q =
                c.prepare("SELECT root FROM workspace_roots WHERE workspace=?1 ORDER BY root")?;
            let mut roots = q
                .query_map([workspace], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            if roots.is_empty() {
                roots.push(root);
            }
            roots.into_iter().map(PathBuf::from).collect::<Vec<_>>()
        };
        let mut files = Vec::new();
        let mut complete = true;
        let mut skipped = Vec::new();
        for root in &roots {
            if files.len() >= limit {
                complete = false;
                break;
            }
            complete &= scan(root, &mut files, limit, &mut skipped);
        }
        let scan_skipped = !skipped.is_empty();
        let mut seen = HashSet::new();
        let mut changed = Vec::new();
        let mut unsupported = Vec::new();
        let mut truncated_sources = Vec::new();
        for path in files.into_iter().take(limit) {
            match self.refresh_file(&mut c, workspace, &roots, &path, &mut seen)? {
                FileRefresh::Unchanged => {}
                FileRefresh::Changed { id, truncated } => {
                    if truncated {
                        truncated_sources.push(path.to_string_lossy().into_owned());
                    }
                    changed.push(id)
                }
                FileRefresh::Unsupported(id) => {
                    unsupported.push(path.to_string_lossy().into_owned());
                    changed.extend(id);
                }
                FileRefresh::Skipped => skipped.push(path.to_string_lossy().into_owned()),
            }
        }
        // Unseen sources are removed only after a complete scan that could read every folder.
        if complete && !scan_skipped {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            Self::assert_workspace_consistent(&tx, workspace)?;
            let old_ids = {
                let mut q = tx.prepare(
                    "SELECT id FROM sources WHERE workspace=?1 AND path NOT LIKE 'chatgpt:%' AND path NOT LIKE 'record:%' AND path NOT LIKE 'shared:%' AND path NOT LIKE 'web:%'",
                )?;
                let ids = q
                    .query_map([workspace], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                ids
            };
            for id in old_ids {
                if !seen.contains(&id) {
                    Self::delete_source(&tx, &id)?;
                    changed.push(id)
                }
            }
            let unreadable = {
                let mut q = tx.prepare("SELECT id FROM unreadable_sources WHERE workspace=?1")?;
                let ids = q
                    .query_map([workspace], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                ids
            };
            for id in unreadable.into_iter().filter(|id| !seen.contains(id)) {
                tx.execute("DELETE FROM unreadable_sources WHERE id=?1", [&id])?;
            }
            tx.commit()?;
        }
        let ready = complete && skipped.is_empty();
        Ok(
            json!({"changedSourceIds":changed,"unsupported":unsupported,"skipped":skipped,"truncatedSources":truncated_sources,"sourceCount":seen.len(),"scanLimit":limit,"truncated":!complete,"status":if ready{"ready"}else{"partial"}}),
        )
    }
    /// Indexes one scanned file. Filesystem reads and extraction happen before the write
    /// transaction opens; a file that disappears or cannot be read is `Skipped` and its earlier
    /// evidence is kept (it counts as seen).
    fn refresh_file(
        &self,
        c: &mut Connection,
        workspace: &str,
        roots: &[PathBuf],
        path: &Path,
        seen: &mut HashSet<String>,
    ) -> anyhow::Result<FileRefresh> {
        let source_id = |p: &Path| hash(format!("{workspace}:{}", p.display()).as_bytes());
        let Ok(canonical) = path.canonicalize() else {
            seen.insert(source_id(path));
            return Ok(FileRefresh::Skipped);
        };
        if !roots.iter().any(|root| canonical.starts_with(root)) {
            return Ok(FileRefresh::Unchanged);
        }
        let id = source_id(&canonical);
        seen.insert(id.clone());
        let ext = canonical
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        let Ok(metadata) = fs::metadata(&canonical) else {
            return Ok(FileRefresh::Skipped);
        };
        let remove = |c: &mut Connection| -> anyhow::Result<FileRefresh> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            Self::assert_workspace_consistent(&tx, workspace)?;
            let removed = Self::delete_source(&tx, &id)?;
            tx.commit()?;
            Ok(FileRefresh::Unsupported(removed.then(|| id.clone())))
        };
        if !matches!(
            ext.as_str(),
            "md" | "txt" | "csv" | "pdf" | "docx" | "pptx" | "xlsx"
        ) || metadata.len() > 24_000_000
        {
            return remove(c);
        }
        let Some(modified) = metadata
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
        else {
            return Ok(FileRefresh::Skipped);
        };
        let cached=c.query_row("SELECT m.modified_ns,m.size FROM source_file_metadata m JOIN sources s ON m.id=s.id WHERE m.id=?1",[&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?))).ok();
        if cached
            .as_ref()
            .is_some_and(|(old, size)| old == &modified && *size == metadata.len())
        {
            return Ok(FileRefresh::Unchanged);
        }
        let bytes = match fs::read(&canonical) {
            Ok(b) if b.len() <= 24_000_000 => b,
            Ok(_) => return remove(c),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileRefresh::Skipped)
            }
            Err(_) => return remove(c),
        };
        let digest = hash(&bytes);
        let old_digest = c
            .query_row("SELECT digest FROM sources WHERE id=?1", [&id], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        let known_unreadable = c
            .query_row(
                "SELECT digest FROM unreadable_sources WHERE id=?1",
                [&id],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if known_unreadable.as_ref() == Some(&digest) {
            // Failed before with these exact bytes; parsing again would fail (or hang) again.
            return Ok(FileRefresh::Unsupported(None));
        }
        let sections = if old_digest.as_ref() == Some(&digest) {
            None
        } else {
            // The bytes just digested are the bytes extracted, so a file changing in between
            // cannot leave a digest that describes other text. Extraction runs guarded: a
            // parser panic or hang marks this file unreadable and the refresh continues.
            use crate::source_extraction::{extract_guarded, GuardFailure, EXTRACTION_TIMEOUT};
            match extract_guarded(&ext, bytes, EXTRACTION_TIMEOUT) {
                Ok(s) => Some(s),
                // Earlier extractions are still stuck: keep the evidence and retry later.
                Err(GuardFailure::Busy | GuardFailure::Stalled) => return Ok(FileRefresh::Skipped),
                Err(GuardFailure::Unreadable | GuardFailure::TimedOut) => {
                    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    Self::assert_workspace_consistent(&tx, workspace)?;
                    let removed = Self::delete_source(&tx, &id)?;
                    tx.execute("INSERT INTO unreadable_sources(id,workspace,digest) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest",params![id,workspace,digest])?;
                    tx.commit()?;
                    return Ok(FileRefresh::Unsupported(removed.then_some(id)));
                }
            }
        };
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Roots may have changed while this file was read; the transaction re-checks authority.
        Self::assert_workspace_consistent(&tx, workspace)?;
        let current_roots = {
            let mut q = tx.prepare("SELECT root FROM workspace_roots WHERE workspace=?1")?;
            let rows = q
                .query_map([workspace], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if !current_roots.is_empty() && !current_roots.iter().any(|r| canonical.starts_with(r)) {
            return Ok(FileRefresh::Unchanged);
        }
        let Some(extraction) = sections else {
            tx.execute("INSERT INTO source_file_metadata(id,modified_ns,size) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET modified_ns=excluded.modified_ns,size=excluded.size",params![id,modified,metadata.len()])?;
            tx.commit()?;
            return Ok(FileRefresh::Unchanged);
        };
        let truncated = extraction.truncated;
        tx.execute("DELETE FROM unreadable_sources WHERE id=?1", [&id])?;
        let revision = Self::next_source_revision(&tx, &id)?;
        tx.execute("DELETE FROM source_vectors WHERE source_id=?1", [&id])?;
        tx.execute("DELETE FROM source_fts WHERE source_id=?1", [&id])?;
        for (locator, text) in extraction.sections {
            let chars: Vec<char> = text.chars().collect();
            for (n, chunk) in chars.chunks(2400).enumerate() {
                let excerpt: String = chunk.iter().collect();
                tx.execute("INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES(?1,?2,?3,?4,?5,?6,0)",params![id,workspace,path.file_name().unwrap_or_default().to_string_lossy(),excerpt,format!("{}#{locator}:part{}",canonical.display(),n+1),revision])?;
            }
        }
        tx.execute("INSERT INTO sources(id,workspace,path,digest,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,revision=excluded.revision,path=excluded.path",params![id,workspace,canonical.to_string_lossy(),digest,revision])?;
        tx.execute("INSERT INTO source_file_metadata(id,modified_ns,size) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET modified_ns=excluded.modified_ns,size=excluded.size",params![id,modified,metadata.len()])?;
        tx.commit()?;
        Ok(FileRefresh::Changed { id, truncated })
    }
    pub fn retrieve(
        &self,
        workspace: &str,
        query: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<Value>> {
        self.retrieve_lexical_selected(workspace, query, limit, None)
    }
    fn retrieve_lexical_selected(
        &self,
        workspace: &str,
        query: &str,
        limit: usize,
        source_ids: Option<&[String]>,
    ) -> anyhow::Result<Vec<Value>> {
        Self::assert_workspace_consistent(&self.db()?, workspace)?;
        let tokens: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.chars().count() > 2)
            .take(48)
            .map(|s| format!("\"{}\"", s))
            .collect();
        if tokens.is_empty() {
            return Ok(vec![]);
        }
        let c = self.db()?;
        let mut q=c.prepare("SELECT source_id,title,text,locator,revision,derived FROM source_fts WHERE source_fts MATCH ?1 AND workspace=?2 AND (?4 IS NULL OR source_id IN (SELECT value FROM json_each(?4))) ORDER BY bm25(source_fts) LIMIT ?3")?;
        let hits=q.query_map(params![tokens.join(" OR "),workspace,limit.min(30) as i64,source_ids.map(|ids|json!(ids).to_string())],|r|Ok(json!({"sourceId":r.get::<_,String>(0)?,"workspaceId":workspace,"kind":"workspace","title":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"revision":r.get::<_,i64>(4)?,"derived":r.get::<_,i64>(5)?!=0})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(hits)
    }
}
enum FileRefresh {
    Unchanged,
    /// Indexed anew; `truncated` when extraction stopped at its character budget.
    Changed { id: String, truncated: bool },
    /// Unsupported or unreadable content; carries the id when earlier evidence was removed.
    Unsupported(Option<String>),
    /// The entry vanished or could not be inspected; earlier evidence is kept.
    Skipped,
}
/// Collects candidate files under `root`. Folders that cannot be listed are recorded in
/// `skipped` and the walk continues; returns false only when `limit` was reached.
fn scan(root: &Path, files: &mut Vec<PathBuf>, limit: usize, skipped: &mut Vec<String>) -> bool {
    let Ok(listing) = fs::read_dir(root) else {
        skipped.push(root.to_string_lossy().into_owned());
        return true;
    };
    let mut entries = Vec::new();
    for entry in listing {
        match entry {
            Ok(entry) => entries.push(entry),
            Err(_) => {
                skipped.push(root.to_string_lossy().into_owned());
            }
        }
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules"
                    | "target"
                    | "keychains"
                    | "secrets"
                    | "credentials"
                    | "private"
                    | "library"
            )
        {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            skipped.push(path.to_string_lossy().into_owned());
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if files.len() >= limit {
            return false;
        }
        if kind.is_dir() {
            if !scan(&path, files, limit, skipped) {
                return false;
            }
        } else if kind.is_file() {
            files.push(path);
        }
    }
    true
}
#[derive(Default)]
pub struct SourceState;
#[tauri::command]
pub async fn connect_workspace(
    app: tauri::AppHandle,
    _state: State<'_, SourceState>,
    id: String,
    root: String,
) -> Result<Value, String> {
    let workspace = id.clone();
    // Reading a new folder is a new grant: the person confirms the exact path unless they just picked it natively
    // or this workspace already reads it.
    let check_id = id.clone();
    let check_root = root.clone();
    let request = tokio::task::spawn_blocking(move || {
        let canonical = Path::new(&check_root).canonicalize().map_err(|_| "sourceFailed")?;
        let current: Option<String> = SourceIndex::open(&crate::commands::data_root())
            .and_then(|index| Ok(index.db()?.query_row("SELECT root FROM workspaces WHERE id=?1", [&check_id], |r| r.get(0)).optional()?))
            .map_err(|_| "sourceFailed")?;
        let path = canonical.to_string_lossy().into_owned();
        Ok::<_, String>(crate::grants::GrantRequest {
            reads: if current.as_deref() == Some(path.as_str()) { vec![] } else { vec![path] },
            ..Default::default()
        })
    })
    .await
    .map_err(|_| "sourceFailed")??;
    crate::grants::confirm_request(&app, request).await?;
    let result = tokio::task::spawn_blocking(move || {
        let index = SourceIndex::open(&crate::commands::data_root())?;
        index.connect(&id, Path::new(&root))?;
        index.refresh(&id)
    })
    .await
    .map_err(|_| "sourceFailed")?
    .map_err(|_| "sourceFailed")?;
    tauri::async_runtime::spawn(async move {
        loop {
            match fill_semantic_index(&app, &workspace).await {
                Ok(n) if n > 0 => {}
                _ => break,
            }
        }
    });
    Ok(result)
}
#[tauri::command]
pub async fn refresh_workspace(
    app: tauri::AppHandle,
    id: String,
    shared_library_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let workspace = id.clone();
    let libraries = shared_library_ids.clone().unwrap_or_default();
    let mut result = tokio::task::spawn_blocking(move || {
        SourceIndex::open(&crate::commands::data_root())?
            .refresh_scoped(&id, shared_library_ids.as_deref())
    })
    .await
    .map_err(|_| "sourceFailed")?
    .map_err(|_| "sourceFailed")?;
    let mut embedded = 0;
    for id in std::iter::once(workspace).chain(libraries) {
        let n = fill_semantic_index(&app, &id).await.unwrap_or(0);
        embedded += n;
        if n > 0 {
            if let Some(ids) = result["changedSourceIds"].as_array_mut() {
                ids.push(json!(format!("index:{id}")));
            }
        }
    }
    result["semanticIndexed"] = json!(embedded);
    Ok(result)
}
#[tauri::command]
pub async fn retrieve_context(
    app: tauri::AppHandle,
    workspace_id: String,
    query: String,
    source_ids: Option<Vec<String>>,
    shared_library_ids: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let mut expanded = query.clone();
    let mut translated_query = None;
    let mut query_vectors = Vec::new();
    if let Ok(mut worker) = crate::local_speech::worker::LocalSpeechWorker::spawn(
        &crate::commands::worker_binary(&app),
        &crate::commands::data_root().join("models"),
        &crate::commands::data_root().join("cache"),
    )
    .await
    {
        if let Ok(result) = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            worker
                .request(&json!({"kind":"translateText","text":query,"source":"en","target":"de"})),
        )
        .await
        {
            if let Ok(events) = result {
                if let Some(text) = events.first().and_then(|v| v["text"].as_str()) {
                    expanded.push(' ');
                    expanded.push_str(text);
                    translated_query = Some(text.to_string());
                }
            }
        }
        let mut entries = vec![json!({"text":query})];
        if let Some(text) = translated_query {
            entries.push(json!({"text":text,"language":"de"}));
        }
        if let Ok(Ok(result)) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            worker.request(&json!({"kind":"embedText","entries":entries})),
        )
        .await
        {
            query_vectors = result
                .first()
                .and_then(|r| r["entries"].as_array())
                .cloned()
                .unwrap_or_default();
        }
        worker.shutdown().await;
    }
    tokio::task::spawn_blocking(move || {
        let index = SourceIndex::open(&crate::commands::data_root())?;
        index.retrieve_scoped(
            &workspace_id,
            &expanded,
            &query_vectors,
            8,
            source_ids.as_deref(),
            shared_library_ids.as_deref(),
        )
    })
    .await
    .map_err(|_| "sourceFailed")?
    .map_err(|_| "sourceFailed".into())
}

#[tauri::command]
pub fn list_workspaces() -> Result<Vec<Value>, String> {
    SourceIndex::open(&crate::commands::data_root())
        .and_then(|s| s.list())
        .map_err(|_| "sourceFailed".into())
}
impl SourceIndex {
    pub fn import_chatgpt(&self, workspace: &str, path: &Path) -> anyhow::Result<Value> {
        self.import_chatgpt_with_limit(workspace, path, MAX_CHATGPT_EXPORT_BYTES)
    }
    /// Imports `conversations.json`, from a zip or as is, of at most `limit` bytes (the file and
    /// the decompressed JSON alike). Conversations are parsed one at a time, so memory holds the
    /// export's bytes plus a single conversation's tree rather than the whole export's tree.
    fn import_chatgpt_with_limit(
        &self,
        workspace: &str,
        path: &Path,
        limit: u64,
    ) -> anyhow::Result<Value> {
        use serde::de::DeserializeSeed;
        use std::io::Cursor;
        Self::assert_workspace_consistent(&self.db()?, workspace)?;
        anyhow::ensure!(fs::metadata(path)?.len() <= limit, CHATGPT_EXPORT_TOO_LARGE);
        let bytes = fs::read(path)?;
        let data = if path.extension().and_then(|s| s.to_str()) == Some("zip") {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            let entry = archive.by_name("conversations.json")?;
            let mut budget = limit;
            crate::source_extraction::read_limited(
                entry,
                limit,
                &mut budget,
                CHATGPT_EXPORT_TOO_LARGE,
            )?
        } else {
            bytes
        };
        let mut c = self.db()?;
        let tx = c.transaction()?;
        let (mut imported, mut skipped) = (0, 0);
        let import_one = |conv: Value| -> anyhow::Result<()> {
            let Some(mapping) = conv["mapping"].as_object() else {
                skipped += 1;
                return Ok(());
            };
            let Some(conversation_id) = conv["id"].as_str() else {
                skipped += 1;
                return Ok(());
            };
            let title = conv["title"].as_str().unwrap_or("ChatGPT conversation");
            for node in mapping.values() {
                let msg = &node["message"];
                let role = msg["author"]["role"].as_str().unwrap_or("");
                if !matches!(role, "user" | "assistant")
                    || !matches!(
                        msg["content"]["content_type"].as_str(),
                        Some("text" | "multimodal_text")
                    )
                {
                    skipped += 1;
                    continue;
                }
                let Some(message_id) = msg["id"].as_str() else {
                    skipped += 1;
                    continue;
                };
                let text = msg["content"]["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.trim().is_empty() {
                    skipped += 1;
                    continue;
                }
                let locator = format!("chatgpt:{conversation_id}:{message_id}");
                let id = hash(format!("{workspace}:{locator}").as_bytes());
                let digest = hash(text.as_bytes());
                let old = tx
                    .query_row(
                        "SELECT digest,revision FROM sources WHERE id=?1",
                        [&id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .ok();
                if old.as_ref().is_some_and(|o| o.0 == digest) {
                    skipped += 1;
                    continue;
                }
                let revision = old.map(|(_, r)| r + 1).unwrap_or(1);
                tx.execute("DELETE FROM source_fts WHERE source_id=?1", [&id])?;
                let chars: Vec<char> = text.chars().collect();
                for (n, chunk) in chars.chunks(2400).enumerate() {
                    let text: String = chunk.iter().collect();
                    tx.execute("INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,workspace,title,text,format!("{locator}:part{}",n+1),revision,(role=="assistant")as i32])?;
                }
                tx.execute("INSERT INTO sources(id,workspace,path,digest,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,revision=excluded.revision",params![id,workspace,locator,digest,revision])?;
                imported += 1;
            }
            Ok(())
        };
        let mut json = serde_json::Deserializer::from_slice(&data);
        EachConversation(import_one).deserialize(&mut json)?;
        json.end()?;
        drop(data);
        tx.commit()?;
        Ok(
            json!({"imported":imported,"skipped":skipped,"conflicts":0,"unresolved":[],"errors":[],"branches":"all mapping nodes","date":time::OffsetDateTime::now_utc().unix_timestamp()}),
        )
    }
}
/// Largest ChatGPT export accepted, both on disk and as decompressed `conversations.json`.
/// The import runs while a meeting may be live, so it must stay well inside memory.
pub const MAX_CHATGPT_EXPORT_BYTES: u64 = 128_000_000;
/// Error code for an export over `MAX_CHATGPT_EXPORT_BYTES`.
pub const CHATGPT_EXPORT_TOO_LARGE: &str = "importTooLarge";

/// Feeds each element of the top-level conversations array to a callback as it is parsed.
struct EachConversation<F>(F);
impl<'de, F: FnMut(Value) -> anyhow::Result<()>> serde::de::DeserializeSeed<'de>
    for EachConversation<F>
{
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de, F: FnMut(Value) -> anyhow::Result<()>> serde::de::Visitor<'de> for EachConversation<F> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a ChatGPT conversations array")
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        while let Some(conversation) = seq.next_element::<Value>()? {
            (self.0)(conversation).map_err(serde::de::Error::custom)?;
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn import_chatgpt_export(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
) -> Result<Value, String> {
    // Importing reads a file the app has not been given before; confirm it unless it was picked natively.
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|_| "importUnsupported")?
        .to_string_lossy()
        .into_owned();
    crate::grants::confirm_request(
        &app,
        crate::grants::GrantRequest { imports: vec![canonical], ..Default::default() },
    )
    .await?;
    tokio::task::spawn_blocking(move || {
        SourceIndex::open(&crate::commands::data_root())?
            .import_chatgpt(&workspace_id, Path::new(&path))
    })
    .await
    .map_err(|_| "importFailed")?
    .map_err(|e| {
        if e.to_string() == CHATGPT_EXPORT_TOO_LARGE {
            CHATGPT_EXPORT_TOO_LARGE.into()
        } else {
            "importUnsupported".into()
        }
    })
}

impl SourceIndex {
    pub fn refresh_app_records(&self, workspace: &str) -> anyhow::Result<Vec<String>> {
        let records = crate::meeting_records::RecordStore::open(&self.root)?;
        let mut c = self.db()?;
        Self::assert_workspace_consistent(&self.db()?, workspace)?;
        let mut changed = Vec::new();
        // The list is summaries; only this workspace's meetings are loaded in full for their text.
        for summary in records
            .list()?
            .into_iter()
            .filter(|r| r["workspaceId"] == workspace)
        {
            let Some(id) = summary["id"].as_str() else {
                continue;
            };
            let record = records.load(id)?;
            let source_id = format!("record:{id}");
            let text = crate::meeting_records::source_text(&record);
            if text.is_empty() {
                continue;
            }
            let digest = hash(text.as_bytes());
            let old = c
                .query_row(
                    "SELECT digest,revision FROM sources WHERE id=?1",
                    [&source_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .ok();
            if old.as_ref().is_some_and(|o| o.0 == digest) {
                continue;
            }
            let revision = old.map(|(_, r)| r + 1).unwrap_or(1);
            let tx = c.transaction()?;
            tx.execute("DELETE FROM source_fts WHERE source_id=?1", [&source_id])?;
            for (n, part) in text.chars().collect::<Vec<_>>().chunks(2400).enumerate() {
                let excerpt: String = part.iter().collect();
                tx.execute("INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES(?1,?2,?3,?4,?5,?6,0)",params![source_id,workspace,record["purpose"].as_str().unwrap_or("Earlier meeting"),excerpt,format!("record:{id}#part{}",n+1),revision])?;
            }
            tx.execute("INSERT INTO sources(id,workspace,path,digest,revision) VALUES(?1,?2,?1,?3,?4) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,revision=excluded.revision",params![source_id,workspace,digest,revision])?;
            tx.commit()?;
            changed.push(source_id);
        }
        Ok(changed)
    }
}

impl SourceIndex {
    pub fn pending_embeddings(&self, workspace: &str, limit: usize) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        Self::assert_workspace_consistent(&c, workspace)?;
        let mut q=c.prepare("SELECT f.source_id,f.locator,f.revision,f.text FROM source_fts f LEFT JOIN source_vectors v ON f.source_id=v.source_id AND f.locator=v.locator AND f.revision=v.revision WHERE f.workspace=?1 AND v.source_id IS NULL LIMIT ?2")?;
        let result=q.query_map(params![workspace,limit.min(128) as i64],|r|Ok(json!({"sourceId":r.get::<_,String>(0)?,"locator":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"text":r.get::<_,String>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(result)
    }
    pub fn save_embeddings(&self, entries: &[Value]) -> anyhow::Result<()> {
        let mut c = self.db()?;
        let tx = c.transaction()?;
        for e in entries {
            let source_workspace: Option<String> = tx
                .query_row(
                    "SELECT workspace FROM sources WHERE id=?1",
                    [e["sourceId"].as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(workspace) = source_workspace {
                Self::assert_workspace_consistent(&tx, &workspace)?;
            } else {
                continue;
            }
            let Some(vector) = e["vector"].as_array() else {
                continue;
            };
            anyhow::ensure!(
                vector.len() <= 1024
                    && vector
                        .iter()
                        .all(|v| v.as_f64().is_some_and(f64::is_finite)),
                "invalidEmbedding"
            );
            tx.execute("INSERT INTO source_vectors(source_id,locator,revision,language,vector) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM source_fts WHERE source_id=?1 AND locator=?2 AND revision=?3) ON CONFLICT(source_id,locator) DO UPDATE SET revision=excluded.revision,language=excluded.language,vector=excluded.vector",params![e["sourceId"].as_str(),e["locator"].as_str(),e["revision"].as_i64(),e["language"].as_str(),e["vector"].to_string()])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn retrieve_semantic(
        &self,
        workspace: &str,
        queries: &[Value],
        limit: usize,
    ) -> anyhow::Result<Vec<Value>> {
        self.retrieve_semantic_selected(workspace, queries, limit, None)
    }
    fn retrieve_semantic_selected(
        &self,
        workspace: &str,
        queries: &[Value],
        limit: usize,
        source_ids: Option<&[String]>,
    ) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        Self::assert_workspace_consistent(&c, workspace)?;
        let mut q=c.prepare("SELECT f.source_id,f.title,f.text,f.locator,f.revision,f.derived,v.language,v.vector FROM source_fts f JOIN source_vectors v ON f.source_id=v.source_id AND f.locator=v.locator AND f.revision=v.revision WHERE f.workspace=?1 AND (?2 IS NULL OR f.source_id IN (SELECT value FROM json_each(?2))) LIMIT 20000")?;
        let mut ranked = std::collections::BTreeMap::<String, Vec<(f64, Value)>>::new();
        for row in q.query_map(params![workspace,source_ids.map(|ids|json!(ids).to_string())],|r|Ok((json!({"sourceId":r.get::<_,String>(0)?,"workspaceId":workspace,"kind":"workspace","title":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"revision":r.get::<_,i64>(4)?,"derived":r.get::<_,i64>(5)?!=0}),r.get::<_,String>(6)?,r.get::<_,String>(7)?)))?{
            let (hit,language,encoded)=row?;
            let vector:Vec<f64>=serde_json::from_str(&encoded)?;
            let score=queries.iter().filter(|v|v["language"]==language).filter_map(|v|v["vector"].as_array()).filter(|v|v.len()==vector.len()).map(|v|v.iter().zip(&vector).map(|(a,b)|a.as_f64().unwrap_or(0.0)*b).sum::<f64>()).max_by(f64::total_cmp);
            if let Some(score)=score{if score.is_finite(){ranked.entry(language.clone()).or_default().push((score,hit));}}
        }
        let mut fused = std::collections::HashMap::<String, (f64, Value)>::new();
        for list in ranked.values_mut() {
            list.sort_by(|a, b| b.0.total_cmp(&a.0));
            for (rank, (_, hit)) in list.iter().take(limit.min(30)).enumerate() {
                let key = format!("{}#{}", hit["sourceId"], hit["locator"]);
                let entry = fused.entry(key).or_insert((0.0, hit.clone()));
                entry.0 += 1.0 / (60.0 + rank as f64 + 1.0);
            }
        }
        let mut hits: Vec<_> = fused.into_values().collect();
        hits.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1["locator"].as_str().cmp(&b.1["locator"].as_str()))
        });
        Ok(hits
            .into_iter()
            .take(limit.min(30))
            .map(|(_, hit)| hit)
            .collect())
    }
}
async fn fill_semantic_index(app: &tauri::AppHandle, workspace: &str) -> anyhow::Result<usize> {
    let index = SourceIndex::open(&crate::commands::data_root())?;
    let entries = index.pending_embeddings(workspace, 64)?;
    if entries.is_empty() {
        return Ok(0);
    }
    let mut worker = crate::local_speech::worker::LocalSpeechWorker::spawn(
        &crate::commands::worker_binary(app),
        &crate::commands::data_root().join("models"),
        &crate::commands::data_root().join("cache"),
    )
    .await?;
    let results = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        worker.request(&json!({"kind":"embedText","entries":entries})),
    )
    .await??;
    let embeddings = results
        .first()
        .and_then(|r| r["entries"].as_array())
        .ok_or_else(|| anyhow::anyhow!("semanticUnavailable"))?;
    index.save_embeddings(embeddings)?;
    worker.shutdown().await;
    Ok(embeddings.len())
}

impl SourceIndex {
    pub fn retrieve_ranked(
        &self,
        workspace: &str,
        query: &str,
        vectors: &[Value],
        limit: usize,
    ) -> anyhow::Result<Vec<Value>> {
        self.retrieve_scoped(workspace, query, vectors, limit, None, None)
    }
    pub fn retrieve_scoped(
        &self,
        workspace: &str,
        query: &str,
        vectors: &[Value],
        limit: usize,
        source_ids: Option<&[String]>,
        shared_ids: Option<&[String]>,
    ) -> anyhow::Result<Vec<Value>> {
        if workspace == "default" && crate::edition::is_public() {
            anyhow::ensure!(
                source_ids.is_none_or(|s| s.is_empty()) && shared_ids.is_none_or(|s| s.is_empty()),
                "sourceScopeDenied"
            );
            return Ok(vec![]);
        }
        let scope = self.scope_ids(workspace)?;
        if let Some(ids) = shared_ids {
            anyhow::ensure!(
                ids.iter().all(|id| id != workspace && scope.contains(id)),
                "sharedScopeDenied"
            );
        }
        let selected: Vec<_> = scope
            .into_iter()
            .filter(|id| id == workspace || shared_ids.is_none_or(|ids| ids.contains(id)))
            .collect();
        if let Some(ids) = source_ids {
            let known = self.sources(workspace)?;
            anyhow::ensure!(
                ids.len() <= 20000
                    && ids
                        .iter()
                        .all(|id| known.iter().any(|s| s["sourceId"] == *id
                            && selected.iter().any(|w| s["workspaceId"] == *w))),
                "sourceScopeDenied"
            );
        }
        let mut semantic = vec![];
        let mut lexical = vec![];
        for id in selected {
            semantic.extend(self.retrieve_semantic_selected(&id, vectors, 30, source_ids)?);
            lexical.extend(self.retrieve_lexical_selected(&id, query, 30, source_ids)?);
        }
        if let Some(ids) = source_ids {
            semantic.retain(|s| {
                s["sourceId"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|s| s == id))
            });
            lexical.retain(|s| {
                s["sourceId"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|s| s == id))
            });
        }
        let mut ranked = std::collections::HashMap::<String, (f64, Value)>::new();
        // Reciprocal ranks avoid comparing absolute scores from different embedding languages or BM25.
        for list in [semantic, lexical] {
            for (rank, hit) in list.into_iter().enumerate() {
                let key = format!("{}#{}", hit["sourceId"], hit["locator"]);
                let entry = ranked.entry(key).or_insert((0.0, hit));
                entry.0 += 1.0 / (60.0 + rank as f64 + 1.0);
            }
        }
        let mut hits: Vec<_> = ranked.into_values().collect();
        hits.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1["locator"].as_str().cmp(&b.1["locator"].as_str()))
        });
        Ok(hits
            .into_iter()
            .take(limit.min(30))
            .map(|(_, hit)| hit)
            .collect())
    }
}

impl SourceIndex {
    pub fn import_portable_source(&self, source: &Value) -> anyhow::Result<&'static str> {
        let workspace = source["workspaceId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidSource"))?;
        anyhow::ensure!(
            crate::meeting_records::valid_id(workspace),
            "invalidWorkspace"
        );
        let text = source["text"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidSource"))?;
        anyhow::ensure!(text.len() < 24000, "sourceExcerptTooLarge");
        let origin = format!("{}:{}:{}", workspace, source["sourceId"], source["locator"]);
        let digest = hash(text.as_bytes());
        let base = format!("shared:{}", hash(origin.as_bytes()));
        let mut c = self.db()?;
        let old = c
            .query_row("SELECT digest FROM sources WHERE id=?1", [&base], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        if old.as_ref() == Some(&digest) {
            return Ok("duplicate");
        }
        let conflict = old.is_some();
        let id = if conflict {
            format!("{base}:{}", &digest[..16])
        } else {
            base.clone()
        };
        if c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1)",
            [&id],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok("duplicate");
        }
        let own_workspace =
            crate::owned_paths::directory(&self.root, &["shared-workspaces", workspace], true)?;
        let tx = c.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO workspaces(id,root) VALUES(?1,?2)",
            params![workspace, own_workspace.to_string_lossy()],
        )?;
        tx.execute(
            "INSERT INTO sources(id,workspace,path,digest,revision) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                workspace,
                format!("shared:{origin}"),
                digest,
                source["revision"].as_i64().unwrap_or(1)
            ],
        )?;
        tx.execute("INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,workspace,source["title"].as_str().unwrap_or("Shared text"),text,source["locator"].as_str().unwrap_or("shared:unknown"),source["revision"].as_i64().unwrap_or(1),source["derived"].as_bool().unwrap_or(false) as i32])?;
        tx.commit()?;
        Ok(if conflict { "conflict" } else { "imported" })
    }
    pub fn share_candidates(&self, workspaces: &[String]) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut results = Vec::new();
        for workspace in workspaces.iter().take(20) {
            Self::assert_workspace_consistent(&c, workspace)?;
            let mut q=c.prepare("SELECT source_id,title,text,locator,revision,derived FROM source_fts WHERE workspace=?1 LIMIT 100")?;
            results.extend(q.query_map([workspace],|r|Ok(json!({"sourceId":r.get::<_,String>(0)?,"workspaceId":workspace,"kind":"workspace","title":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"revision":r.get::<_,i64>(4)?,"derived":r.get::<_,i64>(5)?!=0})))?.collect::<Result<Vec<_>,_>>()?);
        }
        Ok(results)
    }
}
#[tauri::command]
pub fn list_sharing_sources(workspace_ids: Vec<String>) -> Result<Vec<Value>, String> {
    SourceIndex::open(&crate::commands::data_root())
        .and_then(|s| s.share_candidates(&workspace_ids))
        .map_err(|_| "sourceUnavailable".into())
}
impl SourceIndex {
    pub fn cache_public_sources(&self, hits: &mut [Value]) -> anyhow::Result<()> {
        let mut c = self.db()?;
        let tx = c.transaction()?;
        for hit in hits {
            let id = hit["sourceId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalidPublicSource"))?;
            let text = hit["text"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalidPublicSource"))?;
            let digest = hash(text.as_bytes());
            let old = tx
                .query_row(
                    "SELECT digest,revision FROM sources WHERE id=?1",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .ok();
            let revision = old
                .as_ref()
                .map(|(d, r)| if d == &digest { *r } else { r + 1 })
                .unwrap_or(1);
            tx.execute("DELETE FROM source_fts WHERE source_id=?1", [id])?;
            tx.execute("INSERT INTO sources(id,workspace,path,digest,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,revision=excluded.revision",params![id,hit["workspaceId"].as_str(),format!("web:{}",hit["locator"]),digest,revision])?;
            let chars: Vec<char> = text.chars().collect();
            for (n, part) in chars.chunks(2400).enumerate() {
                let excerpt: String = part.iter().collect();
                tx.execute("INSERT INTO source_fts(source_id,workspace,title,text,locator,revision,derived) VALUES(?1,?2,?3,?4,?5,?6,0)",params![id,hit["workspaceId"].as_str(),hit["title"].as_str(),excerpt,format!("{}#excerpt{}",hit["locator"].as_str().unwrap_or(""),n+1),revision])?;
            }
            hit["revision"] = json!(revision);
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_extraction::tests::{forge_declared_sizes, zip_bytes};

    fn workspace() -> (PathBuf, SourceIndex) {
        let root = std::env::temp_dir().join(format!("chatgpt-limit-{}", uuid::Uuid::new_v4()));
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        let index = SourceIndex::open(&root.join("app")).unwrap();
        index.connect("w", &docs).unwrap();
        (root, index)
    }

    fn conversation(n: usize) -> Value {
        json!({"id":format!("c{n}"),"title":"Plan","mapping":{"m":{"message":{"id":format!("m{n}"),"author":{"role":"user"},"content":{"content_type":"text","parts":["Vendor shortlist approved"]}}}}})
    }

    #[test]
    fn an_export_zip_that_lies_about_its_size_stops_at_the_limit() {
        let (root, index) = workspace();
        let export = json!((0..200).map(conversation).collect::<Vec<_>>()).to_string();
        let mut bytes = zip_bytes(&[("conversations.json", export.as_bytes())]);
        forge_declared_sizes(&mut bytes, 10);
        let path = root.join("export.zip");
        fs::write(&path, &bytes).unwrap();
        let limit = (bytes.len() as u64) * 2;
        assert!((export.len() as u64) > limit, "the JSON inflates past the limit");
        let error = index.import_chatgpt_with_limit("w", &path, limit).unwrap_err();
        assert_eq!(error.to_string(), CHATGPT_EXPORT_TOO_LARGE);
        let plain = root.join("conversations.json");
        fs::write(&plain, &export).unwrap();
        let error = index.import_chatgpt_with_limit("w", &plain, limit).unwrap_err();
        assert_eq!(error.to_string(), CHATGPT_EXPORT_TOO_LARGE);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversations_stream_one_at_a_time_and_a_non_array_is_rejected() {
        let (root, index) = workspace();
        let path = root.join("conversations.json");
        let export = json!([conversation(1), {"no":"mapping"}, conversation(2)]);
        fs::write(&path, export.to_string()).unwrap();
        let report = index.import_chatgpt("w", &path).unwrap();
        assert_eq!((report["imported"].as_u64(), report["skipped"].as_u64()), (Some(2), Some(1)));
        fs::write(&path, r#"{"conversations":[]}"#).unwrap();
        assert!(index.import_chatgpt("w", &path).is_err());
        fs::write(&path, r#"[{"id":"x"}] trailing"#).unwrap();
        assert!(index.import_chatgpt("w", &path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
