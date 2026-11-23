# Getting and loading the data

Two paths, same tables:

- **Incremental (TypeScript, any runtime):** API clients in
  `packages/sources` write through the guarded repository. Good for one
  kommun, a list of companies, or statistics tables.
- **National bulk (Rust, Linux):** `opendata-ingest build` reads bulk files
  into a fresh SQLite database plus snapshot table files; `opendata-rbq
  publish` puts them into an rbq object store (local, or the R2/S3 bucket a
  Worker reads). Every deployment then imports the snapshot.

Each section lists what was verified while building this and what to
check against the provider's current documentation before production use.

## SCB företagsregistret (API)

- Free since June 2025. Request an API key from SCB (scbforetag@scb.se, see
  SCB's page on avgiftsfria uppgifter i företagsregistret); store it in an
  owner-only file and set `scb.api_key_file`.
- Client: base `https://apiafr.scb.se/v1`, header `X-API-Key`, cursor paging
  (`limit`, `cursorId` → `pagination.hasMore/nextCursorId`), at most 5 calls/s
  (the client waits 250 ms between calls and honours `Retry-After`).
- Endpoints used: `/arbetsstallen/kommun/{kod}`, `/juridiskaenheter/kommun/{kod}`,
  `/juridiskaenheter/lan/{lan}`, `/juridiskaenheter/{peOrgNr}`.
- **Verify:** field names come from SCB's variable description and public
  client code; optional fields are read defensively. SCB announced a new API
  for September 2026; check whether paths changed.

```sh
opendata ingest scb --kommun 1480                      # straight into the database
opendata dump scb --kommun 1480 --out dumps/           # JSONL for the Rust bulk build
```

## Bolagsverket värdefulla datamängder

- **Bulk file:** weekly zip, `;`-separated UTF-8 with `$` sub-fields
  (e.g. `5560360793$ORGNR-IDORG`, `Name$FORETAGSNAMN-ORGNAM$date|…`,
  `AB-ORGFO`, postadress `street$town$postcode$SE-LAND`). Read by
  `opendata-ingest --bolagsverket bolagsverket_bulkfil.zip`.
- **API:** OAuth2 client credentials from Bolagsverket's API portal; set
  `bolagsverket.client_id` and `client_secret_file`. The client posts
  `{ "identitetsbeteckning": "…" }` to `/organisationer` and `/dokumentlista`
  and downloads `/dokument/{id}` zips into `annual-reports/<orgnr>/…`.
- **Verify:** this client was written without live access. Token URL, base
  URL, scope and response field paths (see `pick(...)` calls in
  `packages/sources/src/bolagsverket.ts`) should be checked against the
  OpenAPI document in the portal. The test environment URLs are a guess.

```sh
opendata ingest bolagsverket --orgnr 5560360793,5567037485 --documents
```

## Lantmäteriet belägenhetsadresser

- Part of the HVD (high-value datasets) release under CC BY 4.0, with extra
  terms for datasets containing personal data. Apply with a purpose; state
  that addresses are used as places for geocoding and proximity, never linked
  to residents.
- The ingest reads CSV with a column mapping, so convert whatever format you
  receive (GeoPackage, GML) with GDAL, keeping SWEREF 99 TM coordinates:

```sh
ogr2ogr -f CSV adresser.csv belagenhetsadress.gpkg -lco GEOMETRY=AS_XY -lco SEPARATOR=SEMICOLON
# Then map your column names to ours (example names; check the real ones with ogrinfo):
opendata-ingest build --out snapshot/ \
  --addresses adresser.csv \
  --address-columns "id=objektidentitet,street=adressomrade,number=adressplatsnummer,letter=bokstavstillagg,postcode=postnummer,town=postort,kommun=kommunkod,e=X,n=Y"
```

Use `lat=…,lon=…` instead of `n/e` if your export is in WGS 84.

## SCB DeSO areas

Download DeSO (demografiska statistikområden) from SCB as GeoPackage and
convert to GeoJSON; EPSG:3006 is detected and converted.

```sh
ogr2ogr -f GeoJSON deso.geojson deso_2025.gpkg
opendata-ingest build --out snapshot/ --addresses adresser.csv --deso deso.geojson ...
```

Addresses are assigned to areas by point-in-polygon; `area` rows keep the
geometry for point lookups.

## SCB Statistikdatabasen (PxWebApi v2)

Statistics per DeSO, JSON-stat 2.0, CC0. Find table ids and dimension codes in
Statistikdatabasen, then:

```sh
opendata ingest px --table TAB_ID --region-dim Region --filter "ContentsCode=…;Kon=1,2"
```

or list tables under `[[px.tables]]` and run `opendata ingest px`. Regions
are requested in batches of 200 with 400 ms between calls; check SCB's
current call and cell limits.

## National build, end to end

```sh
opendata dump scb --kommun 1480 --out dumps/          # per kommun, or loop over all 290
opendata-ingest build --out snapshot/ --source-date 2026-11-23 \
  --addresses adresser.csv --address-columns "…" \
  --deso deso.geojson \
  --bolagsverket bolagsverket_bulkfil.zip \
  --scb-legal-units dumps/legal-1480.jsonl --scb-workplaces dumps/workplaces-1480.jsonl
opendata-rbq publish --storage-root /var/lib/opendata/objects --dir snapshot/ --label national
opendata snapshot import --label national
```

`opendata-rbq publish` writes to an rbq filesystem store. To feed a Worker,
sync that store's `opendata/` prefix to the R2 bucket (any S3 sync tool), or
publish from TypeScript with `objects.type = "s3"` pointing at R2. The Worker
cron then imports it.

## Attribution

Every result carries attribution strings (`packages/core/src/sources.ts`).
Lantmäteriet's CC BY licence requires it; keep it visible wherever results
are shown.
