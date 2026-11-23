//! The SQL schema, from `packages/schema/generated/migrations.json` (TypeScript is the source).
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Deserialize;

#[derive(Deserialize)]
struct Migration {
    id: String,
    sql: String,
    checksum: String,
}

/// FNV-1a 64, as `packages/adapters-sql/src/hash.ts`.
pub fn checksum(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn migrate(conn: &Connection) -> Result<Vec<String>> {
    let migrations: Vec<Migration> = serde_json::from_str(include_str!("../../../../packages/schema/generated/migrations.json"))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);")?;
    let mut ids = Vec::new();
    for m in migrations {
        if checksum(&m.sql) != m.checksum {
            bail!("generated migration {} has a stale checksum; run `pnpm gen`", m.id);
        }
        let existing: Option<String> = conn
            .query_row("SELECT checksum FROM schema_migrations WHERE id = ?1", [&m.id], |r| r.get(0))
            .ok();
        match existing {
            Some(c) if c != m.checksum => bail!("migration {} changed after it was applied", m.id),
            Some(_) => {}
            None => {
                conn.execute_batch(&m.sql)?;
                conn.execute(
                    "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    [&m.id, &m.checksum],
                )?;
            }
        }
        ids.push(m.id);
    }
    Ok(ids)
}
