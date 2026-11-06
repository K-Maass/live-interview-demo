use live_interview_lib::{context_sources::SourceIndex, public_domain::PublicStore};
use serde_json::{json, Value};
fn fixture() -> (std::path::PathBuf, PublicStore) {
    let root = std::env::temp_dir().join(format!("public-domain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(root.join("b")).unwrap();
    let root = root.canonicalize().unwrap();
    let store = PublicStore::open(&root.join("app")).unwrap();
    (root, store)
}
fn workspace(root: &std::path::Path, id: &str, dirs: &[&str], shared: &[&str]) -> Value {
    let roots: Vec<_> = dirs
        .iter()
        .map(|p| root.join(p).to_string_lossy().into_owned())
        .collect();
    json!({"id":id,"name":id,"root":roots[0],"roots":roots,"sharedLibraryIds":shared,"appendTargets":[],"revision":0})
}
#[test]
fn multiple_roots_are_durable_and_shared_library_requires_explicit_selection() {
    let (root, store) = fixture();
    std::fs::write(root.join("a/one.txt"), "Atlas first source").unwrap();
    std::fs::write(root.join("b/two.txt"), "Atlas shared second source").unwrap();
    store
        .save_workspace(workspace(&root, "library", &["b"], &[]))
        .unwrap();
    let w = store
        .save_workspace(workspace(&root, "main", &["a"], &[]))
        .unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("library").unwrap();
    index.refresh("main").unwrap();
    assert_eq!(
        index
            .retrieve_ranked("main", "Atlas", &[], 8)
            .unwrap()
            .len(),
        1
    );
    let mut selected = w;
    selected["sharedLibraryIds"] = json!(["library"]);
    store.save_workspace(selected).unwrap();
    assert_eq!(
        index
            .retrieve_ranked("main", "Atlas", &[], 8)
            .unwrap()
            .len(),
        2
    );
    let mut multi = workspace(&root, "multi", &["a", "b"], &[]);
    multi["name"] = json!("Named sources");
    store.save_workspace(multi).unwrap();
    index.refresh("multi").unwrap();
    assert_eq!(store.sources("multi").unwrap().len(), 2);
    assert_eq!(
        PublicStore::open(&root.join("app"))
            .unwrap()
            .list_workspaces()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        index
            .retrieve_ranked("library", "first", &[], 8)
            .unwrap()
            .len(),
        0
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn partial_scan_never_deletes_unvisited_sources() {
    let (root, _) = fixture();
    std::fs::write(root.join("a/one.txt"), "Atlas survives").unwrap();
    std::fs::write(root.join("a/two.txt"), "Orion survives").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("w", &root.join("a")).unwrap();
    index.refresh("w").unwrap();
    let result = index.refresh_with_limit("w", 1).unwrap();
    assert_eq!(result["truncated"], true);
    assert_eq!(index.retrieve("w", "survives", 8).unwrap().len(), 2);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn recreated_file_requires_fresh_embeddings_and_rejects_delayed_old_embeddings() {
    let (root, _store) = fixture();
    let file = root.join("a/source.txt");
    std::fs::write(&file, "Atlas old meaning").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("w", &root.join("a")).unwrap();
    index.refresh("w").unwrap();
    let mut old = index.pending_embeddings("w", 8).unwrap();
    assert_eq!(old.len(), 1);
    old[0]["vector"] = json!([1.0, 0.0]);
    old[0]["language"] = json!("en");
    index.save_embeddings(&old).unwrap();
    std::fs::remove_file(&file).unwrap();
    index.refresh("w").unwrap();
    std::fs::write(&file, "Orion new meaning").unwrap();
    index.refresh("w").unwrap();
    let new = index.pending_embeddings("w", 8).unwrap();
    assert_eq!(
        new.len(),
        1,
        "a recreated path must never reuse the previous content's embedding"
    );
    assert!(new[0]["revision"].as_i64().unwrap() > old[0]["revision"].as_i64().unwrap());
    index.save_embeddings(&old).unwrap();
    assert_eq!(
        index.pending_embeddings("w", 8).unwrap().len(),
        1,
        "delayed old output must not fill a new source revision"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn workspace_and_plan_updates_reject_stale_revisions_and_cross_scope_sources() {
    let (root, store) = fixture();
    let w = workspace(&root, "main", &["a"], &[]);
    let saved = store.save_workspace(w.clone()).unwrap();
    assert_eq!(saved["revision"], 1);
    assert!(store.save_workspace(w).is_err());
    let plan = json!({"id":"manual-1","title":"Draft","workspaceId":"main","sourceIds":[],"sharedLibraryIds":[],"profileId":"interview","attendees":[],"objectives":[],"publicResearchTopics":[],"briefDraft":"","automaticPreparation":false,"revision":0,"updatedAtMs":0,"status":"draft"});
    let mut saved = store.save_plan(plan.clone()).unwrap();
    assert!(store.save_plan(plan).is_err());
    saved["sourceIds"] = json!(["unregistered"]);
    assert!(store.save_plan(saved).is_err());
    assert_eq!(store.get_plan("manual-1").unwrap().unwrap()["revision"], 1);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn artifacts_are_record_revision_bound_and_human_edits_survive_generated_retries() {
    let (root, store) = fixture();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    let artifact = json!({"meetingId":"m","kind":"synthesis","recordRevision":0,"status":"ready","text":"Generated","evidence":[],"humanEdited":false,"updatedAtMs":0});
    let mut edited = store.save_artifact(artifact.clone()).unwrap();
    edited["text"] = json!("Human correction");
    edited["humanEdited"] = json!(true);
    let edited = store.save_artifact(edited).unwrap();
    let mut retry = edited.clone();
    retry["humanEdited"] = json!(false);
    retry["text"] = json!("Generated replacement");
    assert!(store.save_artifact(retry).is_err());
    assert_eq!(
        store.get_artifact("m", "synthesis", 0).unwrap().unwrap()["text"],
        "Human correction"
    );
    records.append_event(&json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","language":"en","text":"New evidence","startMs":0,"endMs":1})).unwrap();
    assert!(store.save_artifact(artifact).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn latest_artifact_returns_the_newest_revision_at_or_before_the_record() {
    let (root, store) = fixture();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    assert!(store.get_latest_artifact("m", "actions", 9).unwrap().is_none());
    store.save_artifact(json!({"meetingId":"m","kind":"actions","recordRevision":0,"status":"ready","text":"[]","evidence":[],"humanEdited":false,"updatedAtMs":0})).unwrap();
    records.append_event(&json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","language":"en","text":"Corrected","startMs":0,"endMs":1})).unwrap();
    // The record moved to revision 1 after the action was saved; the earlier artifact stays reachable.
    assert!(store.get_artifact("m", "actions", 1).unwrap().is_none());
    assert_eq!(
        store.get_latest_artifact("m", "actions", 1).unwrap().unwrap()["recordRevision"],
        0
    );
    store.save_artifact(json!({"meetingId":"m","kind":"actions","recordRevision":1,"status":"ready","text":"[1]","evidence":[],"humanEdited":false,"updatedAtMs":0})).unwrap();
    assert_eq!(
        store.get_latest_artifact("m", "actions", 1).unwrap().unwrap()["text"],
        "[1]"
    );
    assert_eq!(
        store.get_latest_artifact("m", "actions", 0).unwrap().unwrap()["text"],
        "[]"
    );
    assert!(store.get_latest_artifact("m", "notes", 1).unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn automatic_append_uses_only_record_derived_text_and_registered_exact_target_once() {
    let (root, store) = fixture();
    let target = root.join("a/notes.md");
    std::fs::write(&target, "Human introduction\n").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([target.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    records.append_event(&json!({"meetingId":"m","segmentId":"s","revision":1,"lane":"remote","kind":"final","language":"en","text":"Verified utterance","startMs":0,"endMs":1})).unwrap();
    records.finish("m").unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 1);
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 0);
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(text.starts_with("Human introduction\n"));
    assert_eq!(text.matches("Verified utterance").count(), 1);
    #[cfg(unix)]
    {
        std::fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(root.join("b/escape.md"), &target).unwrap();
        let report = store.apply_notes("m").unwrap();
        assert_eq!(report["applied"], 0);
        assert_eq!(report["failed"][0]["code"], "appendTargetChanged");
        assert!(!root.join("b/escape.md").exists());
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn changing_roots_immediately_revokes_old_files_before_another_scan() {
    let (root, store) = fixture();
    std::fs::write(root.join("a/old.txt"), "Restricted authority").unwrap();
    let w = store
        .save_workspace(workspace(&root, "main", &["a"], &[]))
        .unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("main").unwrap();
    let mut replacement = w;
    replacement["roots"] = json!([root.join("b").to_string_lossy()]);
    store.save_workspace(replacement).unwrap();
    assert!(index
        .retrieve_ranked("main", "Restricted", &[], 8)
        .unwrap()
        .is_empty());
    assert!(store.sources("main").unwrap().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn selected_empty_means_no_sources_and_cross_workspace_ids_are_rejected() {
    let (root, store) = fixture();
    std::fs::write(root.join("a/a.txt"), "Atlas private").unwrap();
    std::fs::write(root.join("b/b.txt"), "Atlas library").unwrap();
    store
        .save_workspace(workspace(&root, "main", &["a"], &[]))
        .unwrap();
    store
        .save_workspace(workspace(&root, "library", &["b"], &[]))
        .unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("main").unwrap();
    index.refresh("library").unwrap();
    assert!(index
        .retrieve_scoped("main", "Atlas", &[], 8, Some(&[]), Some(&[]))
        .unwrap()
        .is_empty());
    let other = store.sources("library").unwrap()[0]["sourceId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(index
        .retrieve_scoped("main", "Atlas", &[], 8, Some(&[other]), None)
        .is_err());
    assert!(index
        .retrieve_scoped("main", "Atlas", &[], 8, None, Some(&["library".into()]))
        .is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn output_destination_creates_a_new_record_and_never_rewrites_an_existing_file() {
    let (root, store) = fixture();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["outputRoot"] = json!(root.join("b").to_string_lossy());
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    records.finish("m").unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 1);
    let path = root.join("b/m.md");
    assert!(std::fs::read_to_string(&path).unwrap().contains("Fixture"));
    std::fs::write(&path, "Edited by human").unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 0);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Edited by human");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn append_grant_rejects_outside_bounds_and_follows_a_rename_saved_target() {
    let (root, store) = fixture();
    let outside = root.join("b/notes.md");
    std::fs::write(&outside, "Keep").unwrap();
    let mut bad = workspace(&root, "main", &["a"], &[]);
    bad["appendTargets"] = json!([outside.to_string_lossy()]);
    assert!(store.save_workspace(bad).is_err());
    let target = root.join("a/notes.md");
    std::fs::write(&target, "Keep").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([target.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    records.finish("m").unwrap();
    // Editors that save by writing a new file and renaming it over the old one change the inode.
    std::fs::rename(&target, root.join("a/old.md")).unwrap();
    std::fs::write(&target, "Replacement").unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 1);
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(text.starts_with("Replacement") && text.contains("Fixture"));
    assert_eq!(std::fs::read_to_string(root.join("a/old.md")).unwrap(), "Keep");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn a_changed_append_target_is_reported_and_other_targets_still_receive_the_note() {
    let (root, store) = fixture();
    let first = root.join("a/first.md");
    let second = root.join("a/second.md");
    std::fs::write(&first, "First").unwrap();
    std::fs::write(&second, "Second").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([first.to_string_lossy(), second.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create("m", &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}))
        .unwrap();
    records.finish("m").unwrap();
    std::fs::write(root.join("a/elsewhere.md"), "Elsewhere").unwrap();
    std::fs::remove_file(&first).unwrap();
    std::os::unix::fs::symlink(root.join("a/elsewhere.md"), &first).unwrap();
    let report = store.apply_notes("m").unwrap();
    assert_eq!(report["applied"], 1);
    assert_eq!(report["failed"].as_array().unwrap().len(), 1);
    assert!(std::fs::read_to_string(&second).unwrap().contains("Fixture"));
    assert_eq!(std::fs::read_to_string(root.join("a/elsewhere.md")).unwrap(), "Elsewhere");
    std::fs::remove_file(&first).unwrap();
    std::fs::write(&first, "First again").unwrap();
    std::fs::hard_link(&first, root.join("a/linked.md")).unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["failed"][0]["code"], "appendTargetChanged");
    std::fs::remove_file(root.join("a/linked.md")).unwrap();
    let report = store.apply_notes("m").unwrap();
    assert_eq!((report["applied"].as_u64(), report["skipped"].as_u64()), (Some(1), Some(1)));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn selected_source_is_filtered_before_search_limits_and_shared_edits_refresh_in_scope() {
    let (root, store) = fixture();
    for n in 0..40 {
        std::fs::write(root.join(format!("a/{n:02}.txt")), "Atlas common topic").unwrap();
    }
    store
        .save_workspace(workspace(&root, "library", &["b"], &[]))
        .unwrap();
    store
        .save_workspace(workspace(&root, "main", &["a"], &["library"]))
        .unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("main").unwrap();
    let selected = store
        .sources("main")
        .unwrap()
        .into_iter()
        .find(|s| s["path"].as_str().unwrap().ends_with("39.txt"))
        .unwrap()["sourceId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        index
            .retrieve_scoped("main", "Atlas", &[], 8, Some(&[selected]), Some(&[]))
            .unwrap()
            .len(),
        1
    );
    std::fs::write(root.join("b/shared.txt"), "Fresh shared authority").unwrap();
    let refreshed = index
        .refresh_scoped("main", Some(&["library".into()]))
        .unwrap();
    assert!(!refreshed["changedSourceIds"].as_array().unwrap().is_empty());
    assert_eq!(
        index
            .retrieve_scoped("main", "Fresh", &[], 8, None, Some(&["library".into()]))
            .unwrap()
            .len(),
        1
    );
    assert!(index
        .refresh_scoped("main", Some(&["unregistered".into()]))
        .is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn removing_a_visible_append_marker_does_not_repeat_an_already_applied_action() {
    let (root, store) = fixture();
    let target = root.join("a/notes.md");
    std::fs::write(&target, "Human introduction").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([target.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "m",
            &json!({"id":"m","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    records.finish("m").unwrap();
    store.apply_notes("m").unwrap();
    std::fs::write(&target, "User deliberately replaced the text").unwrap();
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 0);
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "User deliberately replaced the text"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn folderless_default_plans_persist_without_brief_or_external_context() {
    let (root, store) = fixture();
    let plan = json!({"id":"folderless","title":"Untitled meeting","workspaceId":"default","sourceSelection":"workspace","sourceIds":[],"sharedLibraryIds":[],"profileId":"interview","attendees":[],"objectives":[],"publicResearchTopics":[],"briefDraft":"","draftEvidence":[],"automaticPreparation":false,"revision":0,"updatedAtMs":0,"status":"draft"});
    let saved = store.save_plan(plan).unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["briefDraft"], "");
    assert!(store.sources("default").unwrap().is_empty());
    let mut bad = saved;
    bad["sharedLibraryIds"] = json!(["other"]);
    assert!(store.save_plan(bad).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn automatic_notes_wait_for_stopped_complete_transcription_and_default_is_a_safe_noop() {
    let (root, store) = fixture();
    let target = root.join("a/notes.md");
    std::fs::write(&target, "Keep").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([target.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(
            "pending",
            &json!({"id":"pending","workspaceId":"main","purpose":"Fixture"}),
        )
        .unwrap();
    records.append_event(&json!({"meetingId":"pending","segmentId":"s","revision":1,"lane":"remote","kind":"final","language":"de","text":"Originaler Beleg","startMs":0,"endMs":1})).unwrap();
    records.finish("pending").unwrap();
    assert!(store.apply_notes("pending").is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "Keep");
    records
        .create(
            "default-meeting",
            &json!({"id":"default-meeting","workspaceId":"default","purpose":"No folders"}),
        )
        .unwrap();
    assert_eq!(
        store.apply_notes("default-meeting").unwrap(),
        json!({"applied":0,"skipped":0})
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_scope_update_rolls_back_workspace_authority_and_index_together() {
    let (root, store) = fixture();
    let saved = store
        .save_workspace(workspace(&root, "main", &["a"], &[]))
        .unwrap();
    let c = rusqlite::Connection::open(root.join("app/context.sqlite")).unwrap();
    c.execute_batch("CREATE TRIGGER reject_changed_root BEFORE INSERT ON workspace_roots WHEN NEW.root LIKE '%/b' BEGIN SELECT RAISE(ABORT,'fixture failure after metadata update'); END;").unwrap();
    let mut changed = saved.clone();
    changed["roots"] = json!([root.join("b").to_string_lossy()]);
    assert!(store.save_workspace(changed).is_err());
    assert_eq!(
        store.get_workspace("main").unwrap().unwrap()["revision"],
        saved["revision"]
    );
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("main").unwrap();
    assert_eq!(
        index.list().unwrap()[0]["root"],
        root.join("a").to_string_lossy().as_ref()
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn public_workspace_reads_fail_closed_if_index_scope_is_tampered_or_registration_is_uncommitted() {
    let (root, store) = fixture();
    std::fs::write(root.join("a/a.txt"), "Approved authority").unwrap();
    store
        .save_workspace(workspace(&root, "library", &["b"], &[]))
        .unwrap();
    store
        .save_workspace(workspace(&root, "main", &["a"], &[]))
        .unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.refresh("main").unwrap();
    let c = rusqlite::Connection::open(root.join("app/context.sqlite")).unwrap();
    c.execute(
        "INSERT INTO workspace_scope(workspace,shared) VALUES('main','library')",
        [],
    )
    .unwrap();
    assert!(index.scope_ids("main").is_err());
    assert!(index.retrieve("main", "Approved", 5).is_err());
    assert!(index.retrieve_ranked("main", "Approved", &[], 5).is_err());
    assert!(index.pending_embeddings("main", 5).is_err());
    assert!(index.refresh("main").is_err());
    assert!(store.sources("main").is_err());
    // Models cannot turn an index-only registration into authorized workspace evidence.
    index
        .connect_public(
            "uncommitted",
            &[root.join("a").to_string_lossy().into_owned()],
            &[],
        )
        .unwrap();
    assert!(index.refresh("uncommitted").is_err());
    assert!(index.scope_ids("uncommitted").is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn legacy_public_authority_migration_repairs_divergent_index_before_reading_evidence() {
    let (root, _store) = fixture();
    let legacy = rusqlite::Connection::open(root.join("app/public.sqlite")).unwrap();
    legacy.execute_batch("CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["revision"] = json!(1);
    legacy
        .execute(
            "INSERT INTO workspaces(id,revision,body) VALUES(?1,1,?2)",
            rusqlite::params!["main", w.to_string()],
        )
        .unwrap();
    std::fs::write(root.join("b/restricted.txt"), "Restricted authority").unwrap();
    let index = SourceIndex::open(&root.join("app")).unwrap();
    index.connect("main", &root.join("b")).unwrap();
    index.refresh("main").unwrap();
    let store = PublicStore::open(&root.join("app")).unwrap();
    assert_eq!(
        store.get_workspace("main").unwrap().unwrap()["roots"],
        w["roots"]
    );
    assert!(index.retrieve("main", "Restricted", 5).unwrap().is_empty());
    assert_eq!(
        index.list().unwrap()[0]["root"],
        root.join("a").to_string_lossy().as_ref()
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_plan_keeps_what_was_saved_to_the_calendar_and_rejects_a_malformed_record() {
    let (root, store) = fixture();
    let plan = json!({"id":"dated","title":"Client sync","workspaceId":"default","sourceSelection":"workspace","sourceIds":[],"sharedLibraryIds":[],"profileId":"workClient","attendees":[],"objectives":[],"publicResearchTopics":[],"briefDraft":"","automaticPreparation":false,"revision":0,"updatedAtMs":0,"status":"draft","startMs":1000,"endMs":2000,
        "calendarSync":{"nativeEventId":"EK-1","calendarId":"work","calendarName":"iCloud · Work","version":"v1","syncedTitle":"Client sync","syncedStartMs":1000,"syncedEndMs":2000}});
    let saved = store.save_plan(plan).unwrap();
    assert_eq!(saved["calendarSync"]["nativeEventId"], "EK-1");
    let mut bad = saved.clone();
    bad["calendarSync"]["syncedEndMs"] = json!(500);
    assert!(store.save_plan(bad).is_err());
    let mut half = saved;
    half["endMs"] = Value::Null;
    assert!(store.save_plan(half).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

/// A finished record whose German passage can no longer be translated: its audio is gone and it has
/// no trusted intervals, so the record reads `translationStatus: "unavailable"`.
fn untranslatable_record(root: &std::path::Path, id: &str) {
    let records = live_interview_lib::meeting_records::RecordStore::open(&root.join("app")).unwrap();
    records
        .create(id, &json!({"id":id,"workspaceId":"main","purpose":"Fixture"}))
        .unwrap();
    records.append_event(&json!({"meetingId":id,"segmentId":"en1","revision":1,"lane":"me","kind":"final","language":"en","text":"Verified utterance","startMs":0,"endMs":1})).unwrap();
    let audio = root.join("app/cache").join(id).join("de1.wav");
    std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
    std::fs::write(&audio, b"synthetic audio placeholder").unwrap();
    records.add_chunk("de1", id, "remote", &audio, 10).unwrap();
    records.append_event_once(&json!({"meetingId":id,"segmentId":"de1","revision":1,"lane":"remote","kind":"final","language":"de","text":"Wer entscheidet?","startMs":10,"endMs":20})).unwrap();
    records.mark_translation_pending("de1").unwrap();
    std::fs::remove_file(&audio).unwrap();
    records.retry_translations(id).unwrap();
    let record = records.finish(id).unwrap();
    assert_eq!(record["translationStatus"], "unavailable");
}
#[test]
fn a_record_with_unavailable_translation_is_appended_in_its_source_language_with_a_marker() {
    let (root, store) = fixture();
    let target = root.join("a/notes.md");
    std::fs::write(&target, "Keep\n").unwrap();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["appendTargets"] = json!([target.to_string_lossy()]);
    store.save_workspace(w).unwrap();
    untranslatable_record(&root, "m");
    let report = store.apply_notes("m").unwrap();
    assert_eq!(report["applied"], 1, "{report}");
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(text.starts_with("Keep\n"));
    assert!(text.contains("Verified utterance"));
    assert!(text.contains("Wer entscheidet?"), "source-language evidence is written: {text}");
    assert!(text.contains("Translation unavailable on this Mac"), "{text}");
    assert!(!text.contains("Who decides"), "no guessed English");
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 0);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_record_with_unavailable_translation_is_exported_as_a_new_file_in_its_source_language() {
    let (root, store) = fixture();
    let mut w = workspace(&root, "main", &["a"], &[]);
    w["outputRoot"] = json!(root.join("b").to_string_lossy());
    store.save_workspace(w).unwrap();
    untranslatable_record(&root, "m");
    assert_eq!(store.apply_notes("m").unwrap()["applied"], 1);
    let text = std::fs::read_to_string(root.join("b/m.md")).unwrap();
    assert!(text.contains("Wer entscheidet?"), "{text}");
    assert!(text.contains("Translation unavailable on this Mac"), "{text}");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn only_saves_that_add_access_ask_and_a_declined_sheet_persists_nothing() {
    use live_interview_lib::grants::GrantRequest;
    use std::cell::RefCell;
    let (root, store) = fixture();
    std::fs::write(root.join("a/notes.md"), "# Notes\n").unwrap();
    let asked: RefCell<Vec<GrantRequest>> = RefCell::new(vec![]);
    let accept = |r: &GrantRequest| {
        asked.borrow_mut().push(r.clone());
        Ok(())
    };
    let a = root.join("a").to_string_lossy().into_owned();
    let saved = store.save_workspace_confirmed(workspace(&root, "main", &["a"], &[]), accept).unwrap();
    assert_eq!(asked.borrow().len(), 1);
    assert_eq!(asked.borrow()[0].reads, vec![a.clone()]);
    // An unchanged save (rename only) never prompts.
    let mut renamed = saved.clone();
    renamed["name"] = json!("Renamed");
    let saved = store.save_workspace_confirmed(renamed, accept).unwrap();
    assert_eq!(asked.borrow().len(), 1, "unchanged access must not ask");
    // A declined append grant leaves the stored workspace and its grants as they were.
    let mut more = saved.clone();
    let note = root.join("a/notes.md").to_string_lossy().into_owned();
    more["appendTargets"] = json!([note]);
    let declined = store.save_workspace_confirmed(more.clone(), |_| Err(anyhow::anyhow!("grantDeclined")));
    assert_eq!(declined.unwrap_err().to_string(), "grantDeclined");
    let stored = store.get_workspace("main").unwrap().unwrap();
    assert_eq!(stored["revision"], saved["revision"]);
    assert_eq!(stored["appendTargets"], json!([]));
    // Accepting lists only the new append target, not the unchanged root.
    store.save_workspace_confirmed(more, accept).unwrap();
    let last = asked.borrow().last().cloned().unwrap();
    assert_eq!(last, GrantRequest { appends: vec![note], ..Default::default() });
}
