import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { AREA, GEOCODE, NEAR, ORG, SECTIONS, WATCH, gql, recall, remember, type NearResult, type Suggestion, type Workplace } from "./api";
import { debounced, divisionsOf, escapeHtml as esc, formatDistance, queryToState, safeDownload, stateToQuery, toCsv, type SearchState } from "./lib";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = $<HTMLInputElement>("q");
const radius = $<HTMLSelectElement>("radius");
const section = $<HTMLSelectElement>("section");
const list = $<HTMLOListElement>("results");
const statusEl = $("status");
const suggestions = $<HTMLUListElement>("suggestions");

const dark = matchMedia("(prefers-color-scheme: dark)");
const STYLE = (import.meta.env.VITE_MAP_STYLE as string | undefined) ?? "https://tiles.openfreemap.org/styles/positron";
const map = new maplibregl.Map({ container: "map", style: STYLE, center: [15.5, 62], zoom: 4.2, attributionControl: { compact: true } });
let styleLoaded = false;
map.once("styledata", () => (styleLoaded = true));
map.on("error", () => {
  // Offline or blocked tiles: a plain background so markers still render.
  if (!styleLoaded) {
    styleLoaded = true;
    map.setStyle({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": dark.matches ? "#1b221d" : "#eef0ea" } }] });
  }
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

const STATUS: Record<string, string> = { active: "aktiv", inactive: "inaktiv", deregistered: "avregistrerad", unknown: "okänd status" };

let items: Workplace[] = [];
let state: SearchState | null = null;
let nextCursor: string | null = null;
let center: { lat: number; lon: number } | null = null;
let selected: string | null = null;
let hovered: string | null = null;
let popup: maplibregl.Popup | null = null;
let searchController: AbortController | null = null;

// ---------------------------------------------------------------- status

function setStatus(text: string, kind: "info" | "busy" | "error" = "info", retry?: () => void) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
  list.setAttribute("aria-busy", String(kind === "busy"));
  if (retry) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost";
    b.textContent = "Försök igen";
    b.addEventListener("click", retry);
    statusEl.append(" ", b);
  }
}

// ---------------------------------------------------------------- map

const featureId = (cfar: string) => Number(cfar);

map.on("load", () => {
  map.addSource("wp", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
  map.addSource("radius", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "radius", type: "line", source: "radius", paint: { "line-color": "#16a34a", "line-width": 1.5, "line-dasharray": [2, 2] } });
  map.addLayer({
    id: "wp",
    type: "circle",
    source: "wp",
    paint: {
      "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 9, ["boolean", ["feature-state", "hover"], false], 8, 6],
      "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", ["get", "adBlock"], "#64748b", "#15803d"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
    },
  });
  map.on("click", "wp", (e) => {
    const f = e.features?.[0] as MapGeoJSONFeature | undefined;
    if (f) select(String(f.properties.cfar), { fly: false, scroll: true, open: true });
  });
  map.on("mousemove", "wp", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const cfar = String(e.features?.[0]?.properties.cfar ?? "");
    if (cfar) hover(cfar);
  });
  map.on("mouseleave", "wp", () => {
    map.getCanvas().style.cursor = "";
    hover(null);
  });
  const searchAt = (lngLat: maplibregl.LngLat) => run({ point: { lat: lngLat.lat, lon: lngLat.lng }, radiusM: Number(radius.value), section: section.value || undefined });
  map.on("contextmenu", (e) => searchAt(e.lngLat));
  // Long press on touch screens.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  map.on("touchstart", (e) => {
    if (e.originalEvent.touches.length !== 1) return;
    pressTimer = setTimeout(() => searchAt(e.lngLat), 600);
  });
  for (const ev of ["touchend", "touchmove", "touchcancel"] as const) map.on(ev, () => clearTimeout(pressTimer));

  start();
});

function setFeatureState(cfar: string | null, key: "hover" | "selected", value: boolean) {
  if (cfar && map.getSource("wp")) map.setFeatureState({ source: "wp", id: featureId(cfar) }, { [key]: value });
}

