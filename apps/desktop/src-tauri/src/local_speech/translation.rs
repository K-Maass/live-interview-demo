use super::worker::{LocalSpeechWorker, RetrySchedule};
use crate::meeting_records::RecordStore;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub type SharedTranslationWorker = Arc<tokio::sync::Mutex<Option<LocalSpeechWorker>>>;

/// Failed translations of one run, keyed by source segment and revision (a corrected source is a new job).
/// See [`RetrySchedule`] for when a failed one is tried again.
#[derive(Default)]
pub struct TranslationQueue {
    retries: RetrySchedule<(String, u64)>,
    helper: Option<u64>,
}
impl TranslationQueue {
    fn select<'a>(&self, jobs: &'a [Value]) -> Option<&'a Value> {
        let now = std::time::Instant::now();
        jobs.iter()
            .find(|job| self.retries.eligible_at(&job_key(job), now))
    }
    /// Records a failed job on the helper last observed. `lost_helper`: the failure terminated that helper
    /// (every failed translation request does), so a replacement helper does not retry the job at once.
    fn defer(&mut self, job: &Value, lost_helper: bool) {
        self.retries
            .defer_at(job_key(job), std::time::Instant::now(), self.helper, lost_helper);
    }
    fn observe_helper(&mut self, worker: &Option<LocalSpeechWorker>) {
        self.observe_serial(worker.as_ref().map(LocalSpeechWorker::serial));
    }
    /// A different helper than the last one ends the waits of jobs that did not cost a helper.
    fn observe_serial(&mut self, serial: Option<u64>) {
        if let Some(current) = serial.filter(|s| Some(*s) != self.helper) {
            self.helper = Some(current);
            self.retries.helper_replaced_at(std::time::Instant::now(), current);
        }
    }
    /// See [`RetrySchedule::final_pass_at`].
    pub fn retry_before_exit(&mut self) -> bool {
        self.retries.final_pass_at(std::time::Instant::now())
    }
}
fn job_key(job: &Value) -> (String, u64) {
    (
        job["segmentId"].as_str().unwrap_or("").to_string(),
        job["revision"].as_u64().unwrap_or(0),
    )
}
fn other_live_meeting(active: &Arc<Mutex<Option<String>>>, meeting: &str) -> bool {
    active
        .lock()
        .map(|active| active.as_ref().is_some_and(|id| id != meeting))
        .unwrap_or(true)
}

#[derive(Debug, PartialEq, Eq)]
pub enum TranslationStep {
    Idle,
    Yielded,
    Deferred,
    Translated { inserted: bool },
}

pub async fn translate_pending_step(
    root: &Path,
    meeting: &str,
    binary: &Path,
    shared_worker: &SharedTranslationWorker,
    active_meeting: &Arc<Mutex<Option<String>>>,
    queue: &mut TranslationQueue,
    mut publish: impl FnMut(Value),
) -> anyhow::Result<TranslationStep> {
    if other_live_meeting(active_meeting, meeting) {
        return Ok(TranslationStep::Yielded);
    }
    let mut worker = shared_worker.lock().await;
    if other_live_meeting(active_meeting, meeting) {
        return Ok(TranslationStep::Yielded);
    }
    // A queued recovery/retry must never dispatch a source captured before the
    // serial worker lock: another task may have completed or corrected it.
    let store = RecordStore::open(root)?;
    let jobs = store.pending_translations(meeting)?;
    queue.observe_helper(&worker);
    let Some(job) = queue.select(&jobs) else {
        return Ok(TranslationStep::Idle);
    };
    if worker.is_none() {
        match LocalSpeechWorker::spawn(binary, &root.join("models"), &root.join("cache")).await {
            Ok(local) => {
                *worker = Some(local);
                queue.observe_helper(&worker);
            }
            Err(_) => {
                queue.defer(job, false);
                return Ok(TranslationStep::Deferred);
            }
        }
    }
    // Translation starts directly on its own helper; recognition warm/readiness
    // and audio-cache lifetime belong to their independent owners.
    let result = worker
        .as_mut()
        .unwrap()
        .request_stream_prioritized(job, |_| {}, || other_live_meeting(active_meeting, meeting))
        .await;
    match result {
        Ok(events) => {
            let mut inserted = false;
            for event in events {
                if let Some(saved) = store.commit_translation(&event)? {
                    inserted = true;
                    publish(saved);
                }
            }
            Ok(TranslationStep::Translated { inserted })
        }
        Err(error) => {
            // Kill a stalled/failed helper, discard its unread replies and wait for it to exit, so the next
            // helper never loads beside it.
            if let Some(failed) = worker.take() {
                failed.terminate().await;
            }
            if error.to_string() == super::worker::LIVE_PRIORITY {
                Ok(TranslationStep::Yielded)
            } else {
                queue.defer(job, true);
                Ok(TranslationStep::Deferred)
            }
        }
    }
}

