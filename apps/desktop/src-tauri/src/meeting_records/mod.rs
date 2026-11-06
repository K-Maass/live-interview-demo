pub mod retention;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub struct RecordStore {
    root: PathBuf,
}
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeCompletion {
    Completed,
    TranslationPending,
    RecognitionPending,
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
impl RecordStore {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(root)?;
        let s = Self { root: root.into() };
        let c = s.connection()?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,options TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'recording'); CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,meeting_id TEXT NOT NULL,segment_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(meeting_id,segment_id,revision,kind)); CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL,lane TEXT NOT NULL,path TEXT NOT NULL,start_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');")?;
        s.connection()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery(meeting_id TEXT PRIMARY KEY,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);",
        )?;
        Ok(s)
    }
    fn connection(&self) -> anyhow::Result<Connection> {
        let c = Connection::open(crate::owned_paths::file(
            &self.root,
            &["recording.sqlite"],
            true,
        )?)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(c)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn create(&self, id: &str, options: &Value) -> anyhow::Result<()> {
        anyhow::ensure!(valid_id(id), "invalidMeetingId");
        let record_parent = self.root.join("records");
        fs::create_dir_all(&record_parent)?;
        anyhow::ensure!(
            !fs::symlink_metadata(&record_parent)?
                .file_type()
                .is_symlink(),
            "unownedRecordDirectory"
        );
        let destination = record_parent.join(id);
        fs::create_dir(&destination)?;
        if let Err(error) = self.connection()?.execute(
            "INSERT INTO meetings(id,options) VALUES(?1,?2)",
            params![id, normalized_options(options)?.to_string()],
        ) {
            let _ = fs::remove_dir(&destination);
            return Err(error.into());
        }
        Ok(())
    }
    pub fn append_event(&self, event: &Value) -> anyhow::Result<Value> {
        let (saved, _) = insert_event(&self.connection()?, event)?;
        Ok(saved)
    }
    /// Publication follows durable insertion, never an ignored retry.
    pub fn append_event_once(&self, event: &Value) -> anyhow::Result<Option<Value>> {
        let (saved, inserted) = insert_event(&self.connection()?, event)?;
        Ok(inserted.then_some(saved))
    }
    pub fn next_source_revision(&self, meeting: &str, segment: &str) -> anyhow::Result<i64> {
        let last: Option<i64> = self.connection()?.query_row(
            "SELECT MAX(revision) FROM events WHERE meeting_id=?1 AND segment_id=?2 AND kind='final'",
            params![meeting, segment], |r| r.get(0))?;
        last.unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("invalidRevision"))
    }
    pub fn load(&self, id: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(valid_id(id), "invalidMeetingId");
        let c = self.connection()?;
        let options: String =
            c.query_row("SELECT options FROM meetings WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut record: Value = serde_json::from_str(&options)?;
        let mut q =
            c.prepare("SELECT body,sequence FROM events WHERE meeting_id=?1 ORDER BY sequence")?;
        let mut events = Vec::new();
        for row in q.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (body, sequence) = row?;
            let mut event: Value = serde_json::from_str(&body)?;
            event["journalSequence"] = json!(sequence);
            events.push(event)
        }
        record["segments"] = json!(events);
        record["canonicalEnglishPath"] = json!(self
            .root
            .join("records")
            .join(id)
            .join("english.md")
            .to_string_lossy());
        let pending: i64 = c.query_row(
            "SELECT COUNT(*) FROM chunks WHERE meeting_id=?1 AND status NOT IN ('decoded','translationUnavailable')",
            [id],
            |r| r.get(0),
        )?;
        let unavailable: std::collections::HashSet<String> = {
            let mut q = c.prepare(
                "SELECT id FROM chunks WHERE meeting_id=?1 AND status='translationUnavailable'",
            )?;
            let ids = q
                .query_map([id], |r| r.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            ids
        };
        let raw_pending =
            crate::local_speech::recording::has_raw_tail(&self.root, id).unwrap_or(false);
        let pending = pending + i64::from(raw_pending);
        record["pendingSegments"] = json!(pending);
        record["revision"] = json!(events.len());
        record["translationStatus"] = json!(translation_status(&events, pending, &unavailable));
        if let Some(recovery) = recovery_of(&c, id)? {
            record["recovery"] = recovery;
        }
        Ok(record)
    }
    /// Every meeting, newest first, as a summary: its options and processing state without the transcript
    /// (`segments` is empty and `summary` is true). Open a meeting with [`RecordStore::load`]. The processing
    /// state is computed exactly as `load` computes it, from a few fields of each event read in one query.
    pub fn list(&self) -> anyhow::Result<Vec<Value>> {
        use std::collections::{HashMap, HashSet};
        let c = self.connection()?;
        let mut q = c.prepare("SELECT id,options FROM meetings ORDER BY rowid DESC")?;
        let meetings = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut counts = HashMap::<String, i64>::new();
        let mut q = c.prepare("SELECT meeting_id,COUNT(*) FROM events GROUP BY meeting_id")?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (meeting, count) = row?;
            counts.insert(meeting, count);
        }
        // Only the fields the processing state reads, as JSON text, so each is parsed exactly as in the body.
        let mut light = HashMap::<String, Vec<Value>>::new();
        let mut q = c.prepare(
            "SELECT meeting_id,body->'$.kind',body->'$.segmentId',body->'$.revision',body->'$.language',body->'$.sourceSegmentId',body->'$.startMs' FROM events WHERE kind IN ('final','translation') ORDER BY sequence",
        )?;
        let field = |text: Option<String>| -> anyhow::Result<Value> {
            Ok(match text {
                Some(text) => serde_json::from_str(&text)?,
                None => Value::Null,
            })
        };
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let mut event = serde_json::Map::new();
            for (n, key) in ["kind", "segmentId", "revision", "language", "sourceSegmentId", "startMs"].iter().enumerate() {
                let value = field(r.get::<_, Option<String>>(n + 1)?)?;
                if !value.is_null() {
                    event.insert((*key).into(), value);
                }
            }
            light.entry(r.get::<_, String>(0)?).or_default().push(Value::Object(event));
        }
        let mut pending = HashMap::<String, i64>::new();
        let mut unavailable = HashMap::<String, HashSet<String>>::new();
        let mut q = c.prepare("SELECT meeting_id,id,status FROM chunks")?;
        for row in q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })? {
            let (meeting, chunk, status) = row?;
            match status.as_str() {
                "decoded" => {}
                "translationUnavailable" => {
                    unavailable.entry(meeting).or_default().insert(chunk);
                }
                _ => *pending.entry(meeting).or_default() += 1,
            }
        }
        let mut recoveries = HashMap::<String, Value>::new();
        let mut q = c.prepare("SELECT meeting_id,state FROM recovery")?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (meeting, state) = row?;
            recoveries.insert(meeting, json!({"state": state}));
        }
        let none = HashSet::new();
        meetings
            .into_iter()
            .map(|(id, options)| {
                let mut record: Value = serde_json::from_str(&options)?;
                let events = light.remove(&id).unwrap_or_default();
                let raw_pending =
                    crate::local_speech::recording::has_raw_tail(&self.root, &id).unwrap_or(false);
                let pending = pending.get(&id).copied().unwrap_or(0) + i64::from(raw_pending);
                record["segments"] = json!([]);
                record["summary"] = json!(true);
                record["canonicalEnglishPath"] = json!(self.root.join("records").join(&id).join("english.md").to_string_lossy());
                record["pendingSegments"] = json!(pending);
                record["revision"] = json!(counts.get(&id).copied().unwrap_or(0));
                record["translationStatus"] = json!(translation_status(
                    &events,
                    pending,
                    unavailable.get(&id).unwrap_or(&none),
                ));
                if let Some(recovery) = recoveries.remove(&id) {
                    record["recovery"] = recovery;
                }
                Ok(record)
            })
            .collect()
    }
    /// Meetings whose recording never finished: the app crashed or was force quit while recording or
    /// before their processing ended. Oldest first.
    pub fn interrupted_meetings(&self) -> anyhow::Result<Vec<String>> {
        let c = self.connection()?;
        let mut q = c.prepare("SELECT id FROM meetings WHERE status='recording' ORDER BY rowid")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }
    /// Claims an interrupted meeting for automatic recovery at launch. Each claim counts as an attempt, so a
    /// crash during recovery is retried on the next launch, up to [`AUTO_RECOVERY_ATTEMPTS`]; after that the
    /// meeting is marked `interrupted` and left for Retry processing. False when it is not interrupted.
    pub fn begin_recovery(&self, id: &str) -> anyhow::Result<bool> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let interrupted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1 AND status='recording')",
            [id],
            |r| r.get(0),
        )?;
        if !interrupted {
            return Ok(false);
        }
        use rusqlite::OptionalExtension;
        let attempts: i64 = tx
            .query_row("SELECT attempts FROM recovery WHERE meeting_id=?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        let claimed = attempts < AUTO_RECOVERY_ATTEMPTS;
        tx.execute(
            "INSERT INTO recovery(meeting_id,state,attempts) VALUES(?1,?2,?3) ON CONFLICT(meeting_id) DO UPDATE SET state=excluded.state,attempts=excluded.attempts",
            params![id, if claimed { "recovering" } else { "interrupted" }, attempts + i64::from(claimed)],
        )?;
        tx.commit()?;
        Ok(claimed)
    }
    pub fn add_chunk(
        &self,
        id: &str,
        meeting: &str,
        lane: &str,
        path: &Path,
        start_ms: u64,
    ) -> anyhow::Result<()> {
        self.connection()?.execute(
            "INSERT INTO chunks(id,meeting_id,lane,path,start_ms) VALUES(?1,?2,?3,?4,?5)",
            params![id, meeting, lane, path.to_string_lossy(), start_ms as i64],
        )?;
        Ok(())
    }
    pub fn pending_chunks(&self, meeting: &str) -> anyhow::Result<Vec<Value>> {
        let c = self.connection()?;
        let mut q=c.prepare("SELECT id,lane,path,start_ms FROM chunks WHERE meeting_id=?1 AND status='pending' ORDER BY rowid")?;
        let v=q.query_map([meeting],|r|Ok(json!({"segmentId":r.get::<_,String>(0)?,"lane":r.get::<_,String>(1)?,"audioPath":r.get::<_,String>(2)?,"startMs":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(v)
    }
    /// Complete a successful source decode from canonical durable evidence,
    /// including source published by an earlier interrupted helper request.
    pub fn complete_chunk(&self, id: &str) -> anyhow::Result<DecodeCompletion> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (meeting, lane, start_ms): (String, String, i64) = tx.query_row(
            "SELECT meeting_id,lane,start_ms FROM chunks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let source = current_source(&tx, &meeting, id)?;
        let outcome = if let Some(source) = source {
            anyhow::ensure!(
                source["lane"].as_str() == Some(lane.as_str())
                    && source["startMs"].as_i64() == Some(start_ms),
                "captureProvenanceMismatch"
            );
            let mut translated = source["language"] == "en";
            if !translated {
                let mut q = tx.prepare(
                    "SELECT body FROM events WHERE meeting_id=?1 AND kind='translation' AND revision=?2",
                )?;
                for body in q.query_map(params![meeting, source["revision"].as_i64()], |r| {
                    r.get::<_, String>(0)
                })? {
                    let event: Value = serde_json::from_str(&body?)?;
                    if event["sourceSegmentId"] == source["segmentId"]
                        && event["revision"] == source["revision"]
                        && event["lane"] == source["lane"]
                        && event["startMs"] == source["startMs"]
                        && event["endMs"] == source["endMs"]
                        && event["language"] == "en"
                        && event["text"].as_str().is_some_and(|s| !s.trim().is_empty())
                    {
                        translated = true;
                        break;
                    }
                }
            }
            if translated {
                DecodeCompletion::Completed
            } else if valid_translation_intervals(&source) {
                DecodeCompletion::TranslationPending
            } else {
                DecodeCompletion::RecognitionPending
            }
        } else {
            DecodeCompletion::Completed
        };
        let status = match outcome {
            DecodeCompletion::Completed => "decoded",
            DecodeCompletion::TranslationPending => "translationPending",
            DecodeCompletion::RecognitionPending => "pending",
        };
        tx.execute(
            "UPDATE chunks SET status=?2 WHERE id=?1",
            params![id, status],
        )?;
        tx.commit()?;
        Ok(outcome)
    }
    pub fn finish(&self, id: &str) -> anyhow::Result<Value> {
        let mut record = self.load(id)?;
        let c = self.connection()?;
        c.execute("UPDATE meetings SET status='stopped' WHERE id=?1", [id])?;
        // A meeting recovered after a crash says so; a later Retry processing keeps that.
        if c.execute("UPDATE recovery SET state='recovered' WHERE meeting_id=?1", [id])? > 0 {
            record["recovery"] = json!({"state":"recovered"});
        }
        drop(c);
        let dir = crate::owned_paths::directory(&self.root, &["records", id], false)?;
        let json = serde_json::to_vec_pretty(&record)?;
        atomic_write(
            &crate::owned_paths::file(&self.root, &["records", id, "record.json"], false)?,
            &json,
        )?;
        for (name, english) in [("source.md", false), ("english.md", true)] {
            let mut md = format!("# {}\n\n", record["purpose"].as_str().unwrap_or("Meeting"));
            let events = record["segments"].as_array().cloned().unwrap_or_default();
            let translations = TranslationIndex::new(&events);
            for source in latest_sources(&events) {
                let e = if english && source["language"] != "en" {
                    match translations.find(source, |t| t["lane"] == source["lane"]) {
                        Some(t) => t,
                        None => continue,
                    }
                } else {
                    source
                };
                {
                    md.push_str(&format!(
                        "- [{}ms · {} · {}] {}\n",
                        e["startMs"],
                        e["lane"].as_str().unwrap_or("unknown"),
                        e["language"].as_str().unwrap_or("unknown"),
                        e["text"].as_str().unwrap_or("")
                    ));
                }
            }
            for segment in record["importedSegments"].as_array().into_iter().flatten() {
                if !english || segment["language"] == "en" {
                    md.push_str(&format!(
                        "- [imported · {} · speaker unconfirmed] {}\n",
                        segment["language"].as_str().unwrap_or("unknown"),
                        segment["text"].as_str().unwrap_or("")
                    ));
                }
            }
            if english && record["translationStatus"] == "pending" {
                md.push_str(
                    "\nSome translations are pending. Source evidence is preserved in source.md.\n",
                )
            }
            if english && record["translationStatus"] == "unavailable" {
                md.push_str(
                    "\nSome passages could not be translated. Source evidence is preserved in source.md.\n",
                )
            }
            atomic_write(
                &crate::owned_paths::file(&self.root, &["records", id, name], false)?,
                md.as_bytes(),
            )?
        }
        for person in record["attendees"].as_array().into_iter().flatten() {
            let Some(person_id) = person["id"].as_str() else {
                continue;
            };
            let Some(name) = person["name"].as_str() else {
                continue;
            };
            anyhow::ensure!(
                valid_id(person_id) && name.len() < 200,
                "invalidParticipant"
            );
            self.connection()?.execute("INSERT INTO people(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![person_id,name])?;
            let people = crate::owned_paths::directory(&self.root, &["people", person_id], true)?;
            let link = people.join(format!("{id}.md"));
            let target = dir.join("english.md");
            if let Ok(meta) = fs::symlink_metadata(&link) {
                anyhow::ensure!(
                    meta.file_type().is_symlink() && fs::read_link(&link)? == target,
                    "ownedPersonIndexChanged"
                );
            } else {
                #[cfg(unix)]
                std::os::unix::fs::symlink(&target, &link)?;
            }
        }
        Ok(record)
    }
}
/// Replaces `path` through a synced temporary file. An existing regular file keeps its
/// permission bits (and, on macOS, its extended attributes and ACL); the temporary file is
/// removed on any failure and the parent directory is synced so the rename is durable.
pub fn atomic_write(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let original = fs::symlink_metadata(path).ok().filter(|m| m.is_file());
    let result = (|| -> anyhow::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        if let Some(metadata) = &original {
            #[cfg(target_os = "macos")]
            copy_extended_attributes(path, &file);
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
/// Best effort: a file system without extended attributes must not block the write.
#[cfg(target_os = "macos")]
fn copy_extended_attributes(source: &Path, destination: &fs::File) {
    use std::os::unix::io::AsRawFd;
    if let Ok(source) = fs::File::open(source) {
        unsafe {
            libc::fcopyfile(
                source.as_raw_fd(),
                destination.as_raw_fd(),
                std::ptr::null_mut(),
                libc::COPYFILE_XATTR | libc::COPYFILE_ACL,
            );
        }
    }
}

fn normalized_options(input: &Value) -> anyhow::Result<Value> {
    let mut value = input.clone();
    if !value["date"].is_string() {
        value["date"] = json!(time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)?)
    }
    if !value["importedSegments"].is_array() {
        value["importedSegments"] = json!([])
    }
    if !value["attributions"].is_array() {
        value["attributions"] = json!([])
    }
    Ok(value)
}

impl RecordStore {
    pub fn update_profile(&self, id: &str, profile: &str, revision: u64) -> anyhow::Result<()> {
        anyhow::ensure!(
            [
                "interview",
                "discovery",
                "workClient",
                "presentationAnswering"
            ]
            .contains(&profile),
            "invalidProfile"
        );
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let text: String = tx.query_row("SELECT options FROM meetings WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
        let mut options: Value = serde_json::from_str(&text)?;
        options["profileId"] = json!(profile);
        options["profileRevision"] = json!(revision);
        tx.execute(
            "UPDATE meetings SET options=?2 WHERE id=?1",
            params![id, options.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }
}
impl RecordStore {
    pub fn mark_translation_pending(&self, id: &str) -> anyhow::Result<()> {
        self.connection()?.execute(
            "UPDATE chunks SET status='translationPending' WHERE id=?1",
            [id],
        )?;
        Ok(())
    }
    pub fn retry_translations(&self, meeting: &str) -> anyhow::Result<()> {
        let c = self.connection()?;
        let mut q =
            c.prepare("SELECT id,lane,start_ms,path FROM chunks WHERE meeting_id=?1 AND status='translationPending'")?;
        let ids = q
            .query_map([meeting], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, lane, start_ms, path) in ids {
            let source = current_source(&c, meeting, &id)?;
            // Older records have no trusted clipping intervals. Re-decode only
            // after explicit recovery; never widen a translation to all audio.
            if translatable(source.as_ref(), &lane, start_ms) {
                continue;
            }
            // Re-recognition reads the chunk's WAV. Without it the chunk would stay queued forever, so it
            // ends as translation unavailable; its source-language evidence is kept.
            let audio_kept = fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
            let status = if audio_kept { "pending" } else { "translationUnavailable" };
            c.execute("UPDATE chunks SET status=?3 WHERE meeting_id=?1 AND id=?2 AND status='translationPending'", params![meeting, id, status])?;
        }
        Ok(())
    }
    pub fn pending_translations(&self, meeting: &str) -> anyhow::Result<Vec<Value>> {
        let c = self.connection()?;
        let mut q = c.prepare("SELECT id,path,lane,start_ms FROM chunks WHERE meeting_id=?1 AND status='translationPending' ORDER BY rowid")?;
        let rows = q
            .query_map([meeting], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut jobs = Vec::new();
        for (id, path, lane, start_ms) in rows {
            let Some(source) = current_source(&c, meeting, &id)? else {
                continue;
            };
            if !valid_translation_intervals(&source)
                || source["language"] == "en"
                || source["lane"].as_str() != Some(lane.as_str())
                || source["startMs"].as_i64() != Some(start_ms)
            {
                continue;
            }
            jobs.push(json!({"kind":"translateUtterance","meetingId":meeting,"segmentId":id,"revision":source["revision"],"lane":source["lane"],"audioPath":path,"source":source}));
        }
        Ok(jobs)
    }
    /// Check current source and insert/complete in one transaction. A late
    /// translation cannot finish newer evidence or change physical provenance.
    pub fn commit_translation(&self, event: &Value) -> anyhow::Result<Option<Value>> {
        anyhow::ensure!(
            event["kind"] == "translation"
                && event["language"] == "en"
                && event["text"].as_str().is_some_and(|s| !s.trim().is_empty()),
            "invalidTranslation"
        );
        let meeting = event["meetingId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidTranslation"))?;
        let segment = event["sourceSegmentId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidTranslation"))?;
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let Some(source) = current_source(&tx, meeting, segment)? else {
            return Ok(None);
        };
        if source["revision"] != event["revision"] {
            return Ok(None);
        }
        anyhow::ensure!(
            valid_translation_intervals(&source) && source["language"] != "en",
            "invalidTranslationSource"
        );
        let (lane, start_ms): (String, i64) = tx.query_row(
            "SELECT lane,start_ms FROM chunks WHERE meeting_id=?1 AND id=?2",
            params![meeting, segment],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        anyhow::ensure!(
            source["lane"].as_str() == Some(lane.as_str())
                && source["startMs"].as_i64() == Some(start_ms),
            "captureProvenanceMismatch"
        );
        anyhow::ensure!(
            source["lane"] == event["lane"]
                && source["startMs"] == event["startMs"]
                && source["endMs"] == event["endMs"]
                && event["segmentId"].as_str() == Some(format!("{segment}:en").as_str()),
            "captureProvenanceMismatch"
        );
        let (saved, inserted) = insert_event(&tx, event)?;
        tx.execute("UPDATE chunks SET status='decoded' WHERE meeting_id=?1 AND id=?2 AND status='translationPending'", params![meeting, segment])?;
        tx.commit()?;
        Ok(inserted.then_some(saved))
    }
}

fn insert_event(c: &Connection, event: &Value) -> anyhow::Result<(Value, bool)> {
    let id = event["meetingId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalidEvent"))?;
    anyhow::ensure!(valid_id(id), "invalidMeetingId");
    anyhow::ensure!(
        matches!(event["lane"].as_str(), Some("me" | "remote")),
        "invalidCaptureLane"
    );
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1)",
        [id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(exists, "unknownMeeting");
    let inserted = c.execute("INSERT OR IGNORE INTO events(meeting_id,segment_id,revision,kind,body) VALUES(?1,?2,?3,?4,?5)", params![id,event["segmentId"].as_str(),event["revision"].as_i64(),event["kind"].as_str(),event.to_string()])? == 1;
    let (body, sequence): (String, i64) = c.query_row("SELECT body,sequence FROM events WHERE meeting_id=?1 AND segment_id=?2 AND revision=?3 AND kind=?4", params![id,event["segmentId"].as_str(),event["revision"].as_i64(),event["kind"].as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut saved: Value = serde_json::from_str(&body)?;
    saved["journalSequence"] = json!(sequence);
    Ok((saved, inserted))
}
fn current_source(c: &Connection, meeting: &str, segment: &str) -> anyhow::Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    let body: Option<String> = c.query_row("SELECT body FROM events WHERE meeting_id=?1 AND segment_id=?2 AND kind='final' ORDER BY revision DESC,sequence DESC LIMIT 1", params![meeting,segment], |r| r.get(0)).optional()?;
    body.map(|body| serde_json::from_str(&body).map_err(Into::into))
        .transpose()
}
/// Whether the chunk's current source can be translated from its text alone, without re-recognition.
fn translatable(source: Option<&Value>, lane: &str, start_ms: i64) -> bool {
    source.is_some_and(|source| {
        valid_translation_intervals(source)
            && source["lane"].as_str() == Some(lane)
            && source["startMs"].as_i64() == Some(start_ms)
    })
}
fn valid_translation_intervals(source: &Value) -> bool {
    let Some(intervals) = source["acceptedIntervals"].as_array() else {
        return false;
    };
    let duration =
        source["endMs"].as_f64().unwrap_or(0.0) - source["startMs"].as_f64().unwrap_or(0.0);
    if source["kind"] != "final"
        || intervals.is_empty()
        || intervals.len() > 1024
        || duration <= 0.0
    {
        return false;
    }
    let mut through = 0.0;
    for interval in intervals {
        let (Some(start), Some(end)) = (interval["start"].as_f64(), interval["end"].as_f64())
        else {
            return false;
        };
        if !start.is_finite()
            || !end.is_finite()
            || start < through
            || end <= start
            || end * 1000.0 > duration + 1.0
        {
            return false;
        }
        through = end;
    }
    true
}

/// How many times launch recovery claims one interrupted meeting before leaving it for Retry processing.
pub const AUTO_RECOVERY_ATTEMPTS: i64 = 3;
fn recovery_of(c: &Connection, id: &str) -> anyhow::Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    let state: Option<String> = c
        .query_row("SELECT state FROM recovery WHERE meeting_id=?1", [id], |r| r.get(0))
        .optional()?;
    Ok(state.map(|state| json!({"state": state})))
}
/// Translations by the source segment and revision they translate, in journal order. A lookup returns the
/// first translation that also passes `accept`, the same one a scan of the journal would find.
struct TranslationIndex<'a> {
    by_source: std::collections::HashMap<(&'a str, String), Vec<&'a Value>>,
}
impl<'a> TranslationIndex<'a> {
    fn new(events: &'a [Value]) -> Self {
        let mut by_source = std::collections::HashMap::<(&str, String), Vec<&Value>>::new();
        for event in events.iter().filter(|e| e["kind"] == "translation") {
            if let Some(source) = event["sourceSegmentId"].as_str() {
                by_source.entry((source, revision_key(&event["revision"]))).or_default().push(event);
            }
        }
        Self { by_source }
    }
    fn find(&self, source: &Value, accept: impl Fn(&Value) -> bool) -> Option<&'a Value> {
        let segment = source["segmentId"].as_str()?;
        self.by_source
            .get(&(segment, revision_key(&source["revision"])))?
            .iter()
            .copied()
            .find(|t| t["revision"] == source["revision"] && accept(t))
    }
}
/// A bucket key for a revision. Equal JSON values always share a key; `find` still compares the values.
fn revision_key(revision: &Value) -> String {
    match revision.as_f64() {
        Some(number) => format!("n{number}"),
        None => revision.to_string(),
    }
}
/// "unavailable": nothing is left to process, but some source can no longer be translated (its audio is
/// gone and it has no trusted intervals). Its source-language evidence is in the record.
fn translation_status(
    events: &[Value],
    pending: i64,
    unavailable: &std::collections::HashSet<String>,
) -> &'static str {
    if pending > 0 {
        return "pending";
    }
    let translations = TranslationIndex::new(events);
    let untranslated: Vec<&Value> = latest_sources(events)
        .into_iter()
        .filter(|e| e["kind"] == "final" && e["language"] != "en")
        .filter(|e| translations.find(e, |_| true).is_none())
        .collect();
    if untranslated.is_empty() {
        "complete"
    } else if untranslated
        .iter()
        .all(|e| e["segmentId"].as_str().is_some_and(|s| unavailable.contains(s)))
    {
        "unavailable"
    } else {
        "pending"
    }
}
fn latest_sources(events: &[Value]) -> Vec<&Value> {
    let mut latest = std::collections::HashMap::<&str, &Value>::new();
    for event in events.iter().filter(|e| e["kind"] == "final") {
        if let Some(id) = event["segmentId"].as_str() {
            if latest.get(id).is_none_or(|old| {
                old["revision"].as_u64().unwrap_or(0) < event["revision"].as_u64().unwrap_or(0)
            }) {
                latest.insert(id, event);
            }
        }
    }
    let mut result: Vec<_> = latest.into_values().collect();
    result.sort_by_key(|e| e["startMs"].as_u64().unwrap_or(0));
    result
}
impl RecordStore {
    pub fn has_chunk_at(&self, meeting: &str, lane: &str, start_ms: u64) -> anyhow::Result<bool> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM chunks WHERE meeting_id=?1 AND lane=?2 AND start_ms=?3)",
            params![meeting, lane, start_ms as i64],
            |r| r.get(0),
        )?)
    }
}

pub fn source_text(record: &Value) -> String {
    let events = record["segments"].as_array().cloned().unwrap_or_default();
    let translations = TranslationIndex::new(&events);
    let mut text = String::new();
    for source in latest_sources(&events) {
        text.push_str(source["text"].as_str().unwrap_or(""));
        text.push('\n');
        if let Some(t) = translations.find(source, |_| true) {
            text.push_str(t["text"].as_str().unwrap_or(""));
            text.push('\n');
        }
    }
    for source in record["importedSegments"].as_array().into_iter().flatten() {
        text.push_str(source["text"].as_str().unwrap_or(""));
        text.push('\n');
    }
    text
}

impl RecordStore {
    pub fn people(&self) -> anyhow::Result<Vec<Value>> {
        let c = self.connection()?;
        let mut q = c.prepare("SELECT id,name FROM people ORDER BY name,id")?;
        let people = q
            .query_map([], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(people)
    }
}
#[tauri::command]
pub fn list_people() -> Result<Vec<Value>, String> {
    RecordStore::open(&crate::commands::data_root())
        .and_then(|s| s.people())
        .map_err(|_| "peopleUnavailable".into())
}
