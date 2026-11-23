/** Snapshot publish/import glue between the core tables and rbq layer `opendata`. */
import { activeSnapshot, exportTables, importSnapshot, snapshotOwner, type ImportState, type SnapshotMeta } from "@opendata/core";
import { listSnapshots, publishSnapshot, sha256Hex, type PublishOutcome, type SnapshotManifest } from "@opendata/rbq";
import type { ObjectStore, SqlStore } from "@opendata/ports";

export const LAYER = "opendata";

export async function publishDatabase(sql: SqlStore, objects: ObjectStore, label: string, options: { chunkBytes?: number; runId?: string } = {}): Promise<PublishOutcome> {
  const files = await exportTables(sql);
  const meta = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === "meta.json")!.data)) as SnapshotMeta;
  return publishSnapshot(objects, { layer: LAYER, label, files, owner: snapshotOwner(meta), chunkBytes: options.chunkBytes, runId: options.runId ?? null });
}

export async function latestSnapshot(objects: ObjectStore, label: string): Promise<SnapshotManifest | null> {
  const all = await listSnapshots(objects, LAYER, label);
  return all.at(-1) ?? null;
}

export interface SyncResult {
  snapshot: string | null;
  active: string | null;
  state?: ImportState;
}

/** Import the newest snapshot under `label` if it is not active yet (resumable). */
export async function syncLatest(sql: SqlStore, objects: ObjectStore, label: string, rowBudget?: number): Promise<SyncResult> {
  const latest = await latestSnapshot(objects, label);
  const active = await activeSnapshot(sql);
  if (!latest || latest.id === active) return { snapshot: latest?.id ?? null, active };
  const state = await importSnapshot(sql, objects, latest, { rowBudget, sha256Hex });
  return { snapshot: latest.id, active: await activeSnapshot(sql), state };
}
