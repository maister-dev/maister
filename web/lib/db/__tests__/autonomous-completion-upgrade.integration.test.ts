import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const predecessor = "0359_flow_publications";

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "autonomous_upgrade" },
    predecessor,
  );
  await declareCurrentTestDatabaseWriter(database);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("W01/C03 retains legacy policy and makes decision and outbox a single transaction", async () => {
  const project = await seedProjectRow(database.db);
  const unrelated = await seedProjectRow(database.db);
  const runId = randomUUID();
  const priorPolicy = { preset: "unattended", overrides: { checks: "strict" } };

  await database.pool.query(
    "INSERT INTO runs(id,project_id,status,flow_version,flow_revision,execution_policy) VALUES ($1,$2,'Review','1','revision',$3)",
    [runId, project.id, priorPolicy],
  );
  await upgradeMainTestDb(database, predecessor);
  expect(
    (
      await database.pool.query(
        "SELECT r.execution_policy, p.autonomous_completion_revision FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([
    { execution_policy: priorPolicy, autonomous_completion_revision: 0 },
  ]);

  const { recordAutonomousDecision } =
    await import("@/lib/auto-promotion/decisions");
  const db = database.db as unknown as import("@/lib/execution-host/db").Db;
  const refused = {
    runId,
    projectId: project.id,
    action: "promote",
    phase: "refused",
    reason: "missing_required_evidence",
    projectRevision: 1,
    platformRevision: 1,
    witness: { flowRevision: "revision" },
  } as const;

  await expect(
    db.transaction((tx) =>
      recordAutonomousDecision(tx, { ...refused, projectId: unrelated.id }),
    ),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await database.pool
    .query(`ALTER TABLE domain_events ADD CONSTRAINT test_reject_autonomous
    CHECK (kind <> 'run.autonomous_decision')`);
  await expect(
    db.transaction((tx) => recordAutonomousDecision(tx, refused)),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  expect(
    (await database.pool.query("SELECT id FROM run_autonomous_decisions")).rows,
  ).toEqual([]);
  await database.pool.query(
    "ALTER TABLE domain_events DROP CONSTRAINT test_reject_autonomous",
  );

  const write = () =>
    db.transaction((tx) => recordAutonomousDecision(tx, refused));
  const simultaneous = await Promise.all([write(), write()]);

  expect(simultaneous.filter((row) => row.created)).toHaveLength(1);
  expect(new Set(simultaneous.map((row) => row.id)).size).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT actor_type,actor_id FROM domain_events WHERE kind='run.autonomous_decision'",
      )
    ).rows,
  ).toEqual([{ actor_type: "system", actor_id: null }]);
});
