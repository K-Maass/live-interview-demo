use live_interview_lib::{local_speech::recording::RecordingJournal, meeting_records::RecordStore};
use serde_json::json;
#[test]
fn recording_journal_grows_with_failed_or_never_started_reasoning() {
    let root = std::env::temp_dir().join(format!("live-recording-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store
        .create("synthetic", &json!({"id":"synthetic"}))
        .unwrap();
    let mut recorder = RecordingJournal::new(&root, "synthetic", "remote").unwrap();
    for _ in 0..30 {
        recorder.ingest(&vec![3000; 1600], false).unwrap();
    }
    recorder.flush().unwrap();
    assert_eq!(recorder.frames(), 48_000);
    assert!(!store.pending_chunks("synthetic").unwrap().is_empty());
    let size = std::fs::metadata(root.join("cache/synthetic/remote.pcm"))
        .unwrap()
        .len();
    for _ in 0..30 {
        recorder.ingest(&vec![3000; 1600], false).unwrap();
    }
    recorder.flush().unwrap();
    assert!(
        std::fs::metadata(root.join("cache/synthetic/remote.pcm"))
            .unwrap()
            .len()
            > size
    );
    let before = recorder.frames();
    recorder.ingest(&vec![3000; 1600], true).unwrap();
    assert_eq!(recorder.frames(), before);
    drop(recorder);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn unflushed_raw_tail_recovers_once_with_its_fixed_lane() {
    let root = std::env::temp_dir().join(format!("live-tail-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let mut journal = RecordingJournal::new(&root, "m", "remote").unwrap();
    journal.ingest(&vec![3000; 16000], false).unwrap();
    drop(journal);
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert_eq!(
        live_interview_lib::local_speech::recording::recover_raw_tail(&root, "m").unwrap(),
        1
    );
    let chunks = store.pending_chunks("m").unwrap();
    assert_eq!(chunks[0]["lane"], "remote");
    assert_eq!(
        live_interview_lib::local_speech::recording::recover_raw_tail(&root, "m").unwrap(),
        0
    );
    assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn lanes_share_the_capture_clock_and_recovery_preserves_start_offset() {
    let root = std::env::temp_dir().join(format!("live-clock-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let mut journal = RecordingJournal::new(&root, "m", "remote").unwrap();
    journal
        .ingest_captured(&vec![3000; 16000], 1500, false)
        .unwrap();
    drop(journal);
    live_interview_lib::local_speech::recording::recover_raw_tail(&root, "m").unwrap();
    assert_eq!(store.pending_chunks("m").unwrap()[0]["startMs"], 1500);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn crash_tail_is_visible_as_pending_before_recovery() {
    let root = std::env::temp_dir().join(format!("live-pending-tail-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let mut journal = RecordingJournal::new(&root, "m", "remote").unwrap();
    journal.ingest(&vec![3000; 16000], false).unwrap();
    drop(journal);
    let record = store.load("m").unwrap();
    assert_eq!(record["translationStatus"], "pending");
    assert!(record["pendingSegments"].as_i64().unwrap() > 0);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn recovery_does_not_follow_a_replaced_cache_parent() {
    let root = std::env::temp_dir().join(format!("live-cache-escape-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("cache")).unwrap();
    let foreign = root.join("foreign");
    std::fs::create_dir(&foreign).unwrap();
    std::fs::write(foreign.join("remote.pcm"), vec![0u8; 32000]).unwrap();
    std::os::unix::fs::symlink(&foreign, root.join("cache/m")).unwrap();
    assert!(live_interview_lib::local_speech::recording::recover_raw_tail(&root, "m").is_err());
    assert!(!foreign.join("remote.checkpoint.json").exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn stop_drains_the_already_captured_backlog() {
    use live_interview_lib::local_speech::recording::{drain_capture, CapturedFrames};
    let root = std::env::temp_dir().join(format!("live-drain-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let mut journal = RecordingJournal::new(&root, "m", "me").unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let start = std::time::Instant::now();
    for value in [1000i16, 2000, 3000] {
        tx.send(CapturedFrames {
            pcm: vec![value; 1600],
            captured_at: start + std::time::Duration::from_millis(100),
        })
        .unwrap();
    }
    drop(tx);
    drain_capture(&mut journal, rx, start, |_| false, || false, |_, _| {}, |_| {}, |_| {})
        .await
        .unwrap();
    let bytes = std::fs::read(root.join("cache/m/me.pcm")).unwrap();
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    assert_eq!(samples.len(), 4800);
    assert_eq!(
        [samples[0], samples[1600], samples[3200]],
        [1000, 2000, 3000]
    );
    std::fs::remove_dir_all(root).unwrap();
}
