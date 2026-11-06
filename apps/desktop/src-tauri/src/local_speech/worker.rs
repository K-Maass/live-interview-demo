use serde_json::{json, Value};
use std::path::Path;
/// Attempts one chunk gets in a decode or translation run. Past this it stays pending in the record for the
/// Retry processing path, so a chunk that always fails costs only a few helper requests.
pub const RETRY_MAX_ATTEMPTS: u32 = 4;
/// Wait before a failed chunk's second attempt. It doubles per failure, up to `RETRY_MAX_WAIT`.
pub const RETRY_FIRST_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
const RETRY_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// Failed chunks of one decode or translation run. A failed chunk waits a growing delay instead of leaving
/// the run: it is tried again once the delay has passed, at once when the helper is replaced (the failure may
/// have been the old helper's) unless its own failure cost that helper, and once more before the run ends at
/// Stop. Its attempt count survives all of these, so the retries stay bounded.
pub struct RetrySchedule<K> {
    failures: std::collections::HashMap<K, Failure>,
    final_pass_done: bool,
}
struct Failure {
    attempts: u32,
    next: std::time::Instant,
    /// The helper (by [`LocalSpeechWorker::serial`]) the last attempt ran on, if any.
    helper: Option<u64>,
    /// The last attempt timed out or broke its helper, so a replacement helper is no reason to try it sooner:
    /// it would most likely hang the new helper too.
    lost_helper: bool,
}
impl<K> Default for RetrySchedule<K> {
    fn default() -> Self {
        Self {
            failures: std::collections::HashMap::new(),
            final_pass_done: false,
        }
    }
}
impl<K: Eq + std::hash::Hash> RetrySchedule<K> {
    /// Records a failed attempt that ran on `helper` and whether it cost that helper.
    pub fn defer_at(&mut self, key: K, now: std::time::Instant, helper: Option<u64>, lost_helper: bool) {
        let failure = self.failures.entry(key).or_insert(Failure {
            attempts: 0,
            next: now,
            helper,
            lost_helper,
        });
        failure.attempts += 1;
        failure.next = now + RETRY_FIRST_WAIT.saturating_mul(1 << (failure.attempts - 1).min(8)).min(RETRY_MAX_WAIT);
        failure.helper = helper;
        failure.lost_helper = lost_helper;
    }
    pub fn eligible_at(&self, key: &K, now: std::time::Instant) -> bool {
        self.failures
            .get(key)
            .is_none_or(|f| f.attempts < RETRY_MAX_ATTEMPTS && now >= f.next)
    }
    /// Helper `serial` now serves the run: chunks that failed on an older helper without costing it may try
    /// again now. A chunk whose own failure lost the helper keeps its wait.
    pub fn helper_replaced_at(&mut self, now: std::time::Instant, serial: u64) {
        for failure in self.failures.values_mut() {
            if failure.helper != Some(serial) && !failure.lost_helper {
                failure.next = failure.next.min(now);
            }
        }
    }
    /// Called when nothing is eligible and the run would end. The first call makes every chunk still under
    /// the attempt limit eligible for one last attempt and reports whether there was one; later calls do not.
    pub fn final_pass_at(&mut self, now: std::time::Instant) -> bool {
        if std::mem::replace(&mut self.final_pass_done, true) {
            return false;
        }
        let mut released = false;
        for failure in self.failures.values_mut() {
            if failure.attempts < RETRY_MAX_ATTEMPTS {
                failure.next = now;
                released = true;
            }
        }
        released
    }
}
/// The error a request returns when it yielded to Retry or to another live meeting.
pub const LIVE_PRIORITY: &str = "livePriority";
/// What the decode loop does with a chunk whose decode request returned an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeFailure {
    /// It yielded to Retry or a live meeting. The yield killed the helper, so it is replaced, but the chunk
    /// did not fail and costs no attempt.
    Yielded,
    /// The helper's own failure reply. The helper and its loaded model stay; the chunk waits.
    ChunkFailed,
    /// Timeout, exit or out-of-step helper. It is replaced, and the chunk waits even for the replacement.
    HelperLost,
}
impl DecodeFailure {
    pub fn of(error: &anyhow::Error) -> Self {
        if error.to_string() == LIVE_PRIORITY {
            Self::Yielded
        } else if helper_lost(error) {
            Self::HelperLost
        } else {
            Self::ChunkFailed
        }
    }
    pub fn replaces_helper(self) -> bool {
        self != Self::ChunkFailed
    }
}
/// Whether a decode (or the load before it) on a helper loaded under Retry generation `generation` yields:
/// Retry was pressed since (`restart` moved on), or another meeting is live.
pub fn decode_should_yield(restart: u64, generation: u64, other_meeting_live: bool) -> bool {
    restart != generation || other_meeting_live
}
/// What the decode loop does next.
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeNext {
    /// Select again at once.
    Continue,
    /// Sleep, then select again.
    Wait,
    /// The run is over.
    End,
}
/// After a pass over the selected chunks: a helper that could not start or load ends the run once capture has
/// finished, and otherwise is retried after a pause.
pub fn after_decode_pass(helper_failed: bool, capture_finished: bool) -> DecodeNext {
    match (helper_failed, capture_finished) {
        (false, _) => DecodeNext::Continue,
        (true, false) => DecodeNext::Wait,
        (true, true) => DecodeNext::End,
    }
}
#[derive(Default)]
pub struct DecodeQueue {
    retries: RetrySchedule<String>,
    /// The helper that served this run last.
    helper: Option<u64>,
}
impl DecodeQueue {
    /// A chunk failed for a reason other than its helper (a failure reply, a persistence error).
    pub fn defer(&mut self, id: &str) {
        self.retries.defer_at(id.to_string(), std::time::Instant::now(), self.helper, false);
    }
    /// Records a failed decode request of chunk `id` on the helper last served.
    pub fn fail(&mut self, id: &str, failure: DecodeFailure) {
        match failure {
            DecodeFailure::Yielded => {}
            DecodeFailure::ChunkFailed => self.defer(id),
            DecodeFailure::HelperLost => {
                self.retries.defer_at(id.to_string(), std::time::Instant::now(), self.helper, true)
            }
        }
    }
    pub fn select<'a>(&self, pending: &'a [Value]) -> Vec<&'a Value> {
        self.select_at(pending, std::time::Instant::now())
    }
    pub fn select_at<'a>(&self, pending: &'a [Value], now: std::time::Instant) -> Vec<&'a Value> {
        pending
            .iter()
            .filter(|p| {
                self.retries
                    .eligible_at(&p["segmentId"].as_str().unwrap_or("").to_string(), now)
            })
            .take(8)
            .collect()
    }
    /// Notes the helper (by [`LocalSpeechWorker::serial`]) about to serve a decode. A different helper than
    /// last time ends the waits of chunks that did not cost a helper (see [`RetrySchedule::helper_replaced_at`]).
    pub fn serve(&mut self, serial: u64) {
        if self.helper != Some(serial) {
            self.helper = Some(serial);
            self.retries.helper_replaced_at(std::time::Instant::now(), serial);
        }
    }
    /// See [`RetrySchedule::final_pass_at`].
    pub fn retry_before_exit(&mut self) -> bool {
        self.retries.final_pass_at(std::time::Instant::now())
    }
    /// Nothing is eligible. The run ends once capture has finished and the one final pass has nothing left to
    /// retry; the final pass is only spent after capture has finished.
    pub fn when_idle(&mut self, capture_finished: bool) -> DecodeNext {
        if capture_finished && !self.retry_before_exit() {
            DecodeNext::End
        } else {
            DecodeNext::Wait
        }
    }
}
/// The helper's own `failure` reply for one request. It answered and is ready for the next request.
pub const REQUEST_FAILED: &str = "localSpeechFailed";
/// Whether an error from a request means the helper is gone or out of step (timeout, exit, stream mismatch,
/// yield kill) and must be replaced. A `failure` reply ends that one request only: the helper and its loaded
/// model stay, so one bad chunk never costs a model reload.
pub fn helper_lost(error: &anyhow::Error) -> bool {
    error.to_string() != REQUEST_FAILED
}
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
/// Longest silence tolerated between replies to a decode, translation or flush request.
const REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
/// Longest silence tolerated while the helper loads its models, serves its first decode or (Whisper
/// medium only) its first translation. When the OS has evicted CoreML's
/// compiled-model cache, loading recompiles the encoder for the Neural Engine: 452 s measured on one
/// Mac (60 s partly cached, 4 s fully cached), so the reply limit would kill every attempt and the
/// cache would never fill (#58). A load that is still silent after this is treated as stuck.
const WARM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);
/// Longest silence tolerated for the first decode after a completed `warm`. The models are loaded by then,
/// so a decode silent this long is a hung helper, not a recompile, and must not hold the helper (and Retry)
/// for the load limit (#58).
const FIRST_DECODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
static NEXT_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// Most helper stderr lines forwarded to the app log per minute. The rest are only counted.
const STDERR_LINES_PER_MINUTE: u32 = 20;
/// Longest stderr line kept for the log; the rest of a longer line is skipped unread.
const STDERR_LINE_LIMIT: usize = 300;
/// Prefixes of the stderr lines the helper writes itself: load and tokenizer timings, never transcript,
/// translation or calendar text. Anything else on stderr comes from the ML libraries or the OS and may
/// carry anything, so only its length reaches the log.
const SAFE_STDERR_PREFIXES: &[&str] = &["localSpeechTiming "];
/// The app-log text for one helper stderr line, of which `skipped` more bytes were read past and not kept.
pub fn stderr_log_text(line: &str, skipped: usize) -> String {
    let line = line.trim_end();
    if SAFE_STDERR_PREFIXES.iter().any(|prefix| line.starts_with(prefix)) {
        let mut end = line.len().min(STDERR_LINE_LIMIT);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        line[..end].to_string()
    } else {
        format!("helper stderr line withheld ({} bytes)", line.len() + skipped)
    }
}
/// Per-minute line budget for one helper's stderr.
pub struct StderrBudget {
    window: std::time::Instant,
    used: u32,
    dropped: u32,
}
impl StderrBudget {
    pub fn new(now: std::time::Instant) -> Self {
        Self { window: now, used: 0, dropped: 0 }
    }
    /// Whether a line arriving `now` may be logged, and how many lines the minute that just ended dropped.
    pub fn admit(&mut self, now: std::time::Instant) -> (bool, u32) {
        let mut dropped = 0;
        if now.duration_since(self.window) >= std::time::Duration::from_secs(60) {
            dropped = std::mem::take(&mut self.dropped);
            self.window = now;
            self.used = 0;
        }
        if self.used < STDERR_LINES_PER_MINUTE {
            self.used += 1;
            (true, dropped)
        } else {
            self.dropped += 1;
            (false, dropped)
        }
    }
}
/// Forwards a helper's stderr to the app log as `[tag]` lines, filtered by [`stderr_log_text`] and limited
/// by [`StderrBudget`]. Ends when the helper closes stderr; a full pipe can never stall the helper.
pub fn forward_stderr(stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static, tag: &'static str) {
    use tokio::io::AsyncReadExt;
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut budget = StderrBudget::new(std::time::Instant::now());
        loop {
            let mut line = Vec::new();
            let mut skipped = 0;
            match (&mut reader)
                .take(STDERR_LINE_LIMIT as u64)
                .read_until(b'\n', &mut line)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if !line.ends_with(b"\n") {
                // Longer than the limit: skip to the end of the line without keeping it, counting its length.
                let mut rest = Vec::new();
                loop {
                    rest.clear();
                    match (&mut reader).take(4096).read_until(b'\n', &mut rest).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) if rest.ends_with(b"\n") => {
                            skipped += rest.len() - 1;
                            break;
                        }
                        Ok(n) => skipped += n,
                    }
                }
            }
            let (admitted, dropped) = budget.admit(std::time::Instant::now());
            if dropped > 0 {
                log::warn!("[{tag}] {dropped} helper stderr lines not logged in the last minute");
            }
            if admitted {
                log::info!("[{tag}] {}", stderr_log_text(&String::from_utf8_lossy(&line), skipped));
            }
        }
    });
}
/// How long `terminate` waits for a killed helper to exit before giving up on it.
const TERMINATE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
pub struct LocalSpeechWorker {
    child: Child,
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    reply_timeout: std::time::Duration,
    warm_timeout: std::time::Duration,
    first_decode_timeout: std::time::Duration,
    /// A `warm` request has completed on this helper, so its recognition model is loaded.
    warmed: bool,
    serial: u64,
    /// The Retry generation (`SpeechHost::restart`) this helper was loaded under. A Retry pressed since then
    /// cancels its requests, so the next one starts a fresh helper.
    generation: u64,
    /// Whisper medium loads its translation model on first use, which can hit the same recompile.
    /// The Apple route loads no model, so its first translation keeps the normal limit.
    medium_translation: bool,
    translation_loaded: bool,
    /// The first decode after a load still specialises the model for the Neural Engine.
    recognition_primed: bool,
}
impl LocalSpeechWorker {
    pub async fn spawn(binary: &Path, models: &Path, cache: &Path) -> anyhow::Result<Self> {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-p", "(version 1) (allow default) (deny network*)"])
            .arg(binary)
            .env_remove("IBM_ICA_API_KEY")
            .env_remove("TYPESAFE_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .arg(models)
            .arg(cache);
        // Settings sit beside the models folder. Whisper medium translation stays off unless asked for.
        let medium_translation = models
            .parent()
            .is_some_and(super::settings::experimental_medium_translation);
        if medium_translation {
            command.arg("--experimental-medium-translation");
        }
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        if let Some(stderr) = child.stderr.take() {
            forward_stderr(stderr, "speech");
        }
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Ok(Self {
            child,
            input,
            output,
            reply_timeout: REPLY_TIMEOUT,
            warm_timeout: WARM_TIMEOUT,
            first_decode_timeout: FIRST_DECODE_TIMEOUT,
            warmed: false,
            serial: NEXT_SERIAL.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            generation: 0,
            medium_translation,
            translation_loaded: false,
            recognition_primed: false,
        })
    }
    /// Tells this helper apart from every other one spawned in this app run.
    pub fn serial(&self) -> u64 {
        self.serial
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Records the Retry generation a completed load ran under.
    pub fn set_generation(&mut self, generation: u64) {
        self.generation = generation;
    }
    pub async fn request(&mut self, request: &Value) -> anyhow::Result<Vec<Value>> {
        self.request_stream(request, |_| {}).await
    }
    pub async fn request_stream(
        &mut self,
        request: &Value,
        on_event: impl FnMut(&Value),
    ) -> anyhow::Result<Vec<Value>> {
        self.request_stream_prioritized(request, on_event, || false)
            .await
    }
    pub async fn request_stream_prioritized(
        &mut self,
        request: &Value,
        mut on_event: impl FnMut(&Value),
        should_yield: impl Fn() -> bool,
    ) -> anyhow::Result<Vec<Value>> {
        if should_yield() {
            let _ = self.child.start_kill();
            anyhow::bail!(LIVE_PRIORITY);
        }
        let translating = request["kind"] == "translateUtterance";
        if translating {
            validate_translation_request(request)?;
        }
        self.input
            .write_all(format!("{}\n", request).as_bytes())
            .await?;
        self.input.flush().await?;
        let mut events = Vec::new();
        let first_decode = request["kind"] == "decode" && !self.recognition_primed;
        // Without a completed warm the first decode loads the model itself, so it keeps the load limit.
        let loading = request["kind"] == "warm"
            || (first_decode && !self.warmed)
            || (translating && self.medium_translation && !self.translation_loaded);
        let limit = if loading {
            self.warm_timeout
        } else if first_decode {
            self.first_decode_timeout
        } else {
            self.reply_timeout
        };
        loop {
            let next = tokio::select! {
                biased;
                _=async{while !should_yield(){tokio::time::sleep(std::time::Duration::from_millis(50)).await;}}=>{let _=self.child.start_kill();anyhow::bail!(LIVE_PRIORITY);}
                result=tokio::time::timeout(limit,self.output.next_line())=>match result{
                    Ok(line)=>line?,
                    Err(_)=>{let _=self.child.start_kill();anyhow::bail!("workerTimeout");}
                },
            };
            let line = next.ok_or_else(|| anyhow::anyhow!("workerClosed"))?;
            let value: Value = serde_json::from_str(&line)?;
            match value["kind"].as_str() {
                Some("speech") => {
                    let event = &value["event"];
                    anyhow::ensure!(
                        event["meetingId"] == request["meetingId"]
                            && event["lane"] == request["lane"],
                        "captureProvenanceMismatch"
                    );
                    if translating {
                        validate_translation_event(request, event)?;
                        anyhow::ensure!(events.is_empty(), "translationResponseMismatch");
                    }
                    if request["kind"] == "decode" && request["sourceOnly"] == true {
                        anyhow::ensure!(
                            event["kind"] == "final"
                                && event["segmentId"] == request["segmentId"]
                                && event["revision"].as_u64()
                                    == Some(request["revision"].as_u64().unwrap_or(1)),
                            "sourceDecodeProvenanceMismatch"
                        );
                    }
                    on_event(event);
                    events.push(event.clone())
                }
                Some("translatedText") => {
                    anyhow::ensure!(request["kind"] == "translateText", "workerResponseMismatch");
                    return Ok(vec![value]);
                }
                Some("translationStatus") => {
                    anyhow::ensure!(
                        request["kind"] == "translationStatus",
                        "workerResponseMismatch"
                    );
                    return Ok(vec![value]);
                }
                Some("embeddings") => {
                    anyhow::ensure!(request["kind"] == "embedText", "workerResponseMismatch");
                    return Ok(vec![value]);
                }
                Some("translatedUtterance") => {
                    anyhow::ensure!(
                        translating
                            && value["segmentId"] == request["segmentId"]
                            && value["revision"] == request["revision"]
                            && events.len() == 1,
                        "translationResponseMismatch"
                    );
                    self.translation_loaded = true;
                    return Ok(events);
                }
                Some("decoded" | "ready" | "flushed") if translating => {
                    anyhow::bail!("translationResponseMismatch");
                }
                Some("decoded")
                    if request["kind"] == "decode"
                        && value["segmentId"] == request["segmentId"] =>
                {
                    self.recognition_primed = true;
                    return Ok(events);
                }
                Some("ready") if request["kind"] == "warm" => {
                    self.warmed = true;
                    return Ok(events);
                }
                Some("flushed") if request["kind"] == "flush" => return Ok(events),
                Some("failure") => anyhow::bail!(REQUEST_FAILED),
                _ => {}
            }
        }
    }
    pub async fn warm(&mut self) -> anyhow::Result<()> {
        self.warm_prioritized(|| false).await
    }
    /// Loads the recognition model with the long load limit, yielding to a live meeting.
    pub async fn warm_prioritized(&mut self, should_yield: impl Fn() -> bool) -> anyhow::Result<()> {
        self.request_stream_prioritized(&json!({"kind":"warm"}), |_| {}, should_yield)
            .await?;
        Ok(())
    }
    pub async fn shutdown(mut self) {
        let _ = self.input.write_all(b"{\"kind\":\"shutdown\"}\n").await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), self.child.wait()).await;
    }
    /// Kills the helper and waits until it has exited (bounded), so a replacement started by the caller
    /// never runs beside a half-finished load of the same model. Dropping a worker only sends the kill.
    pub async fn terminate(mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(TERMINATE_WAIT, self.child.wait()).await;
    }
}

