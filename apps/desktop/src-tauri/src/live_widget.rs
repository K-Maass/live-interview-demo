use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetAction {
    version: u8,
    request_id: String,
    owner_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    meeting_id: Option<String>,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    card_id: Option<String>,
}

fn checked_action(sender: &str, value: Value) -> Result<WidgetAction, String> {
    if sender != "live-assistance-widget" { return Err("Widget sender required".into()); }
    let action: WidgetAction = serde_json::from_value(value).map_err(|_| "Invalid widget action".to_string())?;
    let valid_id = |value: &str| !value.is_empty() && value.len() <= 256;
    if action.version != 1 || !valid_id(&action.owner_id) || !valid_id(&action.request_id)
        || !matches!(action.kind.as_str(), "pin" | "dismiss" | "evidence" | "answered" | "outdated" | "openMain")
        || action.meeting_id.as_deref().is_some_and(|id| !valid_id(id))
        || action.card_id.as_deref().is_some_and(|id| !valid_id(id))
        || (action.kind != "openMain" && (action.meeting_id.is_none() || action.card_id.is_none()))
    { return Err("Invalid widget action".into()); }
    Ok(action)
}

pub fn closes_companion(label: &str, recording: bool) -> bool { label == "main" && !recording }

#[tauri::command]
pub fn forward_widget_action(window: tauri::WebviewWindow, app: tauri::AppHandle, action: Value) -> Result<(), String> {
    let action = checked_action(window.label(), action)?;
    app.emit_to("main", "live-widget-action", action).map_err(|_| "Main workspace unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn action() -> Value { json!({"version":1,"requestId":"request-a","ownerId":"owner-a","meetingId":"meeting-a","cardId":"card-a","kind":"pin"}) }
    #[test] fn only_widget_can_forward() { assert!(checked_action("main", action()).is_err()); assert!(checked_action("live-assistance-widget", action()).is_ok()); }
    #[test] fn unknown_operation_is_rejected() { let mut a = action(); a["kind"] = json!("start_local_meeting"); assert!(checked_action("live-assistance-widget", a).is_err()); }
    #[test] fn context_and_audio_cannot_cross() { let mut a = action(); a["audio"] = json!([0,1]); assert!(checked_action("live-assistance-widget", a).is_err()); }
    #[test] fn inactive_open_main_keeps_optional_ids_absent() { let a = checked_action("live-assistance-widget", json!({"version":1,"requestId":"r","ownerId":"o","kind":"openMain"})).unwrap(); let payload = serde_json::to_value(a).unwrap(); assert!(payload.get("meetingId").is_none()); assert!(payload.get("cardId").is_none()); }
    #[test] fn pin_outcomes_are_allowed_only_for_a_card() {
        for kind in ["answered", "outdated"] {
            let mut a = action(); a["kind"] = json!(kind);
            assert!(checked_action("live-assistance-widget", a.clone()).is_ok());
            assert!(checked_action("main", a.clone()).is_err());
            let mut no_card = a.clone(); no_card.as_object_mut().unwrap().remove("cardId");
            assert!(checked_action("live-assistance-widget", no_card).is_err());
            let mut no_meeting = a.clone(); no_meeting.as_object_mut().unwrap().remove("meetingId");
            assert!(checked_action("live-assistance-widget", no_meeting).is_err());
            let mut long = a; long["cardId"] = json!("c".repeat(257));
            assert!(checked_action("live-assistance-widget", long).is_err());
        }
        for kind in ["unpin", "reopen", "Answered", "settle"] { let mut a = action(); a["kind"] = json!(kind); assert!(checked_action("live-assistance-widget", a).is_err()); }
    }
    #[test] fn only_idle_main_close_affects_widget() { assert!(closes_companion("main", false)); assert!(!closes_companion("main", true)); assert!(!closes_companion("live-assistance-widget", false)); }
}
