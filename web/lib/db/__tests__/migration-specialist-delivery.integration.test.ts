import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "specialist_delivery_upgrade" },
    "0264_specialist_flow_question",
  );
  await declareCurrentTestDatabaseWriter(database);
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it("preserves populated legacy delivery, attempt, Inbox and event bytes without inventing native enrollment", async () => {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, { projectId: project.id });
  const userId = randomUUID();
  const taskId = randomUUID();
  const subscriptionId = randomUUID();
  const eventId = randomUUID();
  const deliveryId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Retained task','Legacy input')",
    [taskId, project.id],
  );
  await database.pool.query(
    "INSERT INTO webhook_subscriptions(id,project_id,name,url,event_types,signing_secret_ref) VALUES($1,$2,'Retained subscription','https://example.invalid/retained','[\"run.review\"]'::jsonb,'env:LOCAL_TEST_SECRET')",
    [subscriptionId, project.id],
  );
  await database.pool.query(
    "INSERT INTO webhook_events(id,project_id,run_id,type,data,payload,occurred_at,fanout_at) VALUES($1,$2,$3,'run.review','{\"legacy\":true}'::jsonb,'{\"retained\":\"payload\"}'::jsonb,now(),now())",
    [eventId, project.id, runId],
  );
  await database.pool.query(
    "INSERT INTO webhook_deliveries(id,event_id,subscription_id,status,attempt_count,next_attempt_at,idempotency_key,last_http_status,delivered_at) VALUES($1,$2,$3,'delivered',1,now(),'retained-peer-key',200,now())",
    [deliveryId, eventId, subscriptionId],
  );
  await database.pool.query(
    "INSERT INTO webhook_delivery_attempts(id,delivery_id,attempt_no,requested_at,duration_ms,http_status,response_snippet) VALUES($1,$2,1,now(),7,200,'retained response')",
    [randomUUID(), deliveryId],
  );
  await database.pool.query(
    "INSERT INTO inbox_items(id,recipient_type,recipient_id,project_id,task_id,event_kind,source_ref,read_at) VALUES($1,'user',$2,$3,$4,'comment_added','{\"retained\":true}'::jsonb,now())",
    [randomUUID(), userId, project.id, taskId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) VALUES('run.review_opened',$1,$2,'{\"retained\":true}'::jsonb,now())",
    [project.id, runId],
  );
  const before = (
    await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(row)) FROM runs row) AS runs,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_subscriptions row) AS subscriptions,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_events row) AS events,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_deliveries row) AS deliveries,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_delivery_attempts row) AS attempts,
    (SELECT jsonb_agg(to_jsonb(row)) FROM inbox_items row) AS inbox,
    (SELECT jsonb_agg(to_jsonb(row)) FROM domain_events row) AS domain`)
  ).rows;

  await database.db.transaction(async (tx) => {
    await applyMainMigration(tx, "0265_specialist_result_delivery");
    await applyMainMigration(tx, "0266_specialist_delivery_targets");
  });
  expect(
    (
      await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(row)) FROM runs row) AS runs,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_subscriptions row) AS subscriptions,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_events row) AS events,
    (SELECT jsonb_agg(to_jsonb(row)-'specialist_delivery_id') FROM webhook_deliveries row) AS deliveries,
    (SELECT jsonb_agg(to_jsonb(row)) FROM webhook_delivery_attempts row) AS attempts,
    (SELECT jsonb_agg(to_jsonb(row)-'company_id'-'assignment_delivery_id') FROM inbox_items row) AS inbox,
    (SELECT jsonb_agg(to_jsonb(row)-'assignment_result') FROM domain_events row) AS domain`)
    ).rows,
  ).toEqual(before);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM specialist_delivery_receipts",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(
    (await database.pool.query("SELECT assignment_result FROM domain_events"))
      .rows,
  ).toEqual([{ assignment_result: null }]);
  expect(
    (
      await database.pool.query(
        "SELECT specialist_delivery_id FROM webhook_deliveries",
      )
    ).rows,
  ).toEqual([{ specialist_delivery_id: null }]);
  await expect(
    database.pool.query(
      "INSERT INTO webhook_deliveries(id,event_id,specialist_delivery_id,status,attempt_count,next_attempt_at,idempotency_key) VALUES($1,$2,'forged-receipt','pending',0,now(),'forged-key')",
      [randomUUID(), eventId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "native_assignment_transport_reference",
  });
  await expect(
    database.pool.query(
      "INSERT INTO webhook_deliveries(id,event_id,status,attempt_count,next_attempt_at,idempotency_key) VALUES($1,$2,'pending',0,now(),'missing-target')",
      [randomUUID(), eventId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "webhook_deliveries_one_target",
  });
  await expect(
    database.pool.query(
      "INSERT INTO inbox_items(id,recipient_type,recipient_id,project_id,task_id,assignment_delivery_id,event_kind,source_ref) VALUES('forged-inbox','user',$1,$2,$3,'forged-receipt','assignment_result_available','{}'::jsonb)",
      [userId, project.id, taskId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "native_assignment_inbox_reference",
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM specialist_delivery_receipts",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
});
