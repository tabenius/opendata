//! opendata snapshots go through rebsync-core's own publisher and readers.
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
fn opendata_is_a_registered_rbq_layer() {
    let tmp = tempfile::tempdir().unwrap();
    let storage = FsObjectStorage::open(tmp.path().join("store")).unwrap();
    sample(&tmp.path().join("in"));
    let out = publish_dir(&storage, "opendata", "local", &tmp.path().join("in"), json!({"migration":{"status":"current"}}), 65536).unwrap();
    // rebsync-core's reader, reassembly and fsck accept it directly.
    let manifest = layer::load(&storage, "opendata", &out.id).unwrap();
    assert_eq!(manifest.files.len(), 2);
    layer::assemble(&storage, &manifest, &tmp.path().join("assembled")).unwrap();
    assert_eq!(
        std::fs::read(tmp.path().join("assembled/tables/organisation.ndjson")).unwrap(),
        std::fs::read(tmp.path().join("in/tables/organisation.ndjson")).unwrap()
    );
    let report = layer::fsck(&storage, &["opendata"]).unwrap();
    assert_eq!((report.snapshots_checked, report.snapshots_ok, report.failures.len()), (1, 1, 0));
}

#[test]
fn republishing_reuses_chunks_and_unknown_layers_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let storage = FsObjectStorage::open(tmp.path().join("store")).unwrap();
    sample(&tmp.path().join("in"));
    let first = publish_dir(&storage, "opendata", "local", &tmp.path().join("in"), json!({}), 65536).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = publish_dir(&storage, "opendata", "local", &tmp.path().join("in"), json!({}), 65536).unwrap();
    assert_eq!(second.new_chunks, 0);
    assert_eq!(first.digest, second.digest);
    assert_eq!(list(&storage, "opendata", Some("local")).unwrap().len(), 2);
    verify(&storage, &load(&storage, "opendata", &first.id).unwrap()).unwrap();
    assert!(publish_dir(&storage, "messages", "local", &tmp.path().join("in"), json!({}), 65536).is_err());
}
