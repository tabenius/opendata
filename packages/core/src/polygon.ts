/** Point-in-polygon for GeoJSON Polygon/MultiPolygon in lon/lat order (even-odd rule). */
type Ring = number[][];

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

function inPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  if (!rings[0] || !inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(lon, lat, hole));
}

export interface Geometry {
  type: string;
  coordinates: unknown;
}

export function containsPoint(geometry: Geometry, lon: number, lat: number): boolean {
  if (geometry.type === "Polygon") return inPolygon(lon, lat, geometry.coordinates as Ring[]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Ring[][]).some((p) => inPolygon(lon, lat, p));
  return false;
}
