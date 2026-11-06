use live_interview_lib::local_speech::translation::{
    translate_pending_loop, translate_pending_loop_with, translate_pending_step, SharedTranslationWorker, TranslationQueue,
    TranslationStep,
};
use live_interview_lib::local_speech::worker::LocalSpeechWorker;
use live_interview_lib::meeting_records::RecordStore;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("local-translation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    async fn worker(&self, messages: &[Value]) -> LocalSpeechWorker {
        let encoded = serde_json::to_string(&serde_json::to_string(messages).unwrap()).unwrap();
        let binary = self.binary(
            format!("#!/usr/bin/python3\nimport sys,json\nmessages=json.loads({encoded})\nfor line in sys.stdin:\n q=json.loads(line)\n if q.get('kind')=='shutdown': break\n for message in messages: print(json.dumps(message),flush=True)\n"),
        );
        LocalSpeechWorker::spawn(&binary, &self.0, &self.0)
            .await
            .unwrap()
    }
    fn binary(&self, script: String) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let binary = self.0.join(format!("fake-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(&binary, script).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        binary
    }
    fn backlog(&self) -> RecordStore {
        let store = RecordStore::open(&self.0).unwrap();
        store.create("meeting", &json!({"id":"meeting"})).unwrap();
        let audio = self.0.join("cache/meeting/source.wav");
        std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
        std::fs::write(&audio, b"fake local WAV placeholder").unwrap();
        store
            .add_chunk("source", "meeting", "remote", &audio, 1000)
            .unwrap();
        store.append_event_once(&source()).unwrap();
        store.mark_translation_pending("source").unwrap();
        store
    }
    fn translator(&self, gated: bool, failure: bool) -> PathBuf {
        let started = serde_json::to_string(&self.0.join("started").to_string_lossy()).unwrap();
        let release = serde_json::to_string(&self.0.join("release").to_string_lossy()).unwrap();
        let pid = serde_json::to_string(&self.0.join("pid").to_string_lossy()).unwrap();
        self.binary(format!(r#"#!/usr/bin/python3
import sys,json,os,time
for line in sys.stdin:
 q=json.loads(line)
 if q.get('kind')=='shutdown': break
 if q.get('kind')!='translateUtterance':
  print(json.dumps({{'kind':'failure'}}),flush=True)
  continue
 s=q['source']
 with open({pid},'w') as marker: marker.write(str(os.getpid()))
 with open({started},'w') as marker: marker.write(str(q['revision']))
 while {gated} and not os.path.exists({release}): time.sleep(0.005)
 if {failure}:
  print(json.dumps({{'kind':'failure'}}),flush=True)
  continue
 e={{'kind':'translation','language':'en','text':'Who decides?','meetingId':s['meetingId'],'lane':s['lane'],'segmentId':s['segmentId']+':en','sourceSegmentId':s['segmentId'],'revision':s['revision'],'startMs':s['startMs'],'endMs':s['endMs']}}
 print(json.dumps({{'kind':'speech','event':e}}),flush=True)
 print(json.dumps({{'kind':'translatedUtterance','segmentId':s['segmentId'],'revision':s['revision']}}),flush=True)
"#,gated=if gated {"True"} else {"False"},failure=if failure {"True"} else {"False"}))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn source() -> Value {
    json!({"meetingId":"meeting","lane":"remote","segmentId":"source","revision":3,
        "kind":"final","language":"de","text":"Wer entscheidet?","startMs":1000,"endMs":2000,
        "acceptedIntervals":[{"start":0.0,"end":1.0}]})
}
fn request() -> Value {
    json!({"kind":"translateUtterance","meetingId":"meeting","lane":"remote",
        "segmentId":"source","revision":3,"audioPath":"/fixture/source.wav","source":source()})
}
fn translation() -> Value {
    json!({"meetingId":"meeting","lane":"remote","segmentId":"source:en","sourceSegmentId":"source",
        "revision":3,"kind":"translation","language":"en","text":"Who decides?","startMs":1000,"endMs":2000})
}

#[tokio::test]
async fn translation_reader_rejects_provenance_before_publishing_the_event() {
    let fixture = Fixture::new();
    let mut wrong = translation();
    wrong["sourceSegmentId"] = json!("another-source");
    // A terminal recognized by the existing reader lets this regression fail
    // immediately instead of waiting for its unsupported new terminal kind.
    let mut worker = fixture
        .worker(&[
            json!({"kind":"speech","event":wrong}),
            json!({"kind":"translatedText","text":"done"}),
        ])
        .await;
    let mut published = Vec::new();
    let result = worker
        .request_stream(&request(), |event| published.push(event.clone()))
        .await;
    assert!(result.is_err(), "foreign-source translation was accepted");
    assert!(
        published.is_empty(),
        "foreign-source translation reached the callback"
    );
    worker.shutdown().await;
}

#[tokio::test]
async fn source_only_decode_rejects_unrequested_segment_revision_or_translation() {
    let fixture = Fixture::new();
    for (field, wrong) in [
        ("segmentId", json!("foreign")),
        ("revision", json!(4)),
        ("kind", json!("translation")),
    ] {
        let mut event = source();
        event[field] = wrong;
        let mut worker = fixture
            .worker(&[
                json!({"kind":"speech","event":event}),
                json!({"kind":"decoded","segmentId":"source"}),
            ])
            .await;
        let mut published = Vec::new();
        let result = worker.request_stream(&json!({"kind":"decode","sourceOnly":true,"meetingId":"meeting","lane":"remote","segmentId":"source","revision":3}), |event|published.push(event.clone())).await;
        assert!(result.is_err(), "source-only decode accepted wrong {field}");
        assert!(
            published.is_empty(),
            "source-only decode published wrong {field}"
        );
        worker.shutdown().await;
    }
}

async fn rejects_incompatible_decode_terminal(terminal: Value) {
    let fixture = Fixture::new();
    let store = RecordStore::open(&fixture.0).unwrap();
    store.create("meeting", &json!({"id":"meeting"})).unwrap();
    let audio = fixture.0.join("cache/meeting/source.wav");
    std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
    std::fs::write(&audio, b"owned fake raw audio").unwrap();
    store
        .add_chunk("source", "meeting", "remote", &audio, 1000)
        .unwrap();
    let mut worker = fixture.worker(&[terminal.clone()]).await;
    let mut published = Vec::new();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), worker.request_stream(
        &json!({"kind":"decode","sourceOnly":true,"meetingId":"meeting","lane":"remote","segmentId":"source","revision":1}),
        |event| published.push(event.clone()),
    )).await.expect("incompatible terminal should fail promptly");
    tokio::time::timeout(std::time::Duration::from_secs(20), worker.shutdown())
        .await
        .expect("fake helper should terminate promptly");
    // The decode owner completes a chunk only after the reader succeeds.
    if result.is_ok() {
        store.complete_chunk("source").unwrap();
    }
    assert!(
        result.is_err(),
        "source-only decode accepted {}",
        terminal["kind"]
    );
    assert!(
        published.is_empty(),
        "incompatible terminal reached the source callback"
    );
    assert_eq!(store.pending_chunks("meeting").unwrap().len(), 1);
    assert!(store.load("meeting").unwrap()["segments"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(audio.exists());
}

#[tokio::test]
async fn source_only_decode_rejects_text_translation_terminal_and_keeps_pending_audio() {
    rejects_incompatible_decode_terminal(
        json!({"kind":"translatedText","text":"unrelated query translation"}),
    )
    .await;
}

#[tokio::test]
async fn source_only_decode_rejects_embedding_terminal_and_keeps_pending_audio() {
    rejects_incompatible_decode_terminal(
        json!({"kind":"embeddings","entries":[{"id":"query","vector":[0.1,0.2]}]}),
    )
    .await;
}

#[tokio::test]
async fn text_and_embedding_replies_require_their_matching_request_kind() {
    let fixture = Fixture::new();
    for (request_kind, terminal) in [
        (
            "translateText",
            json!({"kind":"translatedText","text":"Wer entscheidet?"}),
        ),
        (
            "embedText",
            json!({"kind":"embeddings","entries":[{"id":"query","vector":[0.1,0.2]}]}),
        ),
    ] {
        let mut worker = fixture.worker(&[terminal.clone()]).await;
        assert_eq!(
            worker.request(&json!({"kind":request_kind})).await.unwrap(),
            vec![terminal.clone()]
        );
        worker.shutdown().await;
        let wrong_kind = if request_kind == "translateText" {
            "embedText"
        } else {
            "translateText"
        };
        let mut worker = fixture.worker(&[terminal]).await;
        assert!(worker.request(&json!({"kind":wrong_kind})).await.is_err());
        worker.shutdown().await;
    }
}

#[tokio::test]
async fn translation_reader_accepts_only_matching_events_and_terminals() {
    let fixture = Fixture::new();
    let terminal = json!({"kind":"translatedUtterance","segmentId":"source","revision":3});
    let mut worker = fixture
        .worker(&[
            json!({"kind":"speech","event":translation()}),
            terminal.clone(),
        ])
        .await;
    assert_eq!(
        worker.request(&request()).await.unwrap(),
        vec![translation()]
    );
    worker.shutdown().await;
    for (field, wrong) in [
        ("meetingId", json!("another")),
        ("lane", json!("me")),
        ("sourceSegmentId", json!("another")),
        ("segmentId", json!("another:en")),
        ("revision", json!(4)),
        ("kind", json!("final")),
        ("language", json!("de")),
        ("startMs", json!(0)),
        ("endMs", json!(3000)),
        ("text", json!("")),
    ] {
        let mut event = translation();
        event[field] = wrong;
        let mut worker = fixture
            .worker(&[json!({"kind":"speech","event":event}), terminal.clone()])
            .await;
        let mut published = Vec::new();
        assert!(
            worker
                .request_stream(&request(), |event| published.push(event.clone()))
                .await
                .is_err(),
            "accepted wrong {field}"
        );
        assert!(published.is_empty(), "published wrong {field}");
        worker.shutdown().await;
    }
    for wrong in [
        json!({"kind":"translatedUtterance","segmentId":"foreign","revision":3}),
        json!({"kind":"translatedUtterance","segmentId":"source","revision":4}),
    ] {
        let mut worker = fixture
            .worker(&[json!({"kind":"speech","event":translation()}), wrong])
            .await;
        assert!(worker.request(&request()).await.is_err());
        worker.shutdown().await;
    }
}

#[tokio::test]
async fn translation_step_publishes_once_and_retains_owned_audio() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(false, false);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let active = Arc::new(Mutex::new(None));
    let mut queue = TranslationQueue::default();
    let mut published = Vec::new();
    assert_eq!(
        translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |event| published.push(event)
        )
        .await
        .unwrap(),
        TranslationStep::Translated { inserted: true }
    );
    assert_eq!(
        translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut TranslationQueue::default(),
            |event| published.push(event)
        )
        .await
        .unwrap(),
        TranslationStep::Idle
    );
    assert_eq!(published.len(), 1);
    assert_eq!(published[0]["sourceSegmentId"], "source");
    assert_eq!(
        store.load("meeting").unwrap()["segments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(fixture.0.join("cache/meeting/source.wav").exists());
    if let Some(worker) = worker.lock().await.take() {
        worker.shutdown().await;
    };
}

#[tokio::test]
async fn translation_reads_current_backlog_after_acquiring_its_worker_lock() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(false, false);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let held = worker.lock().await;
    let active = Arc::new(Mutex::new(None));
    let mut queue = TranslationQueue::default();
    let mut published = Vec::new();
    {
        let pending = translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |event| published.push(event),
        );
        tokio::pin!(pending);
        assert!(futures_util::poll!(&mut pending).is_pending());
        let mut corrected = source();
        corrected["revision"] = json!(4);
        corrected["text"] = json!("Wer entscheidet wirklich?");
        store.append_event_once(&corrected).unwrap();
        drop(held);
        assert_eq!(
            pending.await.unwrap(),
            TranslationStep::Translated { inserted: true }
        );
    }
    assert_eq!(published[0]["revision"], 4);
    if let Some(worker) = worker.lock().await.take() {
        worker.shutdown().await;
    };
}

