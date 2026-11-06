//! Free disk space for recording. A meeting writes its raw journal and chunk WAVs locally (about 0.5 GB
//! per hour with both lanes), so a nearly full disk is refused at start and warned about during
//! recording. A low disk never stops a recording that is already running.
use std::path::Path;

/// Below this a meeting does not start: about an hour of audio would not fit.
pub const REFUSE_BELOW_BYTES: u64 = 500 * 1024 * 1024;
/// Below this the lanes show a warning, at start and during recording.
pub const WARN_BELOW_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How often a running meeting re-checks free space.
pub const RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DiskVerdict {
    Enough,
    Low,
    Insufficient,
}

pub fn verdict(free_bytes: Option<u64>) -> DiskVerdict {
    match free_bytes {
        // An unreadable volume is not a reason to refuse a recording.
        None => DiskVerdict::Enough,
        Some(free) if free < REFUSE_BELOW_BYTES => DiskVerdict::Insufficient,
        Some(free) if free < WARN_BELOW_BYTES => DiskVerdict::Low,
        Some(_) => DiskVerdict::Enough,
    }
}

/// Bytes available to this user on the volume holding `path` (or its nearest existing parent).
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let existing = path.ancestors().find(|p| p.exists())?;
    let c_path = std::ffi::CString::new(existing.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: c_path is a valid NUL-terminated path and stats points to writable memory of the right size.
    let status = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if status != 0 {
        return None;
    }
    // SAFETY: statvfs returned 0, so it filled the struct.
    let stats = unsafe { stats.assume_init() };
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

/// Plain words for the lane warning, with the free space rounded to tenths of a GB.
pub fn low_space_detail(free: u64) -> String {
    format!(
        "Only {:.1} GB free on the recording disk. Recording continues; free space soon.",
        free as f64 / 1_073_741_824.0
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thresholds_refuse_warn_and_allow() {
        assert_eq!(verdict(Some(100 * 1024 * 1024)), DiskVerdict::Insufficient);
        assert_eq!(verdict(Some(REFUSE_BELOW_BYTES)), DiskVerdict::Low);
        assert_eq!(verdict(Some(WARN_BELOW_BYTES - 1)), DiskVerdict::Low);
        assert_eq!(verdict(Some(WARN_BELOW_BYTES)), DiskVerdict::Enough);
        assert_eq!(verdict(None), DiskVerdict::Enough);
    }
    #[test]
    fn free_space_is_read_for_a_path_that_does_not_exist_yet() {
        let missing = std::env::temp_dir().join(format!("li-disk-{}/a/b", uuid::Uuid::new_v4()));
        assert!(free_bytes(&missing).is_some_and(|free| free > 0));
    }
    #[test]
    fn the_warning_quotes_free_space_in_gigabytes() {
        assert!(low_space_detail(1_610_612_736).contains("1.5 GB"));
    }
}
