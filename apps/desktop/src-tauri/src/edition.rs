use std::path::{Path, PathBuf};
pub const fn is_public() -> bool {
    cfg!(feature = "public")
}
pub const fn keychain_service() -> &'static str {
    if is_public() {
        "com.karim.liveinterview.public"
    } else {
        "com.karim.liveinterview.dev"
    }
}
pub fn data_root_for_home(home: &Path) -> PathBuf {
    home.join("Library/Application Support")
        .join(if is_public() {
            "LiveInterview"
        } else {
            "LiveInterviewDev"
        })
}
pub fn data_root() -> PathBuf {
    data_root_for_home(&PathBuf::from(std::env::var_os("HOME").unwrap_or_default()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_storage_is_separate_from_the_installed_local_app() {
        let home = std::path::Path::new("/Users/example");
        let root = data_root_for_home(home);
        assert_eq!(root, home.join("Library/Application Support/LiveInterview"));
        assert!(!root.ends_with("LiveInterviewDev"));
    }
    #[test]
    fn public_keychain_is_not_a_private_provider_service() {
        assert_eq!(keychain_service(), "com.karim.liveinterview.public");
    }
}
