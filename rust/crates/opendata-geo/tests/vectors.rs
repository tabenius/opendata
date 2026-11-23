//! The same vectors the TypeScript core generates (`pnpm gen`).
use opendata_geo::privacy::classify;
use opendata_geo::{LatLon, Sweref, cell_of, haversine_m, sweref99tm_to_wgs84, wgs84_to_sweref99tm};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../../contracts/vectors/core.json")).unwrap()
}

#[test]
fn classification_matches_typescript() {
    for v in vectors()["classification"].as_array().unwrap() {
        let got = classify(
            v["id"].as_str().unwrap(),
            v["jurform"].as_str(),
            v["bvForm"].as_str(),
            v["idType"].as_str(),
        );
        assert_eq!(got.as_str(), v["expect"].as_str().unwrap(), "{v}");
    }
}

#[test]
fn geodesy_and_cells_match_typescript() {
    for v in vectors()["points"].as_array().unwrap() {
        let p = LatLon { lat: v["lat"].as_f64().unwrap(), lon: v["lon"].as_f64().unwrap() };
        let s = wgs84_to_sweref99tm(p);
        assert!((s.n - v["sweref"]["n"].as_f64().unwrap()).abs() < 1e-6, "{v}");
        assert!((s.e - v["sweref"]["e"].as_f64().unwrap()).abs() < 1e-6, "{v}");
        assert_eq!(cell_of(p), v["cell"].as_i64().unwrap());
        let back = sweref99tm_to_wgs84(Sweref { n: s.n, e: s.e });
        assert!(haversine_m(p, back) < 0.001);
    }
}
