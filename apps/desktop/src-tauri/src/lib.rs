pub mod actions;
mod app_icon;
mod audio;
mod audio_check;
pub mod calendar;
mod commands;
pub mod context_sources;
pub mod crash_report;
mod disk_space;
pub mod instance_lock;
pub mod edition;
pub mod grants;
pub mod public_service;
mod public_updates;
pub mod public_domain;
pub mod public_connectors;
pub mod local_speech;
mod live_widget;
pub mod meeting_detection;
pub mod meeting_records;
mod owned_paths;
mod permissions;
mod recording_activity;
pub mod schema;
pub mod reasoning;
pub mod research;
pub mod source_extraction;
pub mod transcription;
pub mod workspace_sharing;
use tauri::Manager;
pub fn run() {
    // Local crash reports (#47): a panic hook and a run marker. Nothing is sent without the person's choice.
    crash_report::install(edition::data_root());
    // Raw audio of meetings that do not retain it, left behind by a crash or an interrupted finish. Runs
    // off the main thread; it never touches audio that recognition or recovery still needs.
    // Held for the process lifetime: a second copy of the app must not recover, sweep or record (see instance_lock).
    let instance = instance_lock::InstanceGuard::take(&edition::data_root());
    let primary = instance.primary();
    if primary { std::thread::spawn(|| {
        let root = edition::data_root();
        let keep = local_speech::settings::experimental_medium_translation(&root);
        match meeting_records::retention::sweep_raw_audio(&root, keep, meeting_records::retention::ORPHAN_CACHE_TTL) {
            Ok(0) => {}
            Ok(removed) => log::info!("[retention] removed {removed} raw audio items"),
            Err(error) => log::warn!("[retention] sweep failed: {error}"),
        }
    }); }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(public_updates::UpdateState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(commands::MeetingController::default())
        .manage(audio_check::AudioCheck::default())
        .manage(commands::SpeechHost::default())
        .manage(reasoning::ReasoningState::default())
        .manage(actions::ActionState::default())
        .manage(context_sources::SourceState)
        .manage(instance)
        // Meetings a crash or force quit left unfinished are processed in the background.
        .setup(move |app| {
            // Background session renewal (S4); it never touches recording.
            public_service::start_session_renewal();
            if primary {
                commands::spawn_launch_recovery(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_input_devices,
            live_widget::forward_widget_action,
            meeting_records::list_people,
            commands::create_synthetic_record,
            meeting_detection::detect_teams_call,
            commands::speech_readiness,
            commands::warm_local_speech,
            commands::speech_warmup_state,
            commands::restart_local_speech,
            commands::setup_local_models,
            commands::cancel_local_models_setup,
            commands::set_experimental_medium_translation,
            permissions::microphone_access_status,
            permissions::system_audio_access_status,
            permissions::request_microphone_access,
            permissions::check_system_audio_access,
            permissions::open_privacy_settings,
            permissions::accessibility_access_status,
            permissions::request_accessibility_access,
            app_icon::app_icon,
            audio_check::start_audio_check,
            audio_check::stop_audio_check,
            commands::start_local_meeting,
            commands::set_local_meeting_paused,
            commands::stop_local_meeting,
            commands::list_meeting_records,
            commands::current_local_session,
            commands::instance_state,
            commands::recover_local_record,
            commands::load_meeting_record,
            commands::set_meeting_profile,
            reasoning::connect_reasoning,
            reasoning::list_ibm_profiles,
            reasoning::reasoning_status,
            research::search_public_text,
            reasoning::test_reasoning_connection,
            reasoning::reasoning_run,
            reasoning::reasoning_cancel,
            reasoning::jev_decide,
            actions::propose_action,
            actions::approve_action,
            actions::pick_action_target,
            grants::pick_grant_path,
            actions::apply_action,
            actions::decline_action,
            actions::save_internal_note,
            actions::read_internal_note,
            workspace_sharing::export_workspace_bundle,
            workspace_sharing::import_workspace_bundle,
            calendar::calendar_capabilities,
            calendar::read_upcoming_meetings,
            calendar::prepare_calendar_change,
            calendar::apply_calendar_change,
            context_sources::connect_workspace,
            context_sources::list_sharing_sources,
            context_sources::import_chatgpt_export,
            context_sources::refresh_workspace,
            context_sources::list_workspaces,
            context_sources::retrieve_context,
            public_domain::public_list_workspaces,
            public_domain::public_save_workspace,
            public_domain::public_workspace_sources,
            public_domain::public_list_meeting_plans,
            public_domain::public_save_meeting_plan,
            public_domain::public_get_meeting_plan,
            public_domain::public_get_artifact,
            public_domain::public_get_latest_artifact,
            public_domain::public_save_artifact,
            public_domain::public_apply_granted_notes,
            public_connectors::public_calendar_accounts,
            public_connectors::public_connect_calendar,
            public_connectors::public_calendar_sources,
            public_connectors::public_select_calendars,
            public_connectors::public_disconnect_calendar,
            public_connectors::public_calendar_events,
            public_service::public_account_status,
            public_service::public_sign_in,
            public_service::public_cancel_sign_in,
            public_service::public_sign_out,
            public_service::public_sign_out_all,
            public_service::public_checkout,
            public_service::public_billing_portal,
            public_service::public_export_account,
            public_service::public_delete_account,
            public_updates::public_check_update,
            public_updates::public_install_update,
            crash_report::public_pending_crash_report,
            crash_report::public_resolve_crash_report,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<commands::MeetingController>().is_active() {
                    api.prevent_close();
                } else if live_widget::closes_companion(window.label(), false) {
                    if let Some(widget) = window.app_handle().get_webview_window("live-assistance-widget") {
                        let _ = widget.close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Live Interview runtime failed")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if app.state::<commands::MeetingController>().is_active() {
                        api.prevent_exit();
                    }
                }
                // A deliberate exit: the next launch must not read it as a crash.
                tauri::RunEvent::Exit => crash_report::finish(),
                _ => {}
            }
        });
}
