/**
 * Bolagsverket "Värdefulla datamängder" API (free; EU high-value dataset).
 * OAuth2 client credentials from portal.api.bolagsverket.se, then
 *   POST {base}/organisationer   { identitetsbeteckning }
 *   POST {base}/dokumentlista    { identitetsbeteckning }
 *   GET  {base}/dokument/{id}    -> zip with the digitally filed annual report
 *
 * Response field paths are read defensively from several spellings, because
 * this client was written without access to the live API; check them
 * against Bolagsverket's OpenAPI before relying on the optional fields.
 * Identity, name and legal form are the ones that matter, and the privacy
 * guard fails closed if they are missing.
 */
import { parseObjectKey, type ObjectStore } from "@opendata/ports";
import { classify, mergeReports, type AnnualReportRecord, type OrganisationRecord, type Repository, type WriteReport } from "@opendata/core";
import { sha256Hex } from "@opendata/rbq";
import { PoliteFetcher, SourceHttpError, type PoliteFetchOptions } from "./http";

export const BOLAGSVERKET_ENVIRONMENTS = {
  prod: { token: "https://portal.api.bolagsverket.se/oauth2/token", base: "https://gw.api.bolagsverket.se/vardefulla-datamangder/v1" },
  test: { token: "https://portal-accept2.api.bolagsverket.se/oauth2/token", base: "https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1" },
} as const;

export const BOLAGSVERKET_SCOPE = "vardefulla-datamangder:read vardefulla-datamangder:ping";
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export interface BolagsverketOptions extends Partial<PoliteFetchOptions> {
  clientId: string;
  clientSecret: string;
  environment?: keyof typeof BOLAGSVERKET_ENVIRONMENTS;
  tokenUrl?: string;
  baseUrl?: string;
}

type Json = Record<string, unknown>;

/** First defined value among dotted paths. */
export function pick(obj: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split(".")) {
      if (cur === null || cur === undefined) break;
      cur = Array.isArray(cur) ? (cur[0] as Json | undefined)?.[part] : (cur as Json)[part];
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === "object" ? null : String(v).trim() || null);

export class BolagsverketClient {
  private readonly http: PoliteFetcher;
  private readonly tokenUrl: string;
  private readonly base: string;
  private token?: { value: string; expires: number };

  constructor(private readonly options: BolagsverketOptions) {
    if (!options.clientId || !options.clientSecret) throw new TypeError("Bolagsverket client id and secret are required");
    const env = BOLAGSVERKET_ENVIRONMENTS[options.environment ?? "prod"];
    this.tokenUrl = options.tokenUrl ?? env.token;
    this.base = (options.baseUrl ?? env.base).replace(/\/$/, "");
    this.http = new PoliteFetcher({ minIntervalMs: 200, ...options });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: BOLAGSVERKET_SCOPE });
    const response = await this.http.fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${this.options.clientId}:${this.options.clientSecret}`)}`,
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceHttpError(response.status, "/oauth2/token", `token request failed with HTTP ${response.status}`);
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new TypeError("token response lacks access_token");
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.http.json<T>(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  async organisation(orgnr: string): Promise<Json[]> {
    const body = await this.post<Json>("/organisationer", { identitetsbeteckning: orgnr });
    const list = body.organisationer ?? body.organisation ?? [];
    return (Array.isArray(list) ? list : [list]) as Json[];
  }

  async documentList(orgnr: string): Promise<Json[]> {
    const body = await this.post<Json>("/dokumentlista", { identitetsbeteckning: orgnr });
    const list = body.dokument ?? body.dokumentlista ?? [];
    return (Array.isArray(list) ? list : []) as Json[];
  }

  async document(documentId: string): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(documentId)) throw new TypeError("unexpected document id");
    const response = await this.http.fetch(`${this.base}/dokument/${encodeURIComponent(documentId)}`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/zip" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceHttpError(response.status, "/dokument", `document download failed with HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOCUMENT_BYTES) throw new RangeError("document exceeds 50 MiB");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new RangeError("document exceeds 50 MiB");
    return bytes;
  }
}

