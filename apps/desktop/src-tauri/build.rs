fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["forward_widget_action"]),
    )).expect("Tauri UI manifest failed")
}
