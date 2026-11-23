/**
 * Generate files shared with the Rust crates:
 *   packages/schema/generated/migrations.json  (id, sql, checksum)
 *   contracts/vectors/core.json                (privacy, geodesy, address vectors)
 * `pnpm gen` writes them; tests fail if they are stale.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checksum } from "../packages/adapters-sql/src/hash";
import { migrations } from "../packages/schema/src/migrations";
import { TABLES, cellOf, classify, matchKey, parseStreetAddress, wgs84ToSweref99tm, withLuhn } from "../packages/core/src";

export function generated() {
  const migrationsJson = JSON.stringify(migrations.map((m) => ({ id: m.id, sql: m.sql, checksum: checksum(m.sql) })), null, 2) + "\n";
  const ids = ["5560360793", "556036-0793", "5560360794", withLuhn("850612123"), "195006121234", "165560360793", "2120000142", "8020022771", "abc"];
  const classification = [
    ...ids.map((id) => ({ id, expect: classify({ id }) })),
    { id: "5560360793", jurform: "10", expect: classify({ id: "5560360793", jurform: "10" }) },
    { id: "5560360793", jurform: "91", expect: classify({ id: "5560360793", jurform: "91" }) },
    { id: "5560360793", jurform: "49", expect: classify({ id: "5560360793", jurform: "49" }) },
    { id: "5560360793", idType: "PERSON-IDORG", expect: classify({ id: "5560360793", idType: "PERSON-IDORG" }) },
    { id: "5560360793", bvForm: "E-ORGFO", expect: classify({ id: "5560360793", bvForm: "E-ORGFO" }) },
  ];
  const points = [
    { lat: 57.7072, lon: 11.9668 },
    { lat: 59.3275, lon: 18.0545 },
    { lat: 67.8558, lon: 20.2253 },
    { lat: 55.605, lon: 13.0038 },
  ].map((p) => ({ ...p, sweref: wgs84ToSweref99tm(p), cell: cellOf(p) }));
  const addresses = ["Storgatan 12 B lgh 1102", "Kaffegatan 1", "Box 123", "Vägen", "Övre Husargatan 3-5"].map((raw) => {
    const parsed = parseStreetAddress(raw);
    return { raw, parsed, key: matchKey({ ...parsed, postcode: "41101" }) };
  });
  const vectors = JSON.stringify({ classification, points, addresses, tables: TABLES }, null, 2) + "\n";
  return { migrationsJson, vectors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { migrationsJson, vectors } = generated();
  writeFileSync(new URL("../packages/schema/generated/migrations.json", import.meta.url), migrationsJson);
  writeFileSync(new URL("../contracts/vectors/core.json", import.meta.url), vectors);
  console.log("wrote packages/schema/generated/migrations.json and contracts/vectors/core.json");
}
