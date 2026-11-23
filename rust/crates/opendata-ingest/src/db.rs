//! Writes, mirroring `packages/core/src/repository.ts`, including the privacy
//! guard: only records classifying as legal entities are written.
use crate::normalise::{address_label, match_key, normalise_postcode, parse_street_address};
use anyhow::Result;
use opendata_geo::privacy::{Classification, classify, parse_orgnr};
use opendata_geo::{LatLon, cell_of, in_sweden};
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct Report {
    pub written: u64,
    pub skipped_natural_persons: u64,
    pub skipped_invalid: u64,
}

impl Report {
    pub fn add(&mut self, other: Report) {
        self.written += other.written;
        self.skipped_natural_persons += other.skipped_natural_persons;
        self.skipped_invalid += other.skipped_invalid;
    }
}

#[derive(Debug, Default, Clone)]
pub struct Organisation {
    pub id: String,
    pub name: String,
    pub legal_form: Option<String>,
    pub legal_form_code: Option<String>,
    pub status: String,
    pub registered_at: Option<String>,
    pub deregistered_at: Option<String>,
    pub deregistration_reason: Option<String>,
    pub business_description: Option<String>,
    pub post_street: Option<String>,
    pub post_postcode: Option<String>,
    pub post_town: Option<String>,
    pub sni_primary: Option<String>,
    pub sni_codes: Option<Vec<String>>,
    pub ad_block: bool,
    pub source: String,
    pub source_date: String,
    pub jurform: Option<String>,
    pub bv_form: Option<String>,
    pub id_type: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Workplace {
    pub cfar: i64,
    pub orgnr: String,
    pub name: Option<String>,
    pub sni: Option<String>,
    pub sni_division: Option<String>,
    pub size_class: Option<String>,
    pub status: Option<String>,
    pub visit_street: Option<String>,
    pub visit_postcode: Option<String>,
    pub visit_town: Option<String>,
    pub kommun: Option<String>,
    pub lan: Option<String>,
    pub post_street: Option<String>,
    pub post_postcode: Option<String>,
    pub post_town: Option<String>,
    pub ad_block: bool,
    pub source_date: String,
    pub jurform: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Address {
    pub id: String,
    pub street: String,
    pub number: Option<String>,
    pub letter: Option<String>,
    pub postcode: Option<String>,
    pub town: Option<String>,
    pub kommun: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub deso: Option<String>,
    pub source_date: String,
}

const ORG_UPSERT: &str = "INSERT INTO organisation (orgnr, name, legal_form, legal_form_code, status, registered_at, deregistered_at,
  deregistration_reason, business_description, post_street, post_postcode, post_town, sni_primary, sni_codes, ad_block,
  sources, source_date, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(orgnr) DO UPDATE SET
  name = excluded.name,
  legal_form = COALESCE(excluded.legal_form, legal_form),
  legal_form_code = COALESCE(excluded.legal_form_code, legal_form_code),
  status = CASE WHEN excluded.status = 'unknown' THEN status ELSE excluded.status END,
  registered_at = COALESCE(excluded.registered_at, registered_at),
  deregistered_at = COALESCE(excluded.deregistered_at, deregistered_at),
  deregistration_reason = COALESCE(excluded.deregistration_reason, deregistration_reason),
  business_description = COALESCE(excluded.business_description, business_description),
  post_street = COALESCE(excluded.post_street, post_street),
  post_postcode = COALESCE(excluded.post_postcode, post_postcode),
  post_town = COALESCE(excluded.post_town, post_town),
  sni_primary = COALESCE(excluded.sni_primary, sni_primary),
  sni_codes = COALESCE(excluded.sni_codes, sni_codes),
  ad_block = MAX(excluded.ad_block, ad_block),
  sources = CASE WHEN instr(',' || sources || ',', ',' || excluded.sources || ',') > 0 THEN sources ELSE sources || ',' || excluded.sources END,
  source_date = MAX(excluded.source_date, source_date),
  updated_at = excluded.updated_at";

pub fn upsert_organisations(conn: &mut Connection, rows: &[Organisation]) -> Result<Report> {
    let mut report = Report::default();
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare_cached(ORG_UPSERT)?;
        let mut fts_del = tx.prepare_cached("DELETE FROM organisation_fts WHERE orgnr = ?1")?;
        let mut fts_ins = tx.prepare_cached("INSERT INTO organisation_fts (orgnr, name) SELECT orgnr, name FROM organisation WHERE orgnr = ?1")?;
        for r in rows {
            match classify(&r.id, r.jurform.as_deref(), r.bv_form.as_deref().or(r.legal_form_code.as_deref()), r.id_type.as_deref()) {
                Classification::Natural => {
                    report.skipped_natural_persons += 1;
                    continue;
                }
                Classification::Unknown => {
                    report.skipped_invalid += 1;
                    continue;
                }
                Classification::Legal => {}
            }
            let Some(orgnr) = parse_orgnr(&r.id) else {
                report.skipped_invalid += 1;
                continue;
            };
            let sni_codes = r.sni_codes.as_ref().map(|c| serde_json::to_string(c).unwrap());
            upsert.execute(params![
                orgnr,
                r.name,
                r.legal_form,
                r.legal_form_code,
                r.status,
                r.registered_at,
                r.deregistered_at,
                r.deregistration_reason,
                r.business_description,
                r.post_street,
                normalise_postcode(r.post_postcode.as_deref()),
                r.post_town,
                r.sni_primary,
                sni_codes,
                i64::from(r.ad_block),
                r.source,
                r.source_date
            ])?;
            fts_del.execute([&orgnr])?;
            fts_ins.execute([&orgnr])?;
            report.written += 1;
        }
    }
    tx.commit()?;
    Ok(report)
}

pub fn upsert_addresses(conn: &mut Connection, rows: &[Address]) -> Result<Report> {
    let mut report = Report::default();
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare_cached(
            "INSERT INTO address (address_id, street, number, letter, postcode, town, kommun, match_key, lat, lon, cell, deso, source_date)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
ON CONFLICT(address_id) DO UPDATE SET street = excluded.street, number = excluded.number, letter = excluded.letter,
  postcode = excluded.postcode, town = excluded.town, kommun = excluded.kommun, match_key = excluded.match_key, lat = excluded.lat,
  lon = excluded.lon, cell = excluded.cell, deso = COALESCE(excluded.deso, deso), source_date = excluded.source_date",
        )?;
        let mut fts_del = tx.prepare_cached("DELETE FROM address_fts WHERE address_id = ?1")?;
        let mut fts_ins = tx.prepare_cached("INSERT INTO address_fts (address_id, label) VALUES (?1, ?2)")?;
        for a in rows {
            let p = LatLon { lat: a.lat, lon: a.lon };
            if !in_sweden(p) || a.street.is_empty() {
                report.skipped_invalid += 1;
                continue;
            }
            let postcode = normalise_postcode(a.postcode.as_deref());
            let key = match_key(&a.street, a.number.as_deref(), a.letter.as_deref(), postcode.as_deref());
            upsert.execute(params![a.id, a.street, a.number, a.letter, postcode, a.town, a.kommun, key, a.lat, a.lon, cell_of(p), a.deso, a.source_date])?;
            let label = format!(
                "{} {}",
                address_label(&a.street, a.number.as_deref(), a.letter.as_deref(), postcode.as_deref(), a.town.as_deref()),
                postcode.as_deref().unwrap_or("")
            );
            fts_del.execute([&a.id])?;
            fts_ins.execute(params![a.id, label.trim()])?;
            report.written += 1;
        }
    }
    tx.commit()?;
    Ok(report)
}

