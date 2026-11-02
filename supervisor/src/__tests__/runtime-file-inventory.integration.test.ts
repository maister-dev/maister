import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_STATE_FILE,
  HOST_STATE_SCHEMA_VERSION,
  openHostState,
} from "../host-state";

import {
  CORRUPT_PATH_QUERY,
  corruptPathPlan,
  INVENTORY_FILE_BYTES,
  restoreV14InventorySchema,
  seedRuntimeInventory,
} from "./_fixtures/runtime-file-inventory";

const roots: string[] = [];

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "maister-inventory-index-"));

  roots.push(root);

  return join(realpathSync(root), "state");
}

function expectIndexed(db: DatabaseSync, privatePath: string): void {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: HOST_STATE_SCHEMA_VERSION,
  });
  const plan = corruptPathPlan(db, privatePath).join("\n");

  expect(plan).toMatch(
    /SEARCH runtime_objects USING (?:COVERING )?INDEX runtime_objects_corrupt_path_idx \(private_path=\?\)/,
  );
  expect(plan).not.toContain("SCAN runtime_objects");
  expect(db.prepare("PRAGMA index_list(runtime_objects)").all()).toContainEqual(
    expect.objectContaining({
      name: "runtime_objects_corrupt_path_idx",
      unique: 0,
      partial: 1,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("runtime inventory corrupt-path index", () => {
  it("indexes a fresh installation and keeps the index on reopen", () => {
    const stateDir = stateDirectory();
    let hostKey: string | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = openHostState({ stateDir });
      const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

      try {
        if (hostKey !== undefined) expect(state.hostKey).toBe(hostKey);
        hostKey = state.hostKey;
        expectIndexed(db, "/absent");
        expect(state.runtimeFileBudget().chargedBytes).toBe(0);
      } finally {
        db.close();
        state.close();
      }
    }
  });

  it("upgrades a populated v14 database before inventory and preserves its state on reopen", () => {
    const stateDir = stateDirectory();
    const hostKey = seedRuntimeInventory(stateDir, 200);
    const file = join(stateDir, "runtime-objects", "object-000000");
    const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
    const before = legacy
      .prepare("SELECT * FROM runtime_objects ORDER BY id")
      .all();
    const filesBefore = legacy
      .prepare("SELECT * FROM runtime_files ORDER BY file_id")
      .all();

    try {
      restoreV14InventorySchema(legacy);
      expect(corruptPathPlan(legacy, file)).toEqual(["SCAN runtime_objects"]);
    } finally {
      legacy.close();
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = openHostState({ stateDir });
      const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

      try {
        expect(state.hostKey).toBe(hostKey);
        expectIndexed(db, file);
        expect(
          db.prepare("SELECT * FROM runtime_objects ORDER BY id").all(),
        ).toEqual(before);
        expect(
          db.prepare("SELECT * FROM runtime_files ORDER BY file_id").all(),
        ).toEqual(filesBefore);
        expect(state.runtimeFileBudget()).toMatchObject({
          chargedBytes: 200 * INVENTORY_FILE_BYTES,
          writtenBytes: 200 * INVENTORY_FILE_BYTES,
          unusedBytes: 0,
        });
        expect(readFileSync(file)).toEqual(
          Buffer.alloc(INVENTORY_FILE_BYTES, 120),
        );
      } finally {
        db.close();
        state.close();
      }
    }
  });

  it("maintains the partial index for state changes and permits duplicate corrupt paths", () => {
    const stateDir = stateDirectory();

    seedRuntimeInventory(stateDir, 2);
    const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
    const file = join(stateDir, "runtime-objects", "object-000001");

    try {
      const lookup = db.prepare(CORRUPT_PATH_QUERY);

      expect(lookup.get(file)).toBeUndefined();
      db.prepare(
        "UPDATE runtime_objects SET state = 'corrupt' WHERE id = ?",
      ).run("object-000001");
      expect(lookup.get(file)).toBeDefined();
      db.exec(`INSERT INTO runtime_objects
        (id, run_id, assignment_id, assignment_epoch, kind, logical_name,
         mime_type, generation, retention_class, state, private_path, created_at)
        SELECT 'duplicate', run_id, assignment_id, assignment_epoch, kind, logical_name,
          mime_type, generation, retention_class, state, private_path, created_at
        FROM runtime_objects WHERE id = 'object-000001'`);
      expect(lookup.all(file)).toHaveLength(2);
      db.exec(
        "UPDATE runtime_objects SET state = 'available' WHERE id IN ('object-000001', 'duplicate')",
      );
      expect(lookup.get(file)).toBeUndefined();
      expectIndexed(db, file);
    } finally {
      db.close();
    }
  });

  it.each(["oversized", "symlink"] as const)(
    "retains and charges a known corrupt %s through upgrade and reopen",
    (kind) => {
      const stateDir = stateDirectory();

      seedRuntimeInventory(stateDir, 1);
      const file = join(stateDir, "runtime-objects", "object-000000");
      const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

      try {
        restoreV14InventorySchema(db);
      } finally {
        db.close();
      }
      if (kind === "oversized") writeFileSync(file, Buffer.alloc(128, 121));
      else {
        rmSync(file);
        symlinkSync("missing-target", file);
      }
      const bytes = lstatSync(file).size;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = openHostState({ stateDir });

        try {
          expect(state.getRuntimeObject("object-000000")?.state).toBe(
            "corrupt",
          );
          expect(state.runtimeFileBudget()).toMatchObject({
            chargedBytes: Math.max(INVENTORY_FILE_BYTES, bytes),
            writtenBytes: bytes,
          });
          expect(lstatSync(file).size).toBe(bytes);
        } finally {
          state.close();
        }
      }
    },
  );
});
