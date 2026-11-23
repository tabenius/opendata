/** OpenAPI 3.1 description of /api/v1 (hand-written; kept in step by rest.test.ts). */
const page = (item: string) => ({
  type: "object",
  required: ["items", "nextCursor"],
  properties: { items: { type: "array", items: { $ref: `#/components/schemas/${item}` } }, nextCursor: { type: ["string", "null"] }, attribution: { type: "array", items: { type: "string" } } },
});
const q = (name: string, description: string, schema: object = { type: "string" }, required = false) => ({ name, in: "query", required, description, schema });
const path = (name: string, description: string, pattern?: string) => ({ name, in: "path", required: true, description, schema: { type: "string", ...(pattern ? { pattern } : {}) } });
const ok = (schema: object, description = "OK") => ({
  200: { description, headers: { ETag: { schema: { type: "string" } } }, content: { "application/json": { schema } } },
  304: { description: "Not modified (If-None-Match matched)" },
  400: { $ref: "#/components/responses/Problem" },
  429: { description: "Rate limited; see Retry-After" },
});
const notFound = { 404: { $ref: "#/components/responses/Problem" } };
const paging = [q("first", "Page size", { type: "integer", minimum: 1, maximum: 200 }), q("after", "Cursor from nextCursor")];

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "opendata — Swedish open government data",
    version: "1.0.0",
    description:
      "Legal entities, workplaces, addresses and statistical areas from SCB, Bolagsverket and Lantmäteriet. Natural persons are never stored or returned. CC BY sources require the attribution strings included in responses.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/organisations": {
      get: {
        operationId: "searchOrganisations",
        parameters: [
          q("query", "Name search"),
          q("sni", "SNI code or prefix", { type: "string", pattern: "^\\d{1,5}$" }),
          q("town", "Post town"),
          q("kommun", "Kommun code", { type: "string", pattern: "^\\d{4}$" }),
          q("legalFormCode", "SCB legal form code"),
          q("status", "Registration status"),
          ...paging,
        ],
        responses: ok(page("Organisation")),
      },
    },
    "/organisations/{orgnr}": {
      get: { operationId: "getOrganisation", parameters: [path("orgnr", "Organisationsnummer, with or without dash")], responses: { ...ok({ $ref: "#/components/schemas/Organisation" }), ...notFound } },
    },
    "/organisations/{orgnr}/workplaces": {
      get: { operationId: "organisationWorkplaces", parameters: [path("orgnr", "Organisationsnummer"), ...paging], responses: ok(page("Workplace")) },
    },
    "/workplaces/near": {
      get: {
        operationId: "workplacesNear",
        description: "Give either lat+lon or address.",
        parameters: [q("lat", "WGS84 latitude", { type: "number" }), q("lon", "WGS84 longitude", { type: "number" }), q("address", "Street address to geocode"), q("radius", "Metres (max 5000)", { type: "integer" }), q("sni", "Comma-separated SNI prefixes"), ...paging],
        responses: ok(page("Workplace")),
      },
    },
    "/geocode": {
      get: { operationId: "geocode", parameters: [q("q", "Address text", { type: "string" }, true), q("limit", "Max results", { type: "integer", maximum: 20 })], responses: ok({ type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/GeocodeResult" } } } }) },
    },
    "/areas": {
      get: { operationId: "areaAt", parameters: [q("lat", "Latitude", { type: "number" }, true), q("lon", "Longitude", { type: "number" }, true)], responses: { ...ok({ $ref: "#/components/schemas/Area" }), ...notFound } },
    },
    "/areas/{deso}": {
      get: { operationId: "area", parameters: [path("deso", "DeSO code", "^\\d{4}[A-C]\\d{4}$")], responses: { ...ok({ $ref: "#/components/schemas/Area" }), ...notFound } },
    },
    "/sources": { get: { operationId: "sources", responses: ok({ type: "object" }) } },
    "/sni/sections": { get: { operationId: "sniSections", responses: ok({ type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/SniSection" } } } }) } },
    "/sni/{code}": { get: { operationId: "sni", parameters: [path("code", "SNI code")], responses: { ...ok({ type: "object" }), ...notFound } } },
  },
  components: {
    responses: {
      Problem: { description: "RFC 9457 problem", content: { "application/problem+json": { schema: { type: "object", properties: { title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" } } } } } },
    },
    schemas: {
      SniSection: { type: "object", required: ["letter", "title"], properties: { letter: { type: "string" }, title: { type: "string" } } },
      Point: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } },
      Organisation: {
        type: "object",
        required: ["orgnr", "name", "status"],
        properties: {
          orgnr: { type: "string" },
          name: { type: "string" },
          legalForm: { type: ["string", "null"] },
          status: { type: "string" },
          sniPrimary: { type: ["string", "null"] },
          sniSection: { oneOf: [{ $ref: "#/components/schemas/SniSection" }, { type: "null" }] },
          adBlock: { type: "boolean", description: "Declined direct marketing (SCB reklamspärr). Respect it." },
        },
      },
      Workplace: {
        type: "object",
        required: ["cfar", "orgnr"],
        properties: {
          cfar: { type: "string" },
          orgnr: { type: "string" },
          name: { type: ["string", "null"] },
          sni: { type: ["string", "null"] },
          sniSection: { oneOf: [{ $ref: "#/components/schemas/SniSection" }, { type: "null" }] },
          location: { oneOf: [{ $ref: "#/components/schemas/Point" }, { type: "null" }] },
          distanceM: { type: ["integer", "null"] },
          adBlock: { type: "boolean" },
        },
      },
      GeocodeResult: { type: "object", properties: { addressId: { type: "string" }, label: { type: "string" }, location: { $ref: "#/components/schemas/Point" } } },
      Area: { type: "object", properties: { deso: { type: "string" }, kommun: { type: "string" } } },
    },
  },
} as const;