function hover(cfar: string | null) {
  if (hovered === cfar) return;
  setFeatureState(hovered, "hover", false);
  list.querySelector(".row.hover")?.classList.remove("hover");
  hovered = cfar;
  setFeatureState(cfar, "hover", true);
  if (cfar) list.querySelector(`.row[data-cfar="${CSS.escape(cfar)}"]`)?.classList.add("hover");
}

function select(cfar: string, opts: { fly: boolean; scroll: boolean; open: boolean }) {
  const wp = items.find((w) => w.cfar === cfar);
  if (!wp) return;
  setFeatureState(selected, "selected", false);
  list.querySelector(".row[aria-current]")?.removeAttribute("aria-current");
  selected = cfar;
  setFeatureState(cfar, "selected", true);
  const row = list.querySelector<HTMLButtonElement>(`.row[data-cfar="${CSS.escape(cfar)}"]`);
  row?.setAttribute("aria-current", "true");
  if (opts.scroll) row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  popup?.remove();
  if (wp.location) {
    popup = new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "260px" })
      .setLngLat([wp.location.lon, wp.location.lat])
      .setHTML(
        `<strong>${esc(wp.organisationName ?? wp.name ?? "Okänt namn")}</strong><br>${esc([wp.visitAddress.street, wp.visitAddress.town].filter(Boolean).join(", "))}` +
          `${wp.sniTitle || wp.sniSection ? `<br><small>${esc(wp.sniTitle ?? wp.sniSection?.title)}</small>` : ""}`,
      )
      .addTo(map);
    if (opts.fly) map.easeTo({ center: [wp.location.lon, wp.location.lat], zoom: Math.max(map.getZoom(), 15) });
  }
  if (state) {
    state = { ...state, selected: cfar };
    history.replaceState(null, "", stateToQuery(state) || location.pathname);
  }
  if (opts.open) void showOrganisation(wp.orgnr);
}

function circle(c: { lat: number; lon: number }, radiusM: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([c.lon + (radiusM / (111320 * Math.cos((c.lat * Math.PI) / 180))) * Math.cos(a), c.lat + (radiusM / 111320) * Math.sin(a)]);
  }
  return { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts } }] };
}

// ---------------------------------------------------------------- results

function sniLabel(w: Workplace) {
  if (w.sniTitle) return w.sniTitle;
  if (w.sniSection) return `${w.sniSection.title} (${w.sni})`;
  return w.sni ? `SNI ${w.sni}` : "";
}

function render(result: NearResult["workplacesNear"], append: boolean, fromCache = false) {
  items = append ? [...items, ...result.items] : result.items;
  nextCursor = result.nextCursor;
  center = result.center;
  $("toolbar").hidden = items.length === 0;
  $("more").hidden = !nextCursor;
  if (!result.center) {
    list.innerHTML = "";
    setStatus("Hittade inte adressen. Prova med gatunummer och ort, eller välj ett förslag i listan.", "error");
    return;
  }
  const total = result.totalEstimate ?? items.length;
  const where = state?.address ? ` nära ${state.address}` : "";
  setStatus(
    items.length === 0
      ? `Inga arbetsställen inom ${formatDistance(state?.radiusM)}${where}. Prova en större radie${state?.section ? " eller alla branscher" : ""}.`
      : `${total.toLocaleString("sv-SE")} arbetsställen inom ${formatDistance(state?.radiusM)}${where}${fromCache ? " (sparat resultat)" : ""}.`,
  );
  $("attribution").textContent = result.attribution.join(" · ");
  list.innerHTML = items
    .map(
      (w) => `<li><button class="row" data-cfar="${esc(w.cfar)}" data-orgnr="${esc(w.orgnr)}">
        <span class="name">${w.sniSection ? `<span class="badge" title="${esc(w.sniSection.title)}">${esc(w.sniSection.letter)}</span>` : ""}<strong>${esc(w.organisationName ?? w.name ?? "Okänt namn")}</strong></span>
        <span>${esc([w.visitAddress.street, w.visitAddress.town].filter(Boolean).join(", "))}</span>
        <span class="meta">${esc(formatDistance(w.distanceM))}${sniLabel(w) ? ` · ${esc(sniLabel(w))}` : ""}${w.adBlock ? ` · <span class="flag">reklamspärr</span>` : ""}</span>
      </button></li>`,
    )
    .join("");
  (map.getSource("wp") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: items
      .filter((w) => w.location)
      .map((w) => ({ type: "Feature", id: featureId(w.cfar), properties: { id: featureId(w.cfar), cfar: w.cfar, adBlock: w.adBlock }, geometry: { type: "Point", coordinates: [w.location!.lon, w.location!.lat] } })),
  });
  (map.getSource("radius") as GeoJSONSource | undefined)?.setData(circle(result.center, state?.radiusM ?? 500));
  if (!append) map.flyTo({ center: [result.center.lon, result.center.lat], zoom: Math.max(12, 16 - Math.log2((state?.radiusM ?? 500) / 250)) });
  if (selected && items.some((w) => w.cfar === selected)) select(selected, { fly: false, scroll: false, open: false });
}

