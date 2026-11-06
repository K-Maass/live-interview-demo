use live_interview_lib::meeting_records::{DecodeCompletion, RecordStore};
use serde_json::{json, Value};

fn fixture() -> (std::path::PathBuf, RecordStore, Value) {
    let root =
        std::env::temp_dir().join(format!("live-translation-backlog-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let audio = root.join("cache/m/s.wav");
    std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
    std::fs::write(&audio, b"synthetic audio placeholder").unwrap();
    store.add_chunk("s", "m", "remote", &audio, 0).unwrap();
    let source = json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","text":"Wer entscheidet?","language":"de","startMs":0,"endMs":1000,"acceptedIntervals":[{"start":0.2,"end":0.8}]});
    (root, store, source)
}

fn translated(source: &Value) -> Value {
    json!({"meetingId":source["meetingId"],"segmentId":"s:en","sourceSegmentId":source["segmentId"],"revision":source["revision"],"lane":source["lane"],"startMs":source["startMs"],"endMs":source["endMs"],"kind":"translation","language":"en","text":"Who decides?"})
}

#[test]
fn duplicate_publication_returns_no_event_and_preserves_canonical_source() {
    let (root, store, source) = fixture();
    let saved = store.append_event_once(&source).unwrap().unwrap();
    assert!(store.append_event_once(&source).unwrap().is_none());
    let mut different = source.clone();
    different["text"] = json!("This must not replace persisted evidence");
    assert_eq!(store.append_event(&different).unwrap(), saved);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_translation_backlog_does_not_redecode_recognized_source() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    drop(store);
    let store = RecordStore::open(&root).unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    let jobs = store.pending_translations("m").unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0]["source"]["acceptedIntervals"],
        source["acceptedIntervals"]
    );
    assert_eq!(jobs[0]["source"]["text"], source["text"]);
    store.retry_translations("m").unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert_eq!(store.pending_translations("m").unwrap().len(), 1);
    assert!(store
        .commit_translation(&translated(&source))
        .unwrap()
        .is_some());
    assert!(store
        .commit_translation(&translated(&source))
        .unwrap()
        .is_none());
    assert!(store.pending_translations("m").unwrap().is_empty());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "complete");
    assert!(root.join("cache/m/s.wav").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn late_translation_cannot_complete_corrected_source_or_change_capture_lane() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    let mut current = source.clone();
    current["revision"] = json!(2);
    current["text"] = json!("Wer entscheidet wirklich?");
    store.append_event_once(&current).unwrap();
    assert!(store
        .commit_translation(&translated(&source))
        .unwrap()
        .is_none());
    assert_eq!(store.pending_translations("m").unwrap()[0]["revision"], 2);
    let mut wrong_lane = translated(&current);
    wrong_lane["lane"] = json!("me");
    assert!(store.commit_translation(&wrong_lane).is_err());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
    assert_eq!(store.next_source_revision("m", "s").unwrap(), 3);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_or_invalid_intervals_require_explicit_recognition_recovery() {
    for intervals in [
        Value::Null,
        json!([]),
        json!([{"start":-1,"end":0.8}]),
        json!([{"start":0.2,"end":2}]),
    ] {
        let (root, store, mut source) = fixture();
        source["acceptedIntervals"] = intervals;
        store.append_event_once(&source).unwrap();
        store.mark_translation_pending("s").unwrap();
        assert!(store.pending_translations("m").unwrap().is_empty());
        store.retry_translations("m").unwrap();
        assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
        assert!(root.join("cache/m/s.wav").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn a_source_that_conflicts_with_its_physical_chunk_never_becomes_a_translation_job() {
    let (root, store, mut source) = fixture();
    source["lane"] = json!("me");
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    assert!(store.pending_translations("m").unwrap().is_empty());
    assert!(store.commit_translation(&translated(&source)).is_err());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn failed_persistence_keeps_translation_pending_and_raw_audio_available() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    let db = root.join("recording.sqlite");
    let backup = root.join("saved.sqlite");
    std::fs::rename(&db, &backup).unwrap();
    std::os::unix::fs::symlink(root.join("foreign.sqlite"), &db).unwrap();
    assert!(store.commit_translation(&translated(&source)).is_err());
    std::fs::remove_file(&db).unwrap();
    std::fs::rename(&backup, &db).unwrap();
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
    assert!(root.join("cache/m/s.wav").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_retry_after_source_publication_routes_saved_intervals_to_translation() {
    let (root, store, source) = fixture();
    // Source was durably streamed, but the original helper never sent its terminal.
    store.append_event_once(&source).unwrap();
    assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
    // A later successful source decode emitted no new events.
    assert_eq!(
        store.complete_chunk("s").unwrap(),
        DecodeCompletion::TranslationPending
    );
    assert!(store.pending_chunks("m").unwrap().is_empty());
    let jobs = store.pending_translations("m").unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["source"]["text"], "Wer entscheidet?");
    assert_eq!(jobs[0]["revision"], 1);
    assert!(root.join("cache/m/s.wav").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_legacy_retries_remain_selectable_after_repeated_explicit_recovery() {
    let (root, store, mut source) = fixture();
    source.as_object_mut().unwrap().remove("acceptedIntervals");
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    for _ in 0..3 {
        store.retry_translations("m").unwrap();
        assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
        assert_eq!(
            store.complete_chunk("s").unwrap(),
            DecodeCompletion::RecognitionPending
        );
        assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
        assert!(store.pending_translations("m").unwrap().is_empty());
        assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
        assert!(root.join("cache/m/s.wav").exists());
    }
    assert_eq!(
        store.load("m").unwrap()["segments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_genuinely_silent_chunk_without_saved_source_completes() {
    let (root, store, _) = fixture();
    assert_eq!(
        store.complete_chunk("s").unwrap(),
        DecodeCompletion::Completed
    );
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert!(store.pending_translations("m").unwrap().is_empty());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "complete");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn completion_observes_a_translation_committed_before_it_and_does_not_requeue() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    store.commit_translation(&translated(&source)).unwrap();
    assert_eq!(
        store.complete_chunk("s").unwrap(),
        DecodeCompletion::Completed
    );
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert!(store.pending_translations("m").unwrap().is_empty());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "complete");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_retry_cannot_complete_a_newer_source_using_a_stale_translation() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    store.commit_translation(&translated(&source)).unwrap();
    let mut corrected = source.clone();
    corrected["revision"] = json!(2);
    store.append_event_once(&corrected).unwrap();
    assert_eq!(
        store.complete_chunk("s").unwrap(),
        DecodeCompletion::TranslationPending
    );
    let jobs = store.pending_translations("m").unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["revision"], 2);
    assert!(store
        .commit_translation(&translated(&source))
        .unwrap()
        .is_none());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_completion_preserves_physical_capture_provenance() {
    for (key, wrong) in [("lane", json!("me")), ("startMs", json!(5000))] {
        let (root, store, mut source) = fixture();
        source[key] = wrong;
        store.append_event_once(&source).unwrap();
        assert!(store.complete_chunk("s").is_err());
        assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
        assert!(root.join("cache/m/s.wav").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn empty_retry_of_saved_english_source_completes() {
    let (root, store, mut source) = fixture();
    source["language"] = json!("en");
    source["text"] = json!("Who decides?");
    store.append_event_once(&source).unwrap();
    assert_eq!(
        store.complete_chunk("s").unwrap(),
        DecodeCompletion::Completed
    );
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "complete");
    std::fs::remove_dir_all(root).unwrap();
}

// A record written by main: translationPending with no acceptedIntervals. Its WAV is the only way to
// re-recognize it, so releasing recognized audio must keep it, and a retry can then re-recognize.
#[test]
fn audio_of_a_source_without_valid_intervals_is_kept_for_recognition_recovery() {
    let (root, store, mut source) = fixture();
    source.as_object_mut().unwrap().remove("acceptedIntervals");
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    assert_eq!(store.release_recognized_audio("m", false).unwrap(), 0);
    assert!(root.join("cache/m/s.wav").exists());
    store.retry_translations("m").unwrap();
    assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn audio_of_a_translatable_source_is_released() {
    let (root, store, source) = fixture();
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    assert_eq!(store.release_recognized_audio("m", false).unwrap(), 1);
    assert!(!root.join("cache/m/s.wav").exists());
    // Translation works from the text, so the retry keeps it a translation job, not a recognition one.
    store.retry_translations("m").unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert_eq!(store.pending_translations("m").unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

// The WAV of a source without intervals was already deleted (by an earlier build). Re-recognition is
// impossible, so the retry must not queue it forever: the chunk ends as translation unavailable, the
// source evidence stays, and the record no longer reads as processing.
#[test]
fn a_retry_never_queues_recognition_for_audio_that_is_gone() {
    let (root, store, mut source) = fixture();
    source.as_object_mut().unwrap().remove("acceptedIntervals");
    store.append_event_once(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    std::fs::remove_file(root.join("cache/m/s.wav")).unwrap();
    store.retry_translations("m").unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert!(store.pending_translations("m").unwrap().is_empty());
    let record = store.load("m").unwrap();
    assert_eq!(record["pendingSegments"], 0);
    assert_eq!(record["translationStatus"], "unavailable");
    assert_eq!(record["segments"][0]["text"], "Wer entscheidet?");
    store.retry_translations("m").unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
