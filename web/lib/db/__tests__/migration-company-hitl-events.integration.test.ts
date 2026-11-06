import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { beforeAll, afterAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  applyMainMigration,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let companyId: string;
let runId: string;
let retained: Readonly<Record<string, unknown>>[];

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_hitl_event_upgrade" },
    "0245_human_work_owner_guards",
  );
  const project = await seedProjectRow(database.db);

  companyId = (await database.pool.query("SELECT id FROM companies")).rows[0]
    .id;
  runId = randomUUID();
  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision) VALUES($1,$2,'agent','NeedsInput','fixture','fixture')",
    [runId, project.id],
  );
  await database.pool.query(
    'INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) VALUES(\'run.needs_input\',$1,$2,\'{"kind":"permission","retained":true}\'::jsonb,now())',
    [project.id, runId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('specialist.assignment_changed',$1,'{\"retained\":true}'::jsonb,now())",
    [companyId],
  );
  retained = (
    await database.pool.query(
      "SELECT to_jsonb(e) AS value FROM domain_events e ORDER BY id",
    )
  ).rows;
  await applyMainMigration(database.db, "0246_company_hitl_wait_events");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves existing wait/metadata facts while requiring exact company Run ownership for new wait events", async () => {
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(e) AS value FROM domain_events e ORDER BY id",
      )
    ).rows,
  ).toEqual(retained);
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('run.needs_input',$1,'{}'::jsonb,now())",
      [companyId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('run.needs_input',$1,$2,'{}'::jsonb,now())",
      [companyId, runId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_run_reference_check",
  });
  await expect(
    database.pool.query(
      "UPDATE domain_events SET kind='run.needs_input',run_id=$2 WHERE company_id=$1 AND kind='specialist.assignment_changed'",
      [companyId, runId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_identity_check",
  });
});
