//! Privacy-preserving crash reports (#47).
//!
//! A panic, or a launch that finds the previous run did not exit cleanly, leaves one small JSON report on
//! this Mac. Nothing leaves it unless the person reads the report on the next launch and chooses to send
//! it, and only in a build that has `PUBLIC_CRASH_ENDPOINT`. The report is built from an allow-list: app
//! version, OS, a scrubbed panic location, a scrubbed backtrace and a day. It never holds the panic
//! message (which can quote anything, including transcript text), thread-local data, request bodies,
//! notes, file names, account data or any path that names the user. Sending happens only when the person
//! clicks Send, is bounded to 10 seconds on its own task, and a failure only leaves the report where it
//! is. Writing a report costs a backtrace capture on the panicking thread (bounded to five per run), so a
//! panic that something recovers from briefly slows that thread and still leaves a report. That is the
//! price of a useful report; nothing waits on the network. The exception is a panic expected and caught
//! through `catch_expected` (third-party parsing of untrusted files), which is a handled failure, not a crash.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

const DIR: &str = "crash-reports";
const MARKER: &str = "running.marker";
const FORMAT: u32 = 1;
const MAX_REPORTS: usize = 5;
const MAX_FRAMES: usize = 40;
const MAX_BYTES: u64 = 32 * 1024;
const MAX_PANICS_PER_RUN: usize = 5;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static IN_HOOK: AtomicBool = AtomicBool::new(false);
static PANICS: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    /// Set while this thread runs code under `catch_expected`.
    static EXPECTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// True while the current thread runs inside `catch_expected`. Never panics, even while the
/// thread's locals are being destroyed.
fn panic_is_expected() -> bool {
    EXPECTED.try_with(std::cell::Cell::get).unwrap_or(false)
}

/// Runs `f` and turns a panic into `Err(())`. Such a panic is a handled failure of third-party
/// code on untrusted input (a malformed PDF, say), not a crash: the hook neither writes a report
/// nor prints it. Only panics on the calling thread are covered.
pub fn catch_expected<R>(f: impl FnOnce() -> R) -> Result<R, ()> {
    let outer = EXPECTED.with(|e| e.replace(true));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    EXPECTED.with(|e| e.set(outer));
    result.map_err(|_| ())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub format: u32,
    pub id: String,
    /// `panic` or `unexpectedExit`.
    pub kind: String,
    pub app_version: String,
    pub os: String,
    /// UTC day only, for example `2026-10-15`.
    pub day: String,
    /// Scrubbed `file:line:column` of the panic, if known.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub location: Option<String>,
    /// Scrubbed thread name, if it is a plain identifier.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub thread: Option<String>,
    pub frames: Vec<String>,
}

// ---------------------------------------------------------------- scrubbing

fn plain(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/')
}

/// Reduces a source path to something that cannot name the user: a path inside this crate, inside a
/// dependency (`name-version/...`), or inside the Rust standard library. Anything else becomes `other`.
pub fn scrub_path(raw: &str) -> String {
    let path = raw.trim().replace('\\', "/");
    if let Some(i) = path.find("/.cargo/registry/src/") {
        let rest = &path[i + "/.cargo/registry/src/".len()..];
        // `<index-dir>/<crate-version>/<file>`: drop the index directory.
        return match rest.split_once('/') {
            Some((_, krate)) if krate.chars().all(plain) && !krate.contains("..") => {
                format!("crates/{krate}")
            }
            _ => "other".into(),
        };
    }
    if let Some(i) = path.find("/rustc/") {
        let rest = &path[i + "/rustc/".len()..];
        return match rest.split_once('/') {
            Some((_, std)) if std.chars().all(plain) && !std.contains("..") => format!("rust/{std}"),
            _ => "other".into(),
        };
    }
    if let Some(i) = path.rfind("src-tauri/") {
        let rest = &path[i..];
        if rest.chars().all(plain) && !rest.contains("..") {
            return rest.to_owned();
        }
        return "other".into();
    }
    // A relative path as the compiler recorded it (`src/commands.rs`).
    if !path.starts_with('/') && path.chars().all(plain) && !path.contains("..") && !path.is_empty() {
        return path.trim_start_matches("./").to_owned();
    }
    "other".into()
}