/// Bounds only a deadlock: a pass never depends on it. Helpers are Python
/// processes whose start-up time grows with machine load, so no latency budget
/// belongs in these tests; they wait on the condition itself.
const DEADLOCK_GUARD: std::time::Duration = std::time::Duration::from_secs(60);

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(DEADLOCK_GUARD, async {
        while !done() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("deadlock: {what}"));
}

async fn await_marker(path: &std::path::Path) {
    wait_until("fake helper did not receive the translation request", || {
        path.exists()
    })
    .await;
}

#[tokio::test]
async fn a_source_correction_during_translation_rejects_the_late_reply() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(true, false);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let active = Arc::new(Mutex::new(None));
    let mut queue = TranslationQueue::default();
    let mut published = Vec::new();
    let step = translate_pending_step(
        &fixture.0,
        "meeting",
        &binary,
        &worker,
        &active,
        &mut queue,
        |event| published.push(event),
    );
    let correction = async {
        await_marker(&fixture.0.join("started")).await;
        let mut corrected = source();
        corrected["revision"] = json!(4);
        store.append_event_once(&corrected).unwrap();
        std::fs::write(fixture.0.join("release"), b"release").unwrap();
    };
    let (result, ()) = tokio::join!(step, correction);
    assert_eq!(
        result.unwrap(),
        TranslationStep::Translated { inserted: false }
    );
    assert!(published.is_empty());
    assert_eq!(
        store.pending_translations("meeting").unwrap()[0]["revision"],
        4
    );
    if let Some(worker) = worker.lock().await.take() {
        worker.shutdown().await;
    };
}

