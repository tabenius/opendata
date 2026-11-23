import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { AREA, NEAR, ORG, WATCH, gql, recall, remember, type NearResult, type Workplace } from "./api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = (import.meta.env.VITE_MAP_STYLE as string | undefined) ?? "https://tiles.openfreemap.org/styles/positron";
const map = new maplibregl.Map({ container: "map", style: STYLE, center: [15.5, 62], zoom: 4.2, attributionControl: { compact: true } });
// Offline or blocked tiles: fall back to a plain background so markers still render.
let styleLoaded = false;
map.once("styledata", () => (styleLoaded = true));
map.on("error", () => {
  if (!styleLoaded) {
    styleLoaded = true;
    map.setStyle({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef0ea" } }] });
  }
});

const STATUS: Record<string, string> = { active: "aktiv", inactive: "inaktiv", deregistered: "avregistrerad", unknown: "okänd status" };
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

let items: Workplace[] = [];
let lastQuery: { address?: string; point?: { lat: number; lon: number }; radiusM: number; sni?: string[] } | null = null;
let nextCursor: string | null = null;

map.on("load", () => {
  map.addSource("wp", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("radius", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "radius", type: "line", source: "radius", paint: { "line-color": "#14532d", "line-width": 1.5, "line-dasharray": [2, 2] } });
  map.addLayer({
    id: "wp",
    type: "circle",
    source: "wp",
    paint: { "circle-radius": 6, "circle-color": "#15803d", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
  });
  map.on("click", "wp", (e) => {
    const cfar = e.features?.[0]?.properties?.cfar;
    const wp = items.find((w) => w.cfar === String(cfar));
    if (wp) void showOrganisation(wp.orgnr);
  });
  map.on("mouseenter", "wp", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "wp", () => (map.getCanvas().style.cursor = ""));
  map.on("contextmenu", (e) => void search({ point: { lat: e.lngLat.lat, lon: e.lngLat.lng }, radiusM: Number($<HTMLSelectElement>("radius").value) }));
  const saved = recall<{ query: typeof lastQuery; result: NearResult["workplacesNear"] }>("last");
  if (saved?.query) {
    lastQuery = saved.query;
    if (saved.query.address) $<HTMLInputElement>("q").value = saved.query.address;
    $<HTMLSelectElement>("radius").value = String(saved.query.radiusM);
    render(saved.result, false, true);
  }
});

function circle(center: { lat: number; lon: number }, radiusM: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([center.lon + (radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180))) * Math.cos(a), center.lat + (radiusM / 111320) * Math.sin(a)]);
  }
  return { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts } }] };
}

function render(result: NearResult["workplacesNear"], append: boolean, fromCache = false) {
  items = append ? [...items, ...result.items] : result.items;
  nextCursor = result.nextCursor;
  const status = $("status");
  if (!result.center) {
    status.textContent = "Hittade inte adressen. Prova med gatunummer och postnummer.";
    return;
  }
  status.textContent = `${result.totalEstimate ?? items.length} arbetsställen inom ${lastQuery?.radiusM ?? ""} m${fromCache ? " (sparat resultat)" : ""}.`;
  $("attribution").textContent = result.attribution.join(" · ");
  $<HTMLOListElement>("results").innerHTML = items
    .map(
      (w) => `<li><button class="row" data-orgnr="${esc(w.orgnr)}">
        <strong>${esc(w.organisationName ?? w.name ?? "Okänt namn")}</strong>
        <span>${esc([w.visitAddress.street, w.visitAddress.town].filter(Boolean).join(", "))}</span>
        <span class="meta">${w.distanceM ?? "?"} m${w.sni ? ` · SNI ${esc(w.sni)}` : ""}${w.adBlock ? " · reklamspärr" : ""}</span>
      </button></li>`,
    )
    .join("");
  $("more").hidden = !nextCursor;
  const src = map.getSource("wp") as GeoJSONSource | undefined;
  src?.setData({
    type: "FeatureCollection",
    features: items.filter((w) => w.location).map((w) => ({ type: "Feature", properties: { cfar: w.cfar }, geometry: { type: "Point", coordinates: [w.location!.lon, w.location!.lat] } })),
  });
  (map.getSource("radius") as GeoJSONSource | undefined)?.setData(circle(result.center, lastQuery?.radiusM ?? 500));
  if (!append) map.flyTo({ center: [result.center.lon, result.center.lat], zoom: Math.max(12, 16 - Math.log2((lastQuery?.radiusM ?? 500) / 250)) });
}