struct Geo {
    id: String,
    lat: f64,
    lon: f64,
    cell: i64,
    quality: &'static str,
}

fn geocode(conn: &Connection, street: Option<&str>, postcode: Option<&str>) -> Result<Option<Geo>> {
    let Some(street) = street else { return Ok(None) };
    let parsed = parse_street_address(street);
    let (Some(number), Some(pc)) = (parsed.number.as_deref(), normalise_postcode(postcode)) else {
        return Ok(None);
    };
    let mut lookup = conn.prepare_cached("SELECT address_id, lat, lon, cell FROM address WHERE match_key = ?1 LIMIT 1")?;
    let mut find = |key: String, quality: &'static str| -> Result<Option<Geo>> {
        Ok(lookup.query_row([key], |r| Ok(Geo { id: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, cell: r.get(3)?, quality })).optional()?)
    };
    let exact = find(match_key(&parsed.street, Some(number), parsed.letter.as_deref(), Some(&pc)), "exact")?;
    if exact.is_some() || parsed.letter.is_none() {
        return Ok(exact);
    }
    let mut lookup2 = conn.prepare_cached("SELECT address_id, lat, lon, cell FROM address WHERE match_key = ?1 LIMIT 1")?;
    Ok(lookup2
        .query_row([match_key(&parsed.street, Some(number), None, Some(&pc))], |r| {
            Ok(Geo { id: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, cell: r.get(3)?, quality: "number" })
        })
        .optional()?)
}

