//! Bulk file readers. All produce plain records; classification and the
//! privacy guard happen in `db.rs`.
use crate::db::{Address, Organisation, Workplace};
use anyhow::{Context, Result, bail};
use opendata_geo::{LatLon, Sweref, sweref99tm_to_wgs84};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Largest input file (or unpacked zip entry) read into memory. National bulk
/// files are a few GiB; anything larger is refused rather than exhausting memory.
pub const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024 * 1024;

fn read_capped(reader: impl Read, what: &str, max: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    reader.take(max + 1).read_to_end(&mut out)?;
    if out.len() as u64 > max {
        bail!("{what} is larger than {max} bytes");
    }
    Ok(out)
}

/// Bytes of a file, or of the first non-directory entry if it is a .zip.
pub fn read_maybe_zip(path: &Path) -> Result<Vec<u8>> {
    read_maybe_zip_capped(path, MAX_INPUT_BYTES)
}

pub fn read_maybe_zip_capped(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let bytes = read_capped(file, &path.display().to_string(), max)?;
    if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        for i in 0..archive.len() {
            let entry = archive.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            // The declared size can lie; read_capped bounds what is actually inflated.
            let name = entry.name().to_string();
            return read_capped(entry, &format!("{} entry {name}", path.display()), max);
        }
        bail!("{} contains no files", path.display());
    }
    Ok(bytes)
}

fn header_index(headers: &csv::StringRecord) -> HashMap<String, usize> {
    headers.iter().enumerate().map(|(i, h)| (h.trim().trim_start_matches('\u{feff}').to_ascii_lowercase(), i)).collect()
}

fn field<'a>(rec: &'a csv::StringRecord, idx: &HashMap<String, usize>, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|n| idx.get(&n.to_ascii_lowercase()).and_then(|i| rec.get(*i)))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn opt(s: Option<&str>) -> Option<String> {
    s.map(str::to_string)
}

const LEGAL_FORMS: &[(&str, &str)] = &[
    ("AB", "Aktiebolag"),
    ("HB", "Handelsbolag"),
    ("KB", "Kommanditbolag"),
    ("EK", "Ekonomisk förening"),
    ("BRF", "Bostadsrättsförening"),
    ("BF", "Bostadsförening"),
    ("I", "Ideell förening"),
    ("S", "Stiftelse"),
    ("FL", "Filial"),
    ("E", "Enskild näringsidkare"),
    ("SF", "Sambruksförening"),
    ("TSF", "Trossamfund"),
];

/// Bolagsverket "Värdefulla datamängder" bulk file: ';' separated, '$' sub-fields, '|' repeats.
pub fn bolagsverket(bytes: &[u8], source_date: &str) -> Result<Vec<Organisation>> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b';')
        .escape(Some(b'\\'))
        .flexible(true)
        .from_reader(bytes);
    let idx = header_index(reader.headers()?);
    let mut out = Vec::new();
    for rec in reader.records() {
        let rec = rec?;
        let Some(identity) = field(&rec, &idx, &["organisationsidentitet"]) else { continue };
        let mut parts = identity.split('$');
        let id = parts.next().unwrap_or_default().to_string();
        let id_type = parts.next().map(str::to_string);
        let names = field(&rec, &idx, &["organisationsnamn"]).unwrap_or_default();
        let name = names
            .split('|')
            .find(|n| n.contains("FORETAGSNAMN"))
            .or_else(|| names.split('|').next())
            .and_then(|n| n.split('$').next())
            .unwrap_or_default()
            .trim()
            .to_string();
        let code = field(&rec, &idx, &["organisationsform"]).map(|f| f.trim_end_matches("-ORGFO").to_string());
        let legal_form = code.as_deref().and_then(|c| LEGAL_FORMS.iter().find(|(k, _)| *k == c).map(|(_, v)| (*v).to_string()));
        let dereg = opt(field(&rec, &idx, &["avregistreringsdatum"]));
        let (street, postcode, town) = postal(field(&rec, &idx, &["postadress"]).unwrap_or_default());
        out.push(Organisation {
            id,
            name,
            legal_form,
            bv_form: code.clone(),
            legal_form_code: code,
            status: if dereg.is_some() { "deregistered".into() } else { "active".into() },
            registered_at: opt(field(&rec, &idx, &["registreringsdatum"])),
            deregistration_reason: field(&rec, &idx, &["avregistreringsorsak"]).map(|r| r.trim_end_matches("-AVORG").to_string()),
            deregistered_at: dereg,
            business_description: opt(field(&rec, &idx, &["verksamhetsbeskrivning"])),
            post_street: street,
            post_postcode: postcode,
            post_town: town,
            source: "bolagsverket-hvd".into(),
            source_date: source_date.into(),
            id_type,
            ..Default::default()
        });
    }
    Ok(out)
}

