//! Raw audio lifetime for meetings recorded with `retainAudio: false`.
//!
//! A chunk's WAV is needed until its recognition is final. After that only the experimental Whisper medium
//! route reads it again (Apple translation works from the recognized text), so it is deleted unless that
//! route is on. A lane's raw `.pcm` journal is needed only for crash recovery and is deleted once every
//! sample is checkpointed into registered chunks and capture has finished.
use super::RecordStore;
use std::{fs, path::Path};

/// Cache folders with no meeting row are removed once untouched this long.
pub const ORPHAN_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

impl RecordStore {
    fn retains_audio(&self, meeting: &str) -> anyhow::Result<bool> {
        let options: String = self.connection()?.query_row(
            "SELECT options FROM meetings WHERE id=?1",
            [meeting],
            |r| r.get(0),
        )?;
        let options: serde_json::Value = serde_json::from_str(&options)?;
        Ok(options["retainAudio"].as_bool().unwrap_or(false))
    }

    /// Deletes the WAVs of `meeting`'s chunks whose recognition is final. Returns how many were removed.
    /// Nothing is removed when the meeting retains audio.
    pub fn release_recognized_audio(
        &self,
        meeting: &str,
        keep_translation_audio: bool,
    ) -> anyhow::Result<usize> {
        if self.retains_audio(meeting)? {
            return Ok(0);
        }
        let c = self.connection()?;
        let mut q = c.prepare(
            "SELECT id,status,lane,start_ms FROM chunks WHERE meeting_id=?1 AND status IN ('decoded','translationPending')",
        )?;
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
        let mut removed = 0;
        for (id, status, lane, start_ms) in rows {
            if status == "translationPending"
                && (keep_translation_audio
                    // A source without trusted intervals (records written before them) can only be
                    // translated after re-recognition, which reads this WAV.
                    || !super::translatable(super::current_source(&c, meeting, &id)?.as_ref(), &lane, start_ms))
            {
                continue;
            }
            removed += usize::from(self.remove_owned_cache_file(meeting, &format!("{id}.wav"))?);
        }
        Ok(removed)
    }

    /// Deletes each lane's raw journal and checkpoint once every sample is in registered chunks. Call only
    /// after capture for `meeting` has finished.
    pub fn release_raw_journal(&self, meeting: &str) -> anyhow::Result<bool> {
        if self.retains_audio(meeting)?
            || crate::local_speech::recording::has_raw_tail(&self.root, meeting)?
        {
            return Ok(false);
        }
        let mut removed = false;
        for lane in ["me", "remote"] {
            removed |= self.remove_owned_cache_file(meeting, &format!("{lane}.pcm"))?;
            self.remove_owned_cache_file(meeting, &format!("{lane}.checkpoint.json"))?;
        }
        Ok(removed)
    }

