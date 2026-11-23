/** Pure helpers: URL state, CSV, safe links. Tested in apps/pwa/test. */

export interface SearchState {
  address?: string;
  point?: { lat: number; lon: number };
  radiusM: number;
  /** SNI 2007 section letter (A–U), or undefined for all. */
  section?: string;
  /** Selected workplace (CFAR), for shareable links. */
  selected?: string;
}

export const RADII = [250, 500, 1000, 2500, 5000];

export function stateToQuery(s: SearchState): string {
  const p = new URLSearchParams();
  if (s.address) p.set("q", s.address);
  if (s.point) {
    p.set("lat", s.point.lat.toFixed(5));
    p.set("lon", s.point.lon.toFixed(5));
  }
  if (s.radiusM !== 500) p.set("r", String(s.radiusM));
  if (s.section) p.set("sni", s.section);
  if (s.selected) p.set("v", s.selected);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** Parse the URL; anything malformed is dropped rather than trusted. */
export function queryToState(search: string): SearchState | null {
  const p = new URLSearchParams(search);
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const point = p.has("lat") && p.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
  const address = p.get("q")?.slice(0, 200) || undefined;
  if (!point && !address) return null;
  const r = Number(p.get("r"));
  const section = p.get("sni")?.toUpperCase();
  const selected = p.get("v");
  return {
    address,
    point,
    radiusM: RADII.includes(r) ? r : 500,
    section: section && /^[A-U]$/.test(section) ? section : undefined,
    selected: selected && /^\d{1,12}$/.test(selected) ? selected : undefined,
  };
}

/** Division prefixes per SNI 2007 section (mirrors @opendata/core sni.ts). */
const SECTION_RANGES: Record<string, [number, number]> = {
  A: [1, 3], B: [5, 9], C: [10, 33], D: [35, 35], E: [36, 39], F: [41, 43], G: [45, 47], H: [49, 53], I: [55, 56], J: [58, 63], K: [64, 66],
  L: [68, 68], M: [69, 75], N: [77, 82], O: [84, 84], P: [85, 85], Q: [86, 88], R: [90, 93], S: [94, 96], T: [97, 98], U: [99, 99],
};

export function divisionsOf(section: string | undefined): string[] | undefined {
  const range = section ? SECTION_RANGES[section] : undefined;
  if (!range) return undefined;
  const out: string[] = [];
  for (let d = range[0]; d <= range[1]; d++) out.push(String(d).padStart(2, "0"));
  return out;
}

/**
 * RFC 4180 CSV with a BOM (Excel opens UTF-8 correctly). Cells that a
 * spreadsheet would evaluate as a formula are prefixed with an apostrophe.
 */
export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Only same-origin document downloads are linked. */
export function safeDownload(path: string | null | undefined): string | null {
  return path && /^\/files\/[A-Za-z0-9._\-/]+$/.test(path) && !path.includes("..") ? path : null;
}

export const escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return "";
  return m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} km`;
}

/** Debounce that also cancels superseded async work via AbortSignal. */
export function debounced<A extends unknown[]>(ms: number, fn: (signal: AbortSignal, ...args: A) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    controller?.abort();
    const current = (controller = new AbortController());
    timer = setTimeout(() => void fn(current.signal, ...args).catch(() => undefined), ms);
  };
}
