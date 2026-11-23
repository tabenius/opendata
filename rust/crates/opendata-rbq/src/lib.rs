//! Publish and verify `opendata` snapshots with rebsync-core. Since
//! tabenius/rebsync#35, `opendata` is a registered external layer, so this
//! crate is a thin wrapper: it collects a directory's files and hands them to
//! rebsync's own publisher, loader, lister, reassembler and fsck.
#![forbid(unsafe_code)]
use anyhow::{Result, ensure};
use rebsync_core::layer::{self, PublishOutcome, SnapshotManifest, validate_relative_path};
use rebsync_core::storage::ObjectStorage;
use serde_json::Value;
use std::path::Path;

pub const LAYER: &str = "opendata";
pub const DEFAULT_CHUNK_BYTES: u64 = 65536;

/// Regular files below `dir`, as sorted relative `/` paths. Symlinks are refused.
pub fn files_of(dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            ensure!(!kind.is_symlink(), "refusing symlink {}", entry.path().display());
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                let rel = entry.path().strip_prefix(dir)?.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
                validate_relative_path(&rel)?;
                out.push(rel);
            }
        }
    }
    out.sort();
    ensure!(!out.is_empty(), "{} contains no files", dir.display());
    Ok(out)
}

/// Chunks first (create-if-absent, verified reuse), immutable manifest last.
pub fn publish_dir(storage: &dyn ObjectStorage, layer: &str, label: &str, dir: &Path, owner: Value, chunk_bytes: u64) -> Result<PublishOutcome> {
    ensure!(layer::is_known(layer), "unknown layer {layer:?}");
    layer::publish_files(storage, layer, label, chunk_bytes, dir, &files_of(dir)?, owner, None)
}

pub fn load(storage: &dyn ObjectStorage, layer: &str, id: &str) -> Result<SnapshotManifest> {
    layer::load(storage, layer, id)
}

pub fn list(storage: &dyn ObjectStorage, layer: &str, label: Option<&str>) -> Result<Vec<SnapshotManifest>> {
    layer::list(storage, layer, label)
}

/// Verify every chunk and whole-file digest by reassembling into a scratch directory.
pub fn verify(storage: &dyn ObjectStorage, manifest: &SnapshotManifest) -> Result<()> {
    let scratch = tempfile::tempdir()?;
    layer::assemble(storage, manifest, &scratch.path().join("out"))
}

pub fn assemble(storage: &dyn ObjectStorage, manifest: &SnapshotManifest, out: &Path) -> Result<()> {
    layer::assemble(storage, manifest, out)
}
