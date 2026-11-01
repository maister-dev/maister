import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
const legacyRunId = randomUUID();

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "scheduled_request_upgrade" },
    "0209_task_qualification_capability",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await seedRun(database.db, { id: legacyRunId, projectId });
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  const cutoff = journal.entries.find(
    (entry) => entry.tag === "0209_task_qualification_capability",
  )!.when;
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((migration) => migration.folderMillis <= cutoff);

  await database.pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await database.pool.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
    [
      applied.map((entry) => entry.hash),
      applied.map((entry) => entry.folderMillis),
    ],
  );
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("scheduled request additive migration", () => {
  it("keeps legacy input unknown and allows lifecycle changes but no input mutation", async () => {
    const legacy = await database.pool.query(
      "SELECT scheduled_request_snapshot FROM runs WHERE id=$1",
      [legacyRunId],
    );

    expect(legacy.rows[0].scheduled_request_snapshot).toBeNull();
    const id = randomUUID();
    const snapshot = {
      version: 1,
      scheduleId: randomUUID(),
      triggerAttemptId: randomUUID(),
      requestAtLaunch: "Проверить статус\n😀",
    };

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
      [id, projectId, snapshot],
    );
    await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
      id,
    ]);
    await expect(
      database.pool.query(
        "UPDATE runs SET scheduled_request_snapshot=NULL WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "runs_scheduled_request_immutable" });
    await expect(
      database.pool.query(
        "UPDATE runs SET scheduled_request_snapshot=$2 WHERE id=$1",
        [legacyRunId, snapshot],
      ),
    ).rejects.toMatchObject({ constraint: "runs_scheduled_request_immutable" });
  });

  it("rejects malformed present snapshots while accepting captured empty input", async () => {
    const base = {
      version: 1,
      scheduleId: randomUUID(),
      triggerAttemptId: randomUUID(),
      requestAtLaunch: null,
    };
    const invalid = [
      {},
      { ...base, version: 2 },
      { ...base, requestAtLaunch: 4 },
      { ...base, requestAtLaunch: "" },
      { ...base, requestAtLaunch: "😀".repeat(8001) },
      { ...base, extra: true },
      { ...base, scheduleId: "" },
    ];

    for (const snapshot of invalid) {
      await expect(
        database.pool.query(
          "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
          [randomUUID(), projectId, snapshot],
        ),
      ).rejects.toMatchObject({ constraint: "runs_scheduled_request_shape" });
    }
    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
      [randomUUID(), projectId, base],
    );
  });
});
