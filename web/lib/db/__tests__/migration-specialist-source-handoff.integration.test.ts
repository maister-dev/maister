import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "specialist_source_upgrade" },
    "0266_specialist_delivery_targets",
  );
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it("preserves populated legacy source attempts without inventing native assignment ownership and rejects forged handoffs", async () => {
  const project = await seedProjectRow(database.db);
  const binding = {
    version: 1,
    scheduleId: "legacy-source",
    triggerType: "cron",
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    eventKinds: [],
  };

  await database.pool.query(
    `INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,fence,
      delivery_key,trigger_source,reserved_run_id,claimed_at,due_at)
     VALUES('legacy-attempt',$1,'legacy:role','legacy-source',$2::jsonb,1,'cron:retained','cron','legacy-run',now(),now()+interval '1 hour')`,
    [project.id, JSON.stringify(binding)],
  );
  const before = (
    await database.pool.query(
      "SELECT to_jsonb(invocation) AS value FROM agent_trigger_attempts invocation",
    )
  ).rows;

  await database.db.transaction((tx) =>
    applyMainMigration(tx, "0267_specialist_source_handoff"),
  );
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(invocation)-'specialist_assignment' AS value FROM agent_trigger_attempts invocation",
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await database.pool.query(
        "SELECT specialist_assignment FROM agent_trigger_attempts",
      )
    ).rows,
  ).toEqual([{ specialist_assignment: null }]);
  const pointer = {
    schemaVersion: 1,
    assignment: {
      id: "forged-assignment",
      inputRevision: 1,
      inputSha256: "a".repeat(64),
    },
    source: {
      schemaVersion: 1,
      kind: "cron",
      attemptId: "legacy-attempt",
      scheduleId: "legacy-source",
      runId: "legacy-run",
    },
  };

  await expect(
    database.pool.query(
      "UPDATE agent_trigger_attempts SET specialist_assignment=$1::jsonb,outcome='queued',settled_at=now() WHERE id='legacy-attempt'",
      [JSON.stringify(pointer)],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "project_source_handoff_assignment",
  });
  await expect(
    database.pool.query(
      "UPDATE agent_trigger_attempts SET specialist_assignment=$1::jsonb,outcome='queued',settled_at=now() WHERE id='legacy-attempt'",
      [
        JSON.stringify({
          ...pointer,
          source: { ...pointer.source, runId: "different-run" },
        }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "project_source_handoff_reference",
  });
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(invocation)-'specialist_assignment' AS value FROM agent_trigger_attempts invocation",
      )
    ).rows,
  ).toEqual(before);
});