async function run(next: SearchState, append = false, push = true) {
  searchController?.abort();
  const controller = (searchController = new AbortController());
  if (!append) {
    selected = next.selected ?? null;
    popup?.remove();
    $("detail").innerHTML = "";
    if (push) history.pushState(null, "", stateToQuery(next) || location.pathname);
  }
  state = next;
  setStatus(append ? "Hämtar fler…" : "Söker…", "busy");
  try {
    const data = await gql<NearResult>(
      NEAR,
      { address: next.point ? null : next.address, point: next.point ?? null, radiusM: next.radiusM, sni: divisionsOf(next.section) ?? null, after: append ? nextCursor : null },
      controller.signal,
    );
    render(data.workplacesNear, append);
    if (!append) {
      remember("last", { state: next, result: data.workplacesNear });
      if (data.workplacesNear.center) void showArea(data.workplacesNear.center);
      if (next.selected) select(next.selected, { fly: true, scroll: true, open: true });
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    setStatus(error instanceof Error ? error.message : "Något gick fel.", "error", () => void run(next, append));
  }
}

function fillForm(s: SearchState) {
  q.value = s.address ?? (s.point ? `${s.point.lat.toFixed(5)}, ${s.point.lon.toFixed(5)}` : "");
  radius.value = String(s.radiusM);
  section.value = s.section ?? "";
}

function start() {
  const fromUrl = queryToState(location.search);
  if (fromUrl) {
    fillForm(fromUrl);
    void run(fromUrl, false, false);
    return;
  }
  const saved = recall<{ state: SearchState; result: NearResult["workplacesNear"] }>("last");
  if (saved?.state && saved.result) {
    state = saved.state;
    fillForm(saved.state);
    render(saved.result, false, true);
  }
}

addEventListener("popstate", () => {
  const s = queryToState(location.search);
  if (!s) return;
  fillForm(s);
  void run(s, false, false);
});

// ---------------------------------------------------------------- side cards

async function showArea(point: { lat: number; lon: number }) {
  try {
    const { area } = await gql<{ area: null | { deso: string; name: string | null; kommun: string | null; workplaceCount: number; stats: { label: string | null; variable: string; period: string; value: number | null }[] } }>(AREA, { point });
    $("area").innerHTML = area
      ? `<details class="card" open><summary><h2>Område ${esc(area.deso)}${area.name ? ` – ${esc(area.name)}` : ""}</h2></summary>
         <p class="meta">Kommun ${esc(area.kommun)} · ${area.workplaceCount.toLocaleString("sv-SE")} geokodade arbetsställen</p>
         ${area.stats.length ? `<dl>${area.stats.slice(0, 8).map((s) => `<dt>${esc(s.label ?? s.variable)} (${esc(s.period)})</dt><dd>${s.value?.toLocaleString("sv-SE") ?? "–"}</dd>`).join("")}</dl>` : `<p class="meta">Ingen statistik laddad för området.</p>`}</details>`
      : "";
    const kommunInput = document.querySelector<HTMLInputElement>('#watch input[name="kommun"]');
    if (area?.kommun && kommunInput && !kommunInput.value) kommunInput.value = area.kommun;
  } catch {
    $("area").innerHTML = "";
  }
}

async function showOrganisation(orgnr: string) {
  const detail = $("detail");
  detail.innerHTML = `<p class="status busy">Hämtar organisationen…</p>`;
  try {
    const { organisation: o } = await gql<{ organisation: any }>(ORG, { orgnr });
    if (!o) {
      detail.innerHTML = `<p class="status">Organisationen finns inte längre i registret.</p>`;
      return;
    }
    const reports = (o.annualReports as { periodEnd: string; downloadPath: string | null }[]).map((r) => {
      const href = safeDownload(r.downloadPath);
      return `<li>${href ? `<a href="${esc(href)}" download>${esc(r.periodEnd)}</a>` : esc(r.periodEnd)}</li>`;
    });
    detail.innerHTML = `<article class="card" aria-labelledby="org-name">
      <h2 id="org-name">${esc(o.name)}</h2>
      <p class="meta">${esc(o.orgnrFormatted)} · ${esc(o.legalForm ?? "")} · ${esc(STATUS[o.status] ?? o.status)}${o.adBlock ? ` · <span class="flag">reklamspärr</span>` : ""}</p>
      ${o.sniSection ? `<p><span class="badge">${esc(o.sniSection.letter)}</span> ${esc(o.sniTitle ?? o.sniSection.title)}${o.sniPrimary ? ` <span class="meta">(SNI ${esc(o.sniPrimary)})</span>` : ""}</p>` : ""}
      ${o.businessDescription ? `<p>${esc(o.businessDescription)}</p>` : ""}
      <p>${esc([o.postAddress.street, o.postAddress.postcode, o.postAddress.town].filter(Boolean).join(", "))}</p>
      ${reports.length ? `<h3>Årsredovisningar</h3><ul>${reports.join("")}</ul>` : ""}
      <h3>Arbetsställen</h3><ul>${o.workplaces.items.map((w: any) => `<li>${esc(w.name ?? "")} – ${esc([w.visitAddress.street, w.visitAddress.town].filter(Boolean).join(", "))}</li>`).join("")}</ul>
      <p class="sources">${o.sources.map((s: any) => esc(s.attribution)).join(" · ")}</p>
    </article>`;
    detail.focus({ preventScroll: true });
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    detail.innerHTML = `<p class="status error">${esc(error instanceof Error ? error.message : "Fel")}</p>`;
  }
}

// ---------------------------------------------------------------- address autocomplete

let options: Suggestion[] = [];
let active = -1;
let chosen: Suggestion | null = null;

function closeSuggestions() {
  suggestions.hidden = true;
  q.setAttribute("aria-expanded", "false");
  q.removeAttribute("aria-activedescendant");
  active = -1;
}

function paintSuggestions() {
  suggestions.innerHTML = options.map((o, i) => `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="${i === active}">${esc(o.label)}</li>`).join("");
  suggestions.hidden = options.length === 0;
  q.setAttribute("aria-expanded", String(options.length > 0));
  if (active >= 0) q.setAttribute("aria-activedescendant", `sug-${active}`);
  else q.removeAttribute("aria-activedescendant");
}

function choose(i: number) {
  const o = options[i];
  if (!o) return;
  chosen = o;
  q.value = o.label;
  closeSuggestions();
  void run({ address: o.label, point: o.location ?? undefined, radiusM: Number(radius.value), section: section.value || undefined });
}

const suggest = debounced(250, async (signal, text: string) => {
  if (text.length < 3) {
    options = [];
    paintSuggestions();
    return;
  }
  const { geocode } = await gql<{ geocode: Suggestion[] }>(GEOCODE, { q: text }, signal);
  if (signal.aborted || q.value.trim() !== text) return;
  options = geocode;
  active = -1;
  paintSuggestions();
});

q.addEventListener("input", () => {
  chosen = null;
  suggest(q.value.trim());
});
q.addEventListener("keydown", (e) => {
  if (suggestions.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    paintSuggestions();
  } else if (e.key === "Enter" && active >= 0) {
    e.preventDefault();
    choose(active);
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
});
q.addEventListener("blur", () => setTimeout(closeSuggestions, 150));
suggestions.addEventListener("mousedown", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-i]");
  if (li) {
    e.preventDefault();
    choose(Number(li.dataset.i));
  }
});

