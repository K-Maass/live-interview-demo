//! Validate the complete app-owned parent chain immediately before host writes.
use std::{
    fs,
    path::{Path, PathBuf},
};
pub fn directory(root: &Path, parts: &[&str], create: bool) -> anyhow::Result<PathBuf> {
    if create {
        fs::create_dir_all(root)?;
    }
    anyhow::ensure!(
        !fs::symlink_metadata(root)?.file_type().is_symlink(),
        "unownedRoot"
    );
    let mut current = root.canonicalize()?;
    for part in parts {
        anyhow::ensure!(
            !part.is_empty()
                && Path::new(part).components().count() == 1
                && !matches!(*part, "." | ".."),
            "invalidOwnedPath"
        );
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => anyhow::ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "unownedDirectory"
            ),
            Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(current)
}
pub fn file(root: &Path, parts: &[&str], create_parents: bool) -> anyhow::Result<PathBuf> {
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| anyhow::anyhow!("invalidOwnedPath"))?;
    let parent = directory(root, parents, create_parents)?;
    anyhow::ensure!(
        Path::new(name).components().count() == 1 && !matches!(*name, "." | ".."),
        "invalidOwnedPath"
    );
    let path = parent.join(name);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "unownedFile"
        );
    }
    Ok(path)
}
