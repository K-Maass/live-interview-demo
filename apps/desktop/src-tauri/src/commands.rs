//! All exported product commands. No inherited hosted/audio-upload entrypoint is registered.
use crate::{
    audio::{microphone::Microphone, AudioSource},
    local_speech::{recording::RecordingJournal, worker::LocalSpeechWorker},
    meeting_records::RecordStore,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
#[derive(Default)]
pub struct SpeechHost {
    pub worker: Arc<tokio::sync::Mutex<Option<LocalSpeechWorker>>>,
    pub translation_worker: Arc<tokio::sync::Mutex<Option<LocalSpeechWorker>>>,
    pub ready: Arc<AtomicBool>,
    pub active_meeting: Arc<Mutex<Option<String>>>,
    /// Bumped by `restart_local_speech` (the notice's Retry). A model load that started under an older value
    /// kills its helper and gives up, so the next attempt starts a fresh one. Chunks stay pending meanwhile.
    pub restart: Arc<std::sync::atomic::AtomicU64>,
    /// Meetings whose recovery (launch recovery or Retry processing) is running, so one never runs twice.
    pub recovering: Arc<Mutex<std::collections::HashSet<String>>>,
}
/// Holds a meeting in [`SpeechHost::recovering`] until its recovery ends, including on panic.
struct RecoveryClaim(Arc<Mutex<std::collections::HashSet<String>>>, String);
impl RecoveryClaim {
    fn take(set: &Arc<Mutex<std::collections::HashSet<String>>>, id: &str) -> Option<Self> {
        let mut running = set.lock().ok()?;
        running.insert(id.to_string()).then(|| Self(set.clone(), id.to_string()))
    }
}
impl Drop for RecoveryClaim {
    fn drop(&mut self) {
        if let Ok(mut running) = self.0.lock() {
            running.remove(&self.1);
        }
    }
}
/// Runs blocking store work off the main thread, so a long history never stalls the window or a shortcut.
pub(crate) async fn blocking<T: Send + 'static>(
    failure: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err(failure.into()))
}
pub struct Session {
    id: String,
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    pause_timeline: Arc<Mutex<Vec<(std::time::Instant, bool)>>>,
    capture_finished: Arc<AtomicBool>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
    decode: tauri::async_runtime::JoinHandle<()>,
    /// Holds the Mac awake while recording; the decode task holds it on until the record is finalized.
    _awake: Arc<crate::recording_activity::RecordingActivity>,
}
#[derive(Default)]
pub struct MeetingController {
    session: Mutex<Option<Session>>,
    health: Mutex<std::collections::HashMap<(String, String), Value>>,
    starting: AtomicBool,
    finishing: Arc<AtomicBool>,
    updating: AtomicBool,
}
pub(crate) struct UpdateGuard<'a>(&'a AtomicBool);
impl Drop for UpdateGuard<'_> {fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
pub(crate) fn report_capture_health(
    app: &AppHandle,
    id: &str,
    lane: &str,
    code: &str,
    detail: Option<&str>,
) {
    // A setup audio check reuses the capture sources but is not a meeting: it must never create a record
    // folder or a recording-health event. Its failures still reach the app log.
    if id == crate::audio_check::CHECK_ID {
        log::info!("[audio-check] {lane}: {code} {}", detail.unwrap_or(""));
        return;
    }
    let controller = app.state::<MeetingController>();
    // A source may finish consent after its recording owner has stopped.
    let owner = if code == "captureStarted" {
        Some(controller.session.lock().unwrap())
    } else {
        None
    };
    if let Some(owner) = owner.as_ref() {
        if !owner
            .as_ref()
            .is_some_and(|s| s.id == id && s.running.load(Ordering::SeqCst))
        {
            return;
        }
    }
    let payload = json!({"meetingId":id,"lane":lane,"code":code,"detail":detail});
    {
        let mut health = controller.health.lock().unwrap();
        let key = (id.to_string(), lane.to_string());
        if !health_replaces(health.get(&key).and_then(|h| h["code"].as_str()), code) {
            return;
        }
        health.insert(key, payload.clone());
    }
    let _ = app.emit("recording-health", payload.clone());
    let root = data_root();
    if let Ok(path) = crate::owned_paths::file(
        &root,
        &["records", id, &format!("capture-{lane}-health.json")],
        true,
    ) {
        let _ = crate::meeting_records::atomic_write(
            &path,
            &serde_json::to_vec_pretty(&payload).unwrap_or_default(),
        );
    }
}
/// The lane has ended or never started. `captureEnded` is the generic form.
const LANE_ENDED: &[&str] = &[
    "captureEnded",
    "captureUnavailable",
    "journalFailed",
    "system-audio-unavailable",
    "system-audio-unsupported",
];
/// The lane is still capturing but needs attention, or is rebuilding its stream.
const LANE_DEGRADED: &[&str] = &[
    "captureInterrupted",
    "captureStalled",
    "system-audio-silent",
    "journalRetrying",
    "diskSpaceLow",
    "mic-silent",
];
/// The microphone signal is back after silence or a denied permission. Information only.
pub(crate) const MIC_SIGNAL: &str = "microphoneSignal";
/// macOS reports microphone access as denied or restricted at recording start: the lane still records, but
/// what it receives is silence until access is turned on.
pub(crate) const MIC_DENIED: &str = "microphoneDenied";
/// Whether a new lane health code may replace the current one. An ended lane keeps its most specific
/// reason: progress or warnings never hide it, and the generic `captureEnded` never replaces a specific
/// one. A warning is cleared only by frames flowing again (`captureStarted`/`captureRecovered`), never by a
/// `captureStarting` step.
pub(crate) fn health_replaces(current: Option<&str>, next: &str) -> bool {
    // Low disk space is a whole-recording warning: it may only annotate a lane that is capturing normally,
    // never hide a lane that stalled, was interrupted or ended.
    if next == "diskSpaceLow" {
        return matches!(current, Some("captureStarted" | "captureRecovered" | MIC_SIGNAL));
    }
    let Some(current) = current else { return true };
    // Denied access stays until real sound arrives or the lane ends for a specific reason.
    if current == MIC_DENIED {
        return next == MIC_SIGNAL || (LANE_ENDED.contains(&next) && next != "captureEnded");
    }
    if LANE_ENDED.contains(&current) {
        return LANE_ENDED.contains(&next) && next != "captureEnded";
    }
    if LANE_DEGRADED.contains(&current) {
        return next != "captureStarting";
    }
    true
}
fn capture_health(state: &MeetingController, id: &str) -> Value {
    Value::Object(
        state
            .health
            .lock()
            .unwrap()
            .iter()
            .filter(|((meeting, _), _)| meeting == id)
            .map(|((_, lane), value)| (lane.clone(), value.clone()))
            .collect(),
    )
}
impl MeetingController {
    pub(crate) fn begin_update(&self)->Result<UpdateGuard<'_>,String>{
        if self.updating.swap(true,Ordering::SeqCst){return Err("updateInProgress".into());}
        let guard=UpdateGuard(&self.updating);
        if self.is_active(){return Err("recordingActive".into());}
        Ok(guard)
    }
    pub(crate) fn begin_start(&self)->Result<(),String>{
        if self.starting.swap(true,Ordering::SeqCst){return Err("startInProgress".into());}
        if self.updating.load(Ordering::SeqCst){self.starting.store(false,Ordering::SeqCst);return Err("updateInProgress".into());}
        Ok(())
    }
    pub fn is_active(&self) -> bool {
        self.starting.load(Ordering::SeqCst)
            || self.finishing.load(Ordering::SeqCst)
            || self.session.lock().map(|s| s.is_some()).unwrap_or(true)
    }
}
pub fn data_root() -> PathBuf {
    crate::edition::data_root()
}
pub(crate) fn worker_binary(app: &AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("bin/local-speech");
    // The checkout fallback is for development builds only. `env!` values are not touched by
    // `--remap-path-prefix`, so a release build must not embed the builder's checkout path.
    #[cfg(debug_assertions)]
    if !resource.exists() {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin/local-speech");
    }
    resource
}
#[tauri::command]
pub async fn list_input_devices() -> Result<Vec<String>, String> {
    static CATALOG: std::sync::OnceLock<crate::audio::device_catalog::InputDeviceCatalog> =
        std::sync::OnceLock::new();
    CATALOG
        .get_or_init(crate::audio::device_catalog::InputDeviceCatalog::default)
        .list_with(crate::audio::microphone::list_input_devices)
        .await
}
/// Apple translation readiness comes from the helper, because only it can ask the OS which language pairs are
/// installed. A failed probe reads as not ready; it never blocks recording.
async fn apple_translation_status(app: &AppHandle, root: &std::path::Path) -> Value {
    let unknown = json!({"appleAvailable":false,"installedSources":[],"target":"en"});
    let binary = worker_binary(app);
    if !binary.exists() {
        return unknown;
    }
    let Ok(mut worker) =
        LocalSpeechWorker::spawn(&binary, &root.join("models"), &root.join("cache")).await
    else {
        return unknown;
    };
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        worker.request(&json!({"kind":"translationStatus"})),
    )
    .await;
    worker.shutdown().await;
    match reply {
        Ok(Ok(events)) => events.into_iter().next().unwrap_or(unknown),
        _ => unknown,
    }
}
#[tauri::command]
pub async fn speech_readiness(app: AppHandle) -> Value {
    let root = data_root();
    let apple = apple_translation_status(&app, &root).await;
    let experimental = crate::local_speech::settings::experimental_medium_translation(&root);
    let medium_assets = root.join("models/translation/AudioEncoder.mlmodelc").exists();
    let apple_ready = apple["installedSources"]
        .as_array()
        .is_some_and(|sources| !sources.is_empty());
    json!({
        "recognitionReady": worker_binary(&app).exists()
            && root.join("models/recognition/AudioEncoder.mlmodelc").exists()
            && root.join("models/tokenizer/tokenizer.json").exists(),
        // Apple on-device translation is the supported route; medium counts only while the experiment is on.
        "translationReady": apple_ready || (experimental && medium_assets),
        "translation": {
            "target": apple["target"],
            "appleAvailable": apple["appleAvailable"],
            "installedSources": apple["installedSources"],
            "experimentalMedium": experimental,
            "mediumAssetsReady": medium_assets,
        },
        "code": "localAssets",
    })
}
/// Stops a running model download without touching recording. Partial files stay, so Retry resumes.
#[tauri::command]
pub fn cancel_local_models_setup() -> bool {
    crate::local_speech::setup::request_cancel()
}
#[tauri::command]
pub async fn set_experimental_medium_translation(
    app: AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    crate::local_speech::settings::set_experimental_medium_translation(&data_root(), enabled)
        .map_err(|_| "settingsWriteFailed")?;
    Ok(speech_readiness(app).await)
}
#[tauri::command]
pub async fn setup_local_models(app: AppHandle) -> Result<Value, String> {
    // A second request while a download runs is refused; the first keeps reporting progress.
    let Some(_guard) = crate::local_speech::setup::SetupGuard::acquire() else {
        return Err("setupInProgress".into());
    };
    let root = data_root();
    // The 1.5 GB medium model is downloaded only for the experimental setting.
    let with_medium = crate::local_speech::settings::experimental_medium_translation(&root);
    let progress = app.clone();
    let outcome = crate::local_speech::setup::run(
        &worker_binary(&app),
        &root.join("models"),
        &root.join("cache"),
        with_medium,
        crate::local_speech::setup::cancel_flag(),
        move |event| {
            let _ = progress.emit("model-setup-progress", event);
        },
    )
    .await;
    match outcome {
        Ok(()) => Ok(speech_readiness(app).await),
        Err(error) => {
            // The failure line carries the numbers (needed and free bytes) the recovery text quotes.
            let _ = app.emit(
                "model-setup-progress",
                json!({"kind":"setupFailed","code":error.code,"details":error.details}),
            );
            Err(error.code.into())
        }
    }
}
/// How long a stopped lane waits for its capture thread after the journal is flushed.
const CAPTURE_THREAD_JOIN_LIMIT: std::time::Duration = std::time::Duration::from_secs(3);
/// Hard ceiling on capture teardown after Stop. Past it the meeting is treated as finished so the app can
/// quit; each lane has flushed its journal well before this unless the disk itself is stuck.
const CAPTURE_TEARDOWN_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);
fn spawn_lane(
    app: &AppHandle,
    root: &Path,
    id: &str,
    lane: &str,
    source: impl AudioSource,
    running: Arc<AtomicBool>,
    pause_timeline: Arc<Mutex<Vec<(std::time::Instant, bool)>>>,
    started_at: std::time::Instant,
) -> anyhow::Result<tauri::async_runtime::JoinHandle<()>> {
    let mut journal = RecordingJournal::new(root, id, lane)?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let lane_running = Arc::new(AtomicBool::new(true));
    let thread = match source.start(tx, lane_running.clone()) {
        Ok(t) => t,
        Err(e) => {
            lane_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let parent = running.clone();
    let lane_gate = lane_running.clone();
    tauri::async_runtime::spawn(async move {
        while parent.load(Ordering::SeqCst) && lane_gate.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        lane_gate.store(false, Ordering::SeqCst);
    });
    let mut last_emit = std::time::Instant::now();
    let app = app.clone();
    let id = id.to_string();
    let lane = lane.to_string();
    // Only the microphone is watched for digital silence: muted or denied input arrives as exact zeros.
    let mut silence = (lane == "me").then(crate::audio::silence::SilenceWatch::default);
    let silence_app = app.clone();
    let silence_id = id.clone();
    Ok(tauri::async_runtime::spawn(async move {
        let outcome = crate::local_speech::recording::drain_capture(
            &mut journal,
            rx,
            started_at,
            |captured_at| {
                pause_timeline
                    .lock()
                    .map(|events| {
                        events
                            .iter()
                            .rev()
                            .find(|(at, _)| *at <= captured_at)
                            .map(|(_, paused)| *paused)
                            .unwrap_or(false)
                    })
                    .unwrap_or(true)
            },
            || !lane_running.load(Ordering::SeqCst),
            |pcm, paused| {
                if let Some(change) = silence.as_mut().and_then(|w| w.observe(pcm, paused)) {
                    report_mic_signal(&silence_app, &silence_id, change);
                }
            },
            |frames| {
                if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                    last_emit = std::time::Instant::now();
                    let _ = app.emit(
                        "recording-frames",
                        json!({"meetingId":id,"lane":lane,"frames":frames}),
                    );
                }
            },
            // A write error never stops the source: the drain keeps capturing and retries the write.
            |health| match health {
                crate::local_speech::recording::JournalHealth::Retrying(detail) => {
                    report_capture_health(&app, &id, &lane, "journalRetrying", Some(&detail))
                }
                crate::local_speech::recording::JournalHealth::Recovered => {
                    report_capture_health(&app, &id, &lane, "captureRecovered", None)
                }
            },
        )
        .await;
        if outcome.is_err() {
            // Only the final flush can fail here, after the source ended. The raw journal keeps the audio
            // behind the last checkpoint, so recovery can still register it.
            report_capture_health(
                &app,
                &id,
                &lane,
                "journalFailed",
                Some("Local audio journal could not be written"),
            );
        }
        if running.load(Ordering::SeqCst) {
            report_capture_health(
                &app,
                &id,
                &lane,
                "captureEnded",
                Some("The audio source closed unexpectedly"),
            );
        }
        let _ = journal.flush();
        // The journal is flushed. A capture thread wedged in a driver call is left behind rather than
        // holding the meeting open: the app must still be able to finish and quit.
        let join = tokio::task::spawn_blocking(move || thread.join());
        if tokio::time::timeout(CAPTURE_THREAD_JOIN_LIMIT, join).await.is_err() {
            log::warn!("[capture] {lane} source thread did not end after stop; detaching it");
        }
    }))
}
/// Reports a microphone silence change. Never stops or pauses the recording.
fn report_mic_signal(app: &AppHandle, id: &str, change: crate::audio::silence::SilenceChange) {
    let current = app
        .state::<MeetingController>()
        .health
        .lock()
        .ok()
        .and_then(|h| h.get(&(id.to_string(), "me".to_string())).and_then(|v| v["code"].as_str().map(str::to_string)));
    if let Some(code) = mic_signal_update(current.as_deref(), change) {
        let detail = (code == "mic-silent").then_some("The microphone has sent only digital silence for a minute");
        report_capture_health(app, id, "me", code, detail);
    }
}
/// The code a microphone silence change reports on a lane showing `current`, if any. Silence is reported once
/// while it lasts (again only if another code replaced it); returning sound clears silence or denied access.
pub(crate) fn mic_signal_update(
    current: Option<&str>,
    change: crate::audio::silence::SilenceChange,
) -> Option<&'static str> {
    use crate::audio::silence::SilenceChange;
    match change {
        SilenceChange::Silent if current != Some("mic-silent") && health_replaces(current, "mic-silent") => {
            Some("mic-silent")
        }
        SilenceChange::Signal if matches!(current, Some("mic-silent" | MIC_DENIED)) => Some(MIC_SIGNAL),
        _ => None,
    }
}
async fn decode_pending(
    app: AppHandle,
    root: PathBuf,
    id: String,
    binary: PathBuf,
    retain: bool,
    shared_worker: Arc<tokio::sync::Mutex<Option<LocalSpeechWorker>>>,
    capture_finished: Arc<AtomicBool>,
    active_meeting: Arc<Mutex<Option<String>>>,
    ready: Arc<AtomicBool>,
) {
    let recognition_finished = Arc::new(AtomicBool::new(false));
    let translator = crate::local_speech::translation::translate_pending_loop(
        root.clone(),
        id.clone(),
        binary.clone(),
        app.state::<SpeechHost>().translation_worker.clone(),
        active_meeting.clone(),
        capture_finished.clone(),
        recognition_finished.clone(),
        {
            let app = app.clone();
            move |event| {
                let _ = app.emit("speech-event", event);
            }
        },
    );
    let translation_task = tauri::async_runtime::spawn(translator);
    let mut failed = false;
    use crate::local_speech::worker::DecodeNext;
    let mut queue = crate::local_speech::worker::DecodeQueue::default();
    loop {
        let other_live = active_meeting
            .lock()
            .map(|current| current.as_ref().is_some_and(|active| active != &id))
            .unwrap_or(true);
        if other_live {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            continue;
        }
        let store = match RecordStore::open(&root) {
            Ok(s) => s,
            Err(_) => break,
        };
        let pending = store.pending_chunks(&id).unwrap_or_default();
        let selected = queue.select(&pending);
        if selected.is_empty() {
            // Deferred chunks still under the attempt limit get one more try before the run ends; past it
            // they stay pending in the record for Retry processing.
            if queue.when_idle(capture_finished.load(Ordering::SeqCst)) == DecodeNext::End {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            continue;
        }
        for chunk in selected {
            if active_meeting
                .lock()
                .map(|current| current.as_ref().is_some_and(|active| active != &id))
                .unwrap_or(true)
            {
                break;
            }
            let mut worker = shared_worker.lock().await;
            if active_meeting
                .lock()
                .map(|current| current.as_ref().is_some_and(|active| active != &id))
                .unwrap_or(true)
            {
                break;
            }
            // Another recovery owner may have processed this row while we waited.
            let chunk_id = chunk["segmentId"].as_str().unwrap_or("");
            if !store
                .pending_chunks(&id)
                .is_ok_and(|pending| pending.iter().any(|p| p["segmentId"] == chunk["segmentId"]))
            {
                continue;
            }
            if worker.is_none() {
                match LocalSpeechWorker::spawn(&binary, &root.join("models"), &root.join("cache"))
                    .await
                {
                    Ok(mut w) => {
                        // Load the models before the first decode: after the OS evicts CoreML's
                        // compiled-model cache this takes minutes, and a decode would be killed
                        // at the reply limit on every attempt (#58). Chunks stay pending meanwhile.
                        let status = if crate::local_speech::warmup::is_first_load(&root, &binary) {
                            crate::local_speech::warmup::FIRST_LOAD_STATUS
                        } else {
                            crate::local_speech::warmup::LOAD_STATUS
                        };
                        let _ = app.emit("speech-health", json!({"meetingId":id,"code":status}));
                        let restart = app.state::<SpeechHost>().restart.clone();
                        let generation = restart.load(Ordering::SeqCst);
                        let yield_to_live = || {
                            crate::local_speech::worker::decode_should_yield(
                                restart.load(Ordering::SeqCst),
                                generation,
                                active_meeting
                                    .lock()
                                    .map(|current| current.as_ref().is_some_and(|active| active != &id))
                                    .unwrap_or(true),
                            )
                        };
                        if let Err(error) = w.warm_prioritized(yield_to_live).await {
                            let _ = app.emit(
                                "speech-health",
                                json!({"meetingId":id,"code":"decodePending"}),
                            );
                            ready.store(false, Ordering::SeqCst);
                            // Yielding to a live meeting or to Retry is not a failure: the loop starts a
                            // fresh helper (or waits for the live meeting) and the chunks stay pending.
                            failed = error.to_string() != crate::local_speech::worker::LIVE_PRIORITY;
                            // Reaped while the worker lock is held, so the next load never overlaps it.
                            w.terminate().await;
                            break;
                        }
                        crate::local_speech::warmup::record_loaded(&root, &binary);
                        ready.store(true, Ordering::SeqCst);
                        // Clears "Preparing local speech" as soon as the load ends, not only after the first
                        // decode, so the notice never outlives the load it describes.
                        let _ = app.emit(
                            "speech-health",
                            json!({"meetingId":id,"code":crate::local_speech::warmup::READY_STATUS}),
                        );
                        // It serves under the generation its load started with, so a Retry pressed since
                        // then replaces it at its first decode.
                        w.set_generation(generation);
                        *worker = Some(w);
                    }
                    Err(_) => {
                        let _ = app.emit(
                            "speech-health",
                            json!({"meetingId":id,"code":"workerUnavailable"}),
                        );
                        ready.store(false, Ordering::SeqCst);
                        failed = true;
                        break;
                    }
                }
            }
            let mut request = chunk.clone();
            request["kind"] = json!("decode");
            request["meetingId"] = json!(id);
            request["sequence"] = json!(0);
            request["mode"] = json!("transcribe");
            request["sourceOnly"] = json!(true);
            let revision = match store.next_source_revision(&id, chunk_id) {
                Ok(revision) => revision,
                Err(_) => {
                    queue.defer(chunk_id);
                    continue;
                }
            };
            request["revision"] = json!(revision);
            // A helper this run has not used yet (a fresh one, or the launch warm-up's) ends deferred waits.
            queue.serve(worker.as_ref().unwrap().serial());
            let restart = app.state::<SpeechHost>().restart.clone();
            let generation = worker.as_ref().unwrap().generation();
            let mut persistence_failed = false;
            match worker
                .as_mut()
                .unwrap()
                .request_stream_prioritized(
                    &request,
                    |event| match store.append_event_once(event) {
                        Ok(Some(saved)) => {
                            let _ = app.emit("speech-event", saved);
                        }
                        Ok(None) => {}
                        Err(_) => persistence_failed = true,
                    },
                    // Retry (a newer generation) interrupts a hung decode as it does a load (#58).
                    || {
                        crate::local_speech::worker::decode_should_yield(
                            restart.load(Ordering::SeqCst),
                            generation,
                            active_meeting
                                .lock()
                                .map(|current| current.as_ref().is_some_and(|active| active != &id))
                                .unwrap_or(true),
                        )
                    },
                )
                .await
            {
                Ok(_) => {
                    if persistence_failed {
                        queue.defer(chunk_id);
                        let _ = app.emit(
                            "speech-health",
                            json!({"meetingId":id,"code":"decodePending"}),
                        );
                        continue;
                    }
                    match store.complete_chunk(chunk_id) {
                        Ok(crate::meeting_records::DecodeCompletion::RecognitionPending)
                        | Err(_) => {
                            // Legacy source without trusted intervals remains recoverable,
                            // but another empty decode must not spin in this worker run.
                            queue.defer(chunk_id);
                            let _ = app.emit(
                                "speech-health",
                                json!({"meetingId":id,"code":"decodePending"}),
                            );
                            continue;
                        }
                        Ok(_) => {
                            // Recognition is final: without retained audio its WAV goes now, whatever the
                            // translation state (Apple translation works from the text).
                            if !retain {
                                let _ = store.release_recognized_audio(
                                    &id,
                                    crate::local_speech::settings::experimental_medium_translation(&root),
                                );
                            }
                        }
                    }
                    ready.store(true, Ordering::SeqCst);
                    let _ = app.emit(
                        "speech-health",
                        json!({"meetingId":id,"code":"Local speech running"}),
                    );
                    failed = false;
                }
                Err(error) => {
                    let _ = app.emit(
                        "speech-health",
                        json!({"meetingId":id,"code":"decodePending"}),
                    );
                    // Only a timeout, exit, out-of-step or yielded helper is replaced. A failure reply for one
                    // chunk keeps the helper and its loaded model. A yield costs the chunk no attempt; a lost
                    // helper keeps the chunk waiting even for the replacement (see `DecodeFailure`).
                    let failure = crate::local_speech::worker::DecodeFailure::of(&error);
                    if failure.replaces_helper() {
                        if let Some(lost) = worker.take() {
                            lost.terminate().await;
                        }
                        ready.store(false, Ordering::SeqCst);
                    }
                    queue.fail(chunk_id, failure);
                    failed = false;
                    continue;
                }
            }
        }
        match crate::local_speech::worker::after_decode_pass(failed, capture_finished.load(Ordering::SeqCst)) {
            DecodeNext::End => break,
            DecodeNext::Wait => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
            DecodeNext::Continue => {}
        }
    }
    recognition_finished.store(true, Ordering::SeqCst);
    if !matches!(translation_task.await, Ok(Ok(()))) {
        let _ = app.emit(
            "speech-health",
            json!({"meetingId":id,"code":"translationPending"}),
        );
    }
    if let Ok(store) = RecordStore::open(&root) {
        let _ = store.finish(&id);
        if !retain {
            // Capture has finished (the loop above ends only then), so a fully checkpointed raw journal
            // is no longer needed for recovery. Audio still awaiting recognition stays.
            let _ = store.release_recognized_audio(
                &id,
                crate::local_speech::settings::experimental_medium_translation(&root),
            );
            let _ = store.release_raw_journal(&id);
            if store
                .pending_chunks(&id)
                .map(|p| p.is_empty())
                .unwrap_or(false)
                && store
                    .load(&id)
                    .map(|r| r["translationStatus"] == "complete")
                    .unwrap_or(false)
            {
                let _ = std::fs::remove_dir_all(root.join("cache").join(&id));
            }
        }
    }
    let _ = app.emit("recording-finalized", json!({"meetingId":id}));
}
#[tauri::command]
pub async fn start_local_meeting(
    app: AppHandle,
    state: State<'_, MeetingController>,
    options: Value,
    input_device: Option<String>,
) -> Result<String, String> {
    app.state::<crate::instance_lock::InstanceGuard>().require_primary()?;
    crate::transcription::validate_local_voice_provider("local-whisper")
        .map_err(|_| "voicePolicy")?;
    if state.finishing.load(Ordering::SeqCst) {
        return Err("captureFlushPending".into());
    }
    if crate::disk_space::verdict(crate::disk_space::free_bytes(&data_root()))
        == crate::disk_space::DiskVerdict::Insufficient
    {
        return Err("diskSpaceInsufficient".into());
    }
    // A meeting always wins over a setup audio check: the check releases its device first.
    app.state::<crate::audio_check::AudioCheck>().stop();
    state.begin_start()?;
    // A session close to expiry is renewed now, in the background, so assistance
    // does not lapse mid-meeting. Recording never waits for it.
    crate::public_service::renew_before_meeting();
    // Permission/device startup may block; keep the desktop event loop responsive.
    let result = tokio::task::spawn_blocking(move || {
        let state = app.state::<MeetingController>();
        (|| -> anyhow::Result<String> {
            let mut lock = state
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("sessionLock"))?;
            if let Some(s) = lock.as_ref() {
                return Ok(s.id.clone());
            }
            let id = options["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missingId"))?
                .to_string();
            let root = data_root();
            let store = RecordStore::open(&root)?;
            store.create(&id, &options)?;
            let running = Arc::new(AtomicBool::new(true));
            let paused = Arc::new(AtomicBool::new(false));
            let capture_finished = Arc::new(AtomicBool::new(false));
            let started_at = std::time::Instant::now();
            let pause_timeline = Arc::new(Mutex::new(vec![(started_at, false)]));
            let mut tasks = Vec::new();
            // Re-read at every start: access may have been turned off since setup. The lane still records.
            if let Some(access) = crate::permissions::microphone_denied_now() {
                report_capture_health(&app, &id, "me", MIC_DENIED, Some(access));
            }
            match spawn_lane(
                &app,
                &root,
                &id,
                "me",
                Microphone {
                    device_name: input_device,
                    app: app.clone(),
                    meeting_id: id.clone(),
                },
                running.clone(),
                pause_timeline.clone(),
                started_at,
            ) {
                Ok(t) => tasks.push(t),
                Err(error) => {
                    report_capture_health(
                        &app,
                        &id,
                        "me",
                        "captureUnavailable",
                        Some(&error.to_string()),
                    );
                }
            }
            #[cfg(target_os = "macos")]
            match spawn_lane(
                &app,
                &root,
                &id,
                "remote",
                crate::audio::system_macos::SystemAudio {
                    app: app.clone(),
                    meeting_id: id.clone(),
                },
                running.clone(),
                pause_timeline.clone(),
                started_at,
            ) {
                Ok(t) => tasks.push(t),
                Err(error) => {
                    report_capture_health(
                        &app,
                        &id,
                        "remote",
                        "captureUnavailable",
                        Some(&error.to_string()),
                    );
                }
            }
            if tasks.is_empty() {
                running.store(false, Ordering::SeqCst);
                anyhow::bail!("captureUnavailable")
            }
            *app.state::<SpeechHost>().active_meeting.lock().unwrap() = Some(id.clone());
            let awake = Arc::new(crate::recording_activity::RecordingActivity::begin(
                "Recording and transcribing a meeting",
            ));
            let decoding = decode_pending(
                app.clone(),
                root,
                id.clone(),
                worker_binary(&app),
                options["retainAudio"].as_bool().unwrap_or(false),
                app.state::<SpeechHost>().worker.clone(),
                capture_finished.clone(),
                app.state::<SpeechHost>().active_meeting.clone(),
                app.state::<SpeechHost>().ready.clone(),
            );
            let decode_awake = awake.clone();
            let decode = tauri::async_runtime::spawn(async move {
                // Dropped when finalizing ends, or on unwind if it panics.
                let _awake = decode_awake;
                decoding.await
            });
            tauri::async_runtime::spawn(watch_disk_space(app.clone(), id.clone(), running.clone()));
            *lock = Some(Session {
                id: id.clone(),
                running,
                paused,
                pause_timeline,
                capture_finished,
                tasks,
                decode,
                _awake: awake,
            });
            Ok(id)
        })()
    })
    .await
    .unwrap_or_else(|_| Err(anyhow::anyhow!("startupWorkerFailed")));
    state.starting.store(false, Ordering::SeqCst);
    result.map_err(|_| "recordingStartFailed".into())
}
/// The code a disk-space check reports on a lane currently showing `current`, if any.
pub(crate) fn disk_health_update(current: Option<&str>, low: bool) -> Option<&'static str> {
    match (low, current == Some("diskSpaceLow")) {
        (true, false) if health_replaces(current, "diskSpaceLow") => Some("diskSpaceLow"),
        (false, true) => Some("captureRecovered"),
        _ => None,
    }
}
/// Warns on both lanes while free space is low and clears that warning when space returns. It never
/// stops or pauses the recording.
async fn watch_disk_space(app: AppHandle, id: String, running: Arc<AtomicBool>) {
    while running.load(Ordering::SeqCst) {
        let free = tokio::task::spawn_blocking(|| crate::disk_space::free_bytes(&data_root()))
            .await
            .ok()
            .flatten();
        let low = crate::disk_space::verdict(free) != crate::disk_space::DiskVerdict::Enough;
        let detail = crate::disk_space::low_space_detail(free.unwrap_or(0));
        for lane in ["me", "remote"] {
            // Decided from what each lane shows now, so a warning another code cleared returns on the next
            // check while space is still low.
            let current = app
                .state::<MeetingController>()
                .health
                .lock()
                .unwrap()
                .get(&(id.clone(), lane.to_string()))
                .and_then(|h| h["code"].as_str().map(str::to_string));
            match disk_health_update(current.as_deref(), low) {
                Some(code @ "diskSpaceLow") => {
                    report_capture_health(&app, &id, lane, code, Some(&detail))
                }
                Some(code) => report_capture_health(&app, &id, lane, code, None),
                None => {}
            }
        }
        let deadline = std::time::Instant::now() + crate::disk_space::RECHECK_INTERVAL;
        while running.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
}
#[tauri::command]
pub fn set_local_meeting_paused(
    state: State<MeetingController>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    let lock = state.session.lock().map_err(|_| "sessionLock")?;
    let s = lock.as_ref().filter(|s| s.id == id).ok_or("notActive")?;
    s.pause_timeline
        .lock()
        .map_err(|_| "sessionLock")?
        .push((std::time::Instant::now(), paused));
    s.paused.store(paused, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub async fn stop_local_meeting(
    app: AppHandle,
    state: State<'_, MeetingController>,
    id: String,
) -> Result<Value, String> {
    app.state::<crate::instance_lock::InstanceGuard>().require_primary()?;
    let session = {
        let mut lock = state.session.lock().map_err(|_| "sessionLock")?;
        if lock.as_ref().map(|s| s.id.as_str()) != Some(id.as_str()) {
            return Err("notActive".into());
        }
        state.finishing.store(true, Ordering::SeqCst);
        lock.take().unwrap()
    };
    session.running.store(false, Ordering::SeqCst);
    {
        let host = app.state::<SpeechHost>();
        let mut active = host.active_meeting.lock().unwrap();
        if active.as_deref() == Some(id.as_str()) {
            *active = None;
        }
    }
    let mut delayed = Vec::new();
    for mut task in session.tasks {
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task)
            .await
            .is_err()
        {
            delayed.push(task);
        }
    }
    let capture_pending = !delayed.is_empty();
    if capture_pending {
        let capture_finished = session.capture_finished.clone();
        let finishing = state.finishing.clone();
        tauri::async_runtime::spawn(async move {
            let all = async {
                for task in delayed {
                    let _ = task.await;
                }
            };
            if tokio::time::timeout(CAPTURE_TEARDOWN_LIMIT, all).await.is_err() {
                log::error!("[capture] teardown passed {CAPTURE_TEARDOWN_LIMIT:?}; finishing without it");
            }
            capture_finished.store(true, Ordering::SeqCst);
            finishing.store(false, Ordering::SeqCst);
        });
    } else {
        session.capture_finished.store(true, Ordering::SeqCst);
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(15), session.decode).await;
    let mut result = RecordStore::open(&data_root())
        .and_then(|s| s.finish(&id))
        .map_err(|_| "recordSaveFailed".into());
    if capture_pending {
        if let Ok(record) = result.as_mut() {
            record["capturePending"] = json!(true);
            record["translationStatus"] = json!("pending");
        }
    } else {
        state.finishing.store(false, Ordering::SeqCst);
    }
    result
}
/// Summaries only (no transcript); the renderer opens a meeting with `load_meeting_record`.
#[tauri::command]
pub async fn list_meeting_records() -> Result<Vec<Value>, String> {
    blocking("recordReadFailed", || {
        RecordStore::open(&data_root())
            .and_then(|s| s.list())
            .map_err(|_| "recordReadFailed".into())
    })
    .await
}
#[tauri::command]
pub async fn load_meeting_record(id: String) -> Result<Value, String> {
    blocking("recordReadFailed", move || {
        RecordStore::open(&data_root())
            .and_then(|s| s.load(&id))
            .map_err(|_| "recordReadFailed".into())
    })
    .await
}

#[tauri::command]
pub async fn warm_local_speech(app: AppHandle) -> Result<Value, String> {
    let worker = app.state::<SpeechHost>().worker.clone();
    let ready = app.state::<SpeechHost>().ready.clone();
    if ready.load(Ordering::SeqCst) {
        return Ok(json!({"recognitionReady":true}));
    }
    let restart = app.state::<SpeechHost>().restart.clone();
    let mut lock = worker.lock().await;
    // Read after the lock: a Retry pressed while this call waited must not cancel the fresh load it asked for.
    let generation = restart.load(Ordering::SeqCst);
    if lock.is_none() {
        *lock = Some(
            LocalSpeechWorker::spawn(
                &worker_binary(&app),
                &data_root().join("models"),
                &data_root().join("cache"),
            )
            .await
            .map_err(|_| "workerUnavailable")?,
        )
    }
    // Bounded by the worker's load limit; Retry (`restart_local_speech`) ends it sooner.
    if let Err(error) = lock
        .as_mut()
        .unwrap()
        .warm_prioritized(|| restart.load(Ordering::SeqCst) != generation)
        .await
    {
        if let Some(stuck) = lock.take() {
            stuck.terminate().await;
        }
        ready.store(false, Ordering::SeqCst);
        return Err(if error.to_string() == "livePriority" { "warmRestarted" } else { "warmFailed" }.into());
    }
    // A decode on this helper yields only to a Retry pressed after this load.
    lock.as_mut().unwrap().set_generation(generation);
    crate::local_speech::warmup::record_loaded(&data_root(), &worker_binary(&app));
    ready.store(true, Ordering::SeqCst);
    Ok(json!({"recognitionReady":true}))
}
/// Retry from the speech notice: any model load in progress (launch warm-up or a meeting's) kills its helper
/// and gives up, so the next load starts a fresh helper. Recording is untouched and pending audio stays pending
/// in the record until the new helper transcribes it. The caller starts the new load with `warm_local_speech`.
#[tauri::command]
pub fn restart_local_speech(app: AppHandle) {
    let host = app.state::<SpeechHost>();
    host.restart.fetch_add(1, Ordering::SeqCst);
    host.ready.store(false, Ordering::SeqCst);
}
/// Whether the next model load is the first for this helper build (a new install or an update), so the
/// UI can say "one-time, a few minutes". Wording only; it never gates recording.
#[tauri::command]
pub async fn speech_warmup_state(app: AppHandle) -> Value {
    let binary = worker_binary(&app);
    let first_load = tokio::task::spawn_blocking(move || crate::local_speech::warmup::is_first_load(&data_root(), &binary))
        .await
        .unwrap_or(true);
    json!({"firstLoad": first_load, "status": if first_load { crate::local_speech::warmup::FIRST_LOAD_STATUS } else { crate::local_speech::warmup::LOAD_STATUS }})
}
#[tauri::command]
pub fn create_synthetic_record(
    instance: State<crate::instance_lock::InstanceGuard>,
    state: State<MeetingController>,
) -> Result<Value, String> {
    instance.require_primary()?;
    // A fixture record must never appear beside, or race with, a real recording.
    refuse_while_recording(&state)?;
    let id = uuid::Uuid::new_v4().to_string();
    let store = RecordStore::open(&data_root()).map_err(|_| "recordStore")?;
    let options = json!({"id":id,"workspaceId":"default","purpose":"Synthetic approval interview","objectives":["Understand decision ownership and evidence requirements"],"attendees":[],"profileId":"interview","profileRevision":0,"retainAudio":false,"fixtureMode":true});
    store.create(&id, &options).map_err(|_| "recordCreate")?;
    let statements=[("me","en","Can you explain who owns approval when an AI pilot moves into production?"),("remote","en","Central compliance owns all deployment approval."),("remote","de","Die Fachabteilung entscheidet, ob wir live gehen. Compliance legt fest, welche Nachweise wir aufbewahren müssen.")];
    for (n, (lane, language, text)) in statements.iter().enumerate() {
        store.append_event(&json!({"meetingId":id,"segmentId":format!("s{n}"),"revision":1,"lane":lane,"startMs":n*5000,"endMs":n*5000+3000,"language":language,"text":text,"kind":"final"})).map_err(|_|"recordEvent")?;
    }
    store.append_event(&json!({"meetingId":id,"segmentId":"s2-en","sourceSegmentId":"s2","revision":1,"lane":"remote","startMs":10000,"endMs":13000,"language":"en","text":"The business unit decides whether to go live. Compliance specifies the evidence to retain.","kind":"translation"})).map_err(|_|"recordEvent")?;
    store.finish(&id).map_err(|_| "recordSave".into())
}
fn refuse_while_recording(controller: &MeetingController) -> Result<(), String> {
    if controller.is_active() {
        return Err("recordingActive".into());
    }
    Ok(())
}
/// Whether this process owns the data root; the other copy shows that Live Interview is already open.
#[tauri::command]
pub fn instance_state(instance: State<crate::instance_lock::InstanceGuard>) -> Value {
    json!({"primary": instance.primary()})
}
#[tauri::command]
pub async fn current_local_session(state: State<'_, MeetingController>) -> Result<Value, String> {
    let Some((id, paused)) = ({
        let guard = state.session.lock().map_err(|_| "sessionLock")?;
        guard.as_ref().map(|s| (s.id.clone(), s.paused.clone()))
    }) else {
        return Ok(Value::Null);
    };
    let load_id = id.clone();
    let mut record = blocking("recordReadFailed", move || {
        RecordStore::open(&data_root())
            .and_then(|s| s.load(&load_id))
            .map_err(|_| "recordReadFailed".into())
    })
    .await?;
    record["paused"] = json!(paused.load(Ordering::SeqCst));
    record["captureHealth"] = capture_health(&state, &id);
    Ok(record)
}
/// Registers a raw tail left by a crash, requeues translations and returns whether the meeting retains audio.
/// Idempotent: registered chunks are never duplicated, so a crash during it is repaired by running it again.
fn prepare_recovery(root: &Path, id: &str) -> Result<bool, String> {
    crate::local_speech::recording::recover_raw_tail(root, id).map_err(|_| "recoveryFailed")?;
    let record = RecordStore::open(root)
        .and_then(|s| s.load(id))
        .map_err(|_| "recordReadFailed")?;
    RecordStore::open(root)
        .and_then(|s| s.retry_translations(id))
        .map_err(|_| "retryFailed")?;
    Ok(record["retainAudio"].as_bool().unwrap_or(false))
}
/// Decodes and translates what the meeting still has pending, then finalizes it. Yields to a live meeting
/// like any decode: it never holds the helper while another meeting records.
async fn process_recovered(app: AppHandle, root: PathBuf, id: String, retain: bool, _claim: RecoveryClaim) {
    let (worker, active, ready) = {
        let host = app.state::<SpeechHost>();
        (host.worker.clone(), host.active_meeting.clone(), host.ready.clone())
    };
    let binary = worker_binary(&app);
    decode_pending(
        app.clone(),
        root,
        id,
        binary,
        retain,
        worker,
        Arc::new(AtomicBool::new(true)),
        active,
        ready,
    )
    .await;
}
#[tauri::command]
pub async fn recover_local_record(
    app: AppHandle,
    state: State<'_, MeetingController>,
    id: String,
) -> Result<(), String> {
    app.state::<crate::instance_lock::InstanceGuard>().require_primary()?;
    if state.is_active() {
        return Err("recordingActive".into());
    }
    if !crate::meeting_records::valid_id(&id) {
        return Err("recoveryFailed".into());
    }
    let Some(claim) = RecoveryClaim::take(&app.state::<SpeechHost>().recovering, &id) else {
        // Launch recovery (or an earlier Retry) is already processing it.
        return Ok(());
    };
    let root = data_root();
    let (prepare_root, prepare_id) = (root.clone(), id.clone());
    let retain = blocking("recoveryFailed", move || prepare_recovery(&prepare_root, &prepare_id)).await?;
    tauri::async_runtime::spawn(process_recovered(app, root, id, retain, claim));
    Ok(())
}
/// How long launch recovery waits, so the window, shortcuts and the speech warm-up start first.
const LAUNCH_RECOVERY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
/// Finds meetings a crash or force quit left unfinished and processes them in the background, one at a time.
/// Nothing waits for it: startup and the shortcut path never touch it, a live meeting takes the helper first,
/// and a crash during recovery is picked up again at the next launch (up to the attempt limit).
pub fn spawn_launch_recovery(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let root = data_root();
        // Read before anything can start a meeting: a meeting started in this launch is never in the list.
        let interrupted = {
            let root = root.clone();
            blocking("recoveryFailed", move || {
                RecordStore::open(&root)
                    .and_then(|s| s.interrupted_meetings())
                    .map_err(|e| e.to_string())
            })
            .await
        };
        tokio::time::sleep(LAUNCH_RECOVERY_DELAY).await;
        let interrupted = match interrupted {
            Ok(ids) => ids,
            Err(error) => {
                log::warn!("[recovery] interrupted meetings could not be read: {error}");
                return;
            }
        };
        for id in interrupted {
            // A meeting started since launch is not interrupted, whatever its row says.
            if app.state::<SpeechHost>().active_meeting.lock().map(|a| a.as_deref() == Some(id.as_str())).unwrap_or(true) {
                continue;
            }
            // Audio written seconds ago may belong to a recording that is still running; leave it for Retry.
            if crate::instance_lock::audio_recently_written(&root, &id, std::time::SystemTime::now(), crate::instance_lock::RECENT_AUDIO) {
                log::info!("[recovery] {id} skipped: its audio changed in the last 30 s");
                continue;
            }
            let Some(claim) = RecoveryClaim::take(&app.state::<SpeechHost>().recovering, &id) else {
                continue;
            };
            let (task_root, task_id) = (root.clone(), id.clone());
            let prepared = blocking("recoveryFailed", move || {
                let store = RecordStore::open(&task_root).map_err(|_| "recordReadFailed")?;
                if !store.begin_recovery(&task_id).map_err(|_| "recoveryFailed")? {
                    return Ok(None);
                }
                prepare_recovery(&task_root, &task_id).map(Some)
            })
            .await;
            match prepared {
                Ok(Some(retain)) => {
                    log::info!("[recovery] processing interrupted meeting {id}");
                    let _ = app.emit("record-recovery", json!({"meetingId":id,"state":"recovering"}));
                    process_recovered(app.clone(), root.clone(), id.clone(), retain, claim).await;
                    let _ = app.emit("record-recovery", json!({"meetingId":id,"state":"recovered"}));
                }
                Ok(None) => {
                    let _ = app.emit("record-recovery", json!({"meetingId":id,"state":"interrupted"}));
                }
                Err(error) => log::warn!("[recovery] {id} left for Retry processing: {error}"),
            }
        }
    });
}
#[tauri::command]
pub fn set_meeting_profile(
    id: String,
    profile_id: String,
    profile_revision: u64,
) -> Result<(), String> {
    RecordStore::open(&data_root())
        .and_then(|s| s.update_profile(&id, &profile_id, profile_revision))
        .map_err(|_| "profileUpdateFailed".into())
}

