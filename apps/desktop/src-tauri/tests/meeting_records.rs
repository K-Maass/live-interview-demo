use live_interview_lib::meeting_records::RecordStore;
use serde_json::json;
#[test]
fn source_survives_restart_and_duplicates_do_not_grow_journal() {
    let root = std::env::temp_dir().join(format!("live-interview-test-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store
        .create(
            "meeting-1",
            &json!({"id":"meeting-1","purpose":"Synthetic fixture","retainAudio":false}),
        )
        .unwrap();
    let event = json!({"meetingId":"meeting-1","segmentId":"s","revision":1,"lane":"remote","kind":"final","text":"Wer entscheidet?","language":"de","startMs":0,"endMs":1000});
    store.append_event(&event).unwrap();
    store.append_event(&event).unwrap();
    drop(store);
    let reopened = RecordStore::open(&root).unwrap();
    assert_eq!(
        reopened.load("meeting-1").unwrap()["segments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(reopened.load("../escape").is_err());
    assert!(reopened.create("meeting-1", &json!({})).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn translation_failure_stays_recoverable_and_retry_keeps_source_once() {
    let root =
        std::env::temp_dir().join(format!("live-translation-retry-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    // Re-recognition needs the chunk's audio, so the retry below only requeues it while the WAV exists.
    std::fs::write(root.join("s.wav"), b"synthetic audio placeholder").unwrap();
    store
        .add_chunk("s", "m", "remote", &root.join("s.wav"), 0)
        .unwrap();
    let source = json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","text":"Wer entscheidet?","language":"de","startMs":0,"endMs":1});
    store.append_event(&source).unwrap();
    store.mark_translation_pending("s").unwrap();
    assert!(store.pending_chunks("m").unwrap().is_empty());
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending");
    store.retry_translations("m").unwrap();
    assert_eq!(store.pending_chunks("m").unwrap().len(), 1);
    store.append_event(&source).unwrap();
    store.append_event(&json!({"meetingId":"m","segmentId":"s-en","sourceSegmentId":"s","revision":1,"lane":"remote","kind":"translation","text":"Who decides?","language":"en","startMs":0,"endMs":1})).unwrap();
    store.complete_chunk("s").unwrap();
    assert_eq!(
        store.load("m").unwrap()["segments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(store.load("m").unwrap()["translationStatus"], "complete");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn export_uses_latest_final_and_only_its_matching_translation() {
    let root = std::env::temp_dir().join(format!("live-latest-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store
        .create("m", &json!({"id":"m","purpose":"Synthetic"}))
        .unwrap();
    for e in [
        json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"partial","text":"Partial old","language":"de","startMs":0,"endMs":1}),
        json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","text":"Alte Aussage","language":"de","startMs":0,"endMs":1}),
        json!({"meetingId":"m","segmentId":"s-en","sourceSegmentId":"s","revision":1,"lane":"remote","kind":"translation","text":"Old statement","language":"en","startMs":0,"endMs":1}),
        json!({"meetingId":"m","segmentId":"s","revision":2,"lane":"remote","kind":"final","text":"Korrigierte Aussage","language":"de","startMs":0,"endMs":1}),
    ] {
        store.append_event(&e).unwrap();
    }
    let record = store.finish("m").unwrap();
    let source = std::fs::read_to_string(root.join("records/m/source.md")).unwrap();
    let english = std::fs::read_to_string(root.join("records/m/english.md")).unwrap();
    assert_eq!(record["translationStatus"], "pending");
    assert!(source.contains("Korrigierte"));
    assert!(!source.contains("Alte") && !source.contains("Partial"));
    assert!(!english.contains("Old statement"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn participant_links_use_explicit_person_ids_and_do_not_merge_names() {
    let root = std::env::temp_dir().join(format!("live-person-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    for (meeting, person) in [("m1", "p1"), ("m2", "p2")] {
        store
            .create(
                meeting,
                &json!({"id":meeting,"attendees":[{"id":person,"name":"Lisa"}]}),
            )
            .unwrap();
        store.finish(meeting).unwrap();
    }
    assert_eq!(store.people().unwrap().len(), 2);
    assert!(root.join("people/p1/m1.md").exists());
    assert!(root.join("people/p2/m2.md").exists());
    assert!(!root.join("people/p1/m2.md").exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn replaced_record_directory_never_overwrites_foreign_workspace() {
    let root = std::env::temp_dir().join(format!("live-record-escape-{}", uuid::Uuid::new_v4()));
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m"})).unwrap();
    let foreign = root.join("foreign");
    std::fs::create_dir(&foreign).unwrap();
    std::fs::write(foreign.join("english.md"), "USER OWNED SENTINEL").unwrap();
    std::fs::remove_dir(root.join("records/m")).unwrap();
    std::os::unix::fs::symlink(&foreign, root.join("records/m")).unwrap();
    assert!(store.finish("m").is_err());
    assert_eq!(
        std::fs::read_to_string(foreign.join("english.md")).unwrap(),
        "USER OWNED SENTINEL"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(target_os = "macos")]
fn atomic_write_keeps_mode_and_extended_attributes_and_cleans_up_on_failure() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("live-atomic-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, "before").unwrap();
    std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o640)).unwrap();
    let path = std::ffi::CString::new(note.to_str().unwrap()).unwrap();
    let name = std::ffi::CString::new("com.example.tag").unwrap();
    assert_eq!(
        unsafe { libc::setxattr(path.as_ptr(), name.as_ptr(), b"kept".as_ptr().cast(), 4, 0, 0) },
        0
    );
    live_interview_lib::meeting_records::atomic_write(&note, b"after").unwrap();
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "after");
    assert_eq!(std::fs::metadata(&note).unwrap().permissions().mode() & 0o777, 0o640);
    let mut buffer = [0u8; 16];
    let size = unsafe {
        libc::getxattr(path.as_ptr(), name.as_ptr(), buffer.as_mut_ptr().cast(), 16, 0, 0)
    };
    assert_eq!(&buffer[..size.max(0) as usize], b"kept");
    // A directory in the target's place makes the rename fail after the temporary file exists.
    let blocked = root.join("blocked.md");
    std::fs::create_dir(&blocked).unwrap();
    assert!(live_interview_lib::meeting_records::atomic_write(&blocked, b"x").is_err());
    let leftovers = std::fs::read_dir(&root)
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0);
    std::fs::remove_dir_all(root).unwrap();
}

fn fixture_root(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("live-{tag}-{}", uuid::Uuid::new_v4()))
}
fn source(meeting: &str, segment: &str, revision: i64, lane: &str, language: &str, start: i64, text: &str) -> serde_json::Value {
    json!({"meetingId":meeting,"segmentId":segment,"revision":revision,"lane":lane,"kind":"final","text":text,"language":language,"startMs":start,"endMs":start + 1000})
}
fn translation(meeting: &str, segment: &str, revision: i64, lane: &str, start: i64, text: &str) -> serde_json::Value {
    json!({"meetingId":meeting,"segmentId":format!("{segment}:en:{revision}:{lane}"),"sourceSegmentId":segment,"revision":revision,"lane":lane,"kind":"translation","text":text,"language":"en","startMs":start,"endMs":start + 1000})
}
/// Several records covering each processing state: complete, a newer source revision without its translation,
/// a translation unavailable chunk, a pending chunk, an English-only record and an empty one.
fn varied_store(root: &std::path::Path) -> RecordStore {
    let store = RecordStore::open(root).unwrap();
    store.create("done", &json!({"id":"done","purpose":"Complete","attendees":[{"id":"p1","name":"Ana"}]})).unwrap();
    store.append_event(&source("done", "a", 1, "remote", "de", 0, "Hallo")).unwrap();
    store.append_event(&translation("done", "a", 1, "remote", 0, "Hello")).unwrap();
    store.append_event(&source("done", "b", 1, "me", "en", 1000, "Hi")).unwrap();

    store.create("newer", &json!({"id":"newer","purpose":"Newer revision"})).unwrap();
    store.append_event(&source("newer", "a", 1, "remote", "de", 0, "Alt")).unwrap();
    store.append_event(&translation("newer", "a", 1, "remote", 0, "Old")).unwrap();
    store.append_event(&source("newer", "a", 2, "remote", "de", 0, "Neu")).unwrap();

    store.create("gone", &json!({"id":"gone","purpose":"Unavailable"})).unwrap();
    store.add_chunk("x", "gone", "remote", &root.join("missing.wav"), 0).unwrap();
    store.append_event(&source("gone", "x", 1, "remote", "fr", 0, "Bonjour")).unwrap();
    store.mark_translation_pending("x").unwrap();
    store.retry_translations("gone").unwrap();

    store.create("queued", &json!({"id":"queued","purpose":"Queued"})).unwrap();
    store.add_chunk("q", "queued", "me", &root.join("q.wav"), 0).unwrap();

    store.create("english", &json!({"id":"english","purpose":"English only"})).unwrap();
    store.append_event(&source("english", "a", 1, "me", "en", 0, "Hello")).unwrap();
    store.append_event(&json!({"meetingId":"english","segmentId":"a","revision":2,"lane":"me","kind":"partial","text":"Hel","language":"en","startMs":0,"endMs":500})).unwrap();

    store.create("empty", &json!({"id":"empty","purpose":"Empty"})).unwrap();
    store
}
#[test]
fn listing_returns_summaries_that_match_the_full_record() {
    let root = fixture_root("summary");
    let store = varied_store(&root);
    let list = store.list().unwrap();
    let ids: Vec<_> = list.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, ["empty", "english", "queued", "gone", "newer", "done"], "newest first");
    for summary in &list {
        let id = summary["id"].as_str().unwrap();
        let full = store.load(id).unwrap();
        for key in ["purpose", "date", "attendees", "translationStatus", "pendingSegments", "revision", "canonicalEnglishPath", "importedSegments", "attributions"] {
            assert_eq!(summary[key], full[key], "{id}: {key}");
        }
        // The list is a summary: no transcript, and it says so, so the renderer loads the full record to open it.
        assert_eq!(summary["segments"], json!([]), "{id}");
        assert_eq!(summary["summary"], json!(true), "{id}");
        assert!(full.get("summary").is_none(), "{id}");
    }
    let status = |id: &str| store.load(id).unwrap()["translationStatus"].clone();
    assert_eq!(status("done"), "complete");
    assert_eq!(status("newer"), "pending", "a translation of an older revision does not cover the newer source");
    assert_eq!(status("gone"), "unavailable");
    assert_eq!(status("queued"), "pending");
    assert_eq!(status("english"), "complete");
    assert_eq!(status("empty"), "complete");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn the_english_record_matches_each_source_to_its_own_translation() {
    let root = fixture_root("matching");
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m","purpose":"Matching"})).unwrap();
    // A translation for an older revision and one from the other lane must not stand in for the current source.
    store.append_event(&source("m", "a", 1, "remote", "de", 0, "Eins")).unwrap();
    store.append_event(&translation("m", "a", 1, "remote", 0, "One (old)")).unwrap();
    store.append_event(&source("m", "a", 2, "remote", "de", 0, "Eins neu")).unwrap();
    store.append_event(&translation("m", "a", 2, "me", 0, "Wrong lane")).unwrap();
    store.append_event(&translation("m", "a", 2, "remote", 0, "One")).unwrap();
    store.append_event(&json!({"meetingId":"m","segmentId":"a:en:dup","sourceSegmentId":"a","revision":2,"lane":"remote","kind":"translation","text":"One (later duplicate)","language":"en","startMs":0,"endMs":1000})).unwrap();
    store.append_event(&source("m", "b", 1, "me", "en", 2000, "Two")).unwrap();
    store.append_event(&source("m", "c", 1, "remote", "es", 4000, "Tres")).unwrap();
    for n in 0..300 {
        let id = format!("bulk{n}");
        store.append_event(&source("m", &id, 1, "remote", "de", 10_000 + n * 1000, "Wort")).unwrap();
        store.append_event(&translation("m", &id, 1, "remote", 10_000 + n * 1000, &format!("Word {n}"))).unwrap();
    }
    assert_eq!(store.load("m").unwrap()["translationStatus"], "pending", "c has no translation");
    store.finish("m").unwrap();
    let english = std::fs::read_to_string(root.join("records/m/english.md")).unwrap();
    let source_md = std::fs::read_to_string(root.join("records/m/source.md")).unwrap();
    let lines: Vec<&str> = english.lines().filter(|l| l.starts_with("- [")).collect();
    assert_eq!(lines[0], "- [0ms · remote · en] One", "the first translation of the current revision on the same lane");
    assert_eq!(lines[1], "- [2000ms · me · en] Two");
    assert!(!english.contains("Tres") && !english.contains("Wrong lane") && !english.contains("old"));
    assert_eq!(lines.len(), 302);
    assert_eq!(lines[301], "- [309000ms · remote · en] Word 299");
    assert!(english.contains("Some translations are pending"));
    assert!(source_md.contains("- [4000ms · remote · es] Tres"));
    assert!(source_md.contains("- [0ms · remote · de] Eins neu"));
    let text = live_interview_lib::meeting_records::source_text(&store.load("m").unwrap());
    // The searchable text pairs a source with the first translation of its revision, whatever its lane.
    assert!(text.starts_with("Eins neu\nWrong lane\nTwo\nTres\n"), "{}", &text[..40]);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn interrupted_meetings_are_found_and_recovered_once_per_launch_attempt() {
    let root = fixture_root("interrupted");
    let store = RecordStore::open(&root).unwrap();
    store.create("crashed", &json!({"id":"crashed","purpose":"Crashed"})).unwrap();
    store.create("finished", &json!({"id":"finished","purpose":"Finished"})).unwrap();
    store.finish("finished").unwrap();
    assert_eq!(store.interrupted_meetings().unwrap(), ["crashed"]);
    // Each launch claims it again until processing finishes; past the attempt limit it is left for Retry processing.
    for attempt in 1..=live_interview_lib::meeting_records::AUTO_RECOVERY_ATTEMPTS {
        assert!(store.begin_recovery("crashed").unwrap(), "attempt {attempt}");
        assert_eq!(store.load("crashed").unwrap()["recovery"]["state"], "recovering");
        assert_eq!(store.list().unwrap()[1]["recovery"]["state"], "recovering");
    }
    assert!(!store.begin_recovery("crashed").unwrap());
    assert_eq!(store.load("crashed").unwrap()["recovery"]["state"], "interrupted");
    // Retry processing finishes it.
    store.finish("crashed").unwrap();
    assert!(store.interrupted_meetings().unwrap().is_empty());
    assert_eq!(store.load("crashed").unwrap()["recovery"]["state"], "recovered");
    assert!(store.load("finished").unwrap().get("recovery").is_none());
    // A finished meeting is never claimed.
    assert!(!store.begin_recovery("finished").unwrap());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_recovery_that_finishes_marks_the_meeting_recovered() {
    let root = fixture_root("recovered");
    let store = RecordStore::open(&root).unwrap();
    store.create("m", &json!({"id":"m","purpose":"Crashed"})).unwrap();
    assert!(store.begin_recovery("m").unwrap());
    store.finish("m").unwrap();
    assert_eq!(store.load("m").unwrap()["recovery"]["state"], "recovered");
    assert_eq!(store.list().unwrap()[0]["recovery"]["state"], "recovered");
    std::fs::remove_dir_all(root).unwrap();
}