export function mapBolagsverketOrganisation(o: Json, sourceDate: string): OrganisationRecord | null {
  const id = text(pick(o, "organisationsidentitet.identitetsbeteckning", "identitetsbeteckning"));
  const idType = text(pick(o, "organisationsidentitet.typ.kod", "identitetsbeteckningstyp.kod"));
  const names = pick(o, "organisationsnamn.organisationsnamnLista", "organisationsnamn") as unknown;
  let name: string | null = null;
  if (Array.isArray(names)) {
    const main = (names as Json[]).find((n) => /FORETAGSNAMN/.test(String(pick(n, "organisationsnamntyp.kod") ?? ""))) ?? names[0];
    name = text(pick(main, "namn"));
  } else name = text(pick(o, "organisationsnamn.namn", "namn"));
  if (!id || !name) return null;
  const formCode = text(pick(o, "organisationsform.kod"));
  const dereg = text(pick(o, "avregistreringsdatum", "avregistreradOrganisation.avregistreringsdatum"));
  const sni = pick(o, "naringsgrenOrganisation.sni") as Json[] | undefined;
  return {
    orgnr: id,
    idType,
    bvForm: formCode,
    name,
    legalForm: text(pick(o, "organisationsform.klartext")),
    legalFormCode: formCode,
    status: dereg ? "deregistered" : "active",
    registeredAt: text(pick(o, "organisationsdatum.registreringsdatum", "registreringsdatum")),
    deregisteredAt: dereg,
    deregistrationReason: text(pick(o, "avregistreringsorsak.klartext", "avregistreringsorsak.kod")),
    businessDescription: text(pick(o, "verksamhetsbeskrivning.beskrivning", "verksamhetsbeskrivning")),
    post: {
      street: text(pick(o, "postadressOrganisation.postadress.utdelningsadress", "postadress.utdelningsadress")),
      postcode: text(pick(o, "postadressOrganisation.postadress.postnummer", "postadress.postnummer")),
      town: text(pick(o, "postadressOrganisation.postadress.postort", "postadress.postort")),
    },
    sniCodes: Array.isArray(sni) ? sni.map((s) => text(pick(s, "kod"))).filter((c): c is string => Boolean(c)) : null,
    sniPrimary: Array.isArray(sni) ? text(pick(sni[0], "kod")) : null,
    source: "bolagsverket-hvd",
    sourceDate,
  };
}

function safeSegment(id: string) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(id) ? id : sha256Hex(new TextEncoder().encode(id)).slice(0, 32);
}

export interface BolagsverketIngestResult extends WriteReport {
  runId: string;
  documents: number;
  documentBytes: number;
}

/**
 * Fetch organisations (and optionally their annual reports) by number. The
 * privacy guard runs before any document request, so nothing is fetched or
 * stored for natural persons.
 */
export async function ingestBolagsverket(
  client: BolagsverketClient,
  repo: Repository,
  orgnrs: string[],
  options: { objects?: ObjectStore; documents?: boolean; sourceDate?: string } = {},
): Promise<BolagsverketIngestResult> {
  const sourceDate = options.sourceDate ?? new Date().toISOString().slice(0, 10);
  const runId = await repo.startRun("bolagsverket-hvd");
  let report: WriteReport = { written: 0, skippedNaturalPersons: 0, skippedInvalid: 0 };
  let documents = 0;
  let documentBytes = 0;
  try {
    for (const raw of orgnrs) {
      const id = raw.replace(/[\s-]/g, "");
      if (classify({ id }) !== "legal") {
        report.skippedNaturalPersons++;
        continue;
      }
      const records = (await client.organisation(id)).map((o) => mapBolagsverketOrganisation(o, sourceDate)).filter((r) => r !== null);
      const written = await repo.upsertOrganisations(records);
      report = mergeReports(report, written);
      if (!options.documents || !options.objects || written.written === 0) continue;
      const reports: AnnualReportRecord[] = [];
      for (const doc of await client.documentList(id)) {
        const documentId = text(pick(doc, "dokumentId", "id"));
        if (!documentId) continue;
        const bytes = await client.document(documentId);
        const key = `annual-reports/${id}/${safeSegment(documentId)}.zip`;
        await options.objects.putIfAbsent(parseObjectKey(key), bytes);
        reports.push({
          documentId,
          orgnr: id,
          periodEnd: text(pick(doc, "rapporteringsperiodTom", "rakenskapsperiodTom")),
          registeredAt: text(pick(doc, "registreringstidpunkt", "registreringsdatum")),
          format: text(pick(doc, "filformat")) ?? "zip",
          objectKey: key,
          sha256: sha256Hex(bytes),
          sizeBytes: bytes.length,
        });
        documents++;
        documentBytes += bytes.length;
      }
      await repo.upsertAnnualReports(reports);
    }
    await repo.finishRun(runId, { status: "ok", rows: report.written, skippedNaturalPersons: report.skippedNaturalPersons, detail: `${documents} documents` });
  } catch (error) {
    await repo.finishRun(runId, { status: "failed", rows: report.written, detail: (error as Error).message.slice(0, 200) });
    throw error;
  }
  return { ...report, runId, documents, documentBytes };
}