/// Removes the compiler's `::h<16 hex>` hash and refuses anything that is not a plausible symbol.
pub fn scrub_symbol(raw: &str) -> String {
    let mut symbol = raw.trim();
    if let Some(i) = symbol.rfind("::h") {
        let hash = &symbol[i + 3..];
        if hash.len() == 16 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            symbol = &symbol[..i];
        }
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || " _:<>{}$,&*[]()'.#;=-".contains(c);
    if symbol.is_empty() || symbol.chars().count() > 160 || !symbol.chars().all(allowed) {
        return "<unprintable>".into();
    }
    symbol.to_owned()
}

fn scrub_thread(name: Option<&str>) -> Option<String> {
    name.filter(|n| !n.is_empty() && n.len() <= 40 && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':')))
        .map(str::to_owned)
}

/// Turns `std::backtrace::Backtrace`'s text into `symbol (path:line)` lines, dropping the frames of the
/// panic machinery itself and keeping at most `MAX_FRAMES`.
pub fn scrub_backtrace(text: &str) -> Vec<String> {
    let mut frames: Vec<(String, Option<String>)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some((index, symbol)) = trimmed.split_once(": ") {
            if !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) {
                frames.push((scrub_symbol(symbol), None));
                continue;
            }
        }
        if let Some(location) = trimmed.strip_prefix("at ") {
            if let Some(last) = frames.last_mut() {
                let mut parts = location.rsplitn(3, ':');
                let (column, row, file) = (parts.next(), parts.next(), parts.next());
                last.1 = Some(match (file, row, column) {
                    (Some(file), Some(row), Some(column))
                        if row.chars().all(|c| c.is_ascii_digit()) && column.chars().all(|c| c.is_ascii_digit()) =>
                    {
                        format!("{}:{row}", scrub_path(file))
                    }
                    _ => scrub_path(location),
                });
            }
        }
    }
    let machinery = |symbol: &str| {
        symbol.starts_with("std::backtrace")
            || symbol.starts_with("std::panicking")
            || symbol.starts_with("core::panicking")
            || symbol.starts_with("rust_begin_unwind")
            || symbol.contains("crash_report::")
    };
    frames
        .into_iter()
        .filter(|(symbol, _)| !machinery(symbol))
        .take(MAX_FRAMES)
        .map(|(symbol, at)| match at {
            Some(at) => format!("{symbol} ({at})"),
            None => symbol,
        })
        .collect()
}