fn validate_translation_request(request: &Value) -> anyhow::Result<()> {
    let source = &request["source"];
    anyhow::ensure!(
        source["kind"] == "final"
            && request["meetingId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && matches!(request["lane"].as_str(), Some("me" | "remote"))
            && request["segmentId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && request["revision"].as_u64().is_some()
            && request["audioPath"]
                .as_str()
                .is_some_and(|path| !path.is_empty())
            && source["startMs"].as_u64().is_some()
            && source["endMs"].as_u64().is_some()
            && source["endMs"].as_u64() >= source["startMs"].as_u64()
            && ["meetingId", "lane", "segmentId", "revision"]
                .iter()
                .all(|key| request[*key] == source[*key]),
        "translationRequestMismatch"
    );
    Ok(())
}

fn validate_translation_event(request: &Value, event: &Value) -> anyhow::Result<()> {
    let source = &request["source"];
    // The helper defaults a missing target to English, so a request without one still expects English.
    let target = request["target"].as_str().unwrap_or("en");
    anyhow::ensure!(
        event["kind"] == "translation"
            && event["language"] == target
            && event["segmentId"] == format!("{}:{target}", source["segmentId"].as_str().unwrap())
            && event["sourceSegmentId"] == source["segmentId"]
            && event["revision"] == source["revision"]
            && event["startMs"] == source["startMs"]
            && event["endMs"] == source["endMs"]
            && event["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
        "translationProvenanceMismatch"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Writes a stand-in helper that answers `warm` after `warm_delay` seconds, `decode` and `translateUtterance` after 1 and `flush` after 5.
    fn fake_helper(warm_delay: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("li-fake-helper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("local-speech");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nwhile read line; do\n case \"$line\" in\n  *'\"warm\"'*) sleep {warm_delay}; echo '{{\"kind\":\"ready\",\"recognitionReady\":true}}';;\n  *'\"decode\"'*) sleep 1; echo '{{\"kind\":\"decoded\",\"segmentId\":\"s1\"}}';;\n  *'\"flush\"'*) sleep 5; echo '{{\"kind\":\"flushed\"}}';;\n  *'\"translateUtterance\"'*) sleep 1; echo '{{\"kind\":\"speech\",\"event\":{{\"meetingId\":\"m\",\"lane\":\"remote\",\"kind\":\"translation\",\"language\":\"en\",\"segmentId\":\"s1:en\",\"sourceSegmentId\":\"s1\",\"revision\":1,\"startMs\":0,\"endMs\":1000,\"text\":\"Hello\"}}}}'; echo '{{\"kind\":\"translatedUtterance\",\"segmentId\":\"s1\",\"revision\":1}}';;\n esac\ndone\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    async fn spawn(script: &Path, reply: Duration, warm: Duration) -> LocalSpeechWorker {
        let dir = script.parent().unwrap();
        let mut worker = LocalSpeechWorker::spawn(script, dir, dir).await.unwrap();
        worker.reply_timeout = reply;
        worker.warm_timeout = warm;
        worker
    }

    // A cold CoreML compile is silent for minutes. It must not be cut off at the limit that
    // protects decodes, and that limit must still apply to everything after the load (#58).
    #[tokio::test]
    async fn warm_outlasts_the_reply_timeout_while_other_requests_do_not() {
        let script = fake_helper("1");
        let mut worker = spawn(&script, Duration::from_millis(300), Duration::from_secs(20)).await;
        worker.warm().await.unwrap();
        let started = Instant::now();
        let error = worker.request(&json!({"kind":"flush"})).await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    // The medium translation route loads its own model inside the first translateUtterance, so that
    // request gets the load limit; once one has succeeded the model is loaded and the normal limit returns.
    #[tokio::test]
    async fn first_translation_outlasts_the_reply_timeout_and_later_ones_do_not() {
        let script = fake_helper("1");
        let mut worker = spawn(&script, Duration::from_millis(300), Duration::from_secs(20)).await;
        worker.medium_translation = true;
        let source = json!({"kind":"final","meetingId":"m","lane":"remote","segmentId":"s1","revision":1,"startMs":0,"endMs":1000,"language":"de","text":"Hallo"});
        let request = json!({"kind":"translateUtterance","meetingId":"m","lane":"remote","segmentId":"s1","revision":1,"audioPath":"/x.wav","source":source});
        assert_eq!(worker.request(&request).await.unwrap().len(), 1);
        let error = worker.request(&request).await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
    }

    // The Apple route loads no model, so a silent first translation is stuck, not loading.
    #[tokio::test]
    async fn first_translation_keeps_the_reply_timeout_without_the_medium_route() {
        let script = fake_helper("1");
        let mut worker = spawn(&script, Duration::from_millis(300), Duration::from_secs(20)).await;
        let source = json!({"kind":"final","meetingId":"m","lane":"remote","segmentId":"s1","revision":1,"startMs":0,"endMs":1000,"language":"de","text":"Hallo"});
        let request = json!({"kind":"translateUtterance","meetingId":"m","lane":"remote","segmentId":"s1","revision":1,"audioPath":"/x.wav","source":source});
        let error = worker.request(&request).await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
    }

    // The first decode after a load still specialises the model, so it gets the load limit once;
    // later decodes return to the reply limit (#58).
    #[tokio::test]
    async fn first_decode_outlasts_the_reply_timeout_and_later_ones_do_not() {
        let script = fake_helper("1");
        let mut worker = spawn(&script, Duration::from_millis(300), Duration::from_secs(20)).await;
        let request = json!({"kind":"decode","segmentId":"s1","revision":1});
        worker.request(&request).await.unwrap();
        let error = worker.request(&request).await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
    }

    // A load that never answers is still detected, and the stuck helper is killed so the caller
    // can start a fresh one while recording and pending audio carry on.
    #[tokio::test]
    async fn warm_that_never_answers_times_out_and_kills_the_helper() {
        let script = fake_helper("30");
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_millis(400)).await;
        let error = worker.warm().await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
        let exited = tokio::time::timeout(Duration::from_secs(5), worker.child.wait()).await;
        assert!(exited.is_ok(), "stuck helper was left running");
    }

    // Retry from the notice bumps a generation counter (`SpeechHost::restart`). A load stuck under the old value
    // kills its helper at once instead of waiting out the load limit, and a fresh helper then loads normally (#58).
    #[tokio::test]
    async fn retry_kills_a_stuck_load_and_a_fresh_helper_loads() {
        let restart = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let stuck = fake_helper("30");
        let mut worker = spawn(&stuck, Duration::from_secs(20), Duration::from_secs(20)).await;
        let generation = restart.load(std::sync::atomic::Ordering::SeqCst);
        let started = Instant::now();
        let (result, _) = tokio::join!(
            worker.warm_prioritized(|| restart.load(std::sync::atomic::Ordering::SeqCst) != generation),
            async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                restart.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        );
        assert_eq!(result.unwrap_err().to_string(), "livePriority");
        assert!(started.elapsed() < Duration::from_secs(3));
        let exited = tokio::time::timeout(Duration::from_secs(5), worker.child.wait()).await;
        assert!(exited.is_ok(), "stuck helper was left running");
        // The next attempt reads the new generation, so it is not cancelled by the Retry that asked for it.
        let generation = restart.load(std::sync::atomic::Ordering::SeqCst);
        let mut fresh = spawn(&fake_helper("0"), Duration::from_secs(20), Duration::from_secs(20)).await;
        fresh
            .warm_prioritized(|| restart.load(std::sync::atomic::Ordering::SeqCst) != generation)
            .await
            .unwrap();
    }

    // A failure reply for one chunk ends that request only: the same helper serves the next decode, so the
    // caller keeps it. Silence past the limit still means a lost helper.
    #[tokio::test]
    async fn a_failure_reply_keeps_the_helper_and_a_timeout_does_not() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("li-fake-helper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("local-speech");
        std::fs::write(
            &script,
            "#!/bin/sh\nwhile read line; do\n case \"$line\" in\n  *'\"bad\"'*) echo '{\"kind\":\"failure\",\"code\":\"localReadiness\",\"segmentId\":\"bad\"}';;\n  *'\"stuck\"'*) exec sleep 30;;\n  *'\"decode\"'*) echo '{\"kind\":\"decoded\",\"segmentId\":\"s1\"}';;\n esac\ndone\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut worker = spawn(&script, Duration::from_secs(5), Duration::from_secs(5)).await;
        let error = worker
            .request(&json!({"kind":"decode","segmentId":"bad"}))
            .await
            .unwrap_err();
        assert!(!helper_lost(&error), "{error}");
        assert!(worker
            .request(&json!({"kind":"decode","segmentId":"s1"}))
            .await
            .unwrap()
            .is_empty());
        let error = worker
            .request(&json!({"kind":"decode","segmentId":"stuck"}))
            .await
            .unwrap_err();
        assert!(helper_lost(&error));
    }

    // A recovery run for an older meeting must not hold the helper through a long load.
    #[tokio::test]
    async fn warm_yields_to_a_live_meeting() {
        let script = fake_helper("30");
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_secs(20)).await;
        let live = std::sync::atomic::AtomicBool::new(false);
        let started = Instant::now();
        let (result, _) = tokio::join!(
            worker.warm_prioritized(|| live.load(std::sync::atomic::Ordering::SeqCst)),
            async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                live.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        );
        assert_eq!(result.unwrap_err().to_string(), "livePriority");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    fn process_exists(pid: i32) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    /// Writes a stand-in helper whose request loop is `cases` (sh `case` arms).
    fn script_helper(cases: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("li-fake-helper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("local-speech");
        std::fs::write(&script, format!("#!/bin/sh\nwhile read line; do\n case \"$line\" in\n{cases}\n esac\ndone\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
    const WARMS_THEN_HANGS_ON_DECODE: &str = "  *'\"warm\"'*) echo '{\"kind\":\"ready\"}';;\n  *'\"decode\"'*) exec sleep 30;;";

    // The load happened in `warm`, so a first decode that never answers is a hung helper: it is cut off at the
    // first-decode limit, not after the 900 s load limit (#58).
    #[tokio::test]
    async fn first_decode_after_a_warm_is_capped_below_the_load_limit() {
        let script = script_helper(WARMS_THEN_HANGS_ON_DECODE);
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_secs(20)).await;
        worker.first_decode_timeout = Duration::from_millis(400);
        worker.warm().await.unwrap();
        let started = Instant::now();
        let error = worker
            .request(&json!({"kind":"decode","segmentId":"s1","revision":1}))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        let exited = tokio::time::timeout(Duration::from_secs(5), worker.child.wait()).await;
        assert!(exited.is_ok(), "hung helper was left running");
        // `exec sleep` makes the hang the helper process itself (sandbox-exec and the shell exec too), so the
        // exit just awaited is the `sleep`'s own and no orphan is left behind.
    }

    // Retry bumps the restart generation; a decode hung on the old generation's helper yields at once, so
    // `warm_local_speech` gets the worker lock instead of waiting out a limit (#58).
    #[tokio::test]
    async fn retry_interrupts_a_hung_first_decode() {
        let restart = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let script = script_helper(WARMS_THEN_HANGS_ON_DECODE);
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_secs(20)).await;
        worker.warm().await.unwrap();
        worker.set_generation(restart.load(std::sync::atomic::Ordering::SeqCst));
        let generation = worker.generation();
        let started = Instant::now();
        let request = json!({"kind":"decode","segmentId":"s1","revision":1});
        let (result, _) = tokio::join!(
            worker.request_stream_prioritized(&request, |_| {}, || {
                restart.load(std::sync::atomic::Ordering::SeqCst) != generation
            }),
            async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                restart.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        );
        let error = result.unwrap_err();
        assert_eq!(error.to_string(), "livePriority");
        assert!(helper_lost(&error));
        assert!(started.elapsed() < Duration::from_secs(3));
        // The hung decode runs as the helper process itself (`exec sleep`), so reaping it leaves no orphan.
        let pid = worker.child.id().unwrap() as i32;
        worker.terminate().await;
        assert!(!process_exists(pid), "hung helper {pid} still exists");
    }

    // A deferred chunk is no longer dropped from the run (N1): it waits a growing delay, is retried at once by
    // a fresh helper and once more before the run ends, and after the attempt limit waits for Retry processing.
    #[test]
    fn a_deferred_chunk_is_retried_after_its_wait_and_bounded_by_the_attempt_limit() {
        let now = Instant::now();
        let pending = vec![json!({"segmentId":"bad"}), json!({"segmentId":"later"})];
        let ids = |queue: &DecodeQueue, at| -> Vec<String> {
            queue.select_at(&pending, at).iter().map(|p| p["segmentId"].as_str().unwrap().to_string()).collect()
        };
        let mut queue = DecodeQueue::default();
        queue.serve(1);
        queue.retries.defer_at("bad".into(), now, Some(1), false);
        assert_eq!(ids(&queue, now), ["later"]);
        assert_eq!(ids(&queue, now + RETRY_FIRST_WAIT), ["bad", "later"]);
        // The wait doubles with each failure.
        queue.retries.defer_at("bad".into(), now, Some(1), false);
        assert_eq!(ids(&queue, now + RETRY_FIRST_WAIT), ["later"]);
        assert_eq!(ids(&queue, now + RETRY_FIRST_WAIT * 2), ["bad", "later"]);
        // The same helper again does not end the wait; a fresh one does.
        queue.defer("bad");
        queue.serve(1);
        assert_eq!(ids(&queue, Instant::now()), ["later"]);
        queue.serve(2);
        assert_eq!(ids(&queue, Instant::now()), ["bad", "later"]);
        // Four failures: nothing makes it eligible in this run, and the final pass has nothing to retry.
        queue.defer("bad");
        queue.serve(3);
        assert_eq!(ids(&queue, Instant::now() + RETRY_MAX_WAIT), ["later"]);
        assert!(!queue.retry_before_exit());
    }

    // Review of #133: a chunk whose decode hangs kills its helper. The replacement must not try that chunk at
    // once (it would hang the new helper too, a timeout and reload per attempt), while chunks that failed on the
    // old helper for other reasons are released.
    #[test]
    fn a_replaced_helper_releases_innocent_chunks_but_not_the_one_that_lost_the_old_helper() {
        let pending = vec![json!({"segmentId":"poison"}), json!({"segmentId":"innocent"}), json!({"segmentId":"new"})];
        let ids = |queue: &DecodeQueue| -> Vec<String> {
            queue.select(&pending).iter().map(|p| p["segmentId"].as_str().unwrap().to_string()).collect()
        };
        let mut queue = DecodeQueue::default();
        queue.serve(1);
        queue.fail("innocent", DecodeFailure::of(&anyhow::anyhow!(REQUEST_FAILED)));
        let lost = DecodeFailure::of(&anyhow::anyhow!("workerTimeout"));
        assert!(lost.replaces_helper());
        queue.fail("poison", lost);
        assert_eq!(ids(&queue), ["new"]);
        queue.serve(2);
        assert_eq!(ids(&queue), ["innocent", "new"], "the poison chunk keeps its wait");
        // Its wait still ends on its own, and a later helper replacement does not release it either.
        let later = Instant::now() + RETRY_FIRST_WAIT;
        assert_eq!(queue.select_at(&pending, later).len(), 3);
        queue.serve(3);
        assert_eq!(ids(&queue), ["innocent", "new"]);
        // Once it fails without costing its helper, a replacement releases it like any other chunk.
        queue.fail("poison", DecodeFailure::ChunkFailed);
        queue.serve(4);
        assert_eq!(ids(&queue), ["poison", "innocent", "new"]);
    }

    // The decode loop's choice per failed request: a yield replaces the helper but costs no attempt, a failure
    // reply keeps the helper, and a lost helper is replaced and costs an attempt (review of #133).
    #[test]
    fn decode_failures_choose_helper_replacement_and_attempt_cost() {
        let yielded = DecodeFailure::of(&anyhow::anyhow!(LIVE_PRIORITY));
        assert_eq!(yielded, DecodeFailure::Yielded);
        assert!(yielded.replaces_helper());
        let reply = DecodeFailure::of(&anyhow::anyhow!(REQUEST_FAILED));
        assert_eq!(reply, DecodeFailure::ChunkFailed);
        assert!(!reply.replaces_helper());
        for lost in ["workerTimeout", "workerClosed", "translationResponseMismatch"] {
            assert_eq!(DecodeFailure::of(&anyhow::anyhow!(lost)), DecodeFailure::HelperLost);
        }
        let pending = vec![json!({"segmentId":"c"})];
        let mut queue = DecodeQueue::default();
        queue.serve(1);
        for _ in 0..RETRY_MAX_ATTEMPTS + 2 {
            queue.fail("c", DecodeFailure::Yielded);
        }
        assert_eq!(queue.select(&pending).len(), 1, "yields cost no attempt and no wait");
        queue.fail("c", DecodeFailure::ChunkFailed);
        assert!(queue.select(&pending).is_empty());
    }

    // A Retry pressed since the helper loaded, or another live meeting, makes its decode or load yield.
    #[test]
    fn a_decode_yields_to_a_newer_retry_generation_or_another_live_meeting() {
        assert!(!decode_should_yield(3, 3, false));
        assert!(decode_should_yield(4, 3, false));
        assert!(decode_should_yield(3, 3, true));
    }

    // Stop: an idle run waits while capture goes on, spends its one final pass only after capture finished, and
    // then ends. A helper that cannot start ends the run only once capture finished.
    #[test]
    fn the_decode_run_ends_only_after_capture_finished_and_the_final_pass() {
        let mut queue = DecodeQueue::default();
        queue.serve(1);
        queue.defer("bad");
        assert_eq!(queue.when_idle(false), DecodeNext::Wait);
        assert_eq!(queue.when_idle(false), DecodeNext::Wait, "the final pass is not spent while recording");
        assert_eq!(queue.when_idle(true), DecodeNext::Wait, "the final pass retries the deferred chunk");
        assert_eq!(queue.select(&[json!({"segmentId":"bad"})]).len(), 1);
        queue.defer("bad");
        assert_eq!(queue.when_idle(true), DecodeNext::End);
        assert_eq!(DecodeQueue::default().when_idle(true), DecodeNext::End);
        assert_eq!(after_decode_pass(false, true), DecodeNext::Continue);
        assert_eq!(after_decode_pass(true, false), DecodeNext::Wait);
        assert_eq!(after_decode_pass(true, true), DecodeNext::End);
    }

    #[test]
    fn the_run_retries_waiting_chunks_once_before_it_ends() {
        let mut queue = DecodeQueue::default();
        let pending = vec![json!({"segmentId":"bad"})];
        assert!(!queue.retry_before_exit(), "nothing deferred, nothing to retry");
        let mut queue2 = DecodeQueue::default();
        queue2.defer("bad");
        assert!(queue2.select(&pending).is_empty());
        assert!(queue2.retry_before_exit());
        assert_eq!(queue2.select(&pending).len(), 1);
        queue2.defer("bad");
        assert!(!queue2.retry_before_exit(), "only one final pass per run");
        assert!(queue2.select(&pending).is_empty());
        queue.defer("bad");
        assert!(!queue.retry_before_exit(), "the final pass was already used");
    }

    // Only the helper's own timing lines reach the log verbatim; anything else could carry text.
    #[test]
    fn stderr_lines_are_filtered_and_truncated() {
        assert_eq!(
            stderr_log_text("localSpeechTiming modelLoad prewarm=false ms=4012\n", 0),
            "localSpeechTiming modelLoad prewarm=false ms=4012"
        );
        let foreign = "Fatal error: Wer entscheidet über das Budget?";
        assert_eq!(
            stderr_log_text(foreign, 0),
            format!("helper stderr line withheld ({} bytes)", foreign.len())
        );
        // A long line is read only up to the limit, but its whole length is reported.
        assert_eq!(stderr_log_text(foreign, 700), format!("helper stderr line withheld ({} bytes)", foreign.len() + 700));
        let long = format!("localSpeechTiming {}", "é".repeat(400));
        let text = stderr_log_text(&long, 0);
        assert!(text.len() <= STDERR_LINE_LIMIT && text.starts_with("localSpeechTiming "));
    }

    #[test]
    fn stderr_logging_is_limited_per_minute() {
        let now = Instant::now();
        let mut budget = StderrBudget::new(now);
        for _ in 0..STDERR_LINES_PER_MINUTE {
            assert_eq!(budget.admit(now), (true, 0));
        }
        assert_eq!(budget.admit(now), (false, 0));
        assert_eq!(budget.admit(now + Duration::from_secs(59)), (false, 0));
        assert_eq!(budget.admit(now + Duration::from_secs(61)), (true, 2));
    }

    // Stderr is piped now, so it must be drained: a helper writing far more than a pipe buffer still answers.
    #[tokio::test]
    async fn a_chatty_helper_stderr_never_blocks_its_replies() {
        let script = script_helper(
            "  *'\"warm\"'*) i=0; while [ $i -lt 3000 ]; do echo \"localSpeechTiming filler line $i padded to make the pipe fill up quickly\" >&2; i=$((i+1)); done; head -c 300000 /dev/zero | tr '\\0' x >&2; echo >&2; echo '{\"kind\":\"ready\"}';;",
        );
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_secs(20)).await;
        tokio::time::timeout(Duration::from_secs(15), worker.warm())
            .await
            .expect("helper blocked on a full stderr pipe")
            .unwrap();
    }

    // A replaced helper is reaped before its replacement starts, so two loads of one model never overlap (#58).
    #[tokio::test]
    async fn terminate_waits_until_a_stuck_helper_has_exited() {
        let script = fake_helper("30");
        let mut worker = spawn(&script, Duration::from_secs(20), Duration::from_millis(300)).await;
        let pid = worker.child.id().unwrap() as i32;
        let error = worker.warm().await.unwrap_err();
        assert_eq!(error.to_string(), "workerTimeout");
        worker.terminate().await;
        // Reaped, not a zombie: `kill -0` also succeeds on an unreaped zombie, so this fails unless
        // `terminate` waited for the exit. No timing assertion, so a loaded machine cannot flake it.
        assert!(!process_exists(pid), "helper {pid} still exists after terminate");
    }
}