#[tokio::test]
async fn blocked_german_translation_does_not_block_later_english_recognition_and_yields_to_live() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(true, false);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let active = Arc::new(Mutex::new(None));
    let translation_finished = AtomicBool::new(false);
    let mut queue = TranslationQueue::default();
    let mut published = Vec::new();
    let step = async {
        let result = translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |event| published.push(event),
        )
        .await;
        translation_finished.store(true, Ordering::SeqCst);
        result
    };
    let later_english = async {
        await_marker(&fixture.0.join("started")).await;
        let english = json!({"meetingId":"meeting","lane":"me","segmentId":"later","revision":1,"kind":"final","language":"en","text":"The business owner decides.","startMs":2000,"endMs":3000});
        let mut recognition = fixture
            .worker(&[
                json!({"kind":"speech","event":english}),
                json!({"kind":"decoded","segmentId":"later"}),
            ])
            .await;
        recognition
            .request_stream(
                &json!({"kind":"decode","meetingId":"meeting","lane":"me","segmentId":"later"}),
                |event| {
                    store.append_event_once(event).unwrap();
                },
            )
            .await
            .unwrap();
        recognition.shutdown().await;
        assert!(store.load("meeting").unwrap()["segments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["segmentId"] == "later"));
        // The German helper is never released, so translation can only end by
        // yielding after this block. This catches an early failure of the step.
        assert!(
            !translation_finished.load(Ordering::SeqCst),
            "translation ended before recognition did"
        );
        *active.lock().unwrap() = Some("new-live-meeting".into());
    };
    let (result, ()) = tokio::time::timeout(DEADLOCK_GUARD, async {
        tokio::join!(step, later_english)
    })
    .await
    .expect("deadlock: blocked translation and later recognition never finished");
    assert_eq!(result.unwrap(), TranslationStep::Yielded);
    assert!(published.is_empty());
    assert!(
        worker.lock().await.is_none(),
        "priority must drop the blocked helper"
    );
    let pid: libc::pid_t = std::fs::read_to_string(fixture.0.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // Signal 0 only probes: it fails with ESRCH once the killed helper is gone and reaped.
    wait_until("blocked fake translation process was not killed", || {
        unsafe { libc::kill(pid, 0) != 0 }
    })
    .await;
    assert_eq!(store.pending_translations("meeting").unwrap().len(), 1);
}

#[tokio::test]
async fn finished_translation_loop_keeps_failed_work_pending_without_spinning() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(false, true);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    translate_pending_loop(
        fixture.0.clone(),
        "meeting".into(),
        binary,
        worker.clone(),
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(true)),
        |_| panic!("failed loop published a translation"),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.0.join("started")).unwrap(),
        "3"
    );
    assert_eq!(store.pending_translations("meeting").unwrap().len(), 1);
    assert!(worker.lock().await.is_none());
    assert!(fixture.0.join("cache/meeting/source.wav").exists());
}