// ---------------------------------------------------------------- controls

$<HTMLFormElement>("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) {
    setStatus("Skriv en adress, eller använd din position.", "error");
    q.focus();
    return;
  }
  const point = chosen?.label === text ? (chosen.location ?? undefined) : undefined;
  closeSuggestions();
  void run({ address: text, point, radiusM: Number(radius.value), section: section.value || undefined });
});

// Changing radius or branch re-runs the current search.
for (const el of [radius, section])
  el.addEventListener("change", () => {
    if (state) void run({ ...state, radiusM: Number(radius.value), section: section.value || undefined, selected: undefined });
  });

$("locate").addEventListener("click", () => {
  if (!("geolocation" in navigator)) return setStatus("Webbläsaren kan inte ange position.", "error");
  setStatus("Hämtar position…", "busy");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const point = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      q.value = "Min position";
      void run({ address: undefined, point, radiusM: Number(radius.value), section: section.value || undefined });
    },
    (err) => setStatus(err.code === err.PERMISSION_DENIED ? "Positionen är blockerad i webbläsaren." : "Kunde inte hämta positionen.", "error"),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
  );
});

$("more").addEventListener("click", () => state && void run(state, true));

list.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-cfar]");
  if (button) select(button.dataset.cfar!, { fly: true, scroll: false, open: true });
});
list.addEventListener("mouseover", (e) => hover((e.target as HTMLElement).closest<HTMLElement>("[data-cfar]")?.dataset.cfar ?? null));
list.addEventListener("mouseleave", () => hover(null));
list.addEventListener("focusin", (e) => hover((e.target as HTMLElement).closest<HTMLElement>("[data-cfar]")?.dataset.cfar ?? null));

