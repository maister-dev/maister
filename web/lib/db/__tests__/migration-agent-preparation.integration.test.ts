import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let runId: string;
let before: unknown;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "agent_preparation_upgrade" },
    "0214_transcript_creation_order",
  );
  const project = await seedProjectRow(database.db);

  runId = randomUUID();
  const taskId = `${runId}-task`;

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Historical request','Frozen historical input')",
    [taskId, project.id],
  );
  await database.pool.query(
    "INSERT INTO runs(id,project_id,task_id,run_kind,status,flow_version,flow_revision,task_admission_snapshot) VALUES($1,$2,$3,'agent','Running','agent','manual',$4::jsonb)",
    [
      runId,
      project.id,
      taskId,
      JSON.stringify({
        version: 1,
        policyVersion: 1,
        mode: "legacy",
        inputRevision: 1,
        qualificationId: null,
        qualificationRevision: null,
        evidenceTarget: null,
        evidenceSha: null,
        parent: null,
      }),
    ],
  );
  before = (
    await database.pool.query(
      "SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1",
      [runId],
    )
  ).rows[0].value;
  await upgradeMainTestDb(database, "0214_transcript_creation_order");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("DB01 populated upgrade and journal replay preserve historical run bytes without inventing preparation", async () => {
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });

  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(r)-'task_launch_intent_id' AS value FROM runs r WHERE id=$1",
        [runId],
      )
    ).rows[0].value,
  ).toEqual(before);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM agent_preparation_operations",
      )
    ).rows[0].count,
  ).toBe(0);
  const constraints = await database.pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid='agent_preparation_operations'::regclass",
  );

  expect(
    constraints.rows.map((row: { conname: string }) => row.conname),
  ).toContain("agent_preparation_shape_check");
  const indexes = await database.pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname='agent_preparation_active_resource_uq'",
  );

  expect(indexes.rows[0].indexdef).toMatch(
    /UNIQUE.*resource_id.*WHERE.*claimed.*materialized/,
  );
});
