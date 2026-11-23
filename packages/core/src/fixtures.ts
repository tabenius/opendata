/**
 * A small, entirely fictional dataset around a point in Göteborg, used by
 * tests, local development and the PWA demo. It deliberately includes
 * natural persons (sole traders) so the privacy guard is exercised.
 */
import { luhnValid } from "./orgnr";
import { sweref99tmToWgs84, wgs84ToSweref99tm } from "./geo";
import type { AddressRecord, AreaRecord, AreaStatRecord, OrganisationRecord, WorkplaceRecord } from "./types";

export function withLuhn(nine: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(nine + d)) return nine + d;
  throw new Error("unreachable");
}

const box = (minLat: number, minLon: number, maxLat: number, maxLon: number) => ({
  type: "Polygon",
  coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

export const FIXTURE_DATE = "2026-11-20";
export const FIXTURE_CENTER = { lat: 57.7072, lon: 11.9668 };

export interface FixtureDataset {
  organisations: OrganisationRecord[];
  workplaces: WorkplaceRecord[];
  addresses: AddressRecord[];
  areas: AreaRecord[];
  stats: AreaStatRecord[];
  naturalPersonIds: string[];
}

const STREETS = ["Kaffegatan", "Bryggargatan", "Tullplatsen", "Smedjegatan", "Hamnvägen"];
const SNI = ["56100", "47110", "62010", "43210", "86210", "10710"];
const NAMES = ["Kaffekollektivet", "Bryggeri Väst", "Kodverkstaden", "Elfirma Norr", "Tandläkarhuset", "Bageri Solen"];

export function fixtureDataset(): FixtureDataset {
  const center = wgs84ToSweref99tm(FIXTURE_CENTER);
  const addresses: AddressRecord[] = [];
  for (let i = 0; i < 25; i++) {
    const street = STREETS[i % STREETS.length]!;
    const number = String(1 + Math.floor(i / STREETS.length) * 2);
    // Spread over ~1.2 km in SWEREF 99 TM metres, then convert.
    const { lat, lon } = sweref99tmToWgs84({ n: center.n + ((i * 137) % 1200) - 600, e: center.e + ((i * 211) % 1200) - 600 });
    addresses.push({
      addressId: `fixture-${i.toString().padStart(3, "0")}`,
      street,
      number,
      letter: i % 7 === 0 ? "B" : null,
      postcode: `4116${i % 5}`,
      town: "GÖTEBORG",
      kommun: "1480",
      lat,
      lon,
      deso: i < 12 ? "1480C1010" : "1480C1020",
      sourceDate: FIXTURE_DATE,
    });
  }
  const organisations: OrganisationRecord[] = [];
  const workplaces: WorkplaceRecord[] = [];
  NAMES.forEach((name, i) => {
    const orgnr = withLuhn(`55${6 + (i % 3)}${(100000 + i * 7919).toString().slice(-6)}`);
    organisations.push({
      orgnr,
      name: `${name} AB`,
      legalForm: "Aktiebolag",
      legalFormCode: "AB",
      jurform: "49",
      status: "active",
      registeredAt: `20${10 + i}-03-0${1 + i}`,
      businessDescription: `Fiktiv verksamhet nummer ${i + 1}.`,
      post: { street: `Box ${1000 + i}`, postcode: "41101", town: "GÖTEBORG" },
      sniPrimary: SNI[i]!,
      sniCodes: [SNI[i]!],
      source: "fixture",
      sourceDate: FIXTURE_DATE,
    });
    for (let w = 0; w < 2; w++) {
      const a = addresses[(i * 4 + w * 3) % addresses.length]!;
      workplaces.push({
        cfar: 30000000 + i * 10 + w,
        orgnr,
        name: w === 0 ? name : `${name} filial`,
        sni: SNI[i]!,
        sniDivision: SNI[i]!.slice(0, 2),
        sizeClass: String(2 + (i % 4)),
        status: "1",
        visit: { street: `${a.street} ${a.number}${a.letter ?? ""}`, postcode: a.postcode, town: a.town },
        kommun: "1480",
        lan: "14",
        sourceDate: FIXTURE_DATE,
        jurform: "49",
      });
    }
  });
  // Natural persons: a sole trader by personnummer and an estate. Must never be stored.
  const personnummer = withLuhn("850612123");
  const estate = withLuhn("551111222");
  organisations.push(
    { orgnr: personnummer, name: "Anna Andersson Konsult", jurform: "10", source: "fixture", sourceDate: FIXTURE_DATE },
    { orgnr: estate, name: "Dödsbo efter B", jurform: "91", source: "fixture", sourceDate: FIXTURE_DATE },
  );
  workplaces.push({
    cfar: 39999999,
    orgnr: personnummer,
    name: "Anna Andersson Konsult",
    sni: "70220",
    visit: { street: `${addresses[0]!.street} ${addresses[0]!.number}`, postcode: addresses[0]!.postcode, town: "GÖTEBORG" },
    kommun: "1480",
    sourceDate: FIXTURE_DATE,
    jurform: "10",
  });
  const areas: AreaRecord[] = [
        { deso: "1480C1010", regso: "1480R101", kommun: "1480", name: "Centrum västra", lat: FIXTURE_CENTER.lat, lon: FIXTURE_CENTER.lon - 0.004, bbox: [57.69, 11.94, 57.72, 11.967], geometry: box(57.69, 11.94, 57.72, 11.967) },
    { deso: "1480C1020", regso: "1480R101", kommun: "1480", name: "Centrum östra", lat: FIXTURE_CENTER.lat, lon: FIXTURE_CENTER.lon + 0.004, bbox: [57.69, 11.967, 57.72, 11.99], geometry: box(57.69, 11.967, 57.72, 11.99) },
  ];
  const stats: AreaStatRecord[] = [
    { deso: "1480C1010", tableId: "fixture-pop", variable: "population", label: "Folkmängd", period: "2025", value: 1832 },
    { deso: "1480C1020", tableId: "fixture-pop", variable: "population", label: "Folkmängd", period: "2025", value: 2410 },
  ];
  return { organisations, workplaces, addresses, areas, stats, naturalPersonIds: [personnummer, estate] };
}
