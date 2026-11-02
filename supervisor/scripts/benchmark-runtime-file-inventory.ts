import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  corruptPathPlan,
  restoreV14InventorySchema,
  seedRuntimeInventory,
} from "../src/__tests__/_fixtures/runtime-file-inventory";
import { HOST_STATE_FILE, openHostState } from "../src/host-state";
import { ACTIVE_FRAME_SCHEMA } from "../src/outbox-budget";
import {
  ACTIVE_FILE_PROGRESS_SCHEMA,
  runtimeFileBudgetSnapshot,
} from "../src/runtime-file-budget";
import { inventoryRuntimeFiles } from "../src/runtime-file-inventory";
import { DEFAULT_RUNTIME_LIMITS } from "../src/runtime-limits";
import { reuseSqliteStatements } from "../src/sqlite-statements";
import { createSqliteStorage } from "../src/sqlite-storage";

/** Run from supervisor/: pnpm exec node --import tsx scripts/benchmark-runtime-file-inventory.ts */
function benchmark(): void {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "maister-inventory-benchmark-")),
  );
  const stateDir = join(root, "state");
  const file = join(stateDir, HOST_STATE_FILE);
  const objectRoot = join(stateDir, "runtime-objects");
  const count = 30_000;
  const samples = 3;

  const measureInventory = (): {
    milliseconds: number;
    budget: ReturnType<typeof runtimeFileBudgetSnapshot>;
    plan: string[];
  } => {
    const native = new DatabaseSync(file);

    native.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    native.exec(ACTIVE_FRAME_SCHEMA);
    native.exec(ACTIVE_FILE_PROGRESS_SCHEMA);
    const db = reuseSqliteStatements(native);

    try {
      const storage = createSqliteStorage({
        db,
        file,
        limits: DEFAULT_RUNTIME_LIMITS,
      });
      const start = performance.now();

      inventoryRuntimeFiles({
        db,
        objectRoot,
        limits: DEFAULT_RUNTIME_LIMITS,
        write: storage.write,
      });
      const milliseconds = performance.now() - start;

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM runtime_objects").get()?.n,
        count,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM runtime_files").get()?.n,
        count,
      );
      assert.equal(readdirSync(objectRoot).length, count);
      assert.ok(
        storage.snapshot().totalBytes < DEFAULT_RUNTIME_LIMITS.stateMaxBytes,
      );

      return {
        milliseconds,
        budget: runtimeFileBudgetSnapshot(db),
        plan: corruptPathPlan(db, join(objectRoot, "object-000000")),
      };
    } finally {
      db.close();
    }
  };

  try {
    const hostKey = seedRuntimeInventory(stateDir, count);
    const legacy = new DatabaseSync(file);

    try {
      restoreV14InventorySchema(legacy);
    } finally {
      legacy.close();
    }
    const before = Array.from({ length: samples }, () => measureInventory());
    const upgradeStart = performance.now();
    const upgraded = openHostState({ stateDir });
    const upgradeOpenMs = performance.now() - upgradeStart;

    try {
      assert.equal(upgraded.hostKey, hostKey);
      assert.deepEqual(upgraded.runtimeFileBudget(), before[0].budget);
    } finally {
      upgraded.close();
    }
    const after = Array.from({ length: samples }, () => measureInventory());

    for (const sample of [...before, ...after])
      assert.deepEqual(sample.budget, before[0].budget);
    const reopenStart = performance.now();
    const reopened = openHostState({ stateDir });
    const reopenMs = performance.now() - reopenStart;

    try {
      assert.equal(reopened.hostKey, hostKey);
      assert.deepEqual(reopened.runtimeFileBudget(), before[0].budget);
    } finally {
      reopened.close();
    }
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const beforeMs = before.map((sample) => sample.milliseconds);
    const afterMs = after.map((sample) => sample.milliseconds);

    process.stdout.write(
      `${JSON.stringify(
        {
          environment: {
            node: process.version,
            sqlite: process.versions.sqlite,
            platform: platform(),
            release: release(),
            cpu: cpus()[0].model,
          },
          objects: count,
          files: count,
          corruptObjects: count / 100,
          beforePlan: before[0].plan,
          afterPlan: after[0].plan,
          beforeMs,
          afterMs,
          beforeMedianMs: median(beforeMs),
          afterMedianMs: median(afterMs),
          speedup: median(beforeMs) / median(afterMs),
          upgradeOpenMs,
          reopenMs,
          budget: before[0].budget,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

benchmark();