#[tokio::test]
async fn broken_store_terminates_translation_loop_with_backlog_error() {
    let fixture = Fixture::new();
    let broken = fixture.0.join("not-a-directory");
    std::fs::write(&broken, b"owned fixture").unwrap();
    // A persistent store error is retried with backoff, then ends the loop with the error.
    let attempts = std::sync::atomic::AtomicU32::new(0);
    let result = translate_pending_loop_with(
        broken,
        "meeting".into(),
        fixture.0.join("unused-helper"),
        Arc::new(tokio::sync::Mutex::new(None)),
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        |_| panic!("broken store published"),
        |consecutive, _| {
            attempts.store(consecutive, std::sync::atomic::Ordering::SeqCst);
            (consecutive <= 3).then_some(std::time::Duration::from_millis(1))
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 4);
}

// One transient store error must not end translation for the meeting: the loop waits and carries on.
#[tokio::test]
async fn a_transient_store_error_does_not_end_the_translation_loop() {
    let fixture = Fixture::new();
    let flaky = fixture.0.join("flaky-root");
    std::fs::write(&flaky, b"temporarily not a directory").unwrap();
    let result = translate_pending_loop_with(
        flaky.clone(),
        "meeting".into(),
        fixture.0.join("unused-helper"),
        Arc::new(tokio::sync::Mutex::new(None)),
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(true)),
        |_| panic!("empty store published"),
        |consecutive, _| {
            // The fault clears before the retry.
            let _ = std::fs::remove_file(&flaky);
            (consecutive <= 1).then_some(std::time::Duration::from_millis(1))
        },
    )
    .await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn translation_failure_remains_deferred_until_explicit_retry_or_a_new_source_revision() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = fixture.translator(false, true);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let active = Arc::new(Mutex::new(None));
    let mut queue = TranslationQueue::default();
    assert_eq!(
        translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |_| panic!("failed translation published")
        )
        .await
        .unwrap(),
        TranslationStep::Deferred
    );
    assert_eq!(
        translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |_| panic!("deferred translation published")
        )
        .await
        .unwrap(),
        TranslationStep::Idle
    );
    assert_eq!(store.pending_translations("meeting").unwrap().len(), 1);
    assert!(worker.lock().await.is_none());
    let mut corrected = source();
    corrected["revision"] = json!(4);
    store.append_event_once(&corrected).unwrap();
    let binary = fixture.translator(false, false);
    assert_eq!(
        translate_pending_step(
            &fixture.0,
            "meeting",
            &binary,
            &worker,
            &active,
            &mut queue,
            |_| {}
        )
        .await
        .unwrap(),
        TranslationStep::Translated { inserted: true }
    );
    if let Some(worker) = worker.lock().await.take() {
        worker.shutdown().await;
    };
}

