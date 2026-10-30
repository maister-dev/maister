import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { publishRunResult } from "@/lib/run-results/ledger";
import {
  operationalContractFixture,
  operationalSuccessFixture,
} from "@/test-support/operational-agent";
import { emitDecisionsDelta } from "@/lib/notifications/attention-consumer";
import { runDecisionsDeltaBackstop } from "@/lib/notifications/digest-trigger";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_incident_notifications",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function episode(projectId: string, index: number): Promise<string> {
  const id = randomUUID();
  const fingerprint = index.toString(16).padStart(64, "0");

  await database.pool.query(
    "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES ($1,$2,'core:scan','unknown','unknown',$3,$4)",
    [id, projectId, fingerprint, `cause_${index}`],
  );
  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,channel,observed_at) VALUES ($1,$2,$3,'admission_refusal',now())",
    [id, `attempt:${id}`, fingerprint],
  );

  return id;
}

it("IT-UX-09 initializes an empty installation without requiring an upgrade fence", async () => {
  const baseline = await database.pool.query(
    "SELECT state.decisions,state.ordinary_decisions FROM users u LEFT JOIN attention_publication_states state ON state.owner_user_id=u.id WHERE u.role='admin' AND u.must_change_password",
  );

  expect(baseline.rows).toEqual([{ decisions: 0, ordinary_decisions: 0 }]);
  const { backfillAttentionPublicationPage } =
    await import("@/lib/notifications/attention-baseline");

  expect(await backfillAttentionPublicationPage(database.db)).toEqual({
    complete: true,
    processed: 0,
  });
});

