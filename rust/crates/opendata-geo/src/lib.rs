//! Geodesy, grid cells and the privacy classification, bit-for-bit with
//! `packages/core` (checked against `contracts/vectors/core.json`).
//! No dependencies, so it also builds for `wasm32-unknown-unknown`.
#![forbid(unsafe_code)]

pub mod privacy;

const A: f64 = 6378137.0;
const F: f64 = 1.0 / 298.257222101;
const LAMBDA0: f64 = 15.0 * std::f64::consts::PI / 180.0;
const K0: f64 = 0.9996;
const FN: f64 = 0.0;
const FE: f64 = 500000.0;

fn consts() -> (f64, f64, f64) {
    let e2 = F * (2.0 - F);
    let n = F / (2.0 - F);
    let a_hat = A / (1.0 + n) * (1.0 + n * n / 4.0 + n.powi(4) / 64.0);
    (e2, n, a_hat)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sweref {
    pub n: f64,
    pub e: f64,
}

pub fn wgs84_to_sweref99tm(p: LatLon) -> Sweref {
    let (e2, n, a_hat) = consts();
    let phi = p.lat.to_radians();
    let lambda = p.lon.to_radians();
    let a = e2;
    let b = (5.0 * e2.powi(2) - e2.powi(3)) / 6.0;
    let c = (104.0 * e2.powi(3) - 45.0 * e2.powi(4)) / 120.0;
    let d = 1237.0 * e2.powi(4) / 1260.0;
    let beta1 = n / 2.0 - 2.0 * n.powi(2) / 3.0 + 5.0 * n.powi(3) / 16.0 + 41.0 * n.powi(4) / 180.0;
    let beta2 = 13.0 * n.powi(2) / 48.0 - 3.0 * n.powi(3) / 5.0 + 557.0 * n.powi(4) / 1440.0;
    let beta3 = 61.0 * n.powi(3) / 240.0 - 103.0 * n.powi(4) / 140.0;
    let beta4 = 49561.0 * n.powi(4) / 161280.0;
    let s = phi.sin();
    let phi_star = phi - s * phi.cos() * (a + b * s.powi(2) + c * s.powi(4) + d * s.powi(6));
    let dl = lambda - LAMBDA0;
    let xi = (phi_star.tan() / dl.cos()).atan();
    let eta = (phi_star.cos() * dl.sin()).atanh();
    let x = K0
        * a_hat
        * (xi
            + beta1 * (2.0 * xi).sin() * (2.0 * eta).cosh()
            + beta2 * (4.0 * xi).sin() * (4.0 * eta).cosh()
            + beta3 * (6.0 * xi).sin() * (6.0 * eta).cosh()
            + beta4 * (8.0 * xi).sin() * (8.0 * eta).cosh())
        + FN;
    let y = K0
        * a_hat
        * (eta
            + beta1 * (2.0 * xi).cos() * (2.0 * eta).sinh()
            + beta2 * (4.0 * xi).cos() * (4.0 * eta).sinh()
            + beta3 * (6.0 * xi).cos() * (6.0 * eta).sinh()
            + beta4 * (8.0 * xi).cos() * (8.0 * eta).sinh())
        + FE;
    Sweref { n: x, e: y }
}

pub fn sweref99tm_to_wgs84(p: Sweref) -> LatLon {
    let (e2, n, a_hat) = consts();
    let d1 = n / 2.0 - 2.0 * n.powi(2) / 3.0 + 37.0 * n.powi(3) / 96.0 - n.powi(4) / 360.0;
    let d2 = n.powi(2) / 48.0 + n.powi(3) / 15.0 - 437.0 * n.powi(4) / 1440.0;
    let d3 = 17.0 * n.powi(3) / 480.0 - 37.0 * n.powi(4) / 840.0;
    let d4 = 4397.0 * n.powi(4) / 161280.0;
    let a_s = e2 + e2.powi(2) + e2.powi(3) + e2.powi(4);
    let b_s = -(7.0 * e2.powi(2) + 17.0 * e2.powi(3) + 30.0 * e2.powi(4)) / 6.0;
    let c_s = (224.0 * e2.powi(3) + 889.0 * e2.powi(4)) / 120.0;
    let d_s = -(4279.0 * e2.powi(4)) / 1260.0;
    let xi = (p.n - FN) / (K0 * a_hat);
    let eta = (p.e - FE) / (K0 * a_hat);
    let xi_p = xi
        - d1 * (2.0 * xi).sin() * (2.0 * eta).cosh()
        - d2 * (4.0 * xi).sin() * (4.0 * eta).cosh()
        - d3 * (6.0 * xi).sin() * (6.0 * eta).cosh()
        - d4 * (8.0 * xi).sin() * (8.0 * eta).cosh();
    let eta_p = eta
        - d1 * (2.0 * xi).cos() * (2.0 * eta).sinh()
        - d2 * (4.0 * xi).cos() * (4.0 * eta).sinh()
        - d3 * (6.0 * xi).cos() * (6.0 * eta).sinh()
        - d4 * (8.0 * xi).cos() * (8.0 * eta).sinh();
    let phi_star = (xi_p.sin() / eta_p.cosh()).asin();
    let dl = (eta_p.sinh() / xi_p.cos()).atan();
    let s = phi_star.sin();
    let phi = phi_star + s * phi_star.cos() * (a_s + b_s * s.powi(2) + c_s * s.powi(4) + d_s * s.powi(6));
    LatLon { lat: phi.to_degrees(), lon: (LAMBDA0 + dl).to_degrees() }
}

pub const CELL_ROW: i64 = 100000;

/// `floor(lat*100) * 100000 + floor((lon+180)*100)`, as `cellOf` in TypeScript.
pub fn cell_of(p: LatLon) -> i64 {
    (p.lat * 100.0).floor() as i64 * CELL_ROW + ((p.lon + 180.0) * 100.0).floor() as i64
}

pub fn haversine_m(a: LatLon, b: LatLon) -> f64 {
    const R: f64 = 6371008.8;
    let dlat = (b.lat - a.lat).to_radians();
    let dlon = (b.lon - a.lon).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + a.lat.to_radians().cos() * b.lat.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R * h.sqrt().min(1.0).asin()
}

pub fn in_sweden(p: LatLon) -> bool {
    (55.0..=69.2).contains(&p.lat) && (10.5..=24.3).contains(&p.lon)
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Returns [lat, lon].
    #[wasm_bindgen]
    pub fn sweref_to_wgs84(n: f64, e: f64) -> Vec<f64> {
        let p = super::sweref99tm_to_wgs84(super::Sweref { n, e });
        vec![p.lat, p.lon]
    }

    /// Returns [n, e].
    #[wasm_bindgen]
    pub fn wgs84_to_sweref(lat: f64, lon: f64) -> Vec<f64> {
        let p = super::wgs84_to_sweref99tm(super::LatLon { lat, lon });
        vec![p.n, p.e]
    }

    #[wasm_bindgen]
    pub fn cell(lat: f64, lon: f64) -> f64 {
        super::cell_of(super::LatLon { lat, lon }) as f64
    }
}
