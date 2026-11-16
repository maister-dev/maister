import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let before: Readonly<Record<string, unknown>>[];
const userId = randomUUID();
const agentId = "migration:legacy-observer";

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_agent_execution_upgrade" },
    "0239_company_retry_scope",
  );
  await declareCurrentTestDatabaseWriter(database);
  projectId = (await seedProjectRow(database.db)).id;
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,'migration','legacy','git','Legacy observer','Retained project execution','none','session','[\"manual\"]','read_only','/retained/observer.md')",
    [agentId],
  );
  await database.pool.query(
    "INSERT INTO runs(id,run_kind,project_id,agent_id,agent_workspace,flow_version,flow_revision,status) VALUES($1,'agent',$2,$3,'none','agent','manual','Pending')",
    [randomUUID(), projectId, agentId],
  );
  await database.pool.query(
    "INSERT INTO runs(id,run_kind,agent_workspace,flow_version,flow_revision,status,persistent,created_by_user_id) VALUES($1,'librarian','none','librarian','manual','NeedsInputIdle',true,$2)",
    [randomUUID(), userId],
  );
  before = (
    await database.pool.query(
      "SELECT to_jsonb(r) AS value FROM runs r ORDER BY id",
    )
  ).rows.map((row: { value: Record<string, unknown> }) => row.value);
  await applyMainMigration(database.db, "0240_company_agent_execution");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves project execution and private librarian ownership without inventing historical company identity or launch authority", async () => {
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(r) AS value FROM runs r ORDER BY id",
      )
    ).rows.map((row: { value: Record<string, unknown> }) => row.value),
  ).toEqual(
    before.map((row) => ({
      ...row,
      company_id: null,
      company_execution_snapshot: null,
    })),
  );
  await expect(
    database.pool.query(
      "UPDATE runs SET company_execution_snapshot='{}'::jsonb WHERE project_id=$1",
      [projectId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("keeps catalog retirement and project cleanup independent of the Brain store and retains personal execution", async () => {
  await database.pool.query("DELETE FROM agents WHERE id=$1", [agentId]);
  expect(
    (
      await database.pool.query(
        "SELECT agent_id FROM runs WHERE project_id=$1",
        [projectId],
      )
    ).rows[0],
  ).toEqual({ agent_id: null });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (
      await database.pool.query(
        "SELECT run_kind,project_id,company_id FROM runs",
      )
    ).rows,
  ).toEqual([{ run_kind: "librarian", project_id: null, company_id: null }]);
});
