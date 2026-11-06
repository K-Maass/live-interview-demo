//! Only reviewed user requests install a signed update, and never across capture ownership.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
}
static FLOW: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn configured() -> bool {
    valid_config(
        option_env!("PUBLIC_UPDATE_ENDPOINT").unwrap_or(""),
        option_env!("PUBLIC_UPDATE_PUBKEY").unwrap_or(""),
    )
}
fn valid_config(endpoint: &str, pubkey: &str) -> bool {
    !pubkey.is_empty()
        && url::Url::parse(endpoint).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
}
#[tauri::command]
pub async fn public_check_update(app: AppHandle) -> Result<Value, String> {
    let _flow = FLOW.try_lock().map_err(|_| "updateInProgress")?;
    if !configured() {
        return Ok(
            json!({"configured":false,"available":false,"code":"updatePublisherSetupRequired"}),
        );
    }
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "updateUnavailable")?
        .check()
        .await
        .map_err(|_| "updateUnavailable")?;
    if let Some(update) = &update {
        let url = &update.download_url;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err("invalidUpdateSource".into());
        }
    }
    let result = update
        .as_ref()
        .map(|u| json!({"configured":true,"available":true,"version":u.version,"body":u.body}))
        .unwrap_or_else(|| json!({"configured":true,"available":false}));
    *app.state::<UpdateState>()
        .pending
        .lock()
        .map_err(|_| "updateUnavailable")? = update;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_insecure_publisher_setup_never_enables_updating() {
        assert!(!valid_config("", ""));
        assert!(!valid_config(
            "https://updates.example.test/stable.json",
            ""
        ));
        assert!(!valid_config(
            "http://updates.example.test/stable.json",
            "public-fixture"
        ));
        assert!(!valid_config(
            "https://user:secret@updates.example.test/stable.json",
            "public-fixture"
        ));
        assert!(!valid_config(
            "https://updates.example.test/stable.json?token=secret",
            "public-fixture"
        ));
        assert!(valid_config(
            "https://updates.example.test/stable.json",
            "public-fixture"
        ));
    }
}
#[tauri::command]
pub async fn public_install_update(app: AppHandle, version: String) -> Result<(), String> {
    let _flow = FLOW.try_lock().map_err(|_| "updateInProgress")?;
    if !configured() {
        return Err("updatePublisherSetupRequired".into());
    }
    if app
        .state::<crate::commands::MeetingController>()
        .is_active()
    {
        return Err("recordingActive".into());
    }
    let update = app
        .state::<UpdateState>()
        .pending
        .lock()
        .map_err(|_| "updateUnavailable")?
        .as_ref()
        .filter(|u| u.version == version)
        .cloned()
        .ok_or("updateChangedCheckAgain")?;
    // The maintained plugin verifies the mandatory update signature before returning bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|_| "updateDownloadOrSignatureFailed")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let controller = app.state::<crate::commands::MeetingController>();
        let _guard = controller.begin_update()?;
        update.install(bytes).map_err(|_| "updateInstallFailed")?;
        // restart() may exit without a RunEvent::Exit; a deliberate restart is not a crash.
        crate::crash_report::finish();
        app.restart();
    })
    .await
    .map_err(|_| "updateInstallFailed")?
}
