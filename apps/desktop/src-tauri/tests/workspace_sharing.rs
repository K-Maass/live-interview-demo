use serde_json::json;
#[test]
fn imports_only_own_records_and_keeps_conflicts_without_using_origin_paths() {
    let root = std::env::temp_dir().join(format!("live-share-{}", uuid::Uuid::new_v4()));
    let r = json!({"id":"m","workspaceId":"w","purpose":"Synthetic","date":"2026-10-03","revision":1,"segments":[],"importedSegments":[],"attributions":[],"translationStatus":"complete"});
    let b = json!({"version":1,"records":[r],"sources":[{"locator":"/foreign/mac/file.md"}]});
    let report = live_interview_lib::workspace_sharing::import(&root, &b).unwrap();
    assert_eq!(report["imported"], 1);
    assert_eq!(report["unresolved"].as_array().unwrap().len(), 1);
    let mut changed = b.clone();
    changed["records"][0]["purpose"] = json!("Conflicting");
    assert_eq!(
        live_interview_lib::workspace_sharing::import(&root, &changed).unwrap()["conflicts"],
        1
    );
    assert!(live_interview_lib::workspace_sharing::import(
        &root,
        &json!({"version":1,"records":[],"apiKey":"sentinel"})
    )
    .is_err());
    let mut malicious = b;
    malicious["records"][0]["id"] = json!("../../escape");
    assert!(live_interview_lib::workspace_sharing::import(&root, &malicious).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn import_preserves_historical_date_text_and_separate_attribution() {
    let root = std::env::temp_dir().join(format!("live-history-share-{}", uuid::Uuid::new_v4()));
    let r = json!({"id":"m","workspaceId":"w","purpose":"Historical synthetic record","date":"2026-01-01","revision":0,"segments":[],"importedSegments":[{"id":"old","text":"Prior transcript","language":"de","provenance":"unknown","sourceId":"wispr"}],"attributions":[{"clusterId":"m:remote2","personId":"p","status":"suggested","evidence":[]}],"translationStatus":"complete"});
    let b = json!({"version":1,"records":[r],"sources":[]});
    assert_eq!(
        live_interview_lib::workspace_sharing::import(&root, &b).unwrap()["imported"],
        1
    );
    let loaded = live_interview_lib::meeting_records::RecordStore::open(&root)
        .unwrap()
        .load("m")
        .unwrap();
    assert_eq!(loaded["date"], "2026-01-01");
    assert_eq!(
        loaded["importedSegments"],
        b["records"][0]["importedSegments"]
    );
    assert_eq!(loaded["attributions"], b["records"][0]["attributions"]);
    assert_eq!(
        live_interview_lib::workspace_sharing::import(&root, &b).unwrap()["skipped"],
        1
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn nested_fields_are_whitelisted_and_foreign_journal_offsets_are_idempotent() {
    let root = std::env::temp_dir().join(format!("live-nested-share-{}", uuid::Uuid::new_v4()));
    let r = json!({"id":"m","workspaceId":"w","purpose":"Synthetic","date":"2026-01-01","revision":1,"segments":[{"meetingId":"m","segmentId":"s","revision":1,"journalSequence":900,"lane":"remote","startMs":0,"endMs":1,"language":"en","text":"Hello","kind":"final"}],"importedSegments":[],"attributions":[],"translationStatus":"complete"});
    let b = json!({"version":1,"records":[r],"sources":[]});
    let mut bad = b.clone();
    bad["records"][0]["segments"][0]["privatePayload"] = json!({"password":"must-not-import"});
    assert!(live_interview_lib::workspace_sharing::import(&root, &bad).is_err());
    assert_eq!(
        live_interview_lib::workspace_sharing::import(&root, &b).unwrap()["imported"],
        1
    );
    assert_eq!(
        live_interview_lib::workspace_sharing::import(&root, &b).unwrap()["skipped"],
        1
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn imported_text_excerpts_become_context_without_following_foreign_paths() {
    let root = std::env::temp_dir().join(format!("live-shared-context-{}", uuid::Uuid::new_v4()));
    let b = json!({"version":1,"records":[],"sources":[{"sourceId":"origin-1","workspaceId":"w","kind":"workspace","title":"Prior discovery","text":"Manual settlement reconciliation is the bottleneck.","locator":"/foreign/private/prior.md#page1","revision":2,"derived":false}]});
    live_interview_lib::workspace_sharing::import(&root, &b).unwrap();
    let index = live_interview_lib::context_sources::SourceIndex::open(&root).unwrap();
    assert!(index
        .retrieve("w", "settlement reconciliation", 5)
        .unwrap()
        .iter()
        .any(|h| h["text"].as_str().unwrap().contains("bottleneck")));
    std::fs::remove_dir_all(root).unwrap();
}
