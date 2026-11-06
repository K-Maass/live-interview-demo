use live_interview_lib::context_sources::SourceIndex;
/// Refreshes extract each changed file on a guarded thread, and the library caps those threads
/// process-wide (`MAX_EXTRACTION_THREADS`). Tests in this binary run in parallel, so without this
/// lock several refreshes at once can exhaust the cap: the next file gets `Busy`, is reported as
/// `skipped` for a later retry, and is missing from the index the test then asserts on. Every
/// test that refreshes holds this lock, so at most one extraction runs at a time and each file is
/// indexed on the first refresh.
fn serial_refresh() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}
#[test]
fn connected_root_only_changed_and_deleted_source_retrieval() {
    let _serial = serial_refresh();
    let root = std::env::temp_dir().join(format!("live-sources-{}", uuid::Uuid::new_v4()));
    let docs = root.join("documents");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::write(
        docs.join("approval.md"),
        "Business units choose launch. Compliance retains evidence.",
    )
    .unwrap();
    std::fs::write(docs.join(".env"), "SECRET=value").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("workspace", &docs).unwrap();
    index.refresh("workspace").unwrap();
    let hits = index.retrieve("workspace", "Compliance", 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]["text"],
        "Business units choose launch. Compliance retains evidence."
    );
    std::fs::write(
        docs.join("approval.md"),
        "Approval belongs to product owners.",
    )
    .unwrap();
    index.refresh("workspace").unwrap();
    assert!(index
        .retrieve("workspace", "Compliance", 5)
        .unwrap()
        .is_empty());
    std::fs::remove_file(docs.join("approval.md")).unwrap();
    index.refresh("workspace").unwrap();
    assert!(index
        .retrieve("workspace", "Approval", 5)
        .unwrap()
        .is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn office_text_keeps_slide_and_cell_locators_without_executing_macros() {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let doc = live_interview_lib::source_extraction::extract(&fixtures.join("example.docx")).unwrap().sections;
    assert!(doc[0].1.contains("Compliance"));
    let slides = live_interview_lib::source_extraction::extract(&fixtures.join("example.pptx")).unwrap().sections;
    assert!(slides[0].0.contains("slide1.xml"));
    let cells = live_interview_lib::source_extraction::extract(&fixtures.join("example.xlsx")).unwrap().sections;
    assert_eq!(cells[0].1, "Decision owner");
    assert!(cells[0].0.ends_with(":A1"));
}
#[test]
fn chatgpt_branches_are_imported_and_survive_filesystem_refresh() {
    let _serial = serial_refresh();
    let root = std::env::temp_dir().join(format!("live-history-{}", uuid::Uuid::new_v4()));
    let index = SourceIndex::open(&root.join("app")).unwrap();
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    index.connect("workspace", &docs).unwrap();
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chatgpt.json");
    let report = index.import_chatgpt("workspace", &fixture).unwrap();
    assert_eq!(report["imported"], 2);
    index.refresh("workspace").unwrap();
    let hits = index.retrieve("workspace", "production", 5).unwrap();
    assert!(!hits.is_empty());
    assert!(!serde_json::to_string(&hits)
        .unwrap()
        .contains("NEVER_UPLOAD_AUDIO"));
    assert_eq!(
        index.import_chatgpt("workspace", &fixture).unwrap()["imported"],
        0
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn audio_and_oversized_inputs_are_rejected_before_reading_bytes() {
    use std::io::Write;
    let root = std::env::temp_dir().join(format!("live-boundary-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let audio = root.join("recording.wav");
    std::fs::File::create(&audio)
        .unwrap()
        .write_all(b"not audio")
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&audio, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    let error = live_interview_lib::source_extraction::extract(&audio).unwrap_err();
    assert_eq!(error.to_string(), "unsupportedSource");
    let large = root.join("large.txt");
    let file = std::fs::File::create(&large).unwrap();
    file.set_len(25_000_000).unwrap();
    assert_eq!(
        live_interview_lib::source_extraction::extract(&large)
            .unwrap_err()
            .to_string(),
        "sourceTooLarge"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn source_that_becomes_unsupported_loses_old_evidence_and_own_records_are_retrievable() {
    let _serial = serial_refresh();
    let root = std::env::temp_dir().join(format!("live-source-own-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let index = live_interview_lib::context_sources::SourceIndex::open(&root).unwrap();
    index.connect("w", &workspace).unwrap();
    let path = workspace.join("old.txt");
    std::fs::write(&path, "Obsolete deployment authority").unwrap();
    index.refresh("w").unwrap();
    assert!(!index.retrieve("w", "Obsolete", 5).unwrap().is_empty());
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(25_000_000)
        .unwrap();
    assert!(!index.refresh("w").unwrap()["changedSourceIds"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(index.retrieve("w", "Obsolete", 5).unwrap().is_empty());
    let records = live_interview_lib::meeting_records::RecordStore::open(&root).unwrap();
    records
        .create(
            "m",
            &serde_json::json!({"id":"m","workspaceId":"w","purpose":"Earlier approval interview"}),
        )
        .unwrap();
    records.append_event(&serde_json::json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","language":"en","text":"Business owners retain deployment evidence","startMs":0,"endMs":1})).unwrap();
    records.finish("m").unwrap();
    index.refresh_app_records("w").unwrap();
    assert!(index
        .retrieve("w", "deployment evidence", 5)
        .unwrap()
        .iter()
        .any(|s| s["sourceId"] == "record:m"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn cross_language_rank_one_survives_different_absolute_score_distributions() {
    let _serial = serial_refresh();
    let root = std::env::temp_dir().join(format!("live-rank-fusion-{}", uuid::Uuid::new_v4()));
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    for n in 0..31 {
        std::fs::write(
            docs.join(format!("en{n}.txt")),
            format!("English synthetic catalog {n}"),
        )
        .unwrap();
    }
    std::fs::write(docs.join("de-target.txt"), "Deutscher Zielsatz").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("w", &docs).unwrap();
    let report = index.refresh("w").unwrap();
    assert_eq!(report["status"], "ready", "every file is indexed before embedding: {report}");
    let mut entries = index.pending_embeddings("w", 128).unwrap();
    assert!(
        entries.iter().any(|e| e["text"].as_str().unwrap().contains("Zielsatz")),
        "the German target is pending embedding"
    );
    for entry in &mut entries {
        let de = entry["text"].as_str().unwrap().contains("Zielsatz");
        let score: f64 = if de { 0.7 } else { 0.9 };
        entry["language"] = serde_json::json!(if de { "de" } else { "en" });
        entry["vector"] = serde_json::json!([score, (1.0 - score * score).sqrt()]);
    }
    index.save_embeddings(&entries).unwrap();
    let queries = vec![
        serde_json::json!({"language":"en","vector":[1.,0.]}),
        serde_json::json!({"language":"de","vector":[1.,0.]}),
    ];
    assert!(index
        .retrieve_ranked("w", "absentkeyword", &queries, 5)
        .unwrap()
        .iter()
        .any(|h| h["title"] == "de-target.txt"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn refetched_public_text_returns_its_canonical_assigned_revision() {
    let root = std::env::temp_dir().join(format!("live-public-version-{}", uuid::Uuid::new_v4()));
    let index = SourceIndex::open(&root).unwrap();
    let mut hits = vec![
        serde_json::json!({"sourceId":"web:w:page","workspaceId":"w","title":"Public","text":"First publication text","locator":"https://example.org/page","revision":1,"derived":false}),
    ];
    index.cache_public_sources(&mut hits).unwrap();
    hits[0]["text"] = serde_json::json!("Updated publication text");
    index.cache_public_sources(&mut hits).unwrap();
    assert_eq!(hits[0]["revision"], 2);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn opening_an_up_to_date_index_does_not_wait_for_a_writer() {
    let root = std::env::temp_dir().join(format!("live-open-{}", uuid::Uuid::new_v4()));
    let app = root.join("app");
    SourceIndex::open(&app).unwrap();
    let mut writer = rusqlite::Connection::open(app.join("context.sqlite")).unwrap();
    let held = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let started = std::time::Instant::now();
    SourceIndex::open(&app).unwrap();
    live_interview_lib::public_domain::PublicStore::open(&app).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    let version: i64 = held
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert!(version >= 2);
    drop(held);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn an_unreadable_folder_marks_the_refresh_partial_and_keeps_other_progress() {
    let _serial = serial_refresh();
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("live-partial-{}", uuid::Uuid::new_v4()));
    let docs = root.join("documents");
    let locked = docs.join("locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::write(locked.join("old.md"), "Retained quarterly evidence.").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("workspace", &docs).unwrap();
    index.refresh("workspace").unwrap();
    std::fs::write(docs.join("fresh.md"), "Fresh onboarding evidence.").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let report = index.refresh("workspace");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let report = report.unwrap();
    assert_eq!(report["status"], "partial");
    assert!(report["skipped"].as_array().unwrap().iter().any(|p| p.as_str().unwrap().ends_with("locked")));
    assert_eq!(index.retrieve("workspace", "onboarding", 5).unwrap().len(), 1);
    // Evidence under the unreadable folder is kept until a complete scan says otherwise.
    assert_eq!(index.retrieve("workspace", "quarterly", 5).unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
/// A structurally valid PDF whose only page has no MediaBox; pdf-extract panics on it.
fn pdf_without_media_box(marker: &str) -> Vec<u8> {
    let objects = [
        "<</Type/Catalog/Pages 2 0 R>>".to_owned(),
        "<</Type/Pages/Kids[3 0 R]/Count 1>>".to_owned(),
        format!("<</Type/Page/Parent 2 0 R/Contents 4 0 R/Marker({marker})>>"),
        "<</Length 0>>stream\n\nendstream".to_owned(),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (n, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", n + 1).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        pdf.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend(
        format!("trailer\n<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1)
            .as_bytes(),
    );
    pdf
}
#[test]
fn a_pdf_that_panics_the_parser_is_skipped_until_it_changes_and_the_refresh_continues() {
    let _serial = serial_refresh();
    let root = std::env::temp_dir().join(format!("live-panic-pdf-{}", uuid::Uuid::new_v4()));
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::write(docs.join("a-broken.pdf"), pdf_without_media_box("one")).unwrap();
    std::fs::write(docs.join("b-notes.md"), "Procurement signs the renewal.").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("w", &docs).unwrap();
    let first = index.refresh("w").expect("a parser panic does not fail the refresh");
    assert_eq!(first["unsupported"].as_array().unwrap().len(), 1, "{first}");
    assert!(first["unsupported"][0].as_str().unwrap().ends_with("a-broken.pdf"));
    assert!(!index.retrieve("w", "Procurement", 5).unwrap().is_empty());
    let db = rusqlite::Connection::open(root.join("app/context.sqlite")).unwrap();
    let digest = || -> String {
        db.query_row("SELECT digest FROM unreadable_sources", [], |r| r.get(0)).unwrap()
    };
    let before = digest();
    let second = index.refresh("w").unwrap();
    assert_eq!(second["unsupported"].as_array().unwrap().len(), 1);
    assert!(second["changedSourceIds"].as_array().unwrap().is_empty());
    assert_eq!(digest(), before);
    std::fs::write(docs.join("a-broken.pdf"), pdf_without_media_box("two")).unwrap();
    index.refresh("w").unwrap();
    assert_ne!(digest(), before, "changed bytes are tried again");
    std::fs::remove_file(docs.join("a-broken.pdf")).unwrap();
    index.refresh("w").unwrap();
    let left: i64 = db
        .query_row("SELECT COUNT(*) FROM unreadable_sources", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "a removed file leaves no record");
    std::fs::remove_dir_all(root).unwrap();
}
