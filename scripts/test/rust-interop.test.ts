/**
 * TypeScript <-> Rust interop over real files:
 *  - Rust ingest builds the snapshot from bulk-format inputs (made from the fixture),
 *  - Rust publishes it into an rbq store, TypeScript imports it and answers queries,
 *  - TypeScript publishes a snapshot, Rust (rebsync-core) verifies it.
 * Skipped when cargo is unavailable.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FsObjectStore } from "@opendata/adapters-object/fs";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { FIXTURE_CENTER, Queries, fixtureDataset, migrations, wgs84ToSweref99tm } from "@opendata/core";
import { publishDatabase, syncLatest } from "@opendata/datasets";

const rust = fileURLToPath(new URL("../../rust/", import.meta.url));
const hasCargo = spawnSync("cargo", ["--version"]).status === 0;
const bin = (name: string) => path.join(rust, "target", "debug", name);

function inputs(dir: string) {
  const d = fixtureDataset();
  // Lantmäteriet-style address CSV in SWEREF 99 TM with custom column names.
  const addr = ["objektid;gatunamn;nummer;bokstav;postnummer;postort;kommunkod;N;E"];
  for (const a of d.addresses) {
    const s = wgs84ToSweref99tm(a);
    addr.push([a.addressId, a.street, a.number, a.letter ?? "", a.postcode, a.town, a.kommun, s.n.toFixed(4), s.e.toFixed(4)].join(";"));
  }
  writeFileSync(path.join(dir, "addresses.csv"), addr.join("\n") + "\n");
  // Bolagsverket bulk: legal entities plus a sole trader by personnummer.
  const bv = ["organisationsidentitet;namnskyddslopnummer;registreringsland;organisationsnamn;organisationsform;avregistreringsdatum;avregistreringsorsak;pagandeAvvecklingsEllerOmstruktureringsforfarande;registreringsdatum;verksamhetsbeskrivning;postadress"];
  for (const o of d.organisations) {
    const person = o.jurform === "10" || o.jurform === "91";
    bv.push(`${o.orgnr}$${person ? "PERSON-IDORG" : "ORGNR-IDORG"};;SE-LAND;${o.name}$FORETAGSNAMN-ORGNAM$2020-01-01;${person ? "E" : "AB"}-ORGFO;;;;2020-01-01;${o.businessDescription ?? ""};Box 1$GÖTEBORG$41101$SE-LAND`);
  }
  writeFileSync(path.join(dir, "bolagsverket.csv"), bv.join("\n") + "\n");
  // SCB API dumps.
  writeFileSync(path.join(dir, "legal.jsonl"), d.organisations.map((o) => JSON.stringify({ peOrgNr: o.orgnr, jurform: o.jurform, namn: o.name, jeStat: 1 })).join("\n") + "\n");
  writeFileSync(
    path.join(dir, "workplaces.jsonl"),
    d.workplaces.map((w) => JSON.stringify({ cfarNr: w.cfar, peOrgNr: w.orgnr, ben: w.name, primarNaringsgren: { naringsgren: w.sni, avdelningsKod: "X" }, belagenhetsadress: { bGatuAdress: w.visit?.street, bPostNr: w.visit?.postcode, bPostOrt: w.visit?.town, kommun: "1480", lan: "14" }, aeStat: 1, anstKl: w.sizeClass })).join("\n") + "\n",
  );
  // DeSO polygons in SWEREF 99 TM, as SCB publishes them.
  const features = d.areas.map((a) => {
    const [minLat, minLon, maxLat, maxLon] = a.bbox!;
    const ring = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]].map(([lon, lat]) => {
      const s = wgs84ToSweref99tm({ lat: lat!, lon: lon! });
      return [s.e, s.n];
    });
    return { type: "Feature", properties: { desokod: a.deso, regsokod: a.regso, kommunkod: a.kommun }, geometry: { type: "Polygon", coordinates: [ring] } };
  });
  writeFileSync(path.join(dir, "deso.geojson"), JSON.stringify({ type: "FeatureCollection", features }));
  return d;
}

describe.skipIf(!hasCargo)("Rust ingest and rbq interop", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "-q", "-p", "opendata-ingest", "-p", "opendata-rbq"], { cwd: rust, stdio: "pipe" });
  }, 600000);

  it("Rust builds and publishes; TypeScript imports and queries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "od-interop-"));
    const d = inputs(dir);
    const out = path.join(dir, "snapshot");
    const summary = JSON.parse(
      execFileSync(bin("opendata-ingest"), [
        "build", "--out", out, "--source-date", "2026-11-23",
        "--addresses", path.join(dir, "addresses.csv"),
        "--address-columns", "id=objektid,street=gatunamn,number=nummer,letter=bokstav,postcode=postnummer,town=postort,kommun=kommunkod,n=N,e=E",
        "--deso", path.join(dir, "deso.geojson"),
        "--bolagsverket", path.join(dir, "bolagsverket.csv"),
        "--scb-legal-units", path.join(dir, "legal.jsonl"),
        "--scb-workplaces", path.join(dir, "workplaces.jsonl"),
      ]).toString(),
    );
    expect(summary.organisations.skipped_natural_persons).toBe(4); // 2 from Bolagsverket + 2 from SCB
    expect(summary.workplaces.skipped_natural_persons).toBe(1);
    expect(summary.rows.workplace).toBe(12);
    expect(summary.deso.addresses_assigned).toBe(25);

    const store = path.join(dir, "store");
    const published = JSON.parse(execFileSync(bin("opendata-rbq"), ["publish", "--storage-root", store, "--dir", out, "--label", "national"]).toString());
    const objects = await FsObjectStore.open(store);
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const result = await syncLatest(sql, objects, "national");
    expect(result.active).toBe(published.id);
    const q = new Queries(sql);
    const near = await q.workplacesNear({ point: FIXTURE_CENTER, radiusM: 3000, first: 100 });
    expect(near.items).toHaveLength(12);
    expect(near.items.every((w) => w.location !== null)).toBe(true);
    for (const id of d.naturalPersonIds) expect(await q.organisation(id)).toBeNull();
    const org = await q.organisation(d.organisations[0]!.orgnr);
    expect(org?.sources.map((s) => s.id).sort()).toEqual(["bolagsverket-hvd", "scb-fr"]);
    expect(org?.legalForm).toBe("Aktiebolag");
    expect((await q.area({ point: { lat: 57.705, lon: 11.95 } }))?.deso).toBe("1480C1010");
    expect((await q.geocode("Kaffegatan 1, 41160 Göteborg"))[0]?.street).toBe("Kaffegatan");
  });

  it("TypeScript publishes; rebsync-core verifies and reassembles", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "od-interop-"));
    const store = path.join(dir, "store");
    const objects = await FsObjectStore.open(store);
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const outcome = await publishDatabase(sql, objects, "ts");
    const verified = JSON.parse(execFileSync(bin("opendata-rbq"), ["verify", "--storage-root", store, "--id", outcome.id]).toString());
    expect(verified.ok).toBe(true);
    execFileSync(bin("opendata-rbq"), ["pull", "--storage-root", store, "--id", outcome.id, "--out", path.join(dir, "pulled")]);
  });
});