fn os_description() -> String {
    // The version comes from the system plist, a plain file read that is safe inside a panic hook.
    let version = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist")
        .ok()
        .and_then(|text| {
            let after = text.split("<key>ProductVersion</key>").nth(1)?;
            let value = after.split("<string>").nth(1)?.split("</string>").next()?;
            value.chars().all(|c| c.is_ascii_digit() || c == '.').then(|| value.to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    format!("{} {} {}", std::env::consts::OS, version, std::env::consts::ARCH)
}

fn utc_day(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .map(|t| format!("{:04}-{:02}-{:02}", t.year(), u8::from(t.month()), t.day()))
        .unwrap_or_else(|_| "unknown".into())
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A single short word of version-like characters: the version and OS fields hold no free text.
fn token(text: &str, max: usize) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_')).take(max).collect()
}

/// Last line of defence: a string that still names a home or temporary directory is replaced whole.
fn clean(text: String) -> String {
    const PRIVATE: [&str; 5] = ["/Users/", "/home/", "/private/", "/var/folders/", "/Volumes/"];
    if PRIVATE.iter().any(|p| text.contains(p)) {
        "<redacted>".into()
    } else {
        text
    }
}

pub fn build_report(
    kind: &str,
    version: &str,
    os: &str,
    now: i64,
    location: Option<String>,
    thread: Option<&str>,
    backtrace: &str,
) -> CrashReport {
    build_report_with_id(uuid::Uuid::new_v4().to_string(), kind, version, os, now, location, thread, backtrace)
}

#[allow(clippy::too_many_arguments)]
fn build_report_with_id(
    id: String,
    kind: &str,
    version: &str,
    os: &str,
    now: i64,
    location: Option<String>,
    thread: Option<&str>,
    backtrace: &str,
) -> CrashReport {
    CrashReport {
        format: FORMAT,
        id,
        kind: kind.into(),
        app_version: token(version.split_whitespace().next().unwrap_or(""), 40),
        os: os.split_whitespace().take(3).map(|part| token(part, 20)).collect::<Vec<_>>().join(" "),
        day: utc_day(now),
        location: location.map(clean),
        thread: scrub_thread(thread),
        frames: scrub_backtrace(backtrace).into_iter().map(clean).collect(),
    }
}

// ----------------------------------------------------------------- storage

fn dir(root: &Path) -> PathBuf {
    root.join(DIR)
}
fn file_name(id: &str) -> Option<String> {
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then(|| format!("{id}.json"))
}

fn reports(root: &Path) -> Vec<(std::time::SystemTime, PathBuf)> {
    let mut found: Vec<_> = std::fs::read_dir(dir(root))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    found.sort();
    found
}

pub fn write_report(root: &Path, report: &CrashReport) -> std::io::Result<()> {
    let name = file_name(&report.id).ok_or_else(|| std::io::Error::other("bad id"))?;
    let folder = dir(root);
    std::fs::create_dir_all(&folder)?;
    let mut report = report.clone();
    let mut bytes = serde_json::to_vec(&report)?;
    while bytes.len() as u64 > MAX_BYTES && !report.frames.is_empty() {
        report.frames.truncate(report.frames.len() / 2);
        bytes = serde_json::to_vec(&report)?;
    }
    let temporary = folder.join(format!("{name}.tmp"));
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, folder.join(name))?;
    let existing = reports(root);
    for (_, path) in existing.iter().take(existing.len().saturating_sub(MAX_REPORTS)) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

fn read_report(path: &Path) -> Option<CrashReport> {
    if std::fs::metadata(path).ok()?.len() > MAX_BYTES {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let Some(report) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<CrashReport>(&b).ok()) else {
        let _ = std::fs::remove_file(path);
        return None;
    };
    if report.format != FORMAT || file_name(&report.id).is_none() {
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some(report)
}

/// The newest report waiting for the person's decision. Unreadable files are removed.
pub fn pending(root: &Path) -> Option<CrashReport> {
    reports(root).into_iter().rev().find_map(|(_, path)| read_report(&path))
}

pub fn discard(root: &Path, id: &str) -> bool {
    file_name(id).is_some_and(|name| std::fs::remove_file(dir(root).join(name)).is_ok())
}

fn load(root: &Path, id: &str) -> Option<CrashReport> {
    read_report(&dir(root).join(file_name(id)?)).filter(|r| r.id == id)
}

// ---------------------------------------------------------------- lifecycle

/// Starts a run: reports an unclean end of the previous run, then marks this run as in progress.
/// A previous panic report already explains an unclean end, so no second report is made for it.
pub fn begin_session(root: &Path, version: &str) {
    let marker = root.join(MARKER);
    if marker.exists() && pending(root).is_none() {
        let previous: Value = std::fs::read(&marker).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let report = build_report(
            "unexpectedExit",
            previous["version"].as_str().unwrap_or(version),
            previous["os"].as_str().unwrap_or(&os_description()),
            now_seconds(),
            None,
            None,
            "",
        );
        let _ = write_report(root, &report);
    }
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(&marker, json!({"version": version, "os": os_description()}).to_string());
}

/// Call on every deliberate exit, including the one before an update restart.
pub fn end_session(root: &Path) {
    let _ = std::fs::remove_file(root.join(MARKER));
}

/// Held by the background worker in tests, so a test can observe the state between the hook returning and
/// the worker finishing.
#[cfg(test)]
pub(crate) static WORKER_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn os() -> &'static str {
    static OS: OnceLock<String> = OnceLock::new();
    OS.get_or_init(os_description)
}

/// What the panic hook does for one panic, and why it is split in two.
///
/// A panic hook runs *before* unwinding, so the panicking thread still holds every lock it held when it
/// panicked (a recording or transcription mutex, say), and every microsecond spent here keeps those locks
/// held for the other threads. So the hook only (1) reads the location (the message in `info` is never
/// read), (2) takes the backtrace as raw, unsymbolised frame addresses, and (3) writes a minimal report
/// without frames with one plain `write` (no fsync, no rename) so a crash that kills the process right
/// afterwards still leaves the location. Symbolising the backtrace (slow: it reads the binary's debug
/// tables), serialising it and the durable write happen on a detached short-lived thread that needs none
/// of the application's locks and replaces the minimal file under the same id.
///
/// Nothing here may panic, because a panic inside a panic hook aborts the process and `catch_unwind`
/// cannot prevent that: there is no `unwrap`, indexing or arithmetic, and every error is ignored.
fn record_panic_into(root: &Path, info: &std::panic::PanicHookInfo<'_>) -> Option<std::thread::JoinHandle<()>> {
    if panic_is_expected() {
        return None;
    }
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", scrub_path(l.file()), l.line(), l.column()));
    let thread = std::thread::current().name().map(str::to_owned);
    let backtrace = std::backtrace::Backtrace::force_capture();
    let now = now_seconds();
    let id = uuid::Uuid::new_v4().to_string();
    let version = env!("CARGO_PKG_VERSION");
    let quick = build_report_with_id(id.clone(), "panic", version, os(), now, location.clone(), thread.as_deref(), "");
    if let (Some(name), Ok(bytes)) = (file_name(&id), serde_json::to_vec(&quick)) {
        let folder = dir(root);
        let _ = std::fs::create_dir_all(&folder);
        let _ = std::fs::write(folder.join(name), bytes);
    }
    let root = root.to_path_buf();
    std::thread::Builder::new()
        .name("crash-report".into())
        .spawn(move || {
            #[cfg(test)]
            let _gate = WORKER_GATE.lock();
            let text = backtrace.to_string();
            let full = build_report_with_id(id, "panic", version, os(), now, location, thread.as_deref(), &text);
            let _ = write_report(&root, &full);
        })
        .ok()
}

fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let Some(root) = ROOT.get() else { return };
    if PANICS.fetch_add(1, Ordering::SeqCst) >= MAX_PANICS_PER_RUN {
        return;
    }
    // The worker is detached on purpose: the hook never waits for it.
    drop(record_panic_into(root, info));
}

/// Installs the panic hook and starts the run marker. Every I/O error is ignored and the previous
/// (default) hook still runs. See `record_panic_into` for what the hook may and may not do.
pub fn install(root: PathBuf) {
    if ROOT.set(root.clone()).is_err() {
        return;
    }
    os(); // read once here, not inside the hook
    begin_session(&root, env!("CARGO_PKG_VERSION"));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if panic_is_expected() {
            return; // handled by `catch_expected`: no report, and the message is not printed
        }
        if !IN_HOOK.swap(true, Ordering::SeqCst) {
            record_panic(info);
            IN_HOOK.store(false, Ordering::SeqCst);
        }
        previous(info);
    }));
}