it("IT-UX-09 publishes a new episode at count 1→1 once, leaves repeats and baselines quiet, and retries a failed publication through the real sweep backstop", async () => {
  const projectId = randomUUID();
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Notifications',$2,'NOTIFY')",
    [projectId, `/unused/${projectId}`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO notification_subscriptions(id,owner_user_id,transport,event_types) VALUES ($1,$2,'webhook','[\"attention.decisions_changed\"]')",
    [randomUUID(), userId],
  );
  const first = await episode(projectId, 1);
  const count = async () => ({ decisions: 1, ordinaryDecisions: 0 });

  expect(await emitDecisionsDelta(database.db, userId, "member", count)).toBe(
    true,
  );
  expect(await emitDecisionsDelta(database.db, userId, "member", count)).toBe(
    false,
  );
  const second = await episode(projectId, 2);
  const raced = await Promise.all([
    emitDecisionsDelta(database.db, userId, "member", count),
    emitDecisionsDelta(database.db, userId, "member", count),
  ]);

  expect(raced.sort()).toEqual([false, true]);
  const receipts = (
    await database.pool.query(
      "SELECT episode_id,acknowledged_at,notification_mode,notification_event_id FROM agent_incident_reader_states WHERE user_id=$1 ORDER BY episode_id",
      [userId],
    )
  ).rows;

  expect(receipts.map((row) => row.episode_id).sort()).toEqual(
    [first, second].sort(),
  );
  expect(
    receipts.every(
      (row) =>
        row.acknowledged_at === null &&
        row.notification_mode === "published" &&
        row.notification_event_id,
    ),
  ).toBe(true);
  await database.pool.query(
    "UPDATE agent_incident_episodes SET content_revision=content_revision+1,last_at=now() WHERE id=$1",
    [first],
  );
  expect(await emitDecisionsDelta(database.db, userId, "member", count)).toBe(
    false,
  );
  const baseline = await episode(projectId, 3);

  await database.pool.query(
    "INSERT INTO agent_incident_reader_states(user_id,episode_id,attention_revision,notification_recorded_at,notification_mode) VALUES ($1,$2,1,now(),'baseline')",
    [userId, baseline],
  );
  expect(await emitDecisionsDelta(database.db, userId, "member", count)).toBe(
    false,
  );
  const pending = await episode(projectId, 4);
  const refusal = `refuse_notification_${randomUUID().replaceAll("-", "")}`;

  await database.pool.query(
    `CREATE FUNCTION ${refusal}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='attention.decisions_changed' THEN RAISE EXCEPTION 'Reject test notification publication'; END IF; RETURN NEW; END $$`,
  );
  await database.pool.query(
    `CREATE TRIGGER ${refusal} BEFORE INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION ${refusal}()`,
  );
  try {
    await expect(
      emitDecisionsDelta(database.db, userId, "member", count),
    ).rejects.toThrow();
    expect(
      (
        await database.pool.query(
          "SELECT * FROM agent_incident_reader_states WHERE user_id=$1 AND episode_id=$2",
          [userId, pending],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await database.pool.query(`DROP TRIGGER ${refusal} ON webhook_events`);
    await database.pool.query(`DROP FUNCTION ${refusal}()`);
  }
  const recovered = await runDecisionsDeltaBackstop({ db: database.db });

  expect(recovered).toMatchObject({ candidates: 1, emitted: 1, errors: [] });
  expect(await runDecisionsDeltaBackstop({ db: database.db })).toMatchObject({
    candidates: 1,
    emitted: 0,
    errors: [],
  });
  expect(
    (
      await database.pool.query(
        "SELECT notification_mode,acknowledged_at FROM agent_incident_reader_states WHERE user_id=$1 AND episode_id=$2",
        [userId, pending],
      )
    ).rows[0],
  ).toEqual({ notification_mode: "published", acknowledged_at: null });
  const emitted = (
    await database.pool.query(
      "SELECT data FROM webhook_events WHERE data->>'ownerUserId'=$1 ORDER BY occurred_at,id",
      [userId],
    )
  ).rows;

  expect(emitted).toHaveLength(3);
  expect(
    emitted
      .slice(1)
      .every((row) => row.data.decisions === 1 && row.data.previous === 1),
  ).toBe(true);
});

it("IT-UX-09 baselines existing readers only under maintenance, preserves publication on replay, and keeps operational execution evidence out of human Updates", async () => {
  const { backfillAttentionPublicationPage } =
    await import("@/lib/notifications/attention-baseline");
  const { getUpdatesCount } = await import("@/lib/queries/updates");
  const { getCrossProjectActivityFeed } =
    await import("@/lib/queries/activity-feed");
  const userId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Quiet history',$2,'QUIET')",
    [projectId, `/unused/${projectId}`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), projectId, userId],
  );
  const existing = await episode(projectId, 11);

  await database.pool.query(
    "INSERT INTO agent_incident_reader_states(user_id,episode_id,attention_revision,notification_recorded_at,notification_mode) VALUES ($1,$2,1,now(),'baseline')",
    [userId, existing],
  );
  await expect(
    backfillAttentionPublicationPage(database.db),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "attention_baseline_requires_maintenance" },
  });
  process.env.MAISTER_UPGRADE_MAINTENANCE = "1";
  try {
    expect(await backfillAttentionPublicationPage(database.db)).toMatchObject({
      processed: 1,
      complete: false,
    });
    expect(await backfillAttentionPublicationPage(database.db)).toEqual({
      processed: 0,
      complete: true,
    });
  } finally {
    delete process.env.MAISTER_UPGRADE_MAINTENANCE;
  }
  const snapshot = async () => ({ decisions: 1, ordinaryDecisions: 0 });

  expect(
    await emitDecisionsDelta(database.db, userId, "member", snapshot),
  ).toBe(false);
  await database.pool.query(
    "DELETE FROM webhook_events WHERE data->>'ownerUserId'=$1",
    [userId],
  );
  expect(
    await emitDecisionsDelta(database.db, userId, "member", snapshot),
  ).toBe(false);
  await database.pool.query(
    "INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,agent_kind,agent_workspace,status,result_contract,activity_timestamp_provenance,activity_sort_at) VALUES ($1,$2,'fixture','agent','core:scan','operational','none','Pending',$3,'legacy_estimate',now())",
    [runId, projectId, operationalContractFixture("none")],
  );
  for (const status of ["Running", "NeedsInputIdle", "Pending", "Running"])
    await database.pool.query("UPDATE runs SET status=$2 WHERE id=$1", [
      runId,
      status,
    ]);
  const terminal = {
    version: 1,
    status: "Done",
    cause: "operational_success",
    effectiveOutcome: "success",
    successful: true,
    validation: "valid",
    integrity: "clean",
    baselineGeneration: 1,
    resultRevision: 1,
    reasonCodes: [],
    evidenceIds: [],
  };

  await database.db.transaction(async (tx) => {
    const value = { ...operationalSuccessFixture() };

    await publishRunResult(tx, {
      runId,
      value,
      valueBytes: Buffer.byteLength(JSON.stringify(value)),
      contract: operationalContractFixture("none"),
      producerKind: "agent_session",
      producerRef: "session:default",
    });
    await tx.execute(
      sql`UPDATE runs SET status='Done',operational_terminal=${JSON.stringify(terminal)}::jsonb,ended_at=now() WHERE id=${runId}`,
    );
  });
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) VALUES ('run.done',$1,$2,'{}',now())",
    [projectId, runId],
  );
  const facts = (
    await database.pool.query(
      "SELECT payload->>'status' status FROM domain_events WHERE kind='agent.activity_changed' AND run_id=$1 ORDER BY id",
      [runId],
    )
  ).rows;

  expect(facts.map((row) => row.status)).toEqual([
    "Pending",
    "Running",
    "NeedsInputIdle",
    "Pending",
    "Running",
    "Done",
  ]);
  expect(await getUpdatesCount(userId, "member")).toBe(0);
  expect(
    (await getCrossProjectActivityFeed({ id: userId, role: "member" })).rows,
  ).toEqual([]);
  const normal = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,project_id,flow_version,run_kind,status) VALUES ($1,$2,'fixture','flow','Done')",
    [normal, projectId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) VALUES ('run.done',$1,$2,'{}',now())",
    [projectId, normal],
  );
  expect(await getUpdatesCount(userId, "member")).toBe(1);
  expect(
    (
      await getCrossProjectActivityFeed({ id: userId, role: "member" })
    ).rows.map((row) => row.runId),
  ).toEqual([normal]);
});
