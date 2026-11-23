//! opendata-ingest build --out DIR [inputs...]
//!
//! Inputs (all optional, applied in this order):
//!   --addresses FILE.csv [--address-columns id=..,street=..,number=..,letter=..,postcode=..,town=..,kommun=..,n=..,e=..|lat=..,lon=..]
//!   --deso FILE.geojson                 SCB DeSO polygons (EPSG:3006 or 4326)
//!   --bolagsverket FILE(.zip)           Bolagsverket värdefulla datamängder bulk file
//!   --scb-bulk FILE(.zip)               SCB företagsregister bulk file
//!   --scb-legal-units FILE.jsonl        SCB API /juridiskaenheter rows (from `opendata ingest scb --dump`)
//!   --scb-workplaces FILE.jsonl         SCB API /arbetsstallen rows
//!   --source-date YYYY-MM-DD
//!
//! Output DIR gets opendata.sqlite, tables/*.ndjson and meta.json: the file
//! set of an `opendata` rbq snapshot (publish with `opendata-rbq publish`).
//! Natural persons are counted and dropped; nothing about them is written.
use anyhow::{Context, Result, bail};
use opendata_ingest::{db, deso, export, readers, schema};
use rusqlite::Connection;
use serde_json::json;
use std::path::PathBuf;

fn main() {
    if let Err(e) = run() {
        eprintln!("opendata-ingest: {e:#}");
        std::process::exit(2);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("build") {
        println!("{}", include_str!("main.rs").lines().take_while(|l| l.starts_with("//!")).map(|l| l.trim_start_matches("//!").trim_start_matches(' ')).collect::<Vec<_>>().join("\n"));
        return Ok(());
    }
    let mut flags = std::collections::HashMap::new();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let name = a.strip_prefix("--").with_context(|| format!("unexpected argument {a}"))?;
        let value = it.next().with_context(|| format!("--{name} needs a value"))?;
        flags.insert(name.to_string(), value.clone());
    }
    let known = ["out", "addresses", "address-columns", "deso", "bolagsverket", "scb-bulk", "scb-legal-units", "scb-workplaces", "source-date"];
    if let Some(k) = flags.keys().find(|k| !known.contains(&k.as_str())) {
        bail!("unknown option --{k}");
    }
    let out = PathBuf::from(flags.get("out").context("--out DIR is required")?);
    let date = flags.get("source-date").cloned().unwrap_or_else(|| "unknown".into());
    std::fs::create_dir_all(&out)?;
    let db_path = out.join("opendata.sqlite");
    if db_path.exists() {
        std::fs::remove_file(&db_path)?;
    }
    let mut conn = Connection::open(&db_path)?;
    conn.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")?;
    let migrations = schema::migrate(&conn)?;
    let mut summary = serde_json::Map::new();

    if let Some(path) = flags.get("addresses") {
        let cols = readers::AddressColumns::parse(flags.get("address-columns").map(String::as_str))?;
        let rows = readers::addresses(&readers::read_maybe_zip(path.as_ref())?, &cols, &date)?;
        summary.insert("addresses".into(), json!(db::upsert_addresses(&mut conn, &rows)?));
    }
    if let Some(path) = flags.get("deso") {
        let areas = deso::parse(&std::fs::read(path)?)?;
        deso::store(&mut conn, &areas)?;
        let assigned = deso::assign(&mut conn, &areas)?;
        summary.insert("deso".into(), json!({ "areas": areas.len(), "addresses_assigned": assigned }));
    }
    let mut orgs = db::Report::default();
    if let Some(path) = flags.get("bolagsverket") {
        orgs.add(db::upsert_organisations(&mut conn, &readers::bolagsverket(&readers::read_maybe_zip(path.as_ref())?, &date)?)?);
    }
    if let Some(path) = flags.get("scb-bulk") {
        orgs.add(db::upsert_organisations(&mut conn, &readers::scb_bulk(&readers::read_maybe_zip(path.as_ref())?, &date)?)?);
    }
    if let Some(path) = flags.get("scb-workplaces") {
        let legal = flags.get("scb-legal-units").map(std::fs::read).transpose()?;
        let (o, w) = readers::scb_api_jsonl(legal.as_deref(), &std::fs::read(path)?, &date)?;
        orgs.add(db::upsert_organisations(&mut conn, &o)?);
        summary.insert("workplaces".into(), json!(db::upsert_workplaces(&mut conn, &w)?));
    }
    summary.insert("organisations".into(), json!(orgs));
    conn.execute_batch("PRAGMA journal_mode = DELETE; ANALYZE;")?;
    let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        bail!("integrity check failed: {check}");
    }
    let rows = export::write(&conn, &out, &migrations)?;
    drop(conn);
    summary.insert("rows".into(), json!(rows));
    summary.insert("out".into(), json!(out));
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}
