import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let companyId: string;
let retained: Readonly<Record<string, unknown>>[];

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_run_terminal_upgrade" },
    "0241_company_agent_credentials",
  );
  projectId = (await seedProjectRow(database.db)).id;
  companyId = (await database.pool.query("SELECT id FROM companies")).rows[0]
    .id;
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,payload,occurred_at) VALUES('task.created',$1,'{\"retained\":true}'::jsonb,now())",
    [projectId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('knowledge.record_changed',$1,'{\"recordId\":\"retained\"}'::jsonb,now()),('specialist.assignment_changed',$1,'{\"assignmentId\":\"retained\"}'::jsonb,now())",
    [companyId],
  );
  retained = (
    await database.pool.query(
      "SELECT to_jsonb(e) AS value FROM domain_events e ORDER BY id",
    )
  ).rows.map((row: { value: Record<string, unknown> }) => row.value);
  await applyMainMigration(database.db, "0242_company_run_terminal_events");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves populated project and company metadata facts exactly without inventing run ownership", async () => {
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(e) AS value FROM domain_events e ORDER BY id",
      )
    ).rows.map((row: { value: Record<string, unknown> }) => row.value),
  ).toEqual(retained);
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('run.done',$1,'{}'::jsonb,now())",
      [companyId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('run.done',$1,$2,'{}'::jsonb,now())",
      [companyId, randomUUID()],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_run_reference_check",
  });
  await expect(
    database.pool.query(
      "UPDATE domain_events SET kind='specialist.assignment_changed' WHERE company_id=$1 AND kind='knowledge.record_changed'",
      [companyId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_identity_check",
  });
});

it("keeps project event cascade independent of Brain and retains company metadata", async () => {
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (
      await database.pool.query(
        "SELECT kind,project_id,company_id,run_id FROM domain_events ORDER BY id",
      )
    ).rows,
  ).toEqual([
    {
      kind: "knowledge.record_changed",
      project_id: null,
      company_id: companyId,
      run_id: null,
    },
    {
      kind: "specialist.assignment_changed",
      project_id: null,
      company_id: companyId,
      run_id: null,
    },
  ]);
});