/// "Box 7435$STOCKHOLM$10391$SE-LAND" -> (street, postcode, town).
pub fn postal(raw: &str) -> (Option<String>, Option<String>, Option<String>) {
    let parts: Vec<&str> = raw.split('$').map(str::trim).filter(|p| !p.is_empty() && *p != "SE-LAND").collect();
    let pc_at = parts.iter().position(|p| p.chars().filter(char::is_ascii_digit).count() == 5 && p.chars().all(|c| c.is_ascii_digit() || c == ' '));
    let postcode = pc_at.map(|i| parts[i].replace(' ', ""));
    let town = pc_at.and_then(|i| {
        let before = i.checked_sub(1).filter(|b| *b > 0).map(|b| parts[b]);
        before.or_else(|| parts.get(i + 1).copied())
    });
    (parts.first().filter(|_| pc_at != Some(0)).map(|s| s.to_string()), postcode, town.map(str::to_string))
}

/// SCB företagsregister bulk file: tab separated, ISO-8859-1.
pub fn scb_bulk(bytes: &[u8], source_date: &str) -> Result<Vec<Organisation>> {
    let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    let mut reader = csv::ReaderBuilder::new().delimiter(b'\t').quoting(false).flexible(true).from_reader(text.as_bytes());
    let idx = header_index(reader.headers()?);
    let mut out = Vec::new();
    for rec in reader.records() {
        let rec = rec?;
        let Some(id) = field(&rec, &idx, &["peorgnr"]) else { continue };
        let Some(name) = field(&rec, &idx, &["foretagsnamn", "namn"]) else { continue };
        let sni = field(&rec, &idx, &["ng1"]).map(|s| format!("{:0>5}", s));
        let sni_codes: Vec<String> = ["ng1", "ng2", "ng3", "ng4", "ng5"]
            .iter()
            .filter_map(|n| field(&rec, &idx, &[n]))
            .filter(|s| *s != "0" && *s != "00000")
            .map(|s| format!("{:0>5}", s))
            .collect();
        out.push(Organisation {
            id: id.to_string(),
            name: name.to_string(),
            jurform: opt(field(&rec, &idx, &["jurform"])),
            status: match field(&rec, &idx, &["jestat"]) {
                Some("1") => "active".into(),
                Some("9") => "inactive".into(),
                _ => "unknown".into(),
            },
            post_street: opt(field(&rec, &idx, &["gatuadress"])),
            post_postcode: opt(field(&rec, &idx, &["postnr"])),
            post_town: opt(field(&rec, &idx, &["postort"])),
            sni_primary: sni.filter(|s| s != "00000"),
            sni_codes: (!sni_codes.is_empty()).then_some(sni_codes),
            ad_block: field(&rec, &idx, &["reklamsparrtyp", "reklamsparr"]) == Some("2"),
            source: "scb-fr".into(),
            source_date: source_date.into(),
            ..Default::default()
        });
    }
    Ok(out)
}

/// Column mapping for address CSVs exported from Lantmäteriet's Belägenhetsadress
/// (e.g. `ogr2ogr -f CSV`): our names -> the file's names.
#[derive(Debug, Clone)]
pub struct AddressColumns(pub HashMap<String, String>);

impl AddressColumns {
    pub fn parse(spec: Option<&str>) -> Result<Self> {
        let mut map: HashMap<String, String> = ["id", "street", "number", "letter", "postcode", "town", "kommun", "n", "e", "lat", "lon"]
            .iter()
            .map(|k| ((*k).to_string(), (*k).to_string()))
            .collect();
        for pair in spec.unwrap_or("").split(',').filter(|s| !s.is_empty()) {
            let (k, v) = pair.split_once('=').context("address column spec is key=column,...")?;
            if !map.contains_key(k) {
                bail!("unknown address column key {k}");
            }
            map.insert(k.to_string(), v.to_string());
        }
        Ok(Self(map))
    }
    fn get(&self, k: &str) -> &str {
        &self.0[k]
    }
}

