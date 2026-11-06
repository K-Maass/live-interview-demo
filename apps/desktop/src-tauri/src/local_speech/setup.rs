//! First-run model download (#30). The helper does the downloading and reports bytes; this module runs it,
//! relays progress and turns its failure into a code the UI can explain. It holds no worker and no recording
//! lock, so a download never delays or stops a meeting.
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncBufReadExt, BufReader};

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Set by the user's Cancel; cleared when the next download starts so a stale request cannot stop it.
static CANCELLED: AtomicBool = AtomicBool::new(false);
const CANCEL_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// Asks the running download to stop. Nothing running means nothing to cancel (the request is dropped, not queued).
pub fn request_cancel() -> bool {
    let running = RUNNING.load(Ordering::SeqCst);
    if running {
        CANCELLED.store(true, Ordering::SeqCst);
    }
    running
}
pub fn cancel_flag() -> &'static AtomicBool {
    &CANCELLED
}

/// Only one download at a time; a second request while one runs is refused instead of racing for the same files.
pub struct SetupGuard;
impl SetupGuard {
    pub fn acquire() -> Option<Self> {
        let guard = RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self);
        if guard.is_some() {
            CANCELLED.store(false, Ordering::SeqCst);
        }
        guard
    }
}
impl Drop for SetupGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq)]
pub enum SetupLine {
    Progress(Value),
    Complete,
    Failure(Value),
    Other,
}
pub fn parse_line(line: &str) -> SetupLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return SetupLine::Other;
    };
    match value["kind"].as_str() {
        Some("setupProgress") => SetupLine::Progress(value),
        Some("setupComplete") => SetupLine::Complete,
        Some("failure") => SetupLine::Failure(value),
        _ => SetupLine::Other,
    }
}
/// Codes the UI has recovery text for. Anything else is the generic failure.
pub fn error_code(helper_code: Option<&str>) -> &'static str {
    match helper_code {
        Some("diskFull") => "diskFull",
        Some("network") => "network",
        _ => "assetSetupFailed",
    }
}
/// The user stopped the download. Partial files stay on disk, so the next run resumes from them.
pub const CANCELLED_CODE: &str = "cancelled";

#[derive(Debug)]
pub struct SetupError {
    pub code: &'static str,
    /// The helper's failure line (needed and available bytes for a full disk), or null.
    pub details: Value,
}

