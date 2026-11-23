import type { Migration } from "@opendata/ports";

/**
 * Append-only. Never edit an applied migration; add a new one.
 * No triggers (D1 script splitting and FTS maintenance stay explicit).
 *
 * Privacy: these tables hold legal entities only. Natural persons
 * (sole traders, estates) are refused at the single write path
 * (`@opendata/core` privacy.ts) and never reach the database.
 */
export const migrations: Migration[] = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE organisation (
  orgnr TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_form TEXT,
  legal_form_code TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  registered_at TEXT,
  deregistered_at TEXT,
  deregistration_reason TEXT,
  business_description TEXT,
  post_street TEXT,
  post_postcode TEXT,
  post_town TEXT,
  sni_primary TEXT,
  sni_codes TEXT,
  ad_block INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL,
  source_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX organisation_sni ON organisation(sni_primary);
CREATE INDEX organisation_town ON organisation(post_town);
CREATE VIRTUAL TABLE organisation_fts USING fts5(orgnr UNINDEXED, name, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE workplace (
  cfar INTEGER PRIMARY KEY,
  orgnr TEXT NOT NULL,
  name TEXT,
  sni TEXT,
  sni_division TEXT,
  size_class TEXT,
  status TEXT,
  visit_street TEXT,
  visit_postcode TEXT,
  visit_town TEXT,
  kommun TEXT,
  lan TEXT,
  post_street TEXT,
  post_postcode TEXT,
  post_town TEXT,
  address_id TEXT,
  lat REAL,
  lon REAL,
  cell INTEGER,
  geocode_quality TEXT,
  ad_block INTEGER NOT NULL DEFAULT 0,
  source_date TEXT NOT NULL
);
CREATE INDEX workplace_orgnr ON workplace(orgnr);
CREATE INDEX workplace_cell ON workplace(cell);
CREATE INDEX workplace_kommun_sni ON workplace(kommun, sni);

CREATE TABLE address (
  address_id TEXT PRIMARY KEY,
  street TEXT NOT NULL,
  number TEXT,
  letter TEXT,
  postcode TEXT,
  town TEXT,
  kommun TEXT,
  match_key TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  cell INTEGER NOT NULL,
  deso TEXT,
  source_date TEXT NOT NULL
);
CREATE INDEX address_match ON address(match_key);
CREATE INDEX address_cell ON address(cell);
CREATE VIRTUAL TABLE address_fts USING fts5(address_id UNINDEXED, label, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE area (
  deso TEXT PRIMARY KEY,
  regso TEXT,
  kommun TEXT,
  name TEXT,
  lat REAL,
  lon REAL,
  min_lat REAL,
  min_lon REAL,
  max_lat REAL,
  max_lon REAL,
  geometry_key TEXT
);

CREATE TABLE area_stat (
  deso TEXT NOT NULL,
  table_id TEXT NOT NULL,
  variable TEXT NOT NULL,
  label TEXT,
  period TEXT NOT NULL,
  value REAL,
  PRIMARY KEY (deso, table_id, variable, period)
);

CREATE TABLE annual_report (
  document_id TEXT PRIMARY KEY,
  orgnr TEXT NOT NULL,
  period_end TEXT,
  registered_at TEXT,
  format TEXT,
  object_key TEXT,
  sha256 TEXT,
  size_bytes INTEGER
);
CREATE INDEX annual_report_orgnr ON annual_report(orgnr);

CREATE TABLE sni (
  code TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE source_run (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  skipped_natural_persons INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  detail TEXT
);
CREATE INDEX source_run_source ON source_run(source, started_at);

CREATE TABLE dataset_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watch (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  kommun TEXT,
  deso TEXT,
  sni_prefix TEXT,
  confirm_token TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  unsubscribe_token TEXT NOT NULL
);
CREATE INDEX watch_email ON watch(email);

CREATE TABLE watch_seen (
  watch_id TEXT NOT NULL,
  cfar INTEGER NOT NULL,
  PRIMARY KEY (watch_id, cfar)
);
`,
  },
  {
    id: "0002_snapshots",
    sql: `
ALTER TABLE organisation ADD COLUMN snapshot TEXT;
ALTER TABLE workplace ADD COLUMN snapshot TEXT;
ALTER TABLE address ADD COLUMN snapshot TEXT;
ALTER TABLE area ADD COLUMN snapshot TEXT;
ALTER TABLE area ADD COLUMN geometry TEXT;
ALTER TABLE area_stat ADD COLUMN snapshot TEXT;
ALTER TABLE annual_report ADD COLUMN snapshot TEXT;
ALTER TABLE sni ADD COLUMN snapshot TEXT;
CREATE INDEX area_bbox ON area(min_lat, max_lat);
`,
  },
];
