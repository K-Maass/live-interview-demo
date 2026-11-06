#[test]
#[cfg(unix)]
fn a_symlinked_note_directory_does_not_authorize_workspace_writes() {
    let root = std::env::temp_dir().join(format!("live-note-link-{}", uuid::Uuid::new_v4()));
    let external = root.join("user-workspace");
    std::fs::create_dir_all(&external).unwrap();
    let app = root.join("app");
    let store = live_interview_lib::actions::ActionStore::open(&app).unwrap();
    std::os::unix::fs::symlink(&external, app.join("notes")).unwrap();
    assert!(store
        .save_internal_note("test", "must stay app owned")
        .is_err());
    assert!(!external.join("test.md").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_grant_pick_covers_only_its_own_purpose_once_and_never_a_write_proposal() {
    let root = std::env::temp_dir().join(format!("live-grant-pick-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let store = live_interview_lib::actions::ActionStore::open(&root.join("app")).unwrap();
    let ttl = live_interview_lib::grants::PICKED_GRANT_TTL_MS;
    store.record_picked(&project, "grantRead").unwrap();
    // Submitted as the output folder, the read pick does not count, and is not used up by that check.
    assert!(!store.consume_picked(&project, "grantOutput", ttl).unwrap());
    assert!(store.consume_picked(&project, "grantRead", ttl).unwrap());
    // Reuse after consumption asks again.
    assert!(!store.consume_picked(&project, "grantRead", ttl).unwrap());
    // A grant pick never authorises a reviewed write in that folder.
    store.record_picked(&project, "grantOutput").unwrap();
    assert!(store.propose(&project.join("new.md"), "rewrite", "x").is_err());
    // Only grant kinds can be consumed; write-proposal picks are not grant picks.
    assert!(store.consume_picked(&project, "file", ttl).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
