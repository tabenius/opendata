//! Publish and verify `opendata` (and `messages`) snapshots in rbq's layer
//! format, reusing rebsync-core for storage, chunking, manifest types,
//! validation and reassembly. Only the layer allow-list differs: rebsync-core
//! hard-codes its own four layers (see doc/RBQ-COMPAT.md §7), so manifest keys
//! and listing for our layers are computed here.
#![forbid(unsafe_code)]
use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Utc};
use rebsync_core::layer::{
    self, LayerFile, SNAPSHOT_SCHEMA, SnapshotManifest, check_manifest, chunk_file, validate_label, validate_relative_path,
};
use rebsync_core::storage::{ObjectKey, ObjectStorage, PutOutcome};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const LAYERS: &[&str] = &["opendata", "messages"];
pub const DEFAULT_CHUNK_BYTES: u64 = 65536;

fn validate_layer(layer: &str) -> Result<()> {
    ensure!(LAYERS.contains(&layer) || layer::LAYERS.contains(&layer), "unknown layer {layer:?}");
    Ok(())
}

pub fn content_digest(files: &[LayerFile]) -> String {
    let mut lines: Vec<String> = files.iter().map(|f| format!("{}\0{}\n", f.path, f.sha256)).collect();
    lines.sort();
    format!("{:x}", Sha256::digest(lines.concat().as_bytes()))
}

pub fn manifest_key(layer: &str, id: &str) -> Result<ObjectKey> {
    validate_layer(layer)?;
    let (label, name) = id.split_once('/').context("snapshot id must be <label>/<name>")?;
    validate_label(label)?;
    ensure!(!name.is_empty() && !name.contains('/'), "snapshot id must be <label>/<name>");
    Ok(ObjectKey::parse(&format!("{layer}/v1/snapshots/{label}/{name}.json"))?)
}

/// Regular files below `dir`, as sorted relative `/` paths. Symlinks are refused.
fn walk(dir: &Path) -> Result<Vec<(PathBuf, String)>> {
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
                out.push((entry.path(), rel));
            }
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

#[derive(Debug, serde::Serialize)]
pub struct Published {
    pub layer: String,
    pub id: String,
    pub manifest_key: String,
    pub digest: String,
    pub files: usize,
    pub bytes: u64,
    pub new_chunks: usize,
    pub reused_chunks: usize,
}

/// Chunks first (create-if-absent, verified reuse), immutable manifest last.
pub fn publish_dir(storage: &dyn ObjectStorage, layer: &str, label: &str, dir: &Path, owner: Value, chunk_bytes: u64, now: DateTime<Utc>) -> Result<Published> {
    validate_layer(layer)?;
    validate_label(label)?;
    ensure!((4096..=64 * 1024 * 1024).contains(&chunk_bytes) && chunk_bytes.is_multiple_of(4096), "chunk_bytes must be a multiple of 4096 in 4 KiB..64 MiB");
    let prefix = format!("{layer}/v1");
    let mut files = Vec::new();
    let (mut new_chunks, mut total_chunks) = (0, 0);
    for (path, rel) in walk(dir)? {
        let (file, new, _) = chunk_file(storage, &prefix, &path, &rel, chunk_bytes)?;
        new_chunks += new;
        total_chunks += file.chunks.len();
        files.push(file);
    }
    ensure!(!files.is_empty(), "{} contains no files", dir.display());
    let digest = content_digest(&files);
    let id = format!("{label}/{}-{}", now.format("%Y%m%dT%H%M%S%.3fZ"), &digest[..12]);
    let manifest = SnapshotManifest {
        schema: SNAPSHOT_SCHEMA.into(),
        layer: layer.into(),
        id: id.clone(),
        label: label.into(),
        created_at: now,
        run_id: None,
        chunk_bytes,
        digest: digest.clone(),
        files,
        owner,
    };
    check_manifest(&manifest, layer, &id)?;
    let key = manifest_key(layer, &id)?;
    match storage.put_if_absent(&key, &serde_json::to_vec_pretty(&manifest)?)? {
        PutOutcome::Created(_) => {}
        PutOutcome::AlreadyExists(_) => bail!("manifest {key} already exists; not overwriting"),
    }
    Ok(Published {
        layer: layer.into(),
        id,
        manifest_key: key.as_str().into(),
        digest,
        files: manifest.files.len(),
        bytes: manifest.bytes(),
        new_chunks,
        reused_chunks: total_chunks - new_chunks,
    })
}

pub fn load(storage: &dyn ObjectStorage, layer: &str, id: &str) -> Result<SnapshotManifest> {
    let key = manifest_key(layer, id)?;
    let manifest: SnapshotManifest = serde_json::from_slice(&storage.get(&key)?).with_context(|| format!("unreadable manifest {key}"))?;
    check_manifest(&manifest, layer, id)?;
    Ok(manifest)
}

pub fn list(storage: &dyn ObjectStorage, layer: &str, label: Option<&str>) -> Result<Vec<SnapshotManifest>> {
    validate_layer(layer)?;
    let base = format!("{layer}/v1/snapshots/");
    let wanted = match label {
        Some(l) => {
            validate_label(l)?;
            format!("{base}{l}/")
        }
        None => base.clone(),
    };
    let mut found = Vec::new();
    for meta in storage.list_prefix(&wanted, 0)? {
        if let Some(id) = meta.key.strip_prefix(&base).and_then(|r| r.strip_suffix(".json")) {
            found.push(load(storage, layer, id)?);
        }
    }
    found.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(found)
}

/// Verify every chunk and whole-file digest by reassembling into a scratch directory.
pub fn verify(storage: &dyn ObjectStorage, manifest: &SnapshotManifest) -> Result<()> {
    let scratch = tempfile::tempdir()?;
    layer::assemble(storage, manifest, &scratch.path().join("out"))
}

pub fn assemble(storage: &dyn ObjectStorage, manifest: &SnapshotManifest, out: &Path) -> Result<()> {
    layer::assemble(storage, manifest, out)
}