pub fn addresses(bytes: &[u8], columns: &AddressColumns, source_date: &str) -> Result<Vec<Address>> {
    let first_line = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
    let delimiter = if first_line.contains(&b';') { b';' } else { b',' };
    let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).flexible(true).from_reader(bytes);
    let idx = header_index(reader.headers()?);
    let col = |rec: &csv::StringRecord, k: &str| field(rec, &idx, &[columns.get(k)]).map(str::to_string);
    let mut out = Vec::new();
    for rec in reader.records() {
        let rec = rec?;
        let (Some(id), Some(street)) = (col(&rec, "id"), col(&rec, "street")) else { continue };
        let num = |k: &str| col(&rec, k).and_then(|v| v.replace(',', ".").parse::<f64>().ok());
        let point = match (num("lat"), num("lon"), num("n"), num("e")) {
            (Some(lat), Some(lon), _, _) => LatLon { lat, lon },
            (_, _, Some(n), Some(e)) => sweref99tm_to_wgs84(Sweref { n, e }),
            _ => continue,
        };
        out.push(Address {
            id,
            street,
            number: col(&rec, "number"),
            letter: col(&rec, "letter"),
            postcode: col(&rec, "postcode"),
            town: col(&rec, "town"),
            kommun: col(&rec, "kommun"),
            lat: point.lat,
            lon: point.lon,
            deso: None,
            source_date: source_date.into(),
        });
    }
    Ok(out)
}

