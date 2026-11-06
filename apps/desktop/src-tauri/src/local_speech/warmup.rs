//! Remembers which speech helper build has loaded its models on this Mac (#83). CoreML compiles the models
//! for the Neural Engine again whenever the helper binary changes (measured at 144–153 s on an M4), so the
//! first load after an app update is slow. Knowing that lets the app say so, instead of "warming" for minutes.
//! This is a hint for wording only: it never gates recording or transcription, and a wrong answer in either
//! direction only changes the status text.
//!
//! The record is keyed by the helper's bytes, not by the model files, on purpose. CoreML's compiled-model cache
//! follows the code identity of the process that loads the model: the same model files loaded by a re-signed copy
//! of the same helper took 246 s, a byte-identical copy at a new path 2.7 s (docs/acceptance/
//! speech-warmup-after-update.md). Candidate builds are signed ad hoc, and an ad hoc identifier is derived from the
//! binary's hash, so every rebuilt helper really does compile again (measured 416 s for the 18 October candidate)
//! even when the models are unchanged. Keying by the models would hide that wait, so a rebuilt app is announced as
//! a first load again. That is correct, not a stale record.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

const FILE: &str = "speech-warmup.json";

/// Shown while the models load for a helper build that has not loaded here before.
pub const FIRST_LOAD_STATUS: &str =
    "Preparing local speech (one-time, a few minutes) · recording continues";
/// Shown when a meeting has to wait for a load that is not the first for this build (for example after the
/// OS evicted CoreML's compiled-model cache).
pub const LOAD_STATUS: &str = "Preparing local speech · recording continues";
/// Shown once a load has finished. Must equal `warmStatus` in `lib/public/speechWarmup.ts`, which clears the notice.
pub const READY_STATUS: &str = "Warm · local";

/// Identifies the helper build by its content. Measured on an M4 (docs/acceptance/speech-warmup-after-update.md):
/// a re-signed helper loads cold (246 s) while the same bytes at a new path load warm (2.7 s), so the location
/// is deliberately not part of the fingerprint.
pub fn fingerprint(binary: &Path) -> Option<String> {
    let mut file = std::fs::File::open(binary).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn stored(root: &Path) -> Option<String> {
    std::fs::read(root.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["helper"].as_str().map(str::to_owned))
}

/// True unless this exact helper build has already loaded its models here. An unreadable helper or state
/// file counts as a first load, which only makes the message more cautious.
pub fn is_first_load(root: &Path, binary: &Path) -> bool {
    match fingerprint(binary) {
        Some(current) => stored(root).as_deref() != Some(current.as_str()),
        None => true,
    }
}

/// Call after a successful warm-up. Failures are ignored: the next launch just says "one-time" again.
pub fn record_loaded(root: &Path, binary: &Path) {
    let Some(current) = fingerprint(binary) else {
        return;
    };
    if std::fs::create_dir_all(root).is_err() {
        return;
    }
    let temporary = root.join(format!("{FILE}.tmp"));
    if std::fs::write(&temporary, json!({"helper": current}).to_string()).is_ok() {
        let _ = std::fs::rename(temporary, root.join(FILE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("li-speech-warmup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn the_first_load_message_says_one_time_and_that_recording_continues() {
        assert!(FIRST_LOAD_STATUS.starts_with("Preparing local speech (one-time, a few minutes)"));
        assert!(FIRST_LOAD_STATUS.contains("recording continues"));
        assert!(LOAD_STATUS.contains("recording continues"));
        assert!(!LOAD_STATUS.contains("one-time"));
    }

    // The front end clears the "Preparing local speech" notice only on this exact text (#58 follow-up: a meeting's
    // load used to leave the notice up until its first decode returned).
    #[test]
    fn the_ready_status_matches_the_front_end_text_that_clears_the_notice() {
        let source = include_str!("../../../src/lib/public/speechWarmup.ts");
        assert!(source.contains(&format!("export const warmStatus = \"{READY_STATUS}\";")));
        assert!(!READY_STATUS.starts_with("Preparing"));
    }

    #[test]
    fn a_helper_that_never_loaded_here_is_a_first_load() {
        let dir = scratch("never");
        let helper = dir.join("local-speech");
        std::fs::write(&helper, "helper v1").unwrap();
        assert!(is_first_load(&dir, &helper));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_recorded_load_is_not_first_until_the_helper_changes() {
        let dir = scratch("recorded");
        let helper = dir.join("local-speech");
        std::fs::write(&helper, "helper v1").unwrap();
        record_loaded(&dir, &helper);
        assert!(!is_first_load(&dir, &helper));
        // An update replaces the binary in place.
        std::fs::write(&helper, "helper v2").unwrap();
        assert!(is_first_load(&dir, &helper));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_helper_at_a_new_path_is_not_a_first_load() {
        let dir = scratch("moved");
        let old = dir.join("old-local-speech");
        let new = dir.join("new-local-speech");
        std::fs::write(&old, "same bytes").unwrap();
        std::fs::write(&new, "same bytes").unwrap();
        record_loaded(&dir, &old);
        assert!(!is_first_load(&dir, &old));
        assert!(!is_first_load(&dir, &new));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_helper_or_state_file_is_treated_as_a_first_load_and_never_panics() {
        let dir = scratch("unreadable");
        let helper = dir.join("local-speech");
        assert!(is_first_load(&dir, &helper));
        record_loaded(&dir, &helper);
        assert!(!dir.join(FILE).exists());
        std::fs::write(&helper, "helper").unwrap();
        std::fs::write(dir.join(FILE), "{not json").unwrap();
        assert!(is_first_load(&dir, &helper));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
