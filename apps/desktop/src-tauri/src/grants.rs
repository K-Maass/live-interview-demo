//! Native confirmation for new file access. The renderer may still send typed or pasted paths, but a save that
//! adds a folder to read and index, a folder new meeting files save into, a note that receives automatic appends,
//! or an export to import only persists after the person confirms the exact paths in a native sheet. A path
//! chosen in the native picker for that same purpose ([`pick_grant_path`]) was already confirmed by that choice
//! and skips the sheet once. An unchanged save never asks. Document rewrites approved through the action executor
//! confirm the file the same way.
use serde_json::Value;
use std::path::Path;

/// The error code every declined sheet returns. The renderer treats it as "nothing changed", not as a failure.
pub const GRANT_DECLINED: &str = "grantDeclined";
/// A path picked in the native grant picker skips the sheet once, within this long.
pub const PICKED_GRANT_TTL_MS: u64 = 10 * 60 * 1000;

/// What a native pick was made for. A pick only ever covers the grant it was made for: a folder picked to read
/// never becomes the output folder without a sheet, and a note picked for appends is not an import.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    Read,
    Output,
    Append,
    Import,
}

impl GrantKind {
    /// The `picked_targets.kind` the pick is recorded under.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "grantRead",
            Self::Output => "grantOutput",
            Self::Append => "grantAppend",
            Self::Import => "grantImport",
        }
    }
    /// The picker purpose the renderer names.
    pub fn from_pick(kind: &str) -> Option<Self> {
        Some(match kind {
            "workspaceFolder" => Self::Read,
            "outputFolder" => Self::Output,
            "appendNote" => Self::Append,
            "chatgptExport" => Self::Import,
            _ => return None,
        })
    }
    pub fn folder(self) -> bool {
        matches!(self, Self::Read | Self::Output)
    }
}

/// Access a save would add that the stored configuration did not already have.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GrantRequest {
    /// Folders to read and index as context.
    pub reads: Vec<String>,
    /// Folder new meeting files may be written into automatically.
    pub outputs: Vec<String>,
    /// Existing Markdown notes that receive automatic additive appends.
    pub appends: Vec<String>,
    /// A ChatGPT export file read once into a workspace.
    pub imports: Vec<String>,
}

impl GrantRequest {
    pub fn is_empty(&self) -> bool {
        self.reads.is_empty() && self.outputs.is_empty() && self.appends.is_empty() && self.imports.is_empty()
    }

    /// Drops the entries the person chose in the native picker for exactly that grant. `consume(path, kind)`
    /// answers for one path and uses the pick up, so the same pick never skips a second sheet.
    pub fn without_picked(mut self, mut consume: impl FnMut(&str, GrantKind) -> bool) -> Self {
        for (paths, kind) in [
            (&mut self.reads, GrantKind::Read),
            (&mut self.outputs, GrantKind::Output),
            (&mut self.appends, GrantKind::Append),
            (&mut self.imports, GrantKind::Import),
        ] {
            paths.retain(|p| !consume(p, kind));
        }
        self
    }

    /// The sheet text: every exact path, grouped by what it will be allowed to do.
    pub fn message(&self) -> String {
        let mut sections = Vec::new();
        let mut section = |heading: &str, paths: &[String]| {
            if !paths.is_empty() {
                sections.push(format!("{heading}\n{}", paths.iter().map(|p| format!("• {p}")).collect::<Vec<_>>().join("\n")));
            }
        };
        section("Read and index as context (files are not changed):", &self.reads);
        section("Save new meeting files into this folder automatically:", &self.outputs);
        section("Add meeting notes to the end of this existing file automatically:", &self.appends);
        section("Import this ChatGPT export into the workspace (the file is not changed):", &self.imports);
        sections.join("\n\n")
    }
}

