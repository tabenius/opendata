//! Our writer produces exactly what rebsync-core's own reader accepts.
use opendata_rbq::{list, load, publish_dir, verify};
use rebsync_core::layer;
use rebsync_core::storage::FsObjectStorage;
use serde_json::json;

fn sample(dir: &std::path::Path) {
    std::fs::create_dir_all(dir.join("tables")).unwrap();
    let big: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    std::fs::write(dir.join("tables/organisation.ndjson"), &big).unwrap();
    std::fs::write(dir.join("meta.json"), br#"{"schema":"opendata.snapshot.v1"}"#).unwrap();
}

#[test]
fn rebsync_reader_accepts_our_snapshots() {
    let tmp = tempfile::tempdir().unwrap();
    let storage = FsObjectStorage::open(tmp.path().join("store")).unwrap();
    sample(&tmp.path().join("in"));
    // "agenda" is one of rebsync's layers, so rebsync-core's full reader path applies.
    let out = publish_dir(&storage, "agenda", "local", &tmp.path().join("in"), json!({"migration":{"status":"current"}}), 65536, chrono::Utc::now()).unwrap();
    let manifest = layer::load(&storage, "agenda", &out.id).unwrap();
    assert_eq!(manifest.files.len(), 2);
    layer::assemble(&storage, &manifest, &tmp.path().join("assembled")).unwrap();
    assert_eq!(std::fs::read(tmp.path().join("assembled/tables/organisation.ndjson")).unwrap(), std::fs::read(tmp.path().join("in/tables/organisation.ndjson")).unwrap());
    let report = layer::fsck(&storage, &["agenda"]).unwrap();
    assert_eq!((report.snapshots_checked, report.snapshots_ok, report.failures.len()), (1, 1, 0));
}

#[test]
fn opendata_layer_publishes_reuses_and_verifies() {
    let tmp = tempfile::tempdir().unwrap();
    let storage = FsObjectStorage::open(tmp.path().join("store")).unwrap();
    sample(&tmp.path().join("in"));
    let first = publish_dir(&storage, "opendata", "local", &tmp.path().join("in"), json!({}), 65536, chrono::Utc::now()).unwrap();
    let second = publish_dir(&storage, "opendata", "local", &tmp.path().join("in"), json!({}), 65536, chrono::Utc::now() + chrono::Duration::seconds(1)).unwrap();
    assert_eq!(second.new_chunks, 0);
    assert_eq!(first.digest, second.digest);
    assert_eq!(list(&storage, "opendata", Some("local")).unwrap().len(), 2);
    verify(&storage, &load(&storage, "opendata", &first.id).unwrap()).unwrap();
    assert!(publish_dir(&storage, "nope", "local", &tmp.path().join("in"), json!({}), 65536, chrono::Utc::now()).is_err());
}
