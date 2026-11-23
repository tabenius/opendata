/**
 * SCB Statistikdatabasen, PxWebApi v2 (CC0): table data as JSON-stat 2.0.
 *   GET {base}/tables/{id}/data?lang=sv&outputFormat=json-stat2&valueCodes[Dim]=a,b
 * SCB allows a limited number of calls per 10 s per IP and caps cells per
 * request, so region codes are requested in batches with a polite interval.
 */
import type { AreaStatRecord, Repository, WriteReport } from "@opendata/core";
import { PoliteFetcher, type PoliteFetchOptions } from "./http";

export const PX_BASE = "https://statistikdatabasen.scb.se/api/v2";

export interface JsonStat2 {
  id: string[];
  size: number[];
  dimension: Record<string, { label?: string; category: { index: Record<string, number> | string[]; label?: Record<string, string> } }>;
  value: (number | null)[] | Record<string, number | null>;
  label?: string;
}

export interface PxCell {
  coords: Record<string, string>;
  labels: Record<string, string>;
  value: number | null;
}

function categories(dim: JsonStat2["dimension"][string]): string[] {
  const index = dim.category.index;
  if (Array.isArray(index)) return index;
  return Object.entries(index).sort((a, b) => a[1] - b[1]).map(([code]) => code);
}

/** Flatten JSON-stat 2.0 into one cell per value (row-major, last dimension fastest). */
export function flattenJsonStat(doc: JsonStat2): PxCell[] {
  const dims = doc.id.map((id) => ({ id, codes: categories(doc.dimension[id]!), labels: doc.dimension[id]!.category.label ?? {} }));
  const total = doc.size.reduce((a, b) => a * b, 1);
  const cells: PxCell[] = [];
  for (let i = 0; i < total; i++) {
    let rest = i;
    const coords: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (let d = dims.length - 1; d >= 0; d--) {
      const size = doc.size[d]!;
      const code = dims[d]!.codes[rest % size]!;
      coords[dims[d]!.id] = code;
      labels[dims[d]!.id] = dims[d]!.labels[code] ?? code;
      rest = Math.floor(rest / size);
    }
    const value = Array.isArray(doc.value) ? doc.value[i] ?? null : doc.value[String(i)] ?? null;
    cells.push({ coords, labels, value });
  }
  return cells;
}

export interface PxTableSpec {
  id: string;
  /** Dimension holding DeSO/RegSO codes (SCB usually calls it "Region"). */
  regionDimension?: string;
  timeDimension?: string;
  /** Fixed selections for other dimensions, e.g. { ContentsCode: "000005FF" }. */
  filters?: Record<string, string>;
}

export class PxClient {
  private readonly http: PoliteFetcher;
  private readonly base: string;
  constructor(options: Partial<PoliteFetchOptions> & { baseUrl?: string } = {}) {
    this.http = new PoliteFetcher({ minIntervalMs: 400, ...options });
    this.base = (options.baseUrl ?? PX_BASE).replace(/\/$/, "");
  }

  async data(table: PxTableSpec, regions: string[]): Promise<JsonStat2> {
    if (!/^[A-Za-z0-9_]+$/.test(table.id)) throw new TypeError("invalid table id");
    const params = new URLSearchParams({ lang: "sv", outputFormat: "json-stat2" });
    params.set(`valueCodes[${table.regionDimension ?? "Region"}]`, regions.join(","));
    for (const [dim, codes] of Object.entries(table.filters ?? {})) params.set(`valueCodes[${dim}]`, codes);
    return this.http.json<JsonStat2>(`${this.base}/tables/${table.id}/data?${params}`);
  }
}

/** Fetch a table for every known DeSO, batch by batch, and store it as area statistics. */
export async function ingestPxTable(client: PxClient, repo: Repository, table: PxTableSpec, regions: string[], batchSize = 200): Promise<WriteReport & { runId: string }> {
  const runId = await repo.startRun("scb-px");
  const regionDim = table.regionDimension ?? "Region";
  const timeDim = table.timeDimension ?? "Tid";
  let written = 0;
  try {
    for (let i = 0; i < regions.length; i += batchSize) {
      const doc = await client.data(table, regions.slice(i, i + batchSize));
      const records: AreaStatRecord[] = flattenJsonStat(doc).map((cell) => {
        const others = Object.keys(cell.coords).filter((d) => d !== regionDim && d !== timeDim);
        return {
          deso: cell.coords[regionDim]!,
          tableId: table.id,
          variable: others.map((d) => `${d}=${cell.coords[d]}`).join(";") || "value",
          label: others.map((d) => cell.labels[d]).join(", ") || doc.label || null,
          period: cell.coords[timeDim] ?? "",
          value: cell.value,
        };
      });
      written += (await repo.upsertAreaStats(records)).written;
    }
    await repo.finishRun(runId, { status: "ok", rows: written, detail: `table ${table.id}` });
  } catch (error) {
    await repo.finishRun(runId, { status: "failed", rows: written, detail: (error as Error).message.slice(0, 200) });
    throw error;
  }
  return { written, skippedNaturalPersons: 0, skippedInvalid: 0, runId };
}
