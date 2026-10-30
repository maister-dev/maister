import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { operationalContractFixture } from "@/test-support/operational-agent";
import { backfillAgentActivityPage } from "@/lib/runs/agent-activity-backfill";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const maintenanceBefore = process.env.MAISTER_UPGRADE_MAINTENANCE;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_activity_backfill",
  });
  process.env.MAISTER_UPGRADE_MAINTENANCE = "1";
}, 180_000);
afterAll(async () => {
  if (maintenanceBefore === undefined)
    delete process.env.MAISTER_UPGRADE_MAINTENANCE;
  else process.env.MAISTER_UPGRADE_MAINTENANCE = maintenanceBefore;
  await database?.stop();
});

describe("Agent activity cutover", () => {
  it("IT-UX-05 resumes bounded pages and retains stable legacy time without changing completion", async () => {
    const projectId = randomUUID();
    const runIds = [randomUUID(), randomUUID()].sort();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES ($1,$1,'Backfill',$2,'/unused/maister.yaml','BACKFILL')",
      [projectId, `/unused/${projectId}`],
    );
    await database.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES ('fixture:triager','fixture','v1','git','Triager','Triage','none','session','[]','standard','/unused/triager.md')",
    );
    for (const id of runIds)
      await database.pool.query(
        "INSERT INTO runs(id,project_id,agent_id,agent_workspace,run_kind,status,flow_version,flow_revision,started_at,ended_at) VALUES ($1,$2,'fixture:triager','none','agent','Failed','agent','manual','2026-01-01T01:00:00Z','2026-01-01T02:00:00Z')",
        [id, projectId],
      );
    const userId = randomUUID();
    const operationalRunId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role) VALUES ($1,$2,'admin')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,agent_kind,agent_workspace,status,flow_version,flow_revision,result_contract,operational_terminal,started_at,ended_at) VALUES ($1,$2,'agent','operational','none','Failed','agent','manual',$3,$4,'2026-01-01T01:00:00Z','2026-01-01T02:00:00Z')",
      [
        operationalRunId,
        projectId,
        JSON.stringify(operationalContractFixture("none")),
        JSON.stringify({
          version: 1,
          status: "Failed",
          cause: "agent_session_create_failed",
          effectiveOutcome: "failed",
          successful: false,
          validation: "unchecked",
          integrity: "unchecked",
          baselineGeneration: null,
          resultRevision: null,
          reasonCodes: ["agent_session_create_failed"],
          evidenceIds: [],
        }),
      ],
    );
    await database.pool.query(
      "INSERT INTO operational_run_acknowledgements(user_id,run_id,reason,revision) VALUES ($1,$2,'operation_failure',1)",
      [userId, operationalRunId],
    );
    delete process.env.MAISTER_UPGRADE_MAINTENANCE;
    await expect(
      backfillAgentActivityPage(database.db as unknown as Db, 1),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_activity_cutovers",
        )
      ).rows[0].n,
    ).toBe(0);
    process.env.MAISTER_UPGRADE_MAINTENANCE = "1";
    const page = await backfillAgentActivityPage(
      database.db as unknown as Db,
      1,
    );

    expect(page.processed).toBe(1);
    expect(page.complete).toBe(false);
    const savedCursor = (
      await database.pool.query(
        "SELECT after_run_id FROM agent_activity_cutovers WHERE version=1",
      )
    ).rows[0].after_run_id;

    await database.pool.query(
      "INSERT INTO runs(id,project_id,agent_id,agent_workspace,run_kind,status,flow_version,flow_revision,delegation_snapshot) VALUES ('zz-poison',$1,'fixture:triager','none','agent','Pending','agent','manual','{\"agentDefinitionId\":\"other:conflict\",\"revisionId\":\"old\"}')",
      [projectId],
    );
    await expect(
      backfillAgentActivityPage(database.db as unknown as Db, 500),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "agent_activity_identity_conflict",
        runId: "zz-poison",
      },
    });
    expect(
      (
        await database.pool.query(
          "SELECT after_run_id FROM agent_activity_cutovers WHERE version=1",
        )
      ).rows[0].after_run_id,
    ).toBe(savedCursor);
    await database.pool.query("DELETE FROM runs WHERE id='zz-poison'");
    for (let index = 0; index < 20; index++) {
      const next = await backfillAgentActivityPage(
        database.db as unknown as Db,
        1,
      );

      if (next.complete) break;
    }
    const rows = await database.pool.query(
      "SELECT source_agent_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_kind,status FROM runs WHERE id=ANY($1::text[]) ORDER BY id",
      [runIds],
    );

    expect(rows.rows).toEqual(
      runIds.map(() => ({
        source_agent_id: "fixture:triager",
        launched_at: null,
        activity_sort_at: new Date("2026-01-01T01:00:00Z"),
        activity_timestamp_provenance: "legacy_estimate",
        agent_kind: null,
        status: "Failed",
      })),
    );
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_occurrences",
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_reader_states WHERE user_id=$1 AND notification_mode='baseline' AND acknowledged_at IS NULL",
          [userId],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_occurrence_readers WHERE user_id=$1",
          [userId],
        )
      ).rows[0].n,
    ).toBe(1);
    await database.pool.query("DELETE FROM runs WHERE id=$1", [
      operationalRunId,
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM agent_incident_occurrence_readers WHERE user_id=$1",
          [userId],
        )
      ).rows[0].n,
    ).toBe(1);
    await database.pool.query(
      "UPDATE runs SET started_at=now() WHERE id=ANY($1::text[])",
      [runIds],
    );
    expect(
      await backfillAgentActivityPage(database.db as unknown as Db, 1),
    ).toEqual({ complete: true, processed: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT activity_sort_at FROM runs WHERE id=$1",
          [runIds[0]],
        )
      ).rows[0].activity_sort_at,
    ).toEqual(new Date("2026-01-01T01:00:00Z"));
  });
});
