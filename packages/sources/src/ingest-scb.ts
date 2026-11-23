import { mergeReports, type Repository, type WriteReport } from "@opendata/core";
import { mapLegalUnit, mapWorkplace, type ScbFrClient } from "./scb-fr";

export interface ScbIngestResult extends WriteReport {
  runId: string;
  calls: number;
  workplacesFetched: number;
  legalUnitsFetched: number;
}

/**
 * Ingest one kommun: legal units (kommun, then the county for units seated
 * elsewhere), then workplaces. Natural persons are counted and dropped by
 * the repository; nothing about them is kept, logged or returned.
 */
export async function ingestScbKommun(client: ScbFrClient, repo: Repository, kommun: string, sourceDate = new Date().toISOString().slice(0, 10)): Promise<ScbIngestResult> {
  const runId = await repo.startRun("scb-fr");
  let report: WriteReport = { written: 0, skippedNaturalPersons: 0, skippedInvalid: 0 };
  const jurform = new Map<string, string | null>();
  let legalUnitsFetched = 0;
  let workplacesFetched = 0;
  try {
    const lan = kommun.slice(0, 2);
    for (const source of [client.legalUnitsInKommun(kommun), client.legalUnitsInLan(lan)]) {
      for await (const rows of source) {
        legalUnitsFetched += rows.length;
        const records = [];
        for (const row of rows) {
          if (jurform.has(String(row.peOrgNr))) continue;
          jurform.set(String(row.peOrgNr), row.jurform === null || row.jurform === undefined ? null : String(row.jurform));
          const record = mapLegalUnit(row, sourceDate);
          if (record) records.push(record);
        }
        report = mergeReports(report, await repo.upsertOrganisations(records));
      }
    }
    for await (const rows of client.workplacesInKommun(kommun)) {
      workplacesFetched += rows.length;
      const records = rows.map((r) => mapWorkplace(r, sourceDate, (id) => jurform.get(id))).filter((r) => r !== null);
      report = mergeReports(report, await repo.upsertWorkplaces(records));
    }
    await repo.finishRun(runId, { status: "ok", rows: report.written, skippedNaturalPersons: report.skippedNaturalPersons, detail: `kommun ${kommun}` });
  } catch (error) {
    await repo.finishRun(runId, { status: "failed", rows: report.written, skippedNaturalPersons: report.skippedNaturalPersons, detail: (error as Error).message.slice(0, 200) });
    throw error;
  }
  return { ...report, runId, calls: client.calls, workplacesFetched, legalUnitsFetched };
}