pub fn finish() {
    if let Some(root) = ROOT.get() {
        end_session(root);
    }
}

// ------------------------------------------------------------------ sending

/// Sending exists only in a build with an HTTPS endpoint that carries no credentials or query.
fn valid_endpoint(endpoint: &str) -> bool {
    url::Url::parse(endpoint).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}
fn endpoint() -> Option<&'static str> {
    let value = option_env!("PUBLIC_CRASH_ENDPOINT").unwrap_or("");
    valid_endpoint(value).then_some(value)
}

async fn post(endpoint: &str, report: &CrashReport) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("LiveInterview-crash/1")
        .build()
        .map_err(|_| "crashReportUnavailable")?;
    let response = client.post(endpoint).json(report).send().await.map_err(|_| "crashReportUnavailable")?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err("crashReportUnavailable".into())
    }
}

fn view(report: &CrashReport) -> Value {
    json!({
        "report": report,
        "preview": serde_json::to_string_pretty(report).unwrap_or_default(),
        "sendAvailable": endpoint().is_some(),
    })
}

/// The report waiting for a decision, with the exact text that sending would transmit.
#[tauri::command]
pub fn public_pending_crash_report() -> Value {
    match pending(&crate::edition::data_root()) {
        Some(report) => view(&report),
        None => json!({"report": null, "preview": "", "sendAvailable": endpoint().is_some()}),
    }
}