/// SCB API dumps: JSON Lines of `/juridiskaenheter` rows and `/arbetsstallen` rows.
pub fn scb_api_jsonl(legal_units: Option<&[u8]>, workplaces: &[u8], source_date: &str) -> Result<(Vec<Organisation>, Vec<Workplace>)> {
    use serde_json::Value;
    let s = |v: &Value| -> Option<String> {
        match v {
            Value::Null => None,
            Value::String(s) if s.trim().is_empty() => None,
            Value::String(s) => Some(s.trim().to_string()),
            other => Some(other.to_string()),
        }
    };
    let mut jurform: HashMap<String, Option<String>> = HashMap::new();
    let mut orgs = Vec::new();
    for line in legal_units.unwrap_or_default().split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_slice(line)?;
        let Some(id) = s(&v["peOrgNr"]) else { continue };
        let jf = s(&v["jurform"]);
        jurform.insert(id.clone(), jf.clone());
        let name = match &v["namn"] {
            Value::Object(o) => o.get("namn").and_then(&s),
            other => s(other),
        };
        if let Some(name) = name {
            orgs.push(Organisation {
                id,
                name,
                jurform: jf,
                status: match s(&v["jeStat"]).as_deref() {
                    Some("1") => "active".into(),
                    Some("9") => "inactive".into(),
                    _ => "unknown".into(),
                },
                post_street: s(&v["postAdress"]["gatuAdress"]),
                post_postcode: s(&v["postAdress"]["postNr"]),
                post_town: s(&v["postAdress"]["postOrt"]),
                ad_block: s(&v["reklamSparrTyp"]).as_deref() == Some("2"),
                source: "scb-fr".into(),
                source_date: source_date.into(),
                ..Default::default()
            });
        }
    }
    let mut wps = Vec::new();
    for line in workplaces.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_slice(line)?;
        let (Some(cfar), Some(orgnr)) = (v["cfarNr"].as_i64(), s(&v["peOrgNr"])) else { continue };
        let b = &v["belagenhetsadress"];
        let p = &v["postAdress"];
        wps.push(Workplace {
            cfar,
            jurform: jurform.get(&orgnr).cloned().flatten(),
            orgnr,
            name: s(&v["ben"]),
            sni: s(&v["primarNaringsgren"]["naringsgren"]),
            sni_division: s(&v["primarNaringsgren"]["avdelningsKod"]),
            size_class: s(&v["anstKl"]),
            status: s(&v["aeStat"]),
            visit_street: s(&b["bGatuAdress"]),
            visit_postcode: s(&b["bPostNr"]),
            visit_town: s(&b["bPostOrt"]),
            kommun: s(&b["kommun"]),
            lan: s(&b["lan"]),
            post_street: s(&p["gatuAdress"]),
            post_postcode: s(&p["postNr"]),
            post_town: s(&p["postOrt"]),
            ad_block: s(&v["reklamSparrTyp"]).as_deref() == Some("2"),
            source_date: source_date.into(),
        });
    }
    Ok((orgs, wps))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_inflated_zip_entries() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bomb.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file("big.csv", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&vec![b'a'; 1_000_000]).unwrap();
        zip.finish().unwrap();
        assert!(read_maybe_zip_capped(&path, 10_000).unwrap_err().to_string().contains("larger than"));
        assert_eq!(read_maybe_zip_capped(&path, 2_000_000).unwrap().len(), 1_000_000);
    }

    #[test]
    fn parses_postal_addresses() {
        assert_eq!(postal("Box 7435$STOCKHOLM$10391$SE-LAND"), (Some("Box 7435".into()), Some("10391".into()), Some("STOCKHOLM".into())));
        assert_eq!(postal("Stampgatan 13$$GÖTEBORG$41664"), (Some("Stampgatan 13".into()), Some("41664".into()), Some("GÖTEBORG".into())));
        assert_eq!(postal(""), (None, None, None));
    }

    #[test]
    fn reads_bolagsverket_bulk() {
        let text = "organisationsidentitet;namnskyddslopnummer;registreringsland;organisationsnamn;organisationsform;avregistreringsdatum;avregistreringsorsak;pagandeAvvecklingsEllerOmstruktureringsforfarande;registreringsdatum;verksamhetsbeskrivning;postadress\n\
5560360793$ORGNR-IDORG;;SE-LAND;Testbolaget AB$FORETAGSNAMN-ORGNAM$2001-01-01|Test Co$FORNAMN_FRSPRAK-ORGNAM$2002-01-01;AB-ORGFO;;;;2001-01-01;\"Konsult; med \\\"citat\\\"\";Box 1$GÖTEBORG$41101$SE-LAND\n\
8506121238$PERSON-IDORG;1;SE-LAND;Anna Konsult$FORETAGSNAMN-ORGNAM$2010-01-01;E-ORGFO;;;;2010-01-01;;\n";
        let orgs = bolagsverket(text.as_bytes(), "2026-11-23").unwrap();
        assert_eq!(orgs.len(), 2);
        assert_eq!(orgs[0].name, "Testbolaget AB");
        assert_eq!(orgs[0].legal_form.as_deref(), Some("Aktiebolag"));
        assert_eq!(orgs[0].business_description.as_deref(), Some("Konsult; med \"citat\""));
        assert_eq!(orgs[0].post_postcode.as_deref(), Some("41101"));
        assert_eq!(orgs[1].id_type.as_deref(), Some("PERSON-IDORG"));
    }

    #[test]
    fn reads_scb_bulk_in_latin1() {
        let mut bytes = b"PeOrgNr\tForetagsnamn\tJurForm\tGatuadress\tPostNr\tPostOrt\tNg1\tJEStat\n5560360793\tK".to_vec();
        bytes.push(0xe5); // å in ISO-8859-1
        bytes.extend_from_slice(b"llan AB\t49\tGatan 1\t41101\tG\t62010\t1\n195006121234\tPerson\t10\t\t\t\t\t1\n");
        let orgs = scb_bulk(&bytes, "2026-11-23").unwrap();
        assert_eq!(orgs[0].name, "Kållan AB");
        assert_eq!(orgs[0].sni_primary.as_deref(), Some("62010"));
        assert_eq!(orgs[1].jurform.as_deref(), Some("10"));
    }

    #[test]
    fn reads_address_csv_in_sweref() {
        let csv = "objid;gata;nr;bokst;postnr;ort;kom;N;E\nA1;Kaffegatan;1;B;41160;GÖTEBORG;1480;6400157.67;319285.04\n";
        let cols = AddressColumns::parse(Some("id=objid,street=gata,number=nr,letter=bokst,postcode=postnr,town=ort,kommun=kom,n=N,e=E")).unwrap();
        let rows = addresses(csv.as_bytes(), &cols, "2026-11-23").unwrap();
        assert!((rows[0].lat - 57.7072).abs() < 1e-6 && (rows[0].lon - 11.9668).abs() < 1e-6);
        assert_eq!(rows[0].letter.as_deref(), Some("B"));
    }
}