pub fn upsert_workplaces(conn: &mut Connection, rows: &[Workplace]) -> Result<Report> {
    let mut report = Report::default();
    let tx = conn.transaction()?;
    {
        for w in rows {
            match classify(&w.orgnr, w.jurform.as_deref(), None, None) {
                Classification::Natural => {
                    report.skipped_natural_persons += 1;
                    continue;
                }
                Classification::Unknown => {
                    report.skipped_invalid += 1;
                    continue;
                }
                Classification::Legal => {}
            }
            let Some(orgnr) = parse_orgnr(&w.orgnr) else {
                report.skipped_invalid += 1;
                continue;
            };
            let geo = geocode(&tx, w.visit_street.as_deref(), w.visit_postcode.as_deref())?;
            let mut upsert = tx.prepare_cached(
                "INSERT INTO workplace (cfar, orgnr, name, sni, sni_division, size_class, status, visit_street, visit_postcode, visit_town,
  kommun, lan, post_street, post_postcode, post_town, address_id, lat, lon, cell, geocode_quality, ad_block, source_date)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
ON CONFLICT(cfar) DO UPDATE SET orgnr = excluded.orgnr, name = excluded.name, sni = excluded.sni, sni_division = excluded.sni_division,
  size_class = excluded.size_class, status = excluded.status, visit_street = excluded.visit_street, visit_postcode = excluded.visit_postcode,
  visit_town = excluded.visit_town, kommun = excluded.kommun, lan = excluded.lan, post_street = excluded.post_street,
  post_postcode = excluded.post_postcode, post_town = excluded.post_town, address_id = excluded.address_id, lat = excluded.lat,
  lon = excluded.lon, cell = excluded.cell, geocode_quality = excluded.geocode_quality, ad_block = excluded.ad_block,
  source_date = excluded.source_date",
            )?;
            upsert.execute(params![
                w.cfar,
                orgnr,
                w.name,
                w.sni,
                w.sni_division,
                w.size_class,
                w.status,
                w.visit_street,
                normalise_postcode(w.visit_postcode.as_deref()),
                w.visit_town,
                w.kommun,
                w.lan,
                w.post_street,
                normalise_postcode(w.post_postcode.as_deref()),
                w.post_town,
                geo.as_ref().map(|g| g.id.clone()),
                geo.as_ref().map(|g| g.lat),
                geo.as_ref().map(|g| g.lon),
                geo.as_ref().map(|g| g.cell),
                geo.as_ref().map_or("none", |g| g.quality),
                i64::from(w.ad_block),
                w.source_date
            ])?;
            report.written += 1;
        }
    }
    tx.commit()?;
    Ok(report)
}