$("csv").addEventListener("click", () => {
  const csv = toCsv(
    ["cfar", "orgnr", "namn", "gata", "postnummer", "ort", "sni", "bransch", "avstand_m", "reklamsparr", "lat", "lon"],
    items.map((w) => [w.cfar, w.orgnr, w.organisationName ?? w.name, w.visitAddress.street, w.visitAddress.postcode, w.visitAddress.town, w.sni, sniLabel(w), w.distanceM, w.adBlock ? "ja" : "nej", w.location?.lat, w.location?.lon]),
  );
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `arbetsstallen-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (nextCursor) setStatus(`Exporterade de ${items.length} visade raderna. Klicka “Visa fler” för att ta med fler.`);
});

$("share").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("share");
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = "Länk kopierad";
  } catch {
    button.textContent = "Kopiera adressfältet";
  }
  setTimeout(() => (button.textContent = "Kopiera länk"), 2000);
});

$<HTMLFormElement>("watch").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target as HTMLFormElement);
  const out = $("watch-status");
  out.className = "status busy";
  out.textContent = "Skickar…";
  try {
    const { watchArea } = await gql<{ watchArea: { accepted: boolean; message: string } }>(WATCH, {
      email: String(form.get("email")),
      kommun: String(form.get("kommun")),
      sniPrefix: String(form.get("sniPrefix") || "") || null,
    });
    out.className = `status ${watchArea.accepted ? "ok" : "error"}`;
    out.textContent = watchArea.message;
  } catch (error) {
    out.className = "status error";
    out.textContent = error instanceof Error ? error.message : "Fel";
  }
});

void gql<{ sniSections: { letter: string; title: string }[] }>(SECTIONS)
  .then(({ sniSections }) => {
    const current = state?.section ?? queryToState(location.search)?.section ?? "";
    for (const s of sniSections) section.add(new Option(`${s.letter} – ${s.title}`, s.letter));
    section.value = current;
  })
  .catch(() => undefined);

