use live_interview_lib::local_speech::worker::LocalSpeechWorker;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[tokio::test]
async fn a_stalled_stopped_request_yields_to_a_new_live_meeting() {
    let root = std::env::temp_dir().join(format!("live-helper-priority-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let script = root.join("fake-worker.py");
    std::fs::write(&script,"#!/usr/bin/python3\nimport sys,json,time\nfor line in sys.stdin:\n q=json.loads(line)\n if q.get('meetingId')=='a': time.sleep(60)\n else:\n  print(json.dumps({'kind':'decoded','segmentId':q.get('segmentId')}),flush=True)\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut worker = LocalSpeechWorker::spawn(&script, &root, &root)
        .await
        .unwrap();
    let yield_now = Arc::new(AtomicBool::new(false));
    let changed = yield_now.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        changed.store(true, Ordering::SeqCst);
    });
    let start = std::time::Instant::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        worker.request_stream_prioritized(
            &json!({"kind":"decode","meetingId":"a","lane":"me"}),
            |_| {},
            || yield_now.load(Ordering::SeqCst),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    drop(worker);
    let mut next = LocalSpeechWorker::spawn(&script, &root, &root)
        .await
        .unwrap();
    assert!(next
        .request(&json!({"kind":"decode","meetingId":"b","lane":"me"}))
        .await
        .is_ok());
    next.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
