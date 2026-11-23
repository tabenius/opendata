//! DeSO areas from GeoJSON (SCB DeSO converted with ogr2ogr; EPSG:3006 or 4326),
//! stored with WGS 84 geometry, and assignment of addresses to areas.
use anyhow::{Context, Result};
use opendata_geo::{LatLon, Sweref, sweref99tm_to_wgs84};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashMap;

pub struct Area {
    pub deso: String,
    pub regso: Option<String>,
    pub kommun: Option<String>,
    pub name: Option<String>,
    /// Polygons as lists of rings of [lon, lat].
    pub polygons: Vec<Vec<Vec<[f64; 2]>>>,
    pub bbox: [f64; 4],
}

fn prop(p: &Value, names: &[&str]) -> Option<String> {
    let obj = p.as_object()?;
    names.iter().find_map(|n| {
        obj.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(n))
            .and_then(|(_, v)| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|i| i.to_string())))
    })
}

fn ring(v: &Value, sweref: bool) -> Vec<[f64; 2]> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let x = p.get(0)?.as_f64()?;
            let y = p.get(1)?.as_f64()?;
            Some(if sweref {
                let ll = sweref99tm_to_wgs84(Sweref { n: y, e: x });
                [ll.lon, ll.lat]
            } else {
                [x, y]
            })
        })
        .collect()
}

pub fn parse(bytes: &[u8]) -> Result<Vec<Area>> {
    let doc: Value = serde_json::from_slice(bytes).context("DeSO file is not GeoJSON")?;
    let mut out = Vec::new();
    for f in doc["features"].as_array().context("GeoJSON has no features")? {
        let Some(deso) = prop(&f["properties"], &["desokod", "deso", "deso_kod"]) else { continue };
        let g = &f["geometry"];
        let first = g["coordinates"].pointer(if g["type"] == "Polygon" { "/0/0/0" } else { "/0/0/0/0" }).and_then(Value::as_f64).unwrap_or(0.0);
        let sweref = first.abs() > 1000.0;
        let polygons: Vec<Vec<Vec<[f64; 2]>>> = match g["type"].as_str() {
            Some("Polygon") => vec![g["coordinates"].as_array().into_iter().flatten().map(|r| ring(r, sweref)).collect()],
            Some("MultiPolygon") => g["coordinates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| p.as_array().into_iter().flatten().map(|r| ring(r, sweref)).collect())
                .collect(),
            _ => continue,
        };
        let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for p in polygons.iter().flat_map(|p| p.first()).flatten() {
            bbox = [bbox[0].min(p[1]), bbox[1].min(p[0]), bbox[2].max(p[1]), bbox[3].max(p[0])];
        }
        out.push(Area {
            deso,
            regso: prop(&f["properties"], &["regsokod", "regso"]),
            kommun: prop(&f["properties"], &["kommunkod", "kommun"]),
            name: prop(&f["properties"], &["regsonamn", "namn", "kommunnamn"]),
            polygons,
            bbox,
        });
    }
    Ok(out)
}

fn in_ring(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn contains(area: &Area, p: LatLon) -> bool {
    area.polygons.iter().any(|poly| {
        poly.first().is_some_and(|outer| in_ring(p.lon, p.lat, outer)) && !poly.iter().skip(1).any(|hole| in_ring(p.lon, p.lat, hole))
    })
}

pub fn store(conn: &mut Connection, areas: &[Area]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO area (deso, regso, kommun, name, lat, lon, min_lat, min_lon, max_lat, max_lon, geometry_key, geometry)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)
ON CONFLICT(deso) DO UPDATE SET regso = excluded.regso, kommun = excluded.kommun, name = excluded.name, lat = excluded.lat, lon = excluded.lon,
  min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon, geometry = excluded.geometry",
        )?;
        for a in areas {
            let outer = a.polygons.first().and_then(|p| p.first()).cloned().unwrap_or_default();
            let n = outer.len().max(1) as f64;
            let (clon, clat) = outer.iter().fold((0.0, 0.0), |(x, y), p| (x + p[0], y + p[1]));
            let geometry = json!({ "type": "MultiPolygon", "coordinates": a.polygons });
            stmt.execute(params![a.deso, a.regso, a.kommun, a.name, clat / n, clon / n, a.bbox[0], a.bbox[1], a.bbox[2], a.bbox[3], geometry.to_string()])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Set address.deso by point-in-polygon, with a 0.1° bucket index over area bboxes.
pub fn assign(conn: &mut Connection, areas: &[Area]) -> Result<u64> {
    let bucket = |lat: f64, lon: f64| ((lat * 10.0).floor() as i64, (lon * 10.0).floor() as i64);
    let mut index: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, a) in areas.iter().enumerate() {
        let (r0, c0) = bucket(a.bbox[0], a.bbox[1]);
        let (r1, c1) = bucket(a.bbox[2], a.bbox[3]);
        for r in r0..=r1 {
            for c in c0..=c1 {
                index.entry((r, c)).or_default().push(i);
            }
        }
    }
    let points: Vec<(String, f64, f64)> = conn
        .prepare("SELECT address_id, lat, lon FROM address")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let tx = conn.transaction()?;
    let mut assigned = 0;
    {
        let mut update = tx.prepare("UPDATE address SET deso = ?1 WHERE address_id = ?2")?;
        for (id, lat, lon) in points {
            let p = LatLon { lat, lon };
            if let Some(a) = index.get(&bucket(lat, lon)).into_iter().flatten().map(|i| &areas[*i]).find(|a| contains(a, p)) {
                update.execute(params![a.deso, id])?;
                assigned += 1;
            }
        }
    }
    tx.commit()?;
    Ok(assigned)
}
