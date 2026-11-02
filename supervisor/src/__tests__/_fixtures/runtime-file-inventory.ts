import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HOST_STATE_FILE, openHostState } from "../../host-state";

export const CORRUPT_PATH_QUERY =
  "SELECT 1 FROM runtime_objects WHERE private_path = ? AND state = 'corrupt'";
export const INVENTORY_FILE_BYTES = 64;

/** Real retained files and catalog rows, with one percent marked corrupt. */
export function seedRuntimeInventory(stateDir: string, count: number): string {
  const state = openHostState({ stateDir });
  const hostKey = state.hostKey;

  state.close();
  const objectRoot = join(realpathSync(stateDir), "runtime-objects");
  const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
  const bytes = Buffer.alloc(INVENTORY_FILE_BYTES, 120);

  try {
    mkdirSync(objectRoot, { recursive: true });
    const object = db.prepare(`INSERT INTO runtime_objects
      (id, run_id, assignment_id, assignment_epoch, kind, logical_name,
       mime_type, size_bytes, generation, retention_class, state, private_path, created_at)
      VALUES (?, 'inventory-run', 'inventory-assignment', 1, 'evidence', ?,
        'application/octet-stream', ?, 1, 'run', ?, ?, '2026-11-02T00:00:00.000Z')`);
    const file = db.prepare(`INSERT INTO runtime_files
      (file_id, private_path, kind, capacity_bytes, written_bytes, sealed)
      VALUES (?, ?, 'object', ?, ?, 1)`);

    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < count; index += 1) {
      const id = `object-${String(index).padStart(6, "0")}`;
      const privatePath = join(objectRoot, id);

      writeFileSync(privatePath, bytes);
      object.run(
        id,
        id,
        bytes.length,
        index % 100 === 0 ? "corrupt" : "available",
        privatePath,
      );
      file.run(id, privatePath, bytes.length, bytes.length);
    }
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }

  return hostKey;
}

/** Version 14 differs from the current schema only by this missing index. */
export function restoreV14InventorySchema(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    DROP INDEX runtime_objects_corrupt_path_idx;
    PRAGMA user_version = 14;
    COMMIT;`);
}

export function corruptPathPlan(
  db: DatabaseSync,
  privatePath: string,
): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${CORRUPT_PATH_QUERY}`)
    .all(privatePath)
    .map((row) => String(row.detail));
}