#[tokio::test]
async fn translation_into_a_requested_target_must_carry_that_language_and_segment_id() {
    let fixture = Fixture::new();
    let mut french = translation();
    french["language"] = json!("fr");
    french["segmentId"] = json!("source:fr");
    let mut asked = request();
    asked["target"] = json!("fr");
    let reply = |event: &Value| {
        [
            json!({"kind":"speech","event":event}),
            json!({"kind":"translatedUtterance","segmentId":"source","revision":3}),
        ]
    };
    let mut worker = fixture.worker(&reply(&french)).await;
    let events = worker.request_stream(&asked, |_| {}).await.unwrap();
    assert_eq!(events[0]["language"], "fr");
    worker.shutdown().await;
    // English text answering a French request, and French answering an unspecified (English) request, both fail.
    let mut worker = fixture.worker(&reply(&translation())).await;
    assert!(worker.request_stream(&asked, |_| {}).await.is_err());
    worker.shutdown().await;
    let mut worker = fixture.worker(&reply(&french)).await;
    assert!(worker.request_stream(&request(), |_| {}).await.is_err());
    worker.shutdown().await;
}

#[tokio::test]
async fn translation_status_reply_answers_only_a_status_request() {
    let fixture = Fixture::new();
    let status = json!({"kind":"translationStatus","target":"en","installedSources":["de"],"appleAvailable":true});
    let mut worker = fixture.worker(&[status.clone()]).await;
    let events = worker
        .request(&json!({"kind":"translationStatus"}))
        .await
        .unwrap();
    assert_eq!(events[0]["installedSources"], json!(["de"]));
    worker.shutdown().await;
    let mut worker = fixture.worker(&[status]).await;
    assert!(worker.request_stream(&request(), |_| {}).await.is_err());
    worker.shutdown().await;
}