/// What to do after a translation step failed (a database read, a commit, a store open): wait and try
/// again, or `None` to end the loop with the error. One transient failure never ends translation for the
/// meeting. A failure that persists ends it, sooner once recording and recognition are done, and the
/// sources stay pending for Retry.
pub fn step_error_backoff(consecutive: u32, producers_finished: bool) -> Option<std::time::Duration> {
    let limit = if producers_finished { 3 } else { 10 };
    (consecutive <= limit).then(|| {
        std::time::Duration::from_millis(
            250u64
                .saturating_mul(1 << consecutive.saturating_sub(1).min(5))
                .min(5_000),
        )
    })
}

pub async fn translate_pending_loop(
    root: PathBuf,
    meeting: String,
    binary: PathBuf,
    shared_worker: SharedTranslationWorker,
    active_meeting: Arc<Mutex<Option<String>>>,
    capture_finished: Arc<AtomicBool>,
    recognition_finished: Arc<AtomicBool>,
    publish: impl FnMut(Value),
) -> anyhow::Result<()> {
    translate_pending_loop_with(
        root,
        meeting,
        binary,
        shared_worker,
        active_meeting,
        capture_finished,
        recognition_finished,
        publish,
        step_error_backoff,
    )
    .await
}

/// [`translate_pending_loop`] with an explicit error backoff policy.
#[allow(clippy::too_many_arguments)]
pub async fn translate_pending_loop_with(
    root: PathBuf,
    meeting: String,
    binary: PathBuf,
    shared_worker: SharedTranslationWorker,
    active_meeting: Arc<Mutex<Option<String>>>,
    capture_finished: Arc<AtomicBool>,
    recognition_finished: Arc<AtomicBool>,
    mut publish: impl FnMut(Value),
    backoff: impl Fn(u32, bool) -> Option<std::time::Duration>,
) -> anyhow::Result<()> {
    let mut queue = TranslationQueue::default();
    let mut consecutive_errors = 0;
    loop {
        // Observe producer completion before the durable read. Reading an empty
        // backlog first, then newer completion flags, could miss its final source.
        let producers_finished =
            capture_finished.load(Ordering::SeqCst) && recognition_finished.load(Ordering::SeqCst);
        let step = match translate_pending_step(
            &root,
            &meeting,
            &binary,
            &shared_worker,
            &active_meeting,
            &mut queue,
            &mut publish,
        )
        .await
        {
            Ok(step) => {
                consecutive_errors = 0;
                step
            }
            Err(error) => {
                consecutive_errors += 1;
                let Some(wait) = backoff(consecutive_errors, producers_finished) else {
                    return Err(error);
                };
                log::warn!("[translation] step failed ({consecutive_errors}), retrying in {wait:?}: {error}");
                tokio::time::sleep(wait).await;
                continue;
            }
        };
        match step {
            // Failed jobs still under the attempt limit get one more try before the run ends.
            TranslationStep::Idle if producers_finished && queue.retry_before_exit() => {}
            TranslationStep::Idle if producers_finished => return Ok(()),
            TranslationStep::Idle | TranslationStep::Yielded => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await
            }
            TranslationStep::Deferred | TranslationStep::Translated { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{step_error_backoff, TranslationQueue};
    use super::super::worker::RETRY_FIRST_WAIT;
    use serde_json::json;

    // Review of #133: every failed translation terminates its helper. The replacement must not retry the job
    // that failed at once (a hanging job would stall each new helper), while a job deferred without costing a
    // helper (it could not start one) is released.
    #[test]
    fn a_replaced_helper_releases_innocent_jobs_but_not_the_one_that_lost_the_old_helper() {
        let jobs = vec![
            json!({"segmentId":"poison","revision":1}),
            json!({"segmentId":"innocent","revision":1}),
        ];
        let selected = |queue: &TranslationQueue| queue.select(&jobs).map(|j| j["segmentId"].clone());
        let mut queue = TranslationQueue::default();
        queue.defer(&jobs[1], false);
        queue.observe_serial(Some(1));
        queue.defer(&jobs[0], true);
        assert_eq!(selected(&queue), Some(json!("innocent")));
        queue.defer(&jobs[1], false);
        assert_eq!(selected(&queue), None);
        queue.observe_serial(None);
        queue.observe_serial(Some(1));
        assert_eq!(selected(&queue), None, "the same helper ends no wait");
        queue.observe_serial(Some(2));
        assert_eq!(selected(&queue), Some(json!("innocent")), "the poison job keeps its wait");
        let later = std::time::Instant::now() + RETRY_FIRST_WAIT;
        assert!(queue.retries.eligible_at(&("poison".into(), 1), later));
    }

    #[test]
    fn a_step_error_backs_off_and_only_a_persistent_one_ends_the_loop() {
        assert_eq!(step_error_backoff(1, false).unwrap().as_millis(), 250);
        assert_eq!(step_error_backoff(2, false).unwrap().as_millis(), 500);
        assert_eq!(step_error_backoff(10, false).unwrap().as_millis(), 5000);
        assert!(step_error_backoff(11, false).is_none());
        assert!(step_error_backoff(3, true).is_some());
        assert!(step_error_backoff(4, true).is_none());
    }
}