fn list(v: Option<&Value>, key: &str) -> Vec<String> {
    v.and_then(|v| v[key].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Which roots, output root and append targets `next` (already canonicalised) adds compared with the stored
/// `previous` workspace. Removing or keeping an entry grants nothing new.
pub fn new_grants(previous: Option<&Value>, next: &Value) -> GrantRequest {
    let added = |key: &str| {
        let before = list(previous, key);
        let mut out = Vec::new();
        for path in list(Some(next), key) {
            if !before.contains(&path) && !out.contains(&path) {
                out.push(path);
            }
        }
        out
    };
    let output = next["outputRoot"].as_str().filter(|p| previous.and_then(|w| w["outputRoot"].as_str()) != Some(*p));
    GrantRequest {
        reads: added("roots"),
        outputs: output.map(|p| vec![p.to_owned()]).unwrap_or_default(),
        appends: added("appendTargets"),
        imports: vec![],
    }
}

/// Whether approving a proposal needs the native sheet: only a rewrite of a file that exists. Additive appends
/// keep the existing text, and a new file (`missing:` version) replaces nothing; calendar changes have their own
/// review.
pub fn approval_needs_confirmation(operation: &str, target_version: &str) -> bool {
    operation == "rewrite" && !target_version.starts_with("missing:")
}

/// Uses up a recent native pick of `path` for `kind`. False (so the sheet shows) when there is none.
pub fn consume_pick(path: &str, kind: GrantKind) -> bool {
    crate::actions::ActionStore::open(&crate::commands::data_root())
        .and_then(|s| s.consume_picked(Path::new(path), kind.as_str(), PICKED_GRANT_TTL_MS))
        .unwrap_or(false)
}

/// Shows the native sheet and waits for the answer. `Ok(())` only when the person chose the grant button.
pub async fn confirm(app: &tauri::AppHandle, title: &str, message: String, accept: &str) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(accept.to_owned(), "Cancel".to_owned()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |ok| {
        let _ = tx.send(ok);
    });
    if rx.await.unwrap_or(false) {
        Ok(())
    } else {
        Err(GRANT_DECLINED.into())
    }
}

/// Confirms `request` after removing (and using up) paths natively picked for that same grant. Nothing to
/// confirm resolves immediately.
pub async fn confirm_request(app: &tauri::AppHandle, request: GrantRequest) -> Result<(), String> {
    let request = tokio::task::spawn_blocking(move || request.without_picked(consume_pick))
        .await
        .map_err(|_| "grantCheckFailed")?;
    if request.is_empty() {
        return Ok(());
    }
    confirm(app, "Allow Live Interview to use these files?", request.message(), "Allow").await
}

/// Opens the native picker for a path the person is about to grant and records the choice under that purpose,
/// so the save that follows does not ask again for it. The renderer only receives the canonical path.
#[tauri::command]
pub async fn pick_grant_path(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let purpose = GrantKind::from_pick(&kind).ok_or("invalidPickedTarget")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let send = move |path: Option<tauri_plugin_dialog::FilePath>| {
        let _ = tx.send(path);
    };
    let dialog = app.dialog().file();
    match purpose {
        GrantKind::Read => dialog.set_title("Choose a local folder to read as workspace context").pick_folder(send),
        GrantKind::Output => dialog.set_title("Choose where new meeting files may save automatically").pick_folder(send),
        GrantKind::Append => dialog
            .set_title("Enable automatic additive meeting notes to this exact existing Markdown file")
            .add_filter("Markdown notes", &["md", "markdown"])
            .pick_file(send),
        GrantKind::Import => dialog.add_filter("ChatGPT export", &["json", "zip"]).pick_file(send),
    }
    let Some(picked) = rx.await.map_err(|_| "pickFailed")? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "pickFailed")?;
    let recorded = tokio::task::spawn_blocking(move || {
        crate::actions::ActionStore::open(&crate::commands::data_root())
            .and_then(|s| s.record_picked(&path, purpose.as_str()))
    })
    .await
    .map_err(|_| "pickFailed")?
    .map_err(|_| "pickFailed")?;
    Ok(Some(recorded.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn workspace(roots: &[&str], output: Option<&str>, appends: &[&str]) -> Value {
        let mut w = json!({"id":"w","roots":roots,"appendTargets":appends});
        if let Some(o) = output {
            w["outputRoot"] = json!(o);
        }
        w
    }
    /// A stand-in for the pick table: each recorded (path, kind) can be used once.
    fn picks(entries: &[(&str, GrantKind)]) -> impl FnMut(&str, GrantKind) -> bool {
        let mut left: Vec<(String, GrantKind)> = entries.iter().map(|(p, k)| (p.to_string(), *k)).collect();
        move |path, kind| match left.iter().position(|(p, k)| p == path && *k == kind) {
            Some(i) => {
                left.remove(i);
                true
            }
            None => false,
        }
    }
    #[test]
    fn a_new_workspace_asks_for_every_entry() {
        let next = workspace(&["/a", "/b"], Some("/out"), &["/a/n.md"]);
        assert_eq!(
            new_grants(None, &next),
            GrantRequest {
                reads: vec!["/a".into(), "/b".into()],
                outputs: vec!["/out".into()],
                appends: vec!["/a/n.md".into()],
                imports: vec![]
            }
        );
    }
    #[test]
    fn an_unchanged_save_or_a_removal_asks_for_nothing() {
        let stored = workspace(&["/a", "/b"], Some("/out"), &["/a/n.md"]);
        assert!(new_grants(Some(&stored), &stored).is_empty());
        let reordered = workspace(&["/b", "/a"], Some("/out"), &["/a/n.md"]);
        assert!(new_grants(Some(&stored), &reordered).is_empty());
        let fewer = workspace(&["/a"], None, &[]);
        assert!(new_grants(Some(&stored), &fewer).is_empty());
    }
    #[test]
    fn only_the_added_entries_are_listed() {
        let stored = workspace(&["/a"], Some("/out"), &["/a/n.md"]);
        let next = workspace(&["/a", "/c"], Some("/other"), &["/a/n.md", "/a/m.md"]);
        assert_eq!(
            new_grants(Some(&stored), &next),
            GrantRequest {
                reads: vec!["/c".into()],
                outputs: vec!["/other".into()],
                appends: vec!["/a/m.md".into()],
                imports: vec![]
            }
        );
        // A first output root on an existing workspace is new.
        let no_output = workspace(&["/a"], None, &[]);
        assert_eq!(new_grants(Some(&no_output), &workspace(&["/a"], Some("/out"), &[])).outputs, vec!["/out".to_string()]);
    }
    #[test]
    fn natively_picked_entries_skip_the_sheet_for_their_own_grant_only() {
        let request = GrantRequest {
            reads: vec!["/picked".into(), "/typed".into()],
            outputs: vec!["/out".into()],
            appends: vec!["/n.md".into()],
            imports: vec!["/export.zip".into()],
        };
        let table = picks(&[
            ("/picked", GrantKind::Read),
            ("/out", GrantKind::Output),
            ("/n.md", GrantKind::Append),
            ("/export.zip", GrantKind::Import),
        ]);
        assert_eq!(request.without_picked(table), GrantRequest { reads: vec!["/typed".into()], ..Default::default() });
    }
    #[test]
    fn a_read_pick_submitted_as_the_output_folder_still_asks() {
        let request = GrantRequest { outputs: vec!["/project".into()], ..Default::default() };
        assert_eq!(
            request.clone().without_picked(picks(&[("/project", GrantKind::Read)])),
            request,
            "a read-only pick must not become a write grant without a sheet"
        );
        // Likewise an import pick does not cover an append to the same file, nor an append pick an import.
        let append = GrantRequest { appends: vec!["/f".into()], ..Default::default() };
        assert_eq!(append.clone().without_picked(picks(&[("/f", GrantKind::Import)])), append);
        let import = GrantRequest { imports: vec!["/f".into()], ..Default::default() };
        assert_eq!(import.clone().without_picked(picks(&[("/f", GrantKind::Append)])), import);
    }
    #[test]
    fn a_pick_is_used_once() {
        let mut table = picks(&[("/project", GrantKind::Read)]);
        let request = GrantRequest { reads: vec!["/project".into()], ..Default::default() };
        assert!(request.clone().without_picked(&mut table).is_empty());
        assert_eq!(request.clone().without_picked(&mut table), request, "reuse after consumption asks");
    }
    #[test]
    fn picker_purposes_map_to_distinct_kinds() {
        let kinds: Vec<_> = ["workspaceFolder", "outputFolder", "appendNote", "chatgptExport"]
            .iter()
            .map(|k| GrantKind::from_pick(k).unwrap().as_str())
            .collect();
        assert_eq!(kinds, ["grantRead", "grantOutput", "grantAppend", "grantImport"]);
        assert!(GrantKind::from_pick("file").is_none());
        assert!(GrantKind::Read.folder() && GrantKind::Output.folder());
        assert!(!GrantKind::Append.folder() && !GrantKind::Import.folder());
    }
    #[test]
    fn the_sheet_names_every_path_and_what_it_grants() {
        let text = GrantRequest { reads: vec!["/a".into()], appends: vec!["/a/n.md".into()], ..Default::default() }.message();
        assert!(text.contains("Read and index") && text.contains("• /a\n"));
        assert!(text.contains("end of this existing file") && text.contains("• /a/n.md"));
        assert!(!text.contains("Save new meeting files"));
        let import = GrantRequest { imports: vec!["/x.zip".into()], ..Default::default() }.message();
        assert!(import.contains("ChatGPT export") && import.contains("• /x.zip"));
    }
    #[test]
    fn only_rewrites_of_existing_files_need_a_sheet() {
        assert!(approval_needs_confirmation("rewrite", "3f2a"));
        assert!(!approval_needs_confirmation("rewrite", "missing:/tmp"));
        assert!(!approval_needs_confirmation("append", "3f2a"));
        assert!(!approval_needs_confirmation("linkRecord", "missing:/r"));
        assert!(!approval_needs_confirmation("calendarAdd", "x"));
    }
}