#[tokio::test]
async fn medium_translation_flag_reaches_the_helper_only_when_the_setting_is_on() {
    use live_interview_lib::local_speech::settings::set_experimental_medium_translation;
    let fixture = Fixture::new();
    let echo = fixture.binary(
        "#!/usr/bin/python3\nimport sys,json\nfor line in sys.stdin:\n if json.loads(line).get('kind')=='shutdown': break\n print(json.dumps({'kind':'translatedText','args':sys.argv[1:]}),flush=True)\n".into(),
    );
    let models = fixture.0.join("models");
    for (enabled, expected) in [(false, false), (true, true)] {
        set_experimental_medium_translation(&fixture.0, enabled).unwrap();
        let mut worker = LocalSpeechWorker::spawn(&echo, &models, &fixture.0.join("cache"))
            .await
            .unwrap();
        let events = worker
            .request(&json!({"kind":"translateText","text":"x","source":"de","target":"en"}))
            .await
            .unwrap();
        let args = events[0]["args"].as_array().unwrap();
        assert_eq!(
            args.iter().any(|a| a == "--experimental-medium-translation"),
            expected
        );
        worker.shutdown().await;
    }
}

/// A translator that records each attempt in `attempts` and fails it.
fn counting_failure(fixture: &Fixture) -> PathBuf {
    let attempts = serde_json::to_string(&fixture.0.join("attempts").to_string_lossy()).unwrap();
    fixture.binary(format!("#!/usr/bin/python3\nimport sys,json\nfor line in sys.stdin:\n q=json.loads(line)\n if q.get('kind')=='shutdown': break\n with open({attempts},'a') as f: f.write('x')\n print(json.dumps({{'kind':'failure'}}),flush=True)\n"))
}

// N1: a translation that failed during the meeting is tried once more before the run ends at Stop, then
// stays pending for Retry processing instead of being dropped after its first failure.
#[tokio::test]
async fn finished_translation_loop_retries_a_failed_job_once_more_before_ending() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let binary = counting_failure(&fixture);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    translate_pending_loop(
        fixture.0.clone(),
        "meeting".into(),
        binary,
        worker.clone(),
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(true)),
        |_| panic!("failed loop published a translation"),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(fixture.0.join("attempts")).unwrap(), "xx");
    assert_eq!(store.pending_translations("meeting").unwrap().len(), 1);
}

// N1: a failed job is tried again after its wait. Its failure terminated the helper, so the replacement
// helper does not retry it at once (a hanging job would stall every new helper); see review of #133.
#[tokio::test]
async fn a_failed_translation_keeps_its_wait_on_a_replaced_helper_and_is_retried_after_it() {
    let fixture = Fixture::new();
    let store = fixture.backlog();
    let failing = counting_failure(&fixture);
    let worker: SharedTranslationWorker = Arc::new(tokio::sync::Mutex::new(None));
    let active = Arc::new(Mutex::new(None));
    let mut queue = TranslationQueue::default();
    for expected in [TranslationStep::Deferred, TranslationStep::Idle] {
        let step = translate_pending_step(&fixture.0, "meeting", &failing, &worker, &active, &mut queue, |_| {})
            .await
            .unwrap();
        assert_eq!(step, expected);
    }
    assert!(worker.lock().await.is_none(), "the failed helper was terminated");
    let good = fixture.translator(false, false);
    *worker.lock().await = Some(LocalSpeechWorker::spawn(&good, &fixture.0, &fixture.0).await.unwrap());
    assert_eq!(
        translate_pending_step(&fixture.0, "meeting", &good, &worker, &active, &mut queue, |_| {})
            .await
            .unwrap(),
        TranslationStep::Idle
    );
    tokio::time::sleep(live_interview_lib::local_speech::worker::RETRY_FIRST_WAIT).await;
    assert_eq!(
        translate_pending_step(&fixture.0, "meeting", &good, &worker, &active, &mut queue, |_| {})
            .await
            .unwrap(),
        TranslationStep::Translated { inserted: true }
    );
    assert!(store.pending_translations("meeting").unwrap().is_empty());
    if let Some(worker) = worker.lock().await.take() {
        worker.shutdown().await;
    };
}