#[cfg(test)]
mod health_precedence_tests {
    use super::health_replaces;
    #[test]
    fn an_ended_lane_keeps_its_most_specific_reason() {
        // The journal failure is reported first, then the generic end: the specific reason must stay.
        assert!(!health_replaces(Some("journalFailed"), "captureEnded"));
        assert!(!health_replaces(Some("system-audio-unavailable"), "captureEnded"));
        assert!(!health_replaces(Some("captureUnavailable"), "captureStarted"));
        assert!(!health_replaces(Some("captureEnded"), "captureStarting"));
        assert!(!health_replaces(Some("captureEnded"), "diskSpaceLow"));
        // A specific reason may still replace the generic one.
        assert!(health_replaces(Some("captureEnded"), "journalFailed"));
    }
    #[test]
    fn warnings_clear_only_when_frames_flow_again() {
        assert!(!health_replaces(Some("system-audio-silent"), "captureStarting"));
        assert!(health_replaces(Some("system-audio-silent"), "captureStarted"));
        assert!(health_replaces(Some("captureStalled"), "captureRecovered"));
        assert!(health_replaces(Some("journalRetrying"), "captureEnded"));
        assert!(health_replaces(Some("diskSpaceLow"), "journalRetrying"));
    }
    // A lane that failed must not read as merely low on disk (and so as capturing).
    #[test]
    fn low_disk_space_never_hides_a_degraded_or_ended_lane() {
        for current in ["captureStalled", "captureInterrupted", "system-audio-silent", "journalRetrying", "captureStarting"] {
            assert!(!health_replaces(Some(current), "diskSpaceLow"), "{current}");
        }
        assert!(health_replaces(Some("captureStarted"), "diskSpaceLow"));
        assert!(health_replaces(Some("captureRecovered"), "diskSpaceLow"));
    }
    #[test]
    fn the_disk_warning_returns_while_space_stays_low() {
        use super::disk_health_update;
        // Shown on a capturing lane, kept while it shows, cleared when space returns.
        assert_eq!(disk_health_update(Some("captureStarted"), true), Some("diskSpaceLow"));
        assert_eq!(disk_health_update(Some("diskSpaceLow"), true), None);
        assert_eq!(disk_health_update(Some("diskSpaceLow"), false), Some("captureRecovered"));
        // A journal recovery cleared it while space is still low: the next check shows it again.
        assert_eq!(disk_health_update(Some("captureRecovered"), true), Some("diskSpaceLow"));
        // A degraded lane keeps its own code, and gets the warning once it recovers.
        assert_eq!(disk_health_update(Some("captureStalled"), true), None);
        assert_eq!(disk_health_update(Some("captureStalled"), false), None);
        assert_eq!(disk_health_update(Some("captureStarted"), false), None);
    }
    #[test]
    fn microphone_silence_and_denied_access_never_hide_an_ended_lane_and_clear_on_sound() {
        use super::{mic_signal_update, MIC_DENIED, MIC_SIGNAL};
        use crate::audio::silence::SilenceChange::{Signal, Silent};
        assert_eq!(mic_signal_update(Some("captureStarted"), Silent), Some("mic-silent"));
        assert_eq!(mic_signal_update(Some("mic-silent"), Silent), None, "reported once while it lasts");
        assert_eq!(mic_signal_update(Some("captureEnded"), Silent), None);
        assert_eq!(mic_signal_update(Some("mic-silent"), Signal), Some(MIC_SIGNAL));
        assert_eq!(mic_signal_update(Some(MIC_DENIED), Signal), Some(MIC_SIGNAL));
        assert_eq!(mic_signal_update(Some("captureStarted"), Signal), None);
        // Denied access outlives the start-up codes that follow it.
        for next in ["captureStarting", "captureStarted", "captureRecovered", "mic-silent", "diskSpaceLow", "captureEnded"] {
            assert!(!health_replaces(Some(MIC_DENIED), next), "{next}");
        }
        assert!(health_replaces(Some(MIC_DENIED), "journalFailed"));
        assert!(health_replaces(Some(MIC_DENIED), MIC_SIGNAL));
        assert!(health_replaces(Some("mic-silent"), "captureStalled"));
        assert!(!health_replaces(Some("mic-silent"), "diskSpaceLow"));
        assert!(health_replaces(Some(MIC_SIGNAL), "diskSpaceLow"));
    }
    #[test]
    fn progress_codes_replace_each_other() {
        assert!(health_replaces(None, "captureStarting"));
        assert!(health_replaces(Some("captureStarting"), "captureStarted"));
        assert!(health_replaces(Some("captureStarted"), "captureStalled"));
    }
}
#[cfg(test)]
mod update_guard_tests {
    use super::*;
    #[test]fn installation_and_capture_start_are_mutually_exclusive(){
        let controller=MeetingController::default();
        let guard=controller.begin_update().unwrap();
        assert_eq!(controller.begin_start().unwrap_err(),"updateInProgress");
        assert!(!controller.starting.load(Ordering::SeqCst));
        drop(guard);
        controller.begin_start().unwrap();
        assert!(controller.begin_update().is_err());
        assert!(!controller.updating.load(Ordering::SeqCst));
        controller.starting.store(false,Ordering::SeqCst);
        assert!(controller.begin_update().is_ok());
    }
    #[test]fn synthetic_records_are_refused_while_a_recording_starts_runs_or_finishes(){
        let controller=MeetingController::default();
        assert!(refuse_while_recording(&controller).is_ok());
        controller.starting.store(true,Ordering::SeqCst);
        assert_eq!(refuse_while_recording(&controller).unwrap_err(),"recordingActive");
        controller.starting.store(false,Ordering::SeqCst);
        controller.finishing.store(true,Ordering::SeqCst);
        assert_eq!(refuse_while_recording(&controller).unwrap_err(),"recordingActive");
    }
    #[test]fn finalizing_capture_blocks_install_and_failed_gate_can_be_retried(){
        let controller=MeetingController::default();
        controller.finishing.store(true,Ordering::SeqCst);
        assert!(controller.begin_update().is_err());
        controller.finishing.store(false,Ordering::SeqCst);
        assert!(controller.begin_update().is_ok());
    }
}
