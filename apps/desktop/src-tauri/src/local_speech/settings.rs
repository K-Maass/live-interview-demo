//! Speech settings kept beside the models. Whisper medium translation is experimental (#29), so it stays off
//! unless the user turns it on; Apple on-device translation is the supported route.
use serde_json::{json, Value};
use std::path::Path;

const FILE: &str = "speech-settings.json";

pub fn experimental_medium_translation(root: &Path) -> bool {
    std::fs::read(root.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["experimentalMediumTranslation"].as_bool())
        .unwrap_or(false)
}

pub fn set_experimental_medium_translation(root: &Path, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let temporary = root.join(format!("{FILE}.tmp"));
    std::fs::write(
        &temporary,
        json!({"experimentalMediumTranslation": enabled}).to_string(),
    )?;
    std::fs::rename(temporary, root.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("li-speech-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn medium_translation_is_off_until_the_user_turns_it_on() {
        let root = scratch("default");
        assert!(!experimental_medium_translation(&root));
        set_experimental_medium_translation(&root, true).unwrap();
        assert!(experimental_medium_translation(&root));
        set_experimental_medium_translation(&root, false).unwrap();
        assert!(!experimental_medium_translation(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreadable_or_malformed_settings_keep_the_experiment_off() {
        let root = scratch("malformed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(FILE), "{not json").unwrap();
        assert!(!experimental_medium_translation(&root));
        std::fs::write(root.join(FILE), r#"{"experimentalMediumTranslation":"yes"}"#).unwrap();
        assert!(!experimental_medium_translation(&root));
        let _ = std::fs::remove_dir_all(&root);
    }
}
