import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LEGACY_MANIFEST_VERSION } from "./sources";
import type { LegacyRunInventory } from "./inventory";

// D9: "raw paths remain only in the host-private manifest/operator source map"
// and the detailed manifest is "operational import state, not another command or
// Flow ledger". It therefore lives in its own maintenance database beside the
// operator's import authority — never in the committed host-state lineage and
// never in Postgres — and is removed with that authority.

export const IMPORT_MANIFEST_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_sessions (
  import_id TEXT PRIMARY KEY,
  manifest_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_runs (
  import_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scanned_entries INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  PRIMARY KEY (import_id, run_id)
);
CREATE TABLE IF NOT EXISTS import_lanes (
  import_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  inspected_scope TEXT NOT NULL,
  expected_items INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  PRIMARY KEY (import_id, run_id, lane)
);
CREATE TABLE IF NOT EXISTS import_items (
  import_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  source_class TEXT NOT NULL,
  disposition TEXT NOT NULL,
  association_key TEXT NOT NULL,
  row_fingerprint TEXT,
  association_locator TEXT,
  relative_path TEXT NOT NULL,
  relative_path_digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (import_id, item_id)
);
CREATE TABLE IF NOT EXISTS import_blocks (
  import_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lane TEXT,
  reason TEXT NOT NULL,
  relative_path_digest TEXT NOT NULL,
  PRIMARY KEY (import_id, run_id, reason, relative_path_digest)
);
`;

export type ImportManifestStore = {
  recordRun(input: {
    inventory: LegacyRunInventory;
    sourcePaths: ReadonlyMap<string, string>;
    associationLocators: ReadonlyMap<string, string>;
  }): void;
  close(): void;
};

export function openImportManifestStore(input: {
  file: string;
  importId: string;
}): ImportManifestStore {
  const db = new DatabaseSync(input.file);

  chmodSync(input.file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${IMPORT_MANIFEST_SCHEMA_VERSION}`);
  db.prepare(
    `INSERT INTO import_sessions (import_id, manifest_version) VALUES (?, ?)
     ON CONFLICT (import_id) DO NOTHING`,
  ).run(input.importId, LEGACY_MANIFEST_VERSION);

  const upsertRun = db.prepare(
    `INSERT INTO import_runs
      (import_id, run_id, scanned_entries, total_bytes, complete)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (import_id, run_id) DO UPDATE SET
       scanned_entries = excluded.scanned_entries,
       total_bytes = excluded.total_bytes,
       complete = excluded.complete`,
  );
  const upsertLane = db.prepare(
    `INSERT INTO import_lanes
      (import_id, run_id, lane, manifest_digest, inspected_scope,
       expected_items, total_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (import_id, run_id, lane) DO UPDATE SET
       manifest_digest = excluded.manifest_digest,
       inspected_scope = excluded.inspected_scope,
       expected_items = excluded.expected_items,
       total_bytes = excluded.total_bytes`,
  );
  const clearItems = db.prepare(
    "DELETE FROM import_items WHERE import_id = ? AND run_id = ?",
  );
  const clearBlocks = db.prepare(
    "DELETE FROM import_blocks WHERE import_id = ? AND run_id = ?",
  );
  const insertItem = db.prepare(
    `INSERT INTO import_items
      (import_id, item_id, run_id, lane, source_class, disposition,
       association_key, row_fingerprint, association_locator, relative_path,
       relative_path_digest, size_bytes, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO import_blocks
      (import_id, run_id, lane, reason, relative_path_digest)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (import_id, run_id, reason, relative_path_digest) DO NOTHING`,
  );

  return {
    recordRun({ inventory, sourcePaths, associationLocators }) {
      db.exec("BEGIN");
      try {
        upsertRun.run(
          input.importId,
          inventory.runId,
          inventory.scannedEntries,
          inventory.totalBytes,
          inventory.complete ? 1 : 0,
        );
        clearItems.run(input.importId, inventory.runId);
        clearBlocks.run(input.importId, inventory.runId);

        for (const lane of Object.values(inventory.lanes)) {
          upsertLane.run(
            input.importId,
            inventory.runId,
            lane.lane,
            lane.manifestDigest,
            lane.inspectedScope,
            lane.expectedItems,
            lane.totalBytes,
          );

          for (const item of lane.items) {
            const relativePath = sourcePaths.get(item.relativePathDigest);

            if (!relativePath)
              throw new Error(
                `manifest item ${item.itemId} has no operator source-map entry`,
              );
            insertItem.run(
              input.importId,
              item.itemId,
              inventory.runId,
              item.lane,
              item.sourceClass,
              item.disposition,
              item.associationKey,
              item.rowFingerprint,
              associationLocators.get(item.associationKey) ?? null,
              relativePath,
              item.relativePathDigest,
              item.size,
              item.sha256,
            );
          }
        }

        for (const block of inventory.blocks) {
          insertBlock.run(
            input.importId,
            inventory.runId,
            block.lane,
            block.reason,
            block.relativePathDigest,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
