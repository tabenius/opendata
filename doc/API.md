# API

The same read model is served three ways. All three apply the privacy rules
in [PRIVACY.md](PRIVACY.md): natural persons are never returned.

| Surface | Path | Use it for |
|---|---|---|
| GraphQL | `POST /graphql` | The PWA; clients that want nested data in one round trip |
| REST | `GET /api/v1/...` | Plain URLs, HTTP caching, scripts (`curl`, spreadsheets) |
| MCP | `POST /mcp` (Streamable HTTP), `opendata mcp` (stdio) | AI assistants |

## REST `/api/v1`

The OpenAPI 3.1 description is at `/api/v1/openapi.json`.

| Route | Notes |
|---|---|
| `GET /organisations?query=&sni=&town=&kommun=&legalFormCode=&status=&first=&after=` | Search; cursor paging |
| `GET /organisations/{orgnr}` | One organisation plus annual reports; 404 for unknown ids and personnummer |
| `GET /organisations/{orgnr}/workplaces` | Workplaces (CFAR) of an organisation |
| `GET /workplaces/near?lat=&lon=` or `?address=`, `&radius=&sni=56,47&first=&after=` | Nearest first, with `distanceM` |
| `GET /geocode?q=&limit=` | Address search (Lantmäteriet) |
| `GET /areas/{deso}`, `GET /areas?lat=&lon=` | DeSO statistics |
| `GET /sni/sections`, `GET /sni/{code}` | SNI 2007 sections and code titles |
| `GET /sources` | Source freshness |

Errors are RFC 9457 `application/problem+json` (400 for bad input, 404).
Every 200 has a weak `ETag` derived from the data version (active snapshot
and last ingest run) and the URL, and `Cache-Control: public, max-age=300,
stale-while-revalidate=3600`. Send `If-None-Match` to get `304` until the
data changes.

Responses that include CC BY data carry an `attribution` array; show it.

## GraphQL additions

- `Organisation.sniSection`, `Organisation.sniTitle`, `Workplace.sniSection`,
  `Workplace.sniTitle`, and `Query.sniSections`. Sections are static (SNI
  2007 avdelningar A–U); titles come from the `sni` table when the SCB code
  list is loaded.
- `Workplace.organisation` is batched per request: a page of 50 workplaces
  costs one organisation query, not 50.

## Limits

- 120 requests per client per minute (configurable); 429 with `Retry-After`.
- GraphQL and MCP bodies: 64 KiB, enforced on the bytes read. URLs: 8 KiB.
- GraphQL depth 8, 300 fields.
- `watchArea`: 5 requests per client per hour.
