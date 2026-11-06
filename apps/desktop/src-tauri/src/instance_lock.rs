//! One recording process per data root. Two copies of the app share the records and the raw audio cache, so the
//! copy that does not hold this lock must never run launch recovery, the retention sweep, or start/finish a
//! recording: it would treat the other copy's live meeting as interrupted.
use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub const LOCK_FILE: &str = "instance.lock";
/// The error a command returns in the copy that does not hold the lock.
pub const ANOTHER_INSTANCE: &str = "anotherInstance";

/// An advisory exclusive `flock` on `<data root>/instance.lock`, held while this value lives. The kernel releases
/// it when the process exits, however it exits, so a crash never leaves a stale lock.
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    /// `Ok(None)` when another process (or another open of the file in this process) already holds the lock.
    pub fn acquire(root: &Path) -> std::io::Result<Option<InstanceLock>> {
        std::fs::create_dir_all(root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(LOCK_FILE))?;
        // SAFETY: a valid open descriptor owned by `file` for the duration of the call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(InstanceLock { _file: file }));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

/// Managed state: whether this process owns the data root. Kept for the whole process lifetime.
pub struct InstanceGuard {
    _lock: Option<InstanceLock>,
    primary: bool,
}

impl InstanceGuard {
    /// Takes the lock. An unexpected lock error (not "already held") keeps the previous single-process behaviour
    /// rather than blocking recording on a filesystem quirk.
    pub fn take(root: &Path) -> InstanceGuard {
        match InstanceLock::acquire(root) {
            Ok(Some(lock)) => InstanceGuard { _lock: Some(lock), primary: true },
            Ok(None) => {
                log::warn!("[instance] another Live Interview process holds the data root; this one will not record or recover");
                InstanceGuard { _lock: None, primary: false }
            }
            Err(error) => {
                log::warn!("[instance] lock unavailable ({error}); continuing as the only instance");
                InstanceGuard { _lock: None, primary: true }
            }
        }
    }
    pub fn primary(&self) -> bool {
        self.primary
    }
    pub fn require_primary(&self) -> Result<(), String> {
        if self.primary() {
            Ok(())
        } else {
            Err(ANOTHER_INSTANCE.into())
        }
    }
}

/// How recently a meeting's raw audio may have changed and still be treated as interrupted.
pub const RECENT_AUDIO: Duration = Duration::from_secs(30);

/// Whether any file in `cache/<meeting>` was modified within `window` of `now`: something may still be writing it.
pub fn audio_recently_written(root: &Path, meeting: &str, now: SystemTime, window: Duration) -> bool {
    let Ok(entries) = std::fs::read_dir(root.join("cache").join(meeting)) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| now.duration_since(modified).map(|age| age < window).unwrap_or(true))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("li-instance-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_second_attempt_cannot_take_the_lock_until_the_first_is_dropped() {
        let dir = temp_root("lock");
        let first = InstanceLock::acquire(&dir).unwrap();
        assert!(first.is_some());
        assert!(InstanceLock::acquire(&dir).unwrap().is_none());
        let guard = InstanceGuard::take(&dir);
        assert!(!guard.primary());
        assert_eq!(guard.require_primary(), Err(ANOTHER_INSTANCE.to_string()));
        drop(first);
        assert!(InstanceLock::acquire(&dir).unwrap().is_some());
        assert!(InstanceGuard::take(&dir).primary());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recently_written_audio_is_detected_and_old_or_missing_audio_is_not() {
        let dir = temp_root("mtime");
        assert!(!audio_recently_written(&dir, "m1", SystemTime::now(), RECENT_AUDIO));
        let cache = &dir.join("cache").join("m1");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("me.pcm"), [0u8; 4]).unwrap();
        let now = SystemTime::now();
        assert!(audio_recently_written(&dir, "m1", now, RECENT_AUDIO));
        // The same file seen a minute later is old enough to be interrupted.
        assert!(!audio_recently_written(&dir, "m1", now + Duration::from_secs(60), RECENT_AUDIO));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
