use live_interview_lib::actions::{apply_error_code, ActionStore};
#[test]
fn existing_files_need_exact_approval_and_changed_target_is_blocked() {
    let root = std::env::temp_dir().join(format!("live-actions-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("existing.md");
    std::fs::write(&note, "original").unwrap();
    let store = ActionStore::open(&root.join("app")).unwrap();
    assert!(store.propose(&note, "append", "\nnew").is_err());
    store.record_picked(&note, "file").unwrap();
    let proposal = store.propose(&note, "append", "\nnew").unwrap();
    let id = proposal["id"].as_str().unwrap();
    assert!(store.apply(id, "invalid").is_err());
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original");
    let approval = store.approve(id).unwrap();
    std::fs::write(&note, "changed externally").unwrap();
    assert!(store.apply(id, &approval).is_err());
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "changed externally"
    );
    let p = store.propose(&note, "append", "\nreviewed").unwrap();
    let id = p["id"].as_str().unwrap();
    let approval = store.approve(id).unwrap();
    assert!(store.apply(id, &approval).unwrap()["applied"]
        .as_bool()
        .unwrap());
    // A replay of the same approval reports the earlier apply and never writes again.
    let replay = store.apply(id, &approval).unwrap();
    assert_eq!(replay["alreadyApplied"], true);
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "changed externally\nreviewed");
    // Any other token is still refused.
    assert!(store.apply(id, "invalid").is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn notes_are_registered_app_owned_and_existing_collision_is_preserved() {
    let root = std::env::temp_dir().join(format!("live-notes-{}", uuid::Uuid::new_v4()));
    let store = ActionStore::open(&root).unwrap();
    let first = store.save_internal_note("m", "owned text").unwrap();
    assert_eq!(first["expectedRevision"], 1);
    assert_eq!(
        store.save_internal_note("m", "owned text").unwrap()["changed"],
        false
    );
    std::fs::write(root.join("notes/m.md"), "changed by user").unwrap();
    assert!(store.save_internal_note("m", "replacement").is_err());
    std::fs::write(root.join("notes/existing.md"), "The user's file").unwrap();
    assert!(store.save_internal_note("existing", "replacement").is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("notes/existing.md")).unwrap(),
        "The user's file"
    );
    std::fs::remove_dir_all(root).unwrap();
}
fn status(root: &std::path::Path, id: &str) -> String {
    rusqlite::Connection::open(root.join("actions.sqlite"))
        .unwrap()
        .query_row("SELECT status FROM proposals WHERE id=?1", [id], |r| r.get(0))
        .unwrap()
}
#[test]
fn renderer_paths_need_a_granted_root_or_a_native_pick() {
    let root = std::env::temp_dir().join(format!("live-grant-{}", uuid::Uuid::new_v4()));
    let granted = root.join("granted");
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&granted).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    let root = root.canonicalize().unwrap();
    let (granted, elsewhere) = (root.join("granted"), root.join("elsewhere"));
    let app = root.join("app");
    let public = live_interview_lib::public_domain::PublicStore::open(&app).unwrap();
    public
        .save_workspace(serde_json::json!({"id":"main","name":"Main","roots":[granted.to_string_lossy()],"sharedLibraryIds":[],"appendTargets":[],"revision":0}))
        .unwrap();
    let store = ActionStore::open(&app).unwrap();
    std::fs::write(granted.join("inside.md"), "x").unwrap();
    std::fs::write(elsewhere.join("outside.md"), "x").unwrap();
    assert!(store.propose(&granted.join("inside.md"), "append", "y").is_ok());
    let refused = store.propose(&elsewhere.join("outside.md"), "append", "y").unwrap_err();
    assert_eq!(refused.to_string(), "targetNotGranted");
    // A record link may go into a folder chosen in the native picker.
    store.record_picked(&elsewhere, "folder").unwrap();
    assert!(store.propose(&elsewhere.join("meeting.md"), "linkRecord", "x").is_ok());
    assert!(store.propose(&elsewhere.join("other.md"), "rewrite", "x").is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn approval_is_one_use_and_only_for_an_open_proposal() {
    let root = std::env::temp_dir().join(format!("live-approval-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, "original").unwrap();
    let app = root.join("app");
    let store = ActionStore::open(&app).unwrap();
    store.record_picked(&note, "file").unwrap();
    let id = store.propose(&note, "append", "\nmore").unwrap()["id"].as_str().unwrap().to_owned();
    let token = store.approve(&id).unwrap();
    // A second approval (a double click on Apply) returns the outstanding token instead of failing
    // or minting another one.
    assert_eq!(store.approve(&id).unwrap(), token);
    std::fs::write(&note, "changed").unwrap();
    assert!(store.apply(&id, &token).is_err());
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "changed");
    // A failed apply wrote nothing, so the proposal stays open for another reviewed attempt; the used
    // token is gone.
    assert_eq!(status(&app, &id), "proposed");
    assert!(store.apply(&id, &token).is_err());
    let retry = store.approve(&id).unwrap();
    assert_ne!(retry, token);
    // The target changed since the proposal was made, so the retry is refused again, never forced.
    assert!(store.apply(&id, &retry).is_err());
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "changed");
    assert!(store.approve("unknown").is_err());
    let declined = store.propose(&note, "append", "\nno").unwrap()["id"].as_str().unwrap().to_owned();
    store.decline(&declined).unwrap();
    assert_eq!(status(&app, &declined), "declined");
    assert!(store.approve(&declined).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
// A double click on Apply runs approve + apply twice. The second run must succeed without a second write.
#[test]
fn a_repeated_apply_of_the_same_proposal_writes_once_and_reports_success() {
    let root = std::env::temp_dir().join(format!("live-double-apply-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, "original").unwrap();
    let store = ActionStore::open(&root.join("app")).unwrap();
    store.record_picked(&note, "file").unwrap();
    let id = store.propose(&note, "append", "\nonce").unwrap()["id"].as_str().unwrap().to_owned();
    // Both clicks approve before either applies.
    let first = store.approve(&id).unwrap();
    let second = store.approve(&id).unwrap();
    assert_eq!(store.apply(&id, &first).unwrap()["applied"], true);
    assert_eq!(store.apply(&id, &second).unwrap()["alreadyApplied"], true);
    // The second click starts after the first finished: approve says so without minting a token.
    assert_eq!(store.approve(&id).unwrap_err().to_string(), "alreadyApplied");
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original\nonce");
    std::fs::remove_dir_all(root).unwrap();
}
// A fast double click approves twice (same token) and applies twice. The calendar apply awaits the
// helper, so the second apply finds the proposal `applying`: that is the earlier click, not a failure.
#[test]
fn a_second_calendar_apply_while_the_first_is_running_reports_apply_in_progress() {
    let root = std::env::temp_dir().join(format!("live-cal-double-{}", uuid::Uuid::new_v4()));
    let store = ActionStore::open(&root).unwrap();
    store
        .store_calendar(&serde_json::json!({"id":"c","operation":"calendarAdd","before":"","after":"{}","status":"proposed"}))
        .unwrap();
    let first = store.approve("c").unwrap();
    let second = store.approve("c").unwrap();
    assert_eq!(first, second);
    store.take_approved_calendar("c", &first).unwrap();
    assert!(store.already_applied("c", &second).unwrap().is_none());
    assert_eq!(
        store.take_approved_calendar("c", &second).unwrap_err().to_string(),
        "applyInProgress"
    );
    // A token that was never issued for this apply is still refused as unapproved.
    assert_ne!(
        store.take_approved_calendar("c", "forged").unwrap_err().to_string(),
        "applyInProgress"
    );
    store.finish_applying("c", true).unwrap();
    assert_eq!(store.already_applied("c", &second).unwrap().unwrap()["alreadyApplied"], true);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn calendar_proposals_record_how_the_helper_ended_and_old_ones_are_pruned() {
    let root = std::env::temp_dir().join(format!("live-cal-proposal-{}", uuid::Uuid::new_v4()));
    let store = ActionStore::open(&root).unwrap();
    let big = "x".repeat(200_000);
    for id in ["saved", "refused"] {
        store
            .store_calendar(&serde_json::json!({"id":id,"operation":"calendarAdd","before":big,"after":big,"status":"proposed"}))
            .unwrap();
        let token = store.approve(id).unwrap();
        store.take_approved_calendar(id, &token).unwrap();
        assert_eq!(status(&root, id), "applying");
        assert!(store.take_approved_calendar(id, &token).is_err());
    }
    store.finish_applying("saved", true).unwrap();
    store.finish_applying("refused", false).unwrap();
    assert_eq!(status(&root, "saved"), "applied");
    // A calendar failure stays terminal: the helper may have saved part of it, so it is never retried
    // under the same proposal.
    assert_eq!(status(&root, "refused"), "failed");
    // A replay of the saved change's token answers with the recorded result.
    let saved_token = {
        store
            .store_calendar(&serde_json::json!({"id":"replayed","operation":"calendarAdd","before":"","after":"{}","status":"proposed"}))
            .unwrap();
        let token = store.approve("replayed").unwrap();
        store.take_approved_calendar("replayed", &token).unwrap();
        store.finish_applying("replayed", true).unwrap();
        store
            .record_applied_result("replayed", &serde_json::json!({"proposalId":"replayed","applied":true,"event":{"id":"e1"}}))
            .unwrap();
        token
    };
    let replay = store.already_applied("replayed", &saved_token).unwrap().unwrap();
    assert_eq!((replay["event"]["id"].as_str(), replay["alreadyApplied"].as_bool()), (Some("e1"), Some(true)));
    assert!(store.already_applied("replayed", "other").unwrap().is_none());
    let db = rusqlite::Connection::open(root.join("actions.sqlite")).unwrap();
    let size: i64 = db
        .query_row("SELECT length(body) FROM proposals WHERE id='saved'", [], |r| r.get(0))
        .unwrap();
    assert!(size < 150_000);
    db.execute("UPDATE proposals SET created_ms=0 WHERE id='saved'", []).unwrap();
    store
        .store_calendar(&serde_json::json!({"id":"new","operation":"calendarAdd","before":"","after":"","status":"proposed"}))
        .unwrap();
    let left: i64 = db.query_row("SELECT COUNT(*) FROM proposals", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 3, "refused, replayed and new remain; the old saved one is pruned");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn an_interrupted_note_save_recovers_without_overwriting_the_persons_file() {
    let root = std::env::temp_dir().join(format!("live-note-recover-{}", uuid::Uuid::new_v4()));
    let store = ActionStore::open(&root).unwrap();
    // The file was created but the save stopped before registering it.
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::write(root.join("notes/a.md"), "owned text").unwrap();
    assert_eq!(store.save_internal_note("a", "owned text").unwrap()["expectedRevision"], 1);
    assert_eq!(store.save_internal_note("a", "more text").unwrap()["expectedRevision"], 2);
    assert_eq!(std::fs::read_to_string(root.join("notes/a.md")).unwrap(), "more text");
    // Registered but the file is missing: it is created again.
    store.save_internal_note("b", "first").unwrap();
    std::fs::remove_file(root.join("notes/b.md")).unwrap();
    store.save_internal_note("b", "second").unwrap();
    assert_eq!(std::fs::read_to_string(root.join("notes/b.md")).unwrap(), "second");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_refused_approval_is_not_reported_as_a_retryable_write_failure() {
    let root = std::env::temp_dir().join(format!("live-apply-codes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("existing.md");
    std::fs::write(&note, "original").unwrap();
    let store = ActionStore::open(&root.join("app")).unwrap();
    store.record_picked(&note, "file").unwrap();
    let id = store.propose(&note, "append", "\nnew").unwrap()["id"].as_str().unwrap().to_owned();
    // A token that was never issued (or expired) is refused before any write.
    let refused = store.apply(&id, "invalid").unwrap_err();
    assert_eq!(apply_error_code(&refused), "approvalRequired");
    // A declined proposal refuses its earlier token the same way.
    let token = store.approve(&id).unwrap();
    store.decline(&id).unwrap();
    assert_eq!(apply_error_code(&store.apply(&id, &token).unwrap_err()), "approvalRequired");
    // A write that fails after approval reopens the proposal: that one is retryable.
    let id = store.propose(&note, "append", "\nagain").unwrap()["id"].as_str().unwrap().to_owned();
    let token = store.approve(&id).unwrap();
    std::fs::write(&note, "changed externally").unwrap();
    assert_eq!(apply_error_code(&store.apply(&id, &token).unwrap_err()), "applyFailedOrTargetChanged");
    std::fs::remove_dir_all(root).unwrap();
}
