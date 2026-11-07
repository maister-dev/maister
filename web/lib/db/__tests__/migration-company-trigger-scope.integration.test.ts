import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { claimCronAgentAttempt } from "@/lib/agents/trigger-attempts";
import { parseAgentTriggerBindingSnapshot } from "@/lib/agents/trigger-attempt-types";
import { parseScheduledRequestSnapshot } from "@/lib/agents/scheduled-request";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let sourceBefore: Record<string, unknown>;
let attemptBefore: Record<string, unknown>;
const sourceId = randomUUID();
const attemptId = randomUUID();
const agentId = "migration:observer";
const due = new Date(Date.now() + 3600000);
const bindingSnapshot = {
  version: 1,
  scheduleId: sourceId,
  triggerType: "cron",
  cronExpr: "*/15 * * * *",
  timezone: "UTC",
  eventKinds: [],
};
const scheduledRequest = {
  version: 1,
  scheduleId: sourceId,
  triggerAttemptId: attemptId,
  requestAtLaunch: "Наблюдать статус\nDo not repeat completed work.",
};

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_trigger_scope_upgrade" },
    "0237_company_flow_bindings",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,'migration','v1','git','Observer','Legacy project source','none','session','[\"cron\"]','read_only','/unused/legacy.md')",
    [agentId],
  );
  await database.pool.query(
    "INSERT INTO agent_schedules(id,project_id,agent_id,trigger_type,cron_expr,timezone,next_fire_at,last_attempt_fence,request_at_launch) VALUES($1,$2,$3,'cron','*/15 * * * *','UTC',$4,1,$5)",
    [sourceId, projectId, agentId, due, scheduledRequest.requestAtLaunch],
  );
  await database.pool.query(
    "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,scheduled_request_snapshot,fence,delivery_key,trigger_source,reserved_run_id,claimed_at,due_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,1,'cron:1','cron',$7,now(),now())",
    [
      attemptId,
      projectId,
      agentId,
      sourceId,
      JSON.stringify(bindingSnapshot),
      JSON.stringify(scheduledRequest),
      randomUUID(),
    ],
  );
  sourceBefore = (
    await database.pool.query(
      "SELECT to_jsonb(s) AS value FROM agent_schedules s WHERE id=$1",
      [sourceId],
    )
  ).rows[0]!.value;
  attemptBefore = (
    await database.pool.query(
      "SELECT to_jsonb(a) AS value FROM agent_trigger_attempts a WHERE id=$1",
      [attemptId],
    )
  ).rows[0]!.value;
  await applyMainMigration(database.db, "0238_company_trigger_scope");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves existing project identity, v1 request/binding bytes and unknown attribution through the owner migration and next ordinary claim", async () => {
  const source = (
    await database.pool.query(
      "SELECT to_jsonb(s) AS value FROM agent_schedules s WHERE id=$1",
      [sourceId],
    )
  ).rows[0]!.value;
  const attempt = (
    await database.pool.query(
      "SELECT to_jsonb(a) AS value FROM agent_trigger_attempts a WHERE id=$1",
      [attemptId],
    )
  ).rows[0]!.value;

  expect(source).toEqual({
    ...sourceBefore,
    project_agent_id: agentId,
    company_id: null,
    company_specialist_binding_id: null,
    company_flow_binding_id: null,
    company_config_revision: null,
    created_by: null,
    creation_key: null,
    creation_digest: null,
  });
  expect(attempt).toEqual({ ...attemptBefore, company_id: null });
  expect(parseAgentTriggerBindingSnapshot(attempt.binding_snapshot)).toEqual(
    bindingSnapshot,
  );
  expect(
    parseScheduledRequestSnapshot(attempt.scheduled_request_snapshot),
  ).toEqual(scheduledRequest);
  await expect(
    database.pool.query(
      "UPDATE agent_schedules SET company_id=(SELECT id FROM companies) WHERE id=$1",
      [sourceId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await upgradeMainTestDb(database, "0238_company_trigger_scope");
  await declareCurrentTestDatabaseWriter(database);
  const claim = await claimCronAgentAttempt(
    database.db,
    sourceId,
    new Date(due.getTime() + 1),
    new Date(due.getTime() + 900000),
  );

  expect(claim).toMatchObject({
    projectId,
    companyId: null,
    fence: 2,
    bindingSnapshot,
  });
  expect(
    parseScheduledRequestSnapshot(claim!.scheduledRequestSnapshot),
  ).toEqual({ ...scheduledRequest, triggerAttemptId: claim!.id });
});

it("retains project source cascade semantics and permits project deletion through the main store without a Brain lookup", async () => {
  await database.pool.query("DELETE FROM agents WHERE id=$1", [agentId]);
  expect(
    (
      await database.pool.query("SELECT id FROM agent_schedules WHERE id=$1", [
        sourceId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_trigger_attempts WHERE schedule_id=$1",
        [sourceId],
      )
    ).rows,
  ).toHaveLength(2);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_trigger_attempts WHERE schedule_id=$1",
        [sourceId],
      )
    ).rows,
  ).toEqual([]);
});
