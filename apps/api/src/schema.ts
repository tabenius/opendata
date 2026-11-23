export const typeDefs = /* GraphQL */ `
"""
Swedish open government data about legal entities, their workplaces and
areas. Natural persons (sole traders, estates) are never stored or returned.
Every result lists its sources; CC BY sources require the attribution text.
"""
type Query {
  organisation(orgnr: ID!): Organisation
  organisations(filter: OrganisationFilter, first: Int = 20, after: String): OrganisationConnection!
  workplacesNear(point: PointInput, address: String, radiusM: Int = 500, sni: [String!], first: Int = 50, after: String): WorkplaceConnection!
  geocode(address: String!, limit: Int = 5): [GeocodeResult!]!
  area(deso: ID, point: PointInput): Area
  sources: [SourceStatus!]!
}

type Mutation {
  "Start a watch for new workplaces in an area. Sends a confirmation e-mail; nothing is sent until confirmed."
  watchArea(email: String!, kommun: String, deso: String, sniPrefix: String): WatchResult!
}

input PointInput {
  lat: Float!
  lon: Float!
}

input OrganisationFilter {
  query: String
  sni: String
  town: String
  kommun: String
  legalFormCode: String
  status: String
}

type Point {
  lat: Float!
  lon: Float!
}

type Address {
  street: String
  postcode: String
  town: String
}

type Source {
  id: ID!
  name: String!
  publisher: String!
  licence: String!
  attribution: String!
  url: String!
}

type Organisation {
  orgnr: ID!
  orgnrFormatted: String!
  name: String!
  legalForm: String
  legalFormCode: String
  status: String!
  registeredAt: String
  deregisteredAt: String
  deregistrationReason: String
  businessDescription: String
  postAddress: Address!
  sniPrimary: String
  sniCodes: [String!]!
  "The organisation has declined direct marketing (SCB reklamspärr). Respect it."
  adBlock: Boolean!
  sources: [Source!]!
  sourceDate: String!
  workplaces(first: Int = 20, after: String): WorkplaceConnection!
  annualReports: [AnnualReport!]!
}

type OrganisationConnection {
  items: [Organisation!]!
  nextCursor: String
}

type Workplace {
  cfar: ID!
  orgnr: ID!
  name: String
  organisationName: String
  sni: String
  sizeClass: String
  status: String
  visitAddress: Address!
  kommun: String
  lan: String
  location: Point
  geocodeQuality: String
  adBlock: Boolean!
  distanceM: Int
  sourceDate: String!
  organisation: Organisation
}

type WorkplaceConnection {
  items: [Workplace!]!
  nextCursor: String
  totalEstimate: Int
  center: Point
  attribution: [String!]!
}

type GeocodeResult {
  addressId: ID!
  label: String!
  street: String!
  number: String
  letter: String
  postcode: String
  town: String
  kommun: String
  location: Point!
  deso: String
  attribution: String!
}

type AreaStat {
  tableId: String!
  variable: String!
  label: String
  period: String!
  value: Float
}

type Area {
  deso: ID!
  regso: String
  kommun: String
  name: String
  centroid: Point
  stats: [AreaStat!]!
  workplaceCount: Int!
  attribution: [String!]!
}

type AnnualReport {
  documentId: ID!
  orgnr: ID!
  periodEnd: String
  registeredAt: String
  format: String
  "Relative download path when the document is stored, e.g. /files/annual-reports/..."
  downloadPath: String
  sha256: String
  sizeBytes: Int
}

type RunStatus {
  startedAt: String!
  finishedAt: String
  status: String!
  rows: Int!
  skippedNaturalPersons: Int!
}

type SourceStatus {
  id: ID!
  name: String!
  publisher: String!
  licence: String!
  attribution: String!
  url: String!
  lastRun: RunStatus
}

type WatchResult {
  accepted: Boolean!
  message: String!
}
`;