    fn remove_owned_cache_file(&self, meeting: &str, name: &str) -> anyhow::Result<bool> {
        if fs::symlink_metadata(self.root.join("cache").join(meeting)).is_err() {
            return Ok(false);
        }
        let path = crate::owned_paths::file(&self.root, &["cache", meeting, name], false)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

/// Startup sweep (no meeting is active yet): applies the retention rule to every meeting that does not
/// retain audio, and removes cache folders that belong to no meeting once older than `orphan_ttl`. Audio
/// whose recognition is not final, or that is not yet checkpointed into chunks, is always kept so Recover
/// still works. Returns the number of files and folders removed.
pub fn sweep_raw_audio(
    root: &Path,
    keep_translation_audio: bool,
    orphan_ttl: std::time::Duration,
) -> anyhow::Result<usize> {
    let cache = root.join("cache");
    if fs::symlink_metadata(&cache).is_err() {
        return Ok(0);
    }
    let cache = crate::owned_paths::directory(root, &["cache"], false)?;
    let store = RecordStore::open(root)?;
    // Meeting id -> whether it was stopped. A meeting still marked recording may be the one the person
    // just started, so its raw journal is never touched here.
    let known: std::collections::HashMap<String, bool> = {
        let c = store.connection()?;
        let mut q = c.prepare("SELECT id,status FROM meetings")?;
        let ids = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)? == "stopped")))?
            .collect::<Result<_, _>>()?;
        ids
    };
    let mut removed = 0;
    for entry in fs::read_dir(&cache)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || !super::valid_id(&name) {
            continue;
        }
        if let Some(&stopped) = known.get(&name) {
            // One meeting's failure must not stop the sweep of the others.
            removed += store
                .release_recognized_audio(&name, keep_translation_audio)
                .unwrap_or(0);
            if stopped {
                removed += usize::from(store.release_raw_journal(&name).unwrap_or(false));
                let _ = fs::remove_dir(entry.path()); // Only succeeds when nothing is left.
            }
        } else if metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= orphan_ttl)
        {
            let dir = crate::owned_paths::directory(root, &["cache", &name], false)?;
            fs::remove_dir_all(dir)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn store(retain: bool) -> (std::path::PathBuf, RecordStore) {
        let root = std::env::temp_dir().join(format!("li-retention-{}", uuid::Uuid::new_v4()));
        let store = RecordStore::open(&root).unwrap();
        store.create("m", &json!({"id":"m","retainAudio":retain})).unwrap();
        fs::create_dir_all(root.join("cache/m")).unwrap();
        (root, store)
    }
    fn chunk(root: &Path, store: &RecordStore, id: &str, start_ms: u64, status: &str) -> std::path::PathBuf {
        let path = root.join("cache/m").join(format!("{id}.wav"));
        fs::write(&path, b"wav").unwrap();
        store.add_chunk(id, "m", "remote", &path, start_ms).unwrap();
        store
            .connection()
            .unwrap()
            .execute("UPDATE chunks SET status=?2 WHERE id=?1", rusqlite::params![id, status])
            .unwrap();
        path
    }
    // An untranslated meeting (no language pack, macOS before 26) used to keep every WAV and both raw
    // journals forever. Recognized audio goes regardless of translation; audio awaiting recognition stays.
    #[test]
    fn recognized_audio_is_released_whatever_the_translation_state() {
        let (root, store) = store(false);
        let decoded = chunk(&root, &store, "a", 0, "decoded");
        let untranslated = chunk(&root, &store, "b", 9000, "translationPending");
        store.append_event(&json!({"meetingId":"m","segmentId":"b","revision":1,"lane":"remote","kind":"final","text":"Wer?","language":"de","startMs":9000,"endMs":10000,"acceptedIntervals":[{"start":0.1,"end":0.9}]})).unwrap();
        let legacy = chunk(&root, &store, "l", 12000, "translationPending");
        store.append_event(&json!({"meetingId":"m","segmentId":"l","revision":1,"lane":"remote","kind":"final","text":"Wann?","language":"de","startMs":12000,"endMs":13000})).unwrap();
        let pending = chunk(&root, &store, "c", 18000, "pending");
        assert_eq!(store.release_recognized_audio("m", false).unwrap(), 2);
        assert!(!decoded.exists() && !untranslated.exists());
        assert!(pending.exists(), "audio awaiting recognition is kept");
        assert!(legacy.exists(), "a source without intervals needs its audio to be re-recognized");
        let _ = fs::remove_dir_all(root);
    }
    // A stopped record written by main: translationPending, no acceptedIntervals. The startup sweep must
    // leave its WAV so Recover can re-recognize it.
    #[test]
    fn the_startup_sweep_keeps_audio_of_a_record_written_without_intervals() {
        let (root, store) = store(false);
        let legacy = chunk(&root, &store, "l", 0, "translationPending");
        store.append_event(&json!({"meetingId":"m","segmentId":"l","revision":1,"lane":"remote","kind":"final","text":"Wann?","language":"de","startMs":0,"endMs":1000})).unwrap();
        store.finish("m").unwrap();
        sweep_raw_audio(&root, false, std::time::Duration::ZERO).unwrap();
        assert!(legacy.exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn the_audio_translation_route_keeps_untranslated_audio() {
        let (root, store) = store(false);
        let untranslated = chunk(&root, &store, "b", 0, "translationPending");
        assert_eq!(store.release_recognized_audio("m", true).unwrap(), 0);
        assert!(untranslated.exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn retained_audio_is_never_released() {
        let (root, store) = store(true);
        let decoded = chunk(&root, &store, "a", 0, "decoded");
        fs::write(root.join("cache/m/me.pcm"), b"").unwrap();
        assert_eq!(store.release_recognized_audio("m", false).unwrap(), 0);
        assert!(!store.release_raw_journal("m").unwrap());
        assert!(decoded.exists() && root.join("cache/m/me.pcm").exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn a_raw_journal_with_an_unrecovered_tail_is_kept() {
        let (root, store) = store(false);
        fs::write(root.join("cache/m/me.pcm"), [0u8; 64]).unwrap();
        fs::write(root.join("cache/m/me.checkpoint.json"), br#"{"bytes":32,"timelineFrame":16}"#).unwrap();
        assert!(!store.release_raw_journal("m").unwrap());
        fs::write(root.join("cache/m/me.checkpoint.json"), br#"{"bytes":64,"timelineFrame":32}"#).unwrap();
        assert!(store.release_raw_journal("m").unwrap());
        assert!(!root.join("cache/m/me.pcm").exists() && !root.join("cache/m/me.checkpoint.json").exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn the_startup_sweep_cleans_stopped_meetings_and_old_orphans_only() {
        let (root, store) = store(false);
        let decoded = chunk(&root, &store, "a", 0, "decoded");
        fs::write(root.join("cache/m/remote.pcm"), [0u8; 8]).unwrap();
        fs::write(root.join("cache/m/remote.checkpoint.json"), br#"{"bytes":8,"timelineFrame":4}"#).unwrap();
        fs::create_dir_all(root.join("cache/orphan")).unwrap();
        fs::write(root.join("cache/orphan/x.wav"), b"wav").unwrap();
        // Still marked recording: its recognized WAV goes, but its raw journal is left alone.
        sweep_raw_audio(&root, false, std::time::Duration::from_secs(3600)).unwrap();
        assert!(!decoded.exists());
        assert!(root.join("cache/m/remote.pcm").exists());
        assert!(root.join("cache/orphan").exists(), "a recent orphan is kept");
        store.finish("m").unwrap();
        sweep_raw_audio(&root, false, std::time::Duration::ZERO).unwrap();
        assert!(!root.join("cache/m").exists());
        assert!(!root.join("cache/orphan").exists());
        let _ = fs::remove_dir_all(root);
    }
}
