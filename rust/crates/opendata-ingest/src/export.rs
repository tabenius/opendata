//! Snapshot table files, the same format `packages/core/src/snapshot.ts` writes and imports.
use anyhow::Result;
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

#[derive(Deserialize)]
struct Table {
    name: String,
    pk: Vec<String>,
    columns: Vec<String>,
}

fn tables() -> Vec<Table> {
    let v: Value = serde_json::from_str(include_str!("../../../../contracts/vectors/core.json")).unwrap();
    serde_json::from_value(v["tables"].clone()).unwrap()
}

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Write `tables/<t>.ndjson` and `meta.json` under `dir`. Returns row counts.
pub fn write(conn: &Connection, dir: &Path, migrations: &[String]) -> Result<BTreeMap<String, u64>> {
    fs::create_dir_all(dir.join("tables"))?;
    let mut rows = BTreeMap::new();
    for t in tables() {
        let mut out = std::io::BufWriter::new(fs::File::create(dir.join("tables").join(format!("{}.ndjson", t.name)))?);
        let mut stmt = conn.prepare(&format!("SELECT {} FROM {} ORDER BY {}", t.columns.join(", "), t.name, t.pk.join(", ")))?;
        let mut q = stmt.query([])?;
        let mut n = 0u64;
        while let Some(r) = q.next()? {
            let mut obj = Map::new();
            for (i, c) in t.columns.iter().enumerate() {
                obj.insert(c.clone(), to_json(r.get_ref(i)?));
            }
            serde_json::to_writer(&mut out, &Value::Object(obj))?;
            out.write_all(b"\n")?;
            n += 1;
        }
        out.flush()?;
        rows.insert(t.name, n);
    }
    let meta = json!({ "schema": "opendata.snapshot.v1", "migrations": migrations, "rows": rows, "created_by": "opendata-ingest" });
    fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
    Ok(rows)
}
