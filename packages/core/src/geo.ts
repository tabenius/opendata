/**
 * SWEREF 99 TM <-> WGS 84 (Gauss-Krüger, Lantmäteriet's published formulas;
 * GRS80 ellipsoid, central meridian 15°, scale 0.9996, false easting 500 000).
 * Plus the grid cell index shared with rust/opendata-geo.
 */
const A = 6378137.0;
const F = 1 / 298.257222101;
const LAMBDA0 = (15 * Math.PI) / 180;
const K0 = 0.9996;
const FN = 0;
const FE = 500000;

const e2 = F * (2 - F);
const n = F / (2 - F);
const aHat = (A / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);

export interface LatLon {
  lat: number;
  lon: number;
}

export function wgs84ToSweref99tm({ lat, lon }: LatLon): { n: number; e: number } {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const Acoef = e2;
  const B = (5 * e2 ** 2 - e2 ** 3) / 6;
  const C = (104 * e2 ** 3 - 45 * e2 ** 4) / 120;
  const D = (1237 * e2 ** 4) / 1260;
  const beta1 = n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180;
  const beta2 = (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440;
  const beta3 = (61 * n ** 3) / 240 - (103 * n ** 4) / 140;
  const beta4 = (49561 * n ** 4) / 161280;
  const s = Math.sin(phi);
  const phiStar = phi - s * Math.cos(phi) * (Acoef + B * s ** 2 + C * s ** 4 + D * s ** 6);
  const dl = lambda - LAMBDA0;
  const xiP = Math.atan(Math.tan(phiStar) / Math.cos(dl));
  const etaP = Math.atanh(Math.cos(phiStar) * Math.sin(dl));
  const x =
    K0 * aHat *
      (xiP +
        beta1 * Math.sin(2 * xiP) * Math.cosh(2 * etaP) +
        beta2 * Math.sin(4 * xiP) * Math.cosh(4 * etaP) +
        beta3 * Math.sin(6 * xiP) * Math.cosh(6 * etaP) +
        beta4 * Math.sin(8 * xiP) * Math.cosh(8 * etaP)) +
    FN;
  const y =
    K0 * aHat *
      (etaP +
        beta1 * Math.cos(2 * xiP) * Math.sinh(2 * etaP) +
        beta2 * Math.cos(4 * xiP) * Math.sinh(4 * etaP) +
        beta3 * Math.cos(6 * xiP) * Math.sinh(6 * etaP) +
        beta4 * Math.cos(8 * xiP) * Math.sinh(8 * etaP)) +
    FE;
  return { n: x, e: y };
}

export function sweref99tmToWgs84({ n: north, e: east }: { n: number; e: number }): LatLon {
  const delta1 = n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - (n ** 4) / 360;
  const delta2 = (n ** 2) / 48 + (n ** 3) / 15 - (437 * n ** 4) / 1440;
  const delta3 = (17 * n ** 3) / 480 - (37 * n ** 4) / 840;
  const delta4 = (4397 * n ** 4) / 161280;
  const Astar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const Bstar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const Cstar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const Dstar = -(4279 * e2 ** 4) / 1260;
  const xi = (north - FN) / (K0 * aHat);
  const eta = (east - FE) / (K0 * aHat);
  const xiP =
    xi -
    delta1 * Math.sin(2 * xi) * Math.cosh(2 * eta) -
    delta2 * Math.sin(4 * xi) * Math.cosh(4 * eta) -
    delta3 * Math.sin(6 * xi) * Math.cosh(6 * eta) -
    delta4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaP =
    eta -
    delta1 * Math.cos(2 * xi) * Math.sinh(2 * eta) -
    delta2 * Math.cos(4 * xi) * Math.sinh(4 * eta) -
    delta3 * Math.cos(6 * xi) * Math.sinh(6 * eta) -
    delta4 * Math.cos(8 * xi) * Math.sinh(8 * eta);
  const phiStar = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const dl = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  const s = Math.sin(phiStar);
  const phi = phiStar + s * Math.cos(phiStar) * (Astar + Bstar * s ** 2 + Cstar * s ** 4 + Dstar * s ** 6);
  return { lat: (phi * 180) / Math.PI, lon: ((LAMBDA0 + dl) * 180) / Math.PI };
}

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Grid cell: 0.01° latitude rows by 0.01° longitude columns.
 * cell = floor(lat*100) * 100000 + floor((lon+180)*100). Identical in Rust.
 */
export const CELL_ROW = 100000;

export function cellOf({ lat, lon }: LatLon): number {
  return Math.floor(lat * 100) * CELL_ROW + Math.floor((lon + 180) * 100);
}

export const MAX_RADIUS_M = 5000;

/** Per-row [from, to] cell ranges covering a circle's bounding box. */
export function cellRanges(center: LatLon, radiusM: number): [number, number][] {
  if (!(radiusM > 0 && radiusM <= MAX_RADIUS_M)) throw new RangeError(`radius must be 1..${MAX_RADIUS_M} m`);
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const rowFrom = Math.floor((center.lat - dLat) * 100);
  const rowTo = Math.floor((center.lat + dLat) * 100);
  const colFrom = Math.floor((center.lon - dLon + 180) * 100);
  const colTo = Math.floor((center.lon + dLon + 180) * 100);
  const ranges: [number, number][] = [];
  for (let row = rowFrom; row <= rowTo; row++) ranges.push([row * CELL_ROW + colFrom, row * CELL_ROW + colTo]);
  return ranges;
}

/** Sweden's rough bounding box: rejects swapped or foreign coordinates. */
export function inSweden({ lat, lon }: LatLon): boolean {
  return lat >= 55 && lat <= 69.2 && lon >= 10.5 && lon <= 24.3;
}
