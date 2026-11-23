//! opendata-rbq — rbq-format snapshots for opendata.
//!
//!   opendata-rbq publish --storage-root DIR --dir SNAPSHOT_DIR [--layer opendata] [--label local] [--chunk-bytes 65536]
//!   opendata-rbq list    --storage-root DIR [--layer opendata] [--label L]
//!   opendata-rbq verify  --storage-root DIR --id LABEL/NAME [--layer opendata]
//!   opendata-rbq fsck    --storage-root DIR [--layer opendata]
//!   opendata-rbq pull    --storage-root DIR --id LABEL/NAME --out DIR [--layer opendata]
//!
//! The storage root is an rbq object store (rebsync-core FsObjectStorage), the
//! same layout `@opendata/adapters-object/fs` writes.
use anyhow::{Context, Result, bail};
use opendata_rbq::{DEFAULT_CHUNK_BYTES, assemble, list, load, publish_dir, verify};
use rebsync_core::storage::FsObjectStorage;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;

fn main() {
    if let Err(e) = run() {
        eprintln!("opendata-rbq: {e:#}");
        std::process::exit(2);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        println!("{}", include_str!("main.rs").lines().take_while(|l| l.starts_with("//!")).map(|l| l.trim_start_matches("//!").trim_start_matches(' ')).collect::<Vec<_>>().join("\n"));
        return Ok(());
    };
    let rest: Vec<String> = args.collect();
    let mut flags = HashMap::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let name = a.strip_prefix("--").with_context(|| format!("unexpected argument {a}"))?;
        flags.insert(name.to_string(), it.next().with_context(|| format!("--{name} needs a value"))?.clone());
    }
    let root = flags.get("storage-root").context("--storage-root is required")?;
    let storage = FsObjectStorage::open(root)?;
    let layer = flags.get("layer").map_or("opendata", String::as_str);
    match command.as_str() {
        "publish" => {
            let dir = PathBuf::from(flags.get("dir").context("--dir is required")?);
            let owner = match std::fs::read(dir.join("meta.json")) {
                Ok(bytes) => {
                    let meta: serde_json::Value = serde_json::from_slice(&bytes)?;
                    json!({ "migration": { "status": "current" }, "schema": meta["schema"], "migrations": meta["migrations"], "rows": meta["rows"] })
                }
                Err(_) => json!({ "migration": { "status": "current" } }),
            };
            let chunk = flags.get("chunk-bytes").map(|c| c.parse()).transpose()?.unwrap_or(DEFAULT_CHUNK_BYTES);
            let out = publish_dir(&storage, layer, flags.get("label").map_or("local", String::as_str), &dir, owner, chunk)?;
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        "list" => {
            let all = list(&storage, layer, flags.get("label").map(String::as_str))?;
            let rows: Vec<_> = all.iter().map(|m| json!({ "id": m.id, "created_at": m.created_at, "files": m.files.len(), "bytes": m.bytes(), "digest": m.digest })).collect();
            println!("{}", serde_json::to_string_pretty(&rows)?);
        }
        "verify" => {
            let id = flags.get("id").context("--id is required")?;
            verify(&storage, &load(&storage, layer, id)?)?;
            println!("{}", json!({ "ok": true, "id": id }));
        }
        "pull" => {
            let id = flags.get("id").context("--id is required")?;
            let out = PathBuf::from(flags.get("out").context("--out is required")?);
            assemble(&storage, &load(&storage, layer, id)?, &out)?;
            println!("{}", json!({ "ok": true, "id": id, "out": out }));
        }
        "fsck" => {
            let report = rebsync_core::layer::fsck(&storage, &[layer])?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.failures.is_empty() {
                std::process::exit(2);
            }
        }
        other => bail!("unknown command {other}"),
    }
    Ok(())
}