async function search(query: NonNullable<typeof lastQuery>, append = false) {
  lastQuery = query;
  $("status").textContent = "Söker…";
  try {
    const data = await gql<NearResult>(NEAR, { ...query, after: append ? nextCursor : null });
    render(data.workplacesNear, append);
    if (!append) {
      remember("last", { query, result: data.workplacesNear });
      if (data.workplacesNear.center) void showArea(data.workplacesNear.center);
    }
  } catch (error) {
    $("status").textContent = error instanceof Error ? error.message : "Något gick fel.";
  }
}

async function showArea(point: { lat: number; lon: number }) {
  try {
    const { area } = await gql<{ area: null | { deso: string; name: string | null; kommun: string | null; workplaceCount: number; stats: { label: string | null; variable: string; period: string; value: number | null }[] } }>(AREA, { point });
    $("area").innerHTML = area
      ? `<div class="card"><h2>Område ${esc(area.deso)}${area.name ? ` – ${esc(area.name)}` : ""}</h2>
         <p>Kommun ${esc(area.kommun)} · ${area.workplaceCount} geokodade arbetsställen</p>
         <dl>${area.stats.slice(0, 8).map((s) => `<dt>${esc(s.label ?? s.variable)} (${esc(s.period)})</dt><dd>${s.value?.toLocaleString("sv-SE") ?? "–"}</dd>`).join("")}</dl></div>`
      : "";
    const kommunInput = document.querySelector<HTMLInputElement>('#watch input[name="kommun"]');
    if (area?.kommun && kommunInput && !kommunInput.value) kommunInput.value = area.kommun;
  } catch {
    $("area").innerHTML = "";
  }
}

async function showOrganisation(orgnr: string) {
  const detail = $("detail");
  detail.innerHTML = `<p class="status">Hämtar…</p>`;
  try {
    const { organisation: o } = await gql<{ organisation: any }>(ORG, { orgnr });
    if (!o) {
      detail.innerHTML = "";
      return;
    }
    detail.innerHTML = `<article class="card">
      <h2>${esc(o.name)}</h2>
      <p class="meta">${esc(o.orgnrFormatted)} · ${esc(o.legalForm ?? "")} · ${esc(STATUS[o.status] ?? o.status)}${o.adBlock ? " · reklamspärr" : ""}</p>
      ${o.businessDescription ? `<p>${esc(o.businessDescription)}</p>` : ""}
      <p>${esc([o.postAddress.street, o.postAddress.postcode, o.postAddress.town].filter(Boolean).join(", "))}</p>
      ${o.annualReports.length ? `<h3>Årsredovisningar</h3><ul>${o.annualReports.map((r: any) => `<li>${r.downloadPath ? `<a href="${esc(r.downloadPath)}">${esc(r.periodEnd)}</a>` : esc(r.periodEnd)}</li>`).join("")}</ul>` : ""}
      <h3>Arbetsställen</h3><ul>${o.workplaces.items.map((w: any) => `<li>${esc(w.name ?? "")} – ${esc([w.visitAddress.street, w.visitAddress.town].filter(Boolean).join(", "))}</li>`).join("")}</ul>
      <p class="sources">${o.sources.map((s: any) => esc(s.attribution)).join(" · ")}</p>
    </article>`;
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    detail.innerHTML = `<p class="status">${esc(error instanceof Error ? error.message : "Fel")}</p>`;
  }
}

$<HTMLFormElement>("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const sni = $<HTMLInputElement>("sni").value.trim();
  void search({ address: $<HTMLInputElement>("q").value.trim(), radiusM: Number($<HTMLSelectElement>("radius").value), sni: sni ? [sni] : undefined });
});
$("more").addEventListener("click", () => lastQuery && void search(lastQuery, true));
$("results").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-orgnr]");
  if (button) void showOrganisation(button.dataset.orgnr!);
});
$<HTMLFormElement>("watch").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target as HTMLFormElement);
  const out = $("watch-status");
  try {
    const { watchArea } = await gql<{ watchArea: { accepted: boolean; message: string } }>(WATCH, {
      email: String(form.get("email")),
      kommun: String(form.get("kommun")),
      sniPrefix: String(form.get("sniPrefix") || "") || null,
    });
    out.textContent = watchArea.message;
  } catch (error) {
    out.textContent = error instanceof Error ? error.message : "Fel";
  }
});