pub async fn run(
    binary: &Path,
    models: &Path,
    cache: &Path,
    with_medium: bool,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(Value),
) -> Result<(), SetupError> {
    let failed = |code, details| SetupError { code, details };
    let mut command = tokio::process::Command::new(binary);
    command
        .arg(models)
        .arg(cache)
        .arg("--setup")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if with_medium {
        command.arg("--with-medium-translation");
    }
    let mut child = command
        .spawn()
        .map_err(|_| failed("assetSetupFailed", Value::Null))?;
    let Some(stdout) = child.stdout.take() else {
        return Err(failed("assetSetupFailed", Value::Null));
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut complete = false;
    let mut failure: Option<Value> = None;
    loop {
        // Checked on every pass, so a helper that prints more often than the poll interval cannot hold off a cancel.
        if cancelled.load(Ordering::SeqCst) {
            // Only the helper process stops; its partial files stay for the next run to resume from.
            let _ = child.kill().await;
            return Err(failed(CANCELLED_CODE, Value::Null));
        }
        let line = tokio::select! {
            line = lines.next_line() => line,
            _ = tokio::time::sleep(CANCEL_POLL) => continue,
        };
        let Ok(Some(line)) = line else { break };
        match parse_line(&line) {
            SetupLine::Progress(event) => on_progress(event),
            SetupLine::Complete => complete = true,
            SetupLine::Failure(event) => failure = Some(event),
            SetupLine::Other => {}
        }
    }
    let status = child.wait().await;
    if complete && status.is_ok_and(|status| status.success()) {
        return Ok(());
    }
    let details = failure.unwrap_or_else(|| json!(null));
    Err(failed(error_code(details["code"].as_str()), details))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn helper(name: &str, body: &str) -> std::path::PathBuf {
        let script = std::env::temp_dir().join(format!("li-setup-{name}-{}.sh", std::process::id()));
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
    async fn setup(script: &Path, medium: bool) -> (Result<(), SetupError>, Vec<Value>) {
        let mut seen = Vec::new();
        let outcome = run(script, Path::new("/tmp/m"), Path::new("/tmp/c"), medium, &AtomicBool::new(false), |e| seen.push(e)).await;
        (outcome, seen)
    }

    #[test]
    fn helper_lines_are_told_apart() {
        assert!(matches!(parse_line(r#"{"kind":"setupProgress","completedBytes":1}"#), SetupLine::Progress(_)));
        assert_eq!(parse_line(r#"{"kind":"setupComplete"}"#), SetupLine::Complete);
        assert!(matches!(parse_line(r#"{"kind":"failure","code":"diskFull"}"#), SetupLine::Failure(_)));
        assert_eq!(parse_line("downloading… 12%"), SetupLine::Other);
        assert_eq!(parse_line(r#"{"kind":"ready"}"#), SetupLine::Other);
    }

    #[test]
    fn only_known_failures_get_their_own_code() {
        assert_eq!(error_code(Some("diskFull")), "diskFull");
        assert_eq!(error_code(Some("network")), "network");
        assert_eq!(error_code(Some("assetSetup")), "assetSetupFailed");
        assert_eq!(error_code(Some("whatever")), "assetSetupFailed");
        assert_eq!(error_code(None), "assetSetupFailed");
    }

    #[tokio::test]
    async fn progress_is_relayed_and_completion_needs_the_complete_line() {
        let script = helper(
            "ok",
            r#"echo '{"kind":"setupProgress","stage":"downloading","completedBytes":10,"totalBytes":100}'; echo 'noise'; echo '{"kind":"setupProgress","stage":"downloading","completedBytes":100,"totalBytes":100}'; echo '{"kind":"setupComplete"}'"#,
        );
        let (outcome, seen) = setup(&script, false).await;
        assert!(outcome.is_ok());
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1]["completedBytes"], 100);
    }

    #[tokio::test]
    async fn a_full_disk_keeps_its_numbers_for_the_recovery_message() {
        let script = helper(
            "full",
            r#"echo '{"kind":"failure","code":"diskFull","neededBytes":4300000000,"availableBytes":900000000}'; exit 1"#,
        );
        let (outcome, _) = setup(&script, false).await;
        let error = outcome.unwrap_err();
        assert_eq!(error.code, "diskFull");
        assert_eq!(error.details["neededBytes"], 4_300_000_000u64);
    }

    #[tokio::test]
    async fn a_helper_that_dies_without_a_result_is_a_generic_failure_not_success() {
        let script = helper("died", "exit 0");
        let (outcome, _) = setup(&script, false).await;
        assert_eq!(outcome.unwrap_err().code, "assetSetupFailed");
        let (missing, _) = setup(Path::new("/nonexistent/local-speech"), false).await;
        assert_eq!(missing.unwrap_err().code, "assetSetupFailed");
    }

    #[tokio::test]
    async fn medium_translation_is_requested_only_when_asked_for() {
        let script = helper(
            "flag",
            r#"case "$*" in *--with-medium-translation*) echo '{"kind":"setupProgress","stage":"medium"}';; esac; echo '{"kind":"setupComplete"}'"#,
        );
        assert_eq!(setup(&script, false).await.1.len(), 0);
        assert_eq!(setup(&script, true).await.1.len(), 1);
    }

    #[tokio::test]
    async fn cancelling_stops_the_helper_and_reports_cancelled_not_failure() {
        let script = helper(
            "slow",
            r#"echo '{"kind":"setupProgress","stage":"downloading","completedBytes":10,"totalBytes":100}'; sleep 30; echo '{"kind":"setupComplete"}'"#,
        );
        let cancelled = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let mut seen = Vec::new();
        // Cancel as soon as the first progress line arrives, so the test does not depend on how fast the helper starts.
        let outcome = run(&script, Path::new("/tmp/m"), Path::new("/tmp/c"), false, &cancelled, |e| {
            seen.push(e);
            cancelled.store(true, Ordering::SeqCst);
        })
        .await;
        assert_eq!(outcome.unwrap_err().code, CANCELLED_CODE);
        assert_eq!(seen.len(), 1, "progress before the cancel was relayed");
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "the helper was killed, not waited for");
    }

    #[test]
    fn a_second_download_is_refused_and_a_cancel_only_applies_to_the_running_one() {
        // One test owns the globals so parallel tests cannot interleave with it.
        let only = SetupGuard::acquire().expect("free at first");
        assert!(SetupGuard::acquire().is_none());
        drop(only);
        assert!(!request_cancel(), "nothing running, nothing to cancel");
        assert!(!cancel_flag().load(Ordering::SeqCst));
        let first = SetupGuard::acquire().expect("free");
        assert!(request_cancel());
        assert!(cancel_flag().load(Ordering::SeqCst));
        drop(first);
        let second = SetupGuard::acquire().expect("free again");
        assert!(!cancel_flag().load(Ordering::SeqCst), "a stale cancel must not stop the next download");
        drop(second);
    }
}