/// Discards a report, or sends the stored copy (never renderer-supplied content). A failed send keeps the
/// report so the person can try again or discard it.
#[tauri::command]
pub async fn public_resolve_crash_report(id: String, send: bool) -> Result<Value, String> {
    resolve(&crate::edition::data_root(), endpoint(), &id, send).await
}

async fn resolve(root: &Path, endpoint: Option<&str>, id: &str, send: bool) -> Result<Value, String> {
    if !send {
        return Ok(json!({"discarded": discard(root, id)}));
    }
    let endpoint = endpoint.ok_or("crashReportSendUnavailable")?;
    let report = load(root, id).ok_or("crashReportNotFound")?;
    post(endpoint, &report).await?;
    discard(root, id);
    Ok(json!({"sent": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TRANSCRIPT: &str = "Interviewer: the ACME budget is 4.2 million and Priya Natarajan is leaving";
    const EMAIL: &str = "priya.natarajan@acme-private.example";

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("li-crash-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn sample(kind: &str) -> CrashReport {
        build_report(kind, "0.1.0", "macos 15.4 aarch64", 1_760_000_000, Some("src/commands.rs:10:5".into()), Some("main"), "")
    }
    fn assert_private(report: &CrashReport) {
        assert_private_text(&serde_json::to_string(report).unwrap());
    }
    fn assert_private_text(text: &str) {
        let home = std::env::var("HOME").unwrap_or_default();
        let user = home.rsplit('/').next().unwrap_or("");
        for secret in [TRANSCRIPT, EMAIL, "Priya", "ACME", "/Users/", "/home/", "/private/", "/var/folders/"] {
            assert!(!text.contains(secret), "report leaks {secret:?}: {text}");
        }
        if user.len() > 2 {
            assert!(!text.contains(user), "report names the user {user:?}: {text}");
        }
    }

    #[test]
    fn paths_keep_only_the_crate_a_dependency_or_the_standard_library() {
        assert_eq!(scrub_path("/Users/priya/Code/live-interview/apps/desktop/src-tauri/src/commands.rs"), "src-tauri/src/commands.rs");
        assert_eq!(scrub_path("src/commands.rs"), "src/commands.rs");
        assert_eq!(scrub_path("./src/lib.rs"), "src/lib.rs");
        assert_eq!(
            scrub_path("/Users/priya/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.40.0/src/runtime/task.rs"),
            "crates/tokio-1.40.0/src/runtime/task.rs"
        );
        assert_eq!(scrub_path("/rustc/abc123def/library/std/src/panicking.rs"), "rust/library/std/src/panicking.rs");
        for hostile in [
            "/Users/priya/Documents/notes about ACME.txt",
            "/Users/priya/Library/Application Support/LiveInterview/meetings/priya@acme.example.json",
            "../../../etc/passwd",
            "/Users/priya/.cargo/registry/src/idx/../../secret",
            "",
        ] {
            assert_eq!(scrub_path(hostile), "other", "{hostile}");
        }
    }

    #[test]
    fn symbols_lose_their_hash_and_anything_unprintable_is_dropped() {
        assert_eq!(scrub_symbol("live_interview_lib::commands::start::h0123456789abcdef"), "live_interview_lib::commands::start");
        assert_eq!(scrub_symbol("core::ops::function::FnOnce::call_once{{vtable.shim}}"), "core::ops::function::FnOnce::call_once{{vtable.shim}}");
        for hostile in [EMAIL, "fn at /Users/priya/x", "a\nb", "", &"x".repeat(200)] {
            assert_eq!(scrub_symbol(hostile), "<unprintable>", "{hostile}");
        }
    }

    #[test]
    fn a_backtrace_becomes_symbols_with_scrubbed_locations_and_no_panic_machinery() {
        let text = format!(
            "   0: std::backtrace::Backtrace::force_capture\n             at /rustc/abc/library/std/src/backtrace.rs:331:13\n   1: live_interview_lib::crash_report::report_for_panic\n             at /Users/priya/Code/x/apps/desktop/src-tauri/src/crash_report.rs:1:1\n   2: core::panicking::panic_fmt\n             at /rustc/abc/library/core/src/panicking.rs:80:14\n   3: live_interview_lib::commands::start_local_meeting::h0123456789abcdef\n             at /Users/priya/Code/x/apps/desktop/src-tauri/src/commands.rs:42:9\n   4: {EMAIL}\n             at /Users/priya/Documents/{TRANSCRIPT}.rs:1:1\n   5: <unknown>\n"
        );
        let frames = scrub_backtrace(&text);
        assert_eq!(
            frames,
            vec![
                "live_interview_lib::commands::start_local_meeting (src-tauri/src/commands.rs:42)".to_string(),
                "<unprintable> (other:1)".to_string(),
                "<unknown>".to_string(),
            ]
        );
    }

    /// Tests that swap the process-global panic hook run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn gate() -> std::sync::MutexGuard<'static, ()> {
        WORKER_GATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Panics on this thread with `message` under a temporary hook that records it like the real hook.
    /// Panics of any other thread (for example another test failing) go to the previous hook untouched.
    fn panic_with_hook(root: &Path, message: String) -> Option<std::thread::JoinHandle<()>> {
        let me = std::thread::current().id();
        let slot: std::sync::Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Default::default();
        let writer = slot.clone();
        let root = root.to_path_buf();
        let previous = std::sync::Arc::new(std::panic::take_hook());
        let forward = previous.clone();
        std::panic::set_hook(Box::new(move |info| {
            if std::thread::current().id() == me {
                *writer.lock().unwrap() = record_panic_into(&root, info);
            } else {
                (**forward)(info);
            }
        }));
        let outcome = std::panic::catch_unwind(|| panic!("{}", message));
        std::panic::set_hook(Box::new(move |info| (**previous)(info)));
        assert!(outcome.is_err());
        let handle = slot.lock().unwrap().take();
        handle
    }

    #[test]
    fn an_expected_caught_panic_writes_no_report() {
        let _serial = serial();
        let root = scratch("expected");
        let me = std::thread::current().id();
        let started: std::sync::Arc<Mutex<bool>> = Default::default();
        let writer = started.clone();
        let hook_root = root.clone();
        let previous = std::sync::Arc::new(std::panic::take_hook());
        let forward = previous.clone();
        std::panic::set_hook(Box::new(move |info| {
            if std::thread::current().id() == me {
                *writer.lock().unwrap() = record_panic_into(&hook_root, info).is_some();
            } else {
                (**forward)(info);
            }
        }));
        let outcome = catch_expected(|| -> u8 { panic!("malformed {TRANSCRIPT}") });
        let fine = catch_expected(|| 7);
        std::panic::set_hook(Box::new(move |info| (**previous)(info)));
        assert_eq!(outcome, Err(()));
        assert_eq!(fine, Ok(7));
        assert!(!*started.lock().unwrap(), "no report worker was started");
        assert!(pending(&root).is_none());
        assert!(!panic_is_expected(), "the mark ends with the call");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_real_panic_yields_a_report_without_its_message_or_the_username() {
        let _serial = serial();
        let root = scratch("panic");
        let worker = panic_with_hook(&root, format!("{TRANSCRIPT} {EMAIL}")).expect("the hook started its worker");
        worker.join().unwrap();
        let report = pending(&root).expect("the report is on disk");
        assert_eq!(report.kind, "panic");
        assert_eq!(report.format, 1);
        assert!(report.location.as_deref().is_some_and(|l| l.contains("crash_report.rs:")), "{:?}", report.location);
        assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!report.frames.is_empty());
        assert_private(&report);
        assert_private_text(&std::fs::read_to_string(dir(&root).join(format!("{}.json", report.id))).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_hook_returns_with_a_minimal_report_on_disk_and_leaves_symbolising_to_a_worker() {
        let _serial = serial();
        let root = scratch("hook-defer");
        let hold = gate(); // keeps the worker from starting, so the state right after the hook is visible
        let started = std::time::Instant::now();
        let worker = panic_with_hook(&root, format!("{TRANSCRIPT} {EMAIL}")).expect("the hook started its worker");
        let in_hook = started.elapsed();
        let early = pending(&root).expect("the minimal report is written before the hook returns");
        assert_eq!(early.kind, "panic");
        assert!(early.location.as_deref().is_some_and(|l| l.contains("crash_report.rs:")));
        assert!(early.frames.is_empty(), "no symbolising happened inside the hook");
        assert_private(&early);
        assert!(in_hook < Duration::from_secs(5), "the hook did not wait for the blocked worker ({in_hook:?})");
        assert!(!worker.is_finished());
        drop(hold);
        worker.join().unwrap();
        let full = pending(&root).unwrap();
        assert_eq!(full.id, early.id, "the worker replaces the minimal report in place");
        assert!(!full.frames.is_empty());
        assert_eq!(reports(&root).len(), 1);
        assert_private(&full);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reports_are_stored_listed_discarded_and_pruned() {
        let root = scratch("store");
        assert!(pending(&root).is_none());
        let mut newest = String::new();
        for _ in 0..7 {
            let report = sample("panic");
            newest = report.id.clone();
            write_report(&root, &report).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
        assert_eq!(reports(&root).len(), MAX_REPORTS);
        assert_eq!(pending(&root).unwrap().id, newest);
        assert!(!discard(&root, "../../etc/passwd"));
        assert!(!discard(&root, "not-an-id"));
        assert!(discard(&root, &newest));
        assert_eq!(reports(&root).len(), MAX_REPORTS - 1);
        std::fs::write(dir(&root).join("garbage.json"), "{not json").unwrap();
        std::fs::write(dir(&root).join(format!("{}.json", uuid::Uuid::new_v4())), vec![b' '; (MAX_BYTES + 1) as usize]).unwrap();
        assert!(pending(&root).is_some());
        assert!(!dir(&root).join("garbage.json").exists(), "an unreadable file is removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_oversized_report_is_cut_down_before_it_is_written() {
        let root = scratch("size");
        let mut report = sample("panic");
        report.frames = (0..2000).map(|i| format!("{}{i}", "frame::".repeat(20))).collect();
        write_report(&root, &report).unwrap();
        let path = dir(&root).join(format!("{}.json", report.id));
        assert!(std::fs::metadata(path).unwrap().len() <= MAX_BYTES);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unclean_end_is_reported_once_and_a_clean_exit_leaves_nothing() {
        let root = scratch("marker");
        begin_session(&root, "0.1.0");
        assert!(pending(&root).is_none(), "the first launch has nothing to report");
        end_session(&root);
        begin_session(&root, "0.1.0");
        assert!(pending(&root).is_none(), "a clean exit is not a crash");
        // This run never reaches end_session: the next launch reports it.
        begin_session(&root, "0.1.1");
        let report = pending(&root).expect("an unexpected exit is reported");
        assert_eq!(report.kind, "unexpectedExit");
        assert_eq!(report.app_version, "0.1.0");
        assert!(report.frames.is_empty() && report.location.is_none());
        assert_private(&report);
        end_session(&root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_panic_report_explains_an_unclean_end_so_no_second_report_is_made() {
        let root = scratch("explained");
        begin_session(&root, "0.1.0");
        write_report(&root, &sample("panic")).unwrap();
        begin_session(&root, "0.1.0");
        assert_eq!(reports(&root).len(), 1);
        assert_eq!(pending(&root).unwrap().kind, "panic");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn versions_and_os_strings_cannot_carry_free_text() {
        let report = build_report("panic", &format!("0.1.0 {TRANSCRIPT}"), &format!("macos {EMAIL}"), 0, None, Some("a thread named Priya"), "");
        assert!(report.thread.is_none());
        assert_eq!(report.app_version, "0.1.0");
        assert_eq!(report.os.split(' ').count(), 2);
        assert!(!report.os.contains('@'));
        let long = build_report("panic", "1.0", "macos 15.4 aarch64 extra words here", 0, None, None, "");
        assert_eq!(long.os, "macos 15.4 aarch64");
        assert_eq!(clean("/Users/priya/x".into()), "<redacted>");
    }

    #[test]
    fn sending_needs_an_https_endpoint_without_credentials_or_query() {
        assert!(valid_endpoint("https://crash.example.test/v1/reports"));
        for bad in ["", "http://crash.example.test/r", "https://u:p@crash.example.test/r", "https://crash.example.test/r?key=1", "https://crash.example.test/r#x", "not a url"] {
            assert!(!valid_endpoint(bad), "{bad}");
        }
    }

    /// Serves one request, returns it, and answers with `status`.
    async fn serve_once(status: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/reports", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                got.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if body.len() >= length || read == 0 {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let reply = format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = socket.write_all(reply.as_bytes()).await;
            String::from_utf8_lossy(&got).to_string()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn sending_posts_exactly_the_stored_report_and_then_removes_it() {
        let root = scratch("send");
        let report = sample("panic");
        write_report(&root, &report).unwrap();
        let (url, request) = serve_once("200 OK").await;
        let result = resolve(&root, Some(&url), &report.id, true).await.unwrap();
        assert_eq!(result["sent"], true);
        let request = request.await.unwrap();
        let (head, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /reports"));
        assert!(!head.to_ascii_lowercase().contains("authorization") && !head.to_ascii_lowercase().contains("cookie"));
        assert_eq!(serde_json::from_str::<CrashReport>(body).unwrap(), report);
        assert!(pending(&root).is_none(), "a sent report is removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_failed_send_keeps_the_report_and_reports_a_code_only() {
        let root = scratch("fail");
        let report = sample("unexpectedExit");
        write_report(&root, &report).unwrap();
        let (url, request) = serve_once("500 Internal Server Error").await;
        assert_eq!(resolve(&root, Some(&url), &report.id, true).await.unwrap_err(), "crashReportUnavailable");
        request.await.unwrap();
        // A closed port fails the same way, quickly.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = format!("http://{}/r", closed.local_addr().unwrap());
        drop(closed);
        assert_eq!(resolve(&root, Some(&dead), &report.id, true).await.unwrap_err(), "crashReportUnavailable");
        assert_eq!(pending(&root).unwrap().id, report.id, "the person can still retry or discard");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn without_an_endpoint_nothing_is_sent_and_discarding_still_works() {
        let root = scratch("off");
        let report = sample("panic");
        write_report(&root, &report).unwrap();
        assert_eq!(resolve(&root, None, &report.id, true).await.unwrap_err(), "crashReportSendUnavailable");
        assert_eq!(resolve(&root, None, "00000000-0000-0000-0000-000000000000", true).await.unwrap_err(), "crashReportSendUnavailable");
        assert!(pending(&root).is_some());
        assert_eq!(resolve(&root, None, &report.id, false).await.unwrap()["discarded"], true);
        assert!(pending(&root).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
