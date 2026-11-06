use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
pub async fn request(app: &AppHandle, body: Value, approved: bool) -> anyhow::Result<Value> {
    let root = crate::commands::data_root();
    let binary = crate::commands::worker_binary(app);
    let mut child = tokio::process::Command::new("/usr/bin/sandbox-exec");
    child
        .args(["-p", "(version 1) (allow default) (deny network*)"])
        .arg(binary)
        .arg(root.join("models"))
        .arg(root.join("cache"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let body = if approved {
        let capability = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        child.env("LIVE_INTERVIEW_CALENDAR_CAPABILITY", &capability);
        let payload = body.to_string();
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(capability.as_bytes())?;
        mac.update(payload.as_bytes());
        let signature = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        json!({"kind":"calendarApply","payloadJson":payload,"signature":signature})
    } else {
        body
    };
    let mut child = child.spawn()?;
    // Filtered like the speech helper's: event titles or notes never reach the log.
    if let Some(stderr) = child.stderr.take() {
        crate::local_speech::worker::forward_stderr(stderr, "calendar");
    }
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(format!("{}\n{{\"kind\":\"shutdown\"}}\n", body).as_bytes())
        .await?;
    drop(stdin);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await??;
    let text = String::from_utf8(output.stdout)?;
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v["kind"] == "calendarResult" || v["kind"] == "failure" {
                return Ok(v);
            }
        }
    }
    anyhow::bail!("calendarUnavailable")
}
#[tauri::command]
pub async fn calendar_capabilities(app: AppHandle) -> Result<Value, String> {
    request(&app, json!({"kind":"calendarCapabilities"}), false)
        .await
        .map_err(|_| "calendarUnavailable".into())
}
#[tauri::command]
pub async fn read_upcoming_meetings(
    app: AppHandle,
    start_ms: i64,
    end_ms: i64,
    request_permission: bool,
) -> Result<Value, String> {
    let result=request(&app,json!({"kind":"calendarRead","startMs":start_ms,"endMs":end_ms,"requestPermission":request_permission}),false).await.map_err(|_|"calendarUnavailable")?;
    if crate::edition::is_public() && successful_explicit_read(request_permission, &result) {
        crate::public_connectors::CalendarStore::open(&crate::commands::data_root())
            .and_then(|store| store.set_apple_enabled(true))
            .map_err(|_| "calendarStateUnavailable")?;
    }
    Ok(result)
}
fn successful_explicit_read(request_permission: bool, result: &Value) -> bool {
    request_permission
        && result["kind"] == "calendarResult"
        && result["code"].is_null()
        && result["events"].is_array()
}
#[cfg(test)]
mod reconnect_tests {
    use super::*;
    #[test]
    fn enumeration_and_denied_reads_do_not_reconnect_local_calendars() {
        let granted = json!({"kind":"calendarResult","events":[]});
        assert!(!successful_explicit_read(false, &granted));
        assert!(successful_explicit_read(true, &granted));
        assert!(!successful_explicit_read(
            true,
            &json!({"kind":"calendarResult","events":[],"code":"calendarPermissionRequired"})
        ));
        assert!(!successful_explicit_read(
            true,
            &json!({"kind":"failure","code":"unavailable"})
        ));
    }
}
#[tauri::command]
pub async fn prepare_calendar_change(app: AppHandle, change: Value) -> Result<Value, String> {
    let caps = request(&app, json!({"kind":"calendarCapabilities"}), false)
        .await
        .map_err(|_| "calendarUnavailable")?;
    let id = change["calendarId"].as_str().ok_or("calendarRequired")?;
    let capability = caps["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == id && c["add"] == true)
        .ok_or("calendarUnavailable")?;
    if change["move"] == true {
        return prepare_move(&app, &change, id).await;
    }
    let mut delta = change.clone();
    delta["kind"] = json!("calendarApply");
    let before = if change["eventId"].as_str().is_some() {
        if capability["edit"] != true {
            return Err("calendarReadOnly".into());
        }
        let start = change["originalStartMs"]
            .as_i64()
            .or_else(|| change["startMs"].as_i64())
            .ok_or("invalidDate")?;
        let events = read_windows(&app, id, &[(start - DAY_MS, start + DAY_MS)]).await?;
        let event = edit_target(&events, &change, start)?;
        // The helper resolves the same event again from these fields before saving.
        delta["expectedVersion"] = event["version"].clone();
        delta["originalStartMs"] = event["startMs"].clone();
        delta["stableId"] = event["stableId"].clone();
        delta["eventId"] = event["id"].clone();
        event
    } else {
        json!({"newEvent":true,"calendar":capability})
    };
    let proposal_id = uuid::Uuid::new_v4().to_string();
    let p = json!({"id":proposal_id,"targetId":id,"targetPath":format!("calendar:{id}"),"targetVersion":delta["expectedVersion"].as_str().unwrap_or("newEvent"),"operation":if change["eventId"].is_string(){"calendarEdit"}else{"calendarAdd"},"before":before.to_string(),"after":delta.to_string(),"calendar":capability,"evidence":[],"inferred":change["inferred"].as_bool().unwrap_or(true),"status":"proposed"});
    crate::actions::ActionStore::open(&crate::commands::data_root())
        .and_then(|s| s.store_calendar(&p))
        .map_err(|_| "proposalFailed")?;
    Ok(p)
}
#[tauri::command]
pub async fn apply_calendar_change(
    app: AppHandle,
    proposal_id: String,
    approval: String,
) -> Result<Value, String> {
    let store = crate::actions::ActionStore::open(&crate::commands::data_root())
        .map_err(|_| "proposalFailed")?;
    // A replay of the token this change was saved with (a double click) answers with the earlier
    // result and never asks the helper again.
    if let Ok(Some(earlier)) = store.already_applied(&proposal_id, &approval) {
        return Ok(earlier);
    }
    // The same token while the earlier click's apply is still awaiting the helper: that click is the
    // apply, so this one reports `applyInProgress` (the renderer treats it as done), never a failure.
    let p = store
        .take_approved_calendar(&proposal_id, &approval)
        .map_err(|e| match e.to_string().as_str() {
            "applyInProgress" => "applyInProgress",
            _ => "approvalRequired",
        })?;
    // Whether the helper saved the change; recorded on the proposal whatever happens after.
    let mut saved = None;
    let result = apply_approved_calendar(&app, &proposal_id, &p, &mut saved).await;
    let _ = store.finish_applying(&proposal_id, saved.unwrap_or(false));
    if let Ok(value) = &result {
        let _ = store.record_applied_result(&proposal_id, value);
    }
    result
}
async fn apply_approved_calendar(
    app: &AppHandle,
    proposal_id: &str,
    p: &Value,
    saved: &mut Option<bool>,
) -> Result<Value, String> {
    let change: Value = serde_json::from_str(p["after"].as_str().ok_or("invalidProposal")?)
        .map_err(|_| "invalidProposal")?;
    if change["move"] == true {
        return apply_move(app, proposal_id, p, change, saved).await;
    }
    let outcome = request(app, change, true)
        .await
        .map_err(|_| "calendarApplyFailed")?;
    *saved = Some(outcome["applied"] == true);
    if outcome["applied"] != true {
        return Err("calendarApplyFailedOrTargetChanged".into());
    }
    // The event is saved either way; linking only decides whether the app can show it under the plan.
    let public_event = if crate::edition::is_public() {
        let calendar_id = outcome["event"]["calendarId"].as_str().unwrap_or_default();
        crate::public_connectors::link_saved_apple_event(app, calendar_id, &outcome["event"])
            .await
            .ok()
    } else {
        None
    };
    Ok(
        json!({"proposalId":proposal_id,"applied":true,"event":outcome["event"],"publicEvent":public_event}),
    )
}

// ---- Moving an existing event: the same event edited in place, never a copy. ----
//
// A move names the event the way the calendar list knows it (`stableId` = EventKit's
// calendarItemIdentifier, plus the start the person saw), is refused for repeating and all-day
// events and calendars that do not allow changes, compares the version the person saw, and is
// verified after saving by reading the calendar again in a fresh helper process: exactly one event
// with that identity, at the new time, and no new copy left anywhere in the window.

/// Codes a move may fail with; anything else becomes `calendarApplyFailed`.
pub const MOVE_ERRORS: &[&str] = &[
    "recurringUnsupported",
    "allDayUnsupported",
    "calendarReadOnly",
    "eventChanged",
    "eventUnavailable",
    "eventNotModifiable",
    "moveReverted",
    "moveNotVerified",
    "invalidDate",
    "calendarApplyFailed",
];
const DAY_MS: i64 = 86_400_000;
fn move_code(code: Option<&str>) -> String {
    code.filter(|c| MOVE_ERRORS.contains(c))
        .unwrap_or("calendarApplyFailed")
        .to_owned()
}
fn non_empty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}
/// Same event: the same calendar item (stableId) or, when that is unknown, the same native id.
fn same_identity(e: &Value, stable_id: Option<&str>, native_id: Option<&str>) -> bool {
    match (stable_id, non_empty(&e["stableId"])) {
        (Some(want), Some(have)) => want == have,
        _ => native_id.is_some() && non_empty(&e["id"]) == native_id,
    }
}
/// Finds the one native event a move refers to among the helper's read of the calendar.
pub fn resolve_move_target<'a>(
    events: &'a [Value],
    stable_id: Option<&str>,
    native_id: Option<&str>,
    original_start_ms: i64,
) -> Result<&'a Value, &'static str> {
    if stable_id.is_none() && native_id.is_none() {
        return Err("eventUnavailable");
    }
    let candidates: Vec<&Value> = events
        .iter()
        .filter(|e| e["cancelled"] != true && same_identity(e, stable_id, native_id))
        .collect();
    if candidates.is_empty() {
        return Err("eventUnavailable");
    }
    // One identity with several occurrences, or flagged as part of a series: EventKit's lookup by
    // identifier returns the first occurrence, so editing it could move the wrong one.
    if candidates.len() > 1 || candidates.iter().any(|e| e["recurring"] == true) {
        return Err("recurringUnsupported");
    }
    let event = candidates[0];
    let at_original = event["occurrenceStartMs"].as_i64() == Some(original_start_ms)
        || event["startMs"].as_i64() == Some(original_start_ms);
    if !at_original {
        return Err("eventChanged");
    }
    if event["isAllDay"] == true {
        return Err("allDayUnsupported");
    }
    if event["calendarWritable"] == false {
        return Err("calendarReadOnly");
    }
    Ok(event)
}
/// The existing event any reviewed edit (not only a move) refers to, with the move's refusals:
/// repeating series, all-day events, read-only calendars and a version the person did not see.
pub fn edit_target(events: &[Value], change: &Value, original_start_ms: i64) -> Result<Value, &'static str> {
    let target = resolve_move_target(
        events,
        non_empty(&change["stableId"]),
        non_empty(&change["eventId"]),
        original_start_ms,
    )?;
    check_move_version(non_empty(&change["expectedVersion"]), target)?;
    Ok(target.clone())
}
/// The version the person saw (when given) must still be the calendar's.
pub fn check_move_version(seen: Option<&str>, current: &Value) -> Result<(), &'static str> {
    match seen {
        Some(seen) if current["version"].as_str() != Some(seen) => Err("eventChanged"),
        _ => Ok(()),
    }
}
/// Read windows that cover the old and new times with a day either side, within the helper's
/// 31-day limit per read.
pub fn move_windows(old_start: i64, old_end: i64, new_start: i64, new_end: i64) -> Vec<(i64, i64)> {
    let (lo, hi) = (old_start.min(new_start) - DAY_MS, old_end.max(new_end) + DAY_MS);
    if hi - lo <= 30 * DAY_MS {
        vec![(lo, hi)]
    } else {
        vec![
            (old_start - DAY_MS, old_end + DAY_MS),
            (new_start - DAY_MS, new_end + DAY_MS),
        ]
    }
}
fn row_key(e: &Value) -> String {
    format!(
        "{}\0{}\0{}",
        e["id"].as_str().unwrap_or(""),
        e["stableId"].as_str().unwrap_or(""),
        e["startMs"].as_i64().unwrap_or(0)
    )
}
fn same_slot(e: &Value, title: &str, start: i64, end: i64) -> bool {
    e["cancelled"] != true
        && e["title"].as_str() == Some(title)
        && e["startMs"].as_i64() == Some(start)
        && e["endMs"].as_i64() == Some(end)
}
/// After saving: `before_events` and `after_events` are full reads of the same windows taken just
/// before and just after the save. The move is verified only when exactly one event has the
/// target's identity, it sits at the new time, and no event with the same title appeared at the old
/// or new time that was not there before (a copy under a new identity).
pub fn verify_move<'a>(
    target: &Value,
    before_events: &[Value],
    after_events: &'a [Value],
    new_start: i64,
    new_end: i64,
) -> Result<&'a Value, &'static str> {
    let stable = non_empty(&target["stableId"]);
    let native = non_empty(&target["id"]);
    let matches: Vec<&Value> = after_events
        .iter()
        .filter(|e| e["cancelled"] != true && same_identity(e, stable, native))
        .collect();
    let [moved] = matches.as_slice() else {
        return Err("moveNotVerified");
    };
    let (old_start, old_end) = (
        target["startMs"].as_i64().unwrap_or(i64::MIN),
        target["endMs"].as_i64().unwrap_or(i64::MIN),
    );
    let at_new = moved["startMs"].as_i64() == Some(new_start) && moved["endMs"].as_i64() == Some(new_end);
    if !at_new {
        let at_old = moved["startMs"].as_i64() == Some(old_start) && moved["endMs"].as_i64() == Some(old_end);
        return Err(if at_old { "moveReverted" } else { "moveNotVerified" });
    }
    let title = target["title"].as_str().unwrap_or("");
    let known: std::collections::HashSet<String> = before_events.iter().map(row_key).collect();
    let copy = after_events.iter().any(|e| {
        !std::ptr::eq(e, *moved)
            && !same_identity(e, stable, native)
            && !known.contains(&row_key(e))
            && (same_slot(e, title, old_start, old_end) || same_slot(e, title, new_start, new_end))
    });
    if copy {
        return Err("moveNotVerified");
    }
    Ok(moved)
}
async fn read_windows(app: &AppHandle, calendar_id: &str, windows: &[(i64, i64)]) -> Result<Vec<Value>, String> {
    let mut rows: Vec<Value> = vec![];
    for (start, end) in windows {
        let read = request(app, json!({"kind":"calendarRead","startMs":start,"endMs":end,"calendarId":calendar_id}), false)
            .await
            .map_err(|_| "calendarUnavailable")?;
        if !read["code"].is_null() {
            return Err("calendarUnavailable".into());
        }
        rows.extend(read["events"].as_array().ok_or("calendarUnavailable")?.iter().cloned());
    }
    let mut seen = std::collections::HashSet::new();
    rows.retain(|e| seen.insert(row_key(e)));
    Ok(rows)
}
async fn prepare_move(app: &AppHandle, change: &Value, calendar_id: &str) -> Result<Value, String> {
    let caps = request(app, json!({"kind":"calendarCapabilities"}), false)
        .await
        .map_err(|_| "calendarUnavailable")?;
    let capability = caps["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == calendar_id)
        .ok_or("calendarUnavailable")?
        .clone();
    if capability["edit"] != true {
        return Err("calendarReadOnly".into());
    }
    let original = change["originalStartMs"].as_i64().ok_or("invalidDate")?;
    let (start, end) = (
        change["startMs"].as_i64().ok_or("invalidDate")?,
        change["endMs"].as_i64().ok_or("invalidDate")?,
    );
    if end <= start {
        return Err("invalidDate".into());
    }
    let events = read_windows(app, calendar_id, &[(original - DAY_MS, original + DAY_MS)]).await?;
    let target = resolve_move_target(
        &events,
        non_empty(&change["stableId"]),
        non_empty(&change["eventId"]),
        original,
    )?
    .clone();
    check_move_version(non_empty(&change["expectedVersion"]), &target)?;
    let invitation = target["invitation"] == true;
    let delta = json!({
        "kind": "calendarApply", "move": true, "calendarId": calendar_id,
        "stableId": target["stableId"], "eventId": target["id"],
        "originalStartMs": target["startMs"], "startMs": start, "endMs": end,
        "title": target["title"], "expectedVersion": target["version"],
    });
    let proposal_id = uuid::Uuid::new_v4().to_string();
    let p = json!({"id":proposal_id,"targetId":calendar_id,"targetPath":format!("calendar:{calendar_id}"),"targetVersion":target["version"].as_str().unwrap_or(""),"operation":"calendarEdit","move":true,"invitation":invitation,"before":target.to_string(),"after":delta.to_string(),"calendar":capability,"evidence":[],"inferred":change["inferred"].as_bool().unwrap_or(false),"status":"proposed"});
    crate::actions::ActionStore::open(&crate::commands::data_root())
        .and_then(|s| s.store_calendar(&p))
        .map_err(|_| "proposalFailed")?;
    Ok(p)
}
async fn apply_move(
    app: &AppHandle,
    proposal_id: &str,
    p: &Value,
    change: Value,
    saved: &mut Option<bool>,
) -> Result<Value, String> {
    let target: Value = serde_json::from_str(p["before"].as_str().ok_or("invalidProposal")?)
        .map_err(|_| "invalidProposal")?;
    let calendar_id = change["calendarId"].as_str().ok_or("invalidProposal")?.to_owned();
    let (start, end) = (
        change["startMs"].as_i64().ok_or("invalidDate")?,
        change["endMs"].as_i64().ok_or("invalidDate")?,
    );
    let (old_start, old_end) = (
        target["startMs"].as_i64().ok_or("invalidProposal")?,
        target["endMs"].as_i64().ok_or("invalidProposal")?,
    );
    let windows = move_windows(old_start, old_end, start, end);
    let before_events = read_windows(app, &calendar_id, &windows).await?;
    let outcome = request(app, change, true)
        .await
        .map_err(|_| "calendarApplyFailed")?;
    *saved = Some(outcome["applied"] == true);
    if outcome["applied"] != true {
        return Err(move_code(outcome["code"].as_str()));
    }
    // A fresh helper process, so the check reads the calendar database, not the saving process's objects.
    let after_events = read_windows(app, &calendar_id, &windows).await?;
    let moved = verify_move(&target, &before_events, &after_events, start, end)?.clone();
    let public_event = if crate::edition::is_public() {
        crate::public_connectors::link_saved_apple_event(app, &calendar_id, &moved)
            .await
            .ok()
    } else {
        None
    };
    Ok(json!({"proposalId":proposal_id,"applied":true,"moved":true,"event":moved,"before":{"startMs":old_start,"endMs":old_end},"publicEvent":public_event}))
}
#[cfg(test)]
mod move_tests {
    use super::*;
    const T: i64 = 1_792_486_800_000; // 2026-10-20 09:00 +02:00
    const H: i64 = 3_600_000;
    fn ev(id: &str, stable: &str, start: i64, end: i64) -> Value {
        json!({"id":id,"stableId":stable,"title":"Design review","startMs":start,"endMs":end,"occurrenceStartMs":start,"version":format!("v-{id}-{start}"),"recurring":false,"isAllDay":false,"calendarWritable":true})
    }
    #[test]
    fn resolves_the_event_by_stable_id_and_the_start_the_person_saw() {
        let events = vec![ev("native-a", "item-a", T, T + H), ev("native-b", "item-b", T, T + H)];
        let found = resolve_move_target(&events, Some("item-b"), None, T).unwrap();
        assert_eq!(found["id"], "native-b");
        // The native id is only a fallback when no stable id is known.
        let by_native = resolve_move_target(&events, None, Some("native-a"), T).unwrap();
        assert_eq!(by_native["stableId"], "item-a");
        assert_eq!(resolve_move_target(&events, Some("item-x"), None, T), Err("eventUnavailable"));
        assert_eq!(resolve_move_target(&events, None, None, T), Err("eventUnavailable"));
        // Moved elsewhere in Calendar since the person saw it.
        assert_eq!(resolve_move_target(&events, Some("item-a"), None, T + H), Err("eventChanged"));
        // A cancelled row with the same identity is ignored.
        let mut cancelled = ev("native-a", "item-a", T, T + H);
        cancelled["cancelled"] = json!(true);
        assert_eq!(resolve_move_target(&[cancelled], Some("item-a"), None, T), Err("eventUnavailable"));
    }
    #[test]
    fn repeating_all_day_and_read_only_events_are_refused() {
        let mut recurring = ev("n", "item", T, T + H);
        recurring["recurring"] = json!(true);
        assert_eq!(resolve_move_target(&[recurring], Some("item"), None, T), Err("recurringUnsupported"));
        // Several occurrences of one calendar item: a series even if the flag is missing.
        let twice = vec![ev("n1", "item", T, T + H), ev("n2", "item", T + 7 * 24 * H, T + 7 * 24 * H + H)];
        assert_eq!(resolve_move_target(&twice, Some("item"), None, T), Err("recurringUnsupported"));
        let mut all_day = ev("n", "item", T, T + 24 * H);
        all_day["isAllDay"] = json!(true);
        assert_eq!(resolve_move_target(&[all_day], Some("item"), None, T), Err("allDayUnsupported"));
        let mut locked = ev("n", "item", T, T + H);
        locked["calendarWritable"] = json!(false);
        assert_eq!(resolve_move_target(&[locked], Some("item"), None, T), Err("calendarReadOnly"));
    }
    #[test]
    fn a_plain_edit_of_an_existing_event_gets_the_same_refusals_as_a_move() {
        let change = json!({"eventId":"n","title":"Renamed","startMs":T,"endMs":T + H});
        assert_eq!(edit_target(&[ev("n", "item", T, T + H)], &change, T).unwrap()["stableId"], "item");
        let mut recurring = ev("n", "item", T, T + H);
        recurring["recurring"] = json!(true);
        assert_eq!(edit_target(&[recurring], &change, T), Err("recurringUnsupported"));
        // The first occurrence of a series found by native id is still a series.
        let series = vec![ev("n", "item", T, T + H), ev("n", "item", T + 24 * H, T + 25 * H)];
        assert_eq!(edit_target(&series, &change, T), Err("recurringUnsupported"));
        let mut all_day = ev("n", "item", T, T + 24 * H);
        all_day["isAllDay"] = json!(true);
        assert_eq!(edit_target(&[all_day], &change, T), Err("allDayUnsupported"));
        let mut locked = ev("n", "item", T, T + H);
        locked["calendarWritable"] = json!(false);
        assert_eq!(edit_target(&[locked], &change, T), Err("calendarReadOnly"));
        let mut seen = change.clone();
        seen["expectedVersion"] = json!("v-old");
        assert_eq!(edit_target(&[ev("n", "item", T, T + H)], &seen, T), Err("eventChanged"));
    }
    #[test]
    fn an_invitation_resolves_like_any_other_single_event() {
        let mut invite = ev("n", "item", T, T + H);
        invite["invitation"] = json!(true);
        invite["organiserIsCurrentUser"] = json!(false);
        let found = resolve_move_target(std::slice::from_ref(&invite), Some("item"), None, T).unwrap();
        assert_eq!(found["invitation"], true);
    }
    #[test]
    fn a_version_the_person_did_not_see_is_rejected() {
        let current = ev("n", "item", T, T + H);
        assert_eq!(check_move_version(Some("v-n-0"), &current), Err("eventChanged"));
        assert_eq!(check_move_version(current["version"].as_str(), &current), Ok(()));
        assert_eq!(check_move_version(None, &current), Ok(()));
    }
    #[test]
    fn verification_accepts_only_one_event_at_the_new_time() {
        let target = ev("n", "item", T, T + H);
        let other = json!({"id":"o","stableId":"other","title":"Lunch","startMs":T,"endMs":T+H});
        let before = vec![target.clone(), other.clone()];
        let moved = ev("n", "item", T + 2 * H, T + 3 * H);
        let after = vec![moved.clone(), other.clone()];
        assert_eq!(verify_move(&target, &before, &after, T + 2 * H, T + 3 * H).unwrap()["startMs"], T + 2 * H);
        // Exchange may give the saved event a new native id: the stable id still identifies it.
        let mut renamed = moved.clone();
        renamed["id"] = json!("n-after-sync");
        assert!(verify_move(&target, &before, &[renamed], T + 2 * H, T + 3 * H).is_ok());
    }
    #[test]
    fn verification_rejects_duplicates_reverts_and_missing_events() {
        let target = ev("n", "item", T, T + H);
        let before = vec![target.clone()];
        let moved = ev("n", "item", T + 2 * H, T + 3 * H);
        // Two events with the same identity.
        assert_eq!(verify_move(&target, &before, &[moved.clone(), target.clone()], T + 2 * H, T + 3 * H), Err("moveNotVerified"));
        // The calendar kept the old time.
        assert_eq!(verify_move(&target, &before, &[target.clone()], T + 2 * H, T + 3 * H), Err("moveReverted"));
        // Gone, or somewhere else.
        assert_eq!(verify_move(&target, &before, &[], T + 2 * H, T + 3 * H), Err("moveNotVerified"));
        assert_eq!(verify_move(&target, &before, &[ev("n", "item", T + 5 * H, T + 6 * H)], T + 2 * H, T + 3 * H), Err("moveNotVerified"));
        // A copy under a new identity appeared at the old time (or the new time).
        let copy_old = ev("copy", "item-copy", T, T + H);
        assert_eq!(verify_move(&target, &before, &[moved.clone(), copy_old], T + 2 * H, T + 3 * H), Err("moveNotVerified"));
        let copy_new = ev("copy", "item-copy", T + 2 * H, T + 3 * H);
        assert_eq!(verify_move(&target, &before, &[moved.clone(), copy_new], T + 2 * H, T + 3 * H), Err("moveNotVerified"));
        // A same-titled event that was already there before is not a copy.
        let existing = ev("twin", "item-twin", T + 2 * H, T + 3 * H);
        let before_with_twin = vec![target.clone(), existing.clone()];
        assert!(verify_move(&target, &before_with_twin, &[moved, existing], T + 2 * H, T + 3 * H).is_ok());
    }
    #[test]
    fn windows_cover_both_times_within_the_read_limit() {
        assert_eq!(move_windows(T, T + H, T + 2 * H, T + 3 * H), vec![(T - DAY_MS, T + 3 * H + DAY_MS)]);
        let far = T + 60 * DAY_MS;
        let w = move_windows(T, T + H, far, far + H);
        assert_eq!(w, vec![(T - DAY_MS, T + H + DAY_MS), (far - DAY_MS, far + H + DAY_MS)]);
        assert!(w.iter().all(|(a, b)| b - a <= 31 * DAY_MS));
    }
    #[test]
    fn helper_codes_are_passed_through_only_when_known() {
        assert_eq!(move_code(Some("eventNotModifiable")), "eventNotModifiable");
        assert_eq!(move_code(Some("recurringUnsupported")), "recurringUnsupported");
        assert_eq!(move_code(Some("somethingInternal")), "calendarApplyFailed");
        assert_eq!(move_code(None), "calendarApplyFailed");
    }
}
