import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import {
  claimCronAgentAttempt,
  claimEventAgentAttempt,
} from "@/lib/agents/trigger-attempts";
import { projectSourceContentDigest } from "@/lib/agents/project-source-review";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDb,
  declareCurrentTestDatabaseWriter,
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_upgrade" },
    "0214_transcript_creation_order",
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("IT-CBX-01 applies company migrations after the current master journal and preserves the workspace witness", async () => {
  const baseline = "0229_librarian_history";
  const master = await startMainPostgresTestDbUpTo(
    { databaseName: "company_after_master" },
    baseline,
  );

  try {
    await declareCurrentTestDatabaseWriter(master);
    const journal = JSON.parse(
      await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
    ) as { entries: { tag: string; when: number }[] };
    const cutoff = journal.entries.find(({ tag }) => tag === baseline);

    if (!cutoff) throw new Error("Master's applied migration is unavailable");
    const applied = readMigrationFiles({
      migrationsFolder: "./lib/db/migrations",
    }).filter(({ folderMillis }) => folderMillis <= cutoff.when);

    await master.pool.query("CREATE SCHEMA drizzle");
    await master.pool.query(
      "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    await master.pool.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
      [
        applied.map(({ hash }) => hash),
        applied.map(({ folderMillis }) => folderMillis),
      ],
    );
    const project = await seedProjectRow(master.db);
    const runId = await seedRun(master.db, { projectId: project.id });
    const workspaceId = await seedWorkspace(master.db, {
      runId,
      projectId: project.id,
      worktreePath: "/unused-company-upgrade-worktree",
      parentRepoPath: project.repoPath,
    });
    const evidence = {
      target: { remote: "origin", remoteBranch: "reviewed-workspace" },
      error: null,
    };

    await master.pool.query(
      "UPDATE workspaces SET branch_delivery=$2::jsonb WHERE id=$1",
      [workspaceId, JSON.stringify(evidence)],
    );
    const ledger = async () =>
      (
        await master.pool.query(
          "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
        )
      ).rows;
    const appliedMaster = await ledger();

    await migrate(master.db, { migrationsFolder: "./lib/db/migrations" });
    const upgraded = await ledger();

    const indexes = await master.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
         ('librarian_cards_history_idx','librarian_operations_history_idx','librarian_task_links_history_idx') ORDER BY indexname`,
    );

    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "librarian_cards_history_idx",
      "librarian_operations_history_idx",
      "librarian_task_links_history_idx",
    ]);

    expect(upgraded.length).toBeGreaterThan(appliedMaster.length);
    expect(upgraded.slice(0, appliedMaster.length)).toEqual(appliedMaster);
    expect(
      (await master.pool.query("SELECT id FROM companies")).rows,
    ).toHaveLength(1);
    expect(
      (
        await master.pool.query(
          "SELECT branch_delivery FROM workspaces WHERE id=$1",
          [workspaceId],
        )
      ).rows,
    ).toEqual([{ branch_delivery: evidence }]);
    await migrate(master.db, { migrationsFolder: "./lib/db/migrations" });
    expect(await ledger()).toEqual(upgraded);
  } finally {
    await master.stop();
  }
}, 180_000);

it("IT-CBX-01 event review upgrade retains historical approval without inventing enrollment or sharing and guards new claims", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "project_event_upgrade" },
    "0257_project_trigger_review",
  );

  try {
    const project = await seedProjectRow(legacy.db);
    const role = "legacy:event-review";

    await legacy.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,'legacy','v1','git','Legacy role','Retained identity','none','session','[\"domain_event\"]'::jsonb,'read_only','/tmp/legacy-event.md')",
      [role],
    );
    const review = {
      schemaVersion: 1,
      reviewerUserId: "historical-recorded-operator",
      reviewedAt: new Date().toISOString(),
      sourceRevision: 1,
      sourceSha256: projectSourceContentDigest({
        triggerType: "event",
        cronExpr: null,
        timezone: null,
        eventMatch: { kinds: ["task.created"] },
        requestAtLaunch: null,
      }),
    };

    await legacy.pool.query(
      "INSERT INTO agent_schedules(id,agent_id,project_id,trigger_type,event_match,project_source_review,last_attempt_fence) VALUES('legacy-event-source',$1,$2,'event','{\"kinds\":[\"task.created\"]}'::jsonb,$3::jsonb,1)",
      [role, project.id, JSON.stringify(review)],
    );
    const event = (
      await legacy.pool.query<{ id: string }>(
        "INSERT INTO domain_events(kind,project_id,actor_type,actor_id,payload,occurred_at) VALUES('task.created',$1,'user','historical-recorded-operator','{}',clock_timestamp()) RETURNING id",
        [project.id],
      )
    ).rows[0]!;
    const snapshot = {
      version: 3,
      scheduleId: "legacy-event-source",
      triggerType: "event",
      owner: { kind: "project", projectId: project.id },
      review,
      cronExpr: null,
      timezone: null,
      eventKinds: ["task.created"],
    };
    const old = (
      await legacy.pool.query(
        "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,fence,delivery_key,trigger_source,trigger_event_id,reserved_run_id,claimed_at,due_at) VALUES('legacy-event-attempt',$1,$2,'legacy-event-source',$3::jsonb,1,'event:old','domain_event',$4,'legacy-event-run',now(),now()) RETURNING to_jsonb(agent_trigger_attempts) AS value",
        [project.id, role, JSON.stringify(snapshot), event.id],
      )
    ).rows;
    const head = (
      await legacy.pool.query(
        "SELECT to_jsonb(source) AS value FROM agent_schedules source WHERE id='legacy-event-source'",
      )
    ).rows;

    await legacy.db.transaction((tx) =>
      applyMainMigration(tx, "0258_project_event_context"),
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(source) AS value FROM agent_schedules source WHERE id='legacy-event-source'",
        )
      ).rows,
    ).toEqual(head);
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(agent_trigger_attempts) AS value FROM agent_trigger_attempts WHERE id='legacy-event-attempt'",
        )
      ).rows,
    ).toEqual(old);
    const next = (
      await legacy.pool.query<{ id: string }>(
        "INSERT INTO domain_events(kind,project_id,actor_type,actor_id,payload,occurred_at) VALUES('task.created',$1,'user','historical-recorded-operator','{}',clock_timestamp()) RETURNING id",
        [project.id],
      )
    ).rows[0]!;

    // Compare the historical bytes before exercising the current writer on a fully upgraded database.
    await upgradeMainTestDb(legacy, "0258_project_event_context");
    await expect(
      claimEventAgentAttempt(
        legacy.db,
        "legacy-event-source",
        new Date(),
        Number(next.id),
      ),
    ).rejects.toMatchObject({
      code: "NEEDS_INPUT",
      details: { reason: "project_event_review_required" },
    });
    const current = {
      ...review,
      schemaVersion: 2,
      eventCursor: event.id,
      sourceSharing: "none",
    };

    for (const invalid of [
      { ...current, eventCursor: "-1" },
      { ...current, eventCursor: "9223372036854775808" },
      { ...current, eventCursor: null },
      { ...current, sourceSharing: "all" },
    ])
      await expect(
        legacy.pool.query(
          "UPDATE agent_schedules SET project_source_review=$1::jsonb WHERE id='legacy-event-source'",
          [JSON.stringify(invalid)],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "agent_schedules_project_review_check",
      });
    await legacy.pool.query(
      "UPDATE agent_schedules SET project_source_review=$1::jsonb WHERE id='legacy-event-source'",
      [JSON.stringify(current)],
    );
    const claim = await claimEventAgentAttempt(
      legacy.db,
      "legacy-event-source",
      new Date(),
      Number(next.id),
    );

    expect(claim?.bindingSnapshot).toMatchObject({
      version: 3,
      review: current,
    });
    await expect(
      legacy.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE agent_schedules SET last_attempt_fence=last_attempt_fence+1 WHERE id='legacy-event-source'`,
        );
        await tx.execute(sql`INSERT INTO agent_trigger_attempts SELECT (jsonb_populate_record(NULL::agent_trigger_attempts,to_jsonb(original)||jsonb_build_object(
        'id','old-event-after-review','reserved_run_id','old-event-after-review-run','delivery_key','event:older','fence',original.fence+1,'trigger_event_id',${event.id}::bigint
      ))).* FROM agent_trigger_attempts original WHERE original.id=${claim!.id}`);
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "agent_trigger_project_review_reference",
      },
    });
    await legacy.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
    expect(
      (
        await legacy.pool.query(
          "SELECT id FROM agent_schedules WHERE project_id=$1",
          [project.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await legacy.pool.query(
          "SELECT id FROM agent_trigger_attempts WHERE project_id=$1",
          [project.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await legacy.pool.query(
          "SELECT to_regclass('public.brain_items') AS present",
        )
      ).rows,
    ).toEqual([{ present: null }]);
  } finally {
    await legacy.stop();
  }
}, 180000);

it("IT-CBX-01 project source review upgrade preserves legacy bytes and permits project deletion without Brain", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "project_review_upgrade" },
    "0255_company_event_admission",
  );

  try {
    const project = await seedProjectRow(legacy.db);

    await legacy.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES('legacy:review-agent','legacy','v1','git','Legacy role','Retained identity','none','session','[\"cron\"]'::jsonb,'read_only','/tmp/legacy-review.md')",
    );
    const source = (
      await legacy.pool.query(
        "INSERT INTO agent_schedules(id,agent_id,project_id,trigger_type,cron_expr,timezone,next_fire_at,request_at_launch,last_attempt_fence) VALUES('legacy-review-source','legacy:review-agent',$1,'cron','* * * * *','UTC',now(),$2,1) RETURNING to_jsonb(agent_schedules) AS value",
        [project.id, "Original request\nKeep exact source 😀"],
      )
    ).rows[0].value as Record<string, unknown>;
    const bindingSnapshot = {
      version: 1,
      scheduleId: "legacy-review-source",
      triggerType: "cron",
      cronExpr: "* * * * *",
      timezone: "UTC",
      eventKinds: [],
    };
    const requestSnapshot = {
      version: 1,
      scheduleId: "legacy-review-source",
      triggerAttemptId: "legacy-review-attempt",
      requestAtLaunch: "Original request\nKeep exact source 😀",
    };
    const attempt = (
      await legacy.pool.query(
        "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,scheduled_request_snapshot,fence,delivery_key,trigger_source,reserved_run_id,claimed_at,due_at) VALUES('legacy-review-attempt',$1,'legacy:review-agent','legacy-review-source',$2::jsonb,$3::jsonb,1,'cron:1','cron','legacy-review-run',now(),now()) RETURNING to_jsonb(agent_trigger_attempts) AS value",
        [
          project.id,
          JSON.stringify(bindingSnapshot),
          JSON.stringify(requestSnapshot),
        ],
      )
    ).rows[0].value as Record<string, unknown>;

    await legacy.db.transaction((tx) =>
      applyMainMigration(tx, "0256_project_source_review"),
    );
    await legacy.db.transaction((tx) =>
      applyMainMigration(tx, "0257_project_trigger_review"),
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(s) AS value FROM agent_schedules s WHERE id='legacy-review-source'",
        )
      ).rows[0].value,
    ).toEqual({ ...source, project_source_review: null });
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(a) AS value FROM agent_trigger_attempts a WHERE id='legacy-review-attempt'",
        )
      ).rows[0].value,
    ).toEqual(attempt);
    expect(
      (
        await legacy.pool.query(
          "SELECT to_regclass('public.brain_items') AS present",
        )
      ).rows[0].present,
    ).toBeNull();
    await legacy.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES('native-review-operator','native-review-operator@example.test','admin','active')",
    );
    const review = {
      schemaVersion: 1,
      reviewerUserId: "native-review-operator",
      reviewedAt: new Date().toISOString(),
      sourceRevision: 2,
      sourceSha256: projectSourceContentDigest({
        triggerType: "cron",
        cronExpr: "* * * * *",
        timezone: "UTC",
        eventMatch: null,
        requestAtLaunch: "Original request\nKeep exact source 😀",
      }),
    };

    await legacy.pool.query(
      "UPDATE agent_schedules SET project_source_review=$1::jsonb WHERE id='legacy-review-source'",
      [JSON.stringify(review)],
    );
    await upgradeMainTestDb(legacy, "0257_project_trigger_review");
    const reviewed = await claimCronAgentAttempt(
      legacy.db,
      "legacy-review-source",
      new Date(),
      new Date(Date.now() + 60000),
    );

    expect(reviewed?.bindingSnapshot).toMatchObject({ version: 3, review });
    await expect(
      legacy.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE agent_schedules SET last_attempt_fence=last_attempt_fence+1 WHERE id='legacy-review-source'`,
        );
        await tx.execute(sql`INSERT INTO agent_trigger_attempts
      SELECT (jsonb_populate_record(NULL::agent_trigger_attempts,to_jsonb(original)||jsonb_build_object(
        'id','downgraded-review-attempt','reserved_run_id','downgraded-review-run','delivery_key','downgraded-review-delivery',
        'fence',original.fence+1,
        'binding_snapshot',(original.binding_snapshot-ARRAY['owner','review'])||jsonb_build_object('version',1),
        'scheduled_request_snapshot',jsonb_set(original.scheduled_request_snapshot,'{triggerAttemptId}','"downgraded-review-attempt"'::jsonb)
      ))).* FROM agent_trigger_attempts original WHERE original.id=${reviewed!.id}`);
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "agent_trigger_project_review_reference",
      },
    });
    await legacy.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
    expect(
      (
        await legacy.pool.query(
          "SELECT id FROM agent_schedules WHERE id='legacy-review-source'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await legacy.pool.query(
          "SELECT id FROM agent_trigger_attempts WHERE project_id=$1",
          [project.id],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await legacy.stop();
  }
}, 180_000);

it("IT-CBX-01 company migration preserves existing project data and identity across repeated boot", async () => {
  const project = await seedProjectRow(database.db);
  const run = await seedRun(database.db, { projectId: project.id });

  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES('legacy:event-agent','legacy','v1','git','Legacy event role','Retained catalog identity','none','session','[\"manual\"]'::jsonb,'read_only','/tmp/legacy-event.md')",
  );
  await database.pool.query(
    "UPDATE runs SET agent_id='legacy:event-agent',trigger_event_id=42 WHERE id=$1",
    [run],
  );

  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status,vars) VALUES('legacy-native-actor-attempt',$1,'coordinator','orchestrator','Succeeded','{\"legacyFinding\":\"preserve exact value\"}')",
    [run],
  );
  await database.pool.query(
    "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash) VALUES('legacy-native-actor-token',$1,$2,'legacy-native-prefix','legacy-native-hash')",
    [project.id, `orchestrator-run:${run}`],
  );
  const attemptBefore = (
    await database.pool.query(
      "SELECT to_jsonb(a) AS value FROM node_attempts a WHERE id='legacy-native-actor-attempt'",
    )
  ).rows[0]?.value as Record<string, unknown>;
  const tokenBefore = (
    await database.pool.query(
      "SELECT to_jsonb(t) AS value FROM project_tokens t WHERE id='legacy-native-actor-token'",
    )
  ).rows[0]?.value as Record<string, unknown>;

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES ('legacy-admin','legacy-admin@example.test','admin','active')",
  );
  const before = await database.pool.query<{ value: unknown }>(
    "SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1",
    [run],
  );
  const oldEvent = (
    await database.pool.query<{ id: string; value: Record<string, unknown> }>(
      "INSERT INTO domain_events(kind,project_id,payload,occurred_at) VALUES('task.created',$1,$2::jsonb,now()) RETURNING id,to_jsonb(domain_events) AS value",
      [project.id, JSON.stringify({ legacySnapshot: "preserve exactly" })],
    )
  ).rows[0]!;
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as {
    entries: { tag: string; when: number }[];
  };
  const baseline = journal.entries.find(
    (entry) => entry.tag === "0214_transcript_creation_order",
  );

  expect(baseline).toBeDefined();
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((migration) => migration.folderMillis <= baseline!.when);

  await database.pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await database.pool.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
    [
      applied.map((migration) => migration.hash),
      applied.map((migration) => migration.folderMillis),
    ],
  );
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  await declareCurrentTestDatabaseWriter(database);
  const company = await database.pool.query<{ id: string }>(
    "SELECT id FROM companies",
  );

  expect(company.rows).toHaveLength(1);
  const specialistStorage = await database.pool.query<{
    assignments: string | null;
    inputs: string | null;
    runLinks: string | null;
    bindings: string | null;
    bindingRevisions: string | null;
  }>(
    `SELECT to_regclass('public.specialist_assignments')::text AS assignments,
      to_regclass('public.specialist_input_revisions')::text AS inputs,
      to_regclass('public.specialist_run_links')::text AS "runLinks",
      to_regclass('public.company_specialist_bindings')::text AS bindings,
      to_regclass('public.company_specialist_binding_revisions')::text AS "bindingRevisions"`,
  );

  expect(specialistStorage.rows).toEqual([
    {
      assignments: "specialist_assignments",
      inputs: "specialist_input_revisions",
      runLinks: "specialist_run_links",
      bindings: "company_specialist_bindings",
      bindingRevisions: "company_specialist_binding_revisions",
    },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM specialist_assignments",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(
    await database.pool.query("SELECT id FROM company_grants"),
  ).toMatchObject({ rowCount: 0 });
  const after = (
    await database.pool.query<{ value: Record<string, unknown> }>(
      "SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1",
      [run],
    )
  ).rows[0]!.value;

  expect(after).toMatchObject(before.rows[0]!.value as Record<string, unknown>);
  expect(after.task_launch_intent_id).toBeNull();
  expect(after.knowledge_access).toBeNull();
  expect(after.company_id).toBeNull();
  expect(after.company_execution_snapshot).toBeNull();
  expect(after.company_cancellation_intent).toBeNull();
  expect(after.agent_memory_hash_format).toBeNull();
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(a) AS value FROM node_attempts a WHERE id='legacy-native-actor-attempt'",
      )
    ).rows[0]?.value,
  ).toEqual({ ...attemptBefore, knowledge_actor: null, error_reason: null });
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(t) AS value FROM project_tokens t WHERE id='legacy-native-actor-token'",
      )
    ).rows[0]?.value,
  ).toEqual({
    ...tokenBefore,
    knowledge_node_attempt_id: null,
    installation_run_id: null,
    company_id: null,
    company_run_id: null,
    bound_run_id: null,
    origin_kind: null,
    revocation_reason: null,
  });
  expect(Object.keys(after).sort()).toEqual(
    [
      ...Object.keys(before.rows[0]!.value as Record<string, unknown>),
      "task_launch_intent_id",
      "knowledge_access",
      "company_id",
      "company_execution_snapshot",
      "company_cancellation_intent",
      "agent_memory_hash_format",
    ].sort(),
  );
  expect(
    await database.pool.query("SELECT id FROM users WHERE id='legacy-admin'"),
  ).toMatchObject({ rowCount: 1 });
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(e) AS value FROM domain_events e WHERE id=$1",
        [oldEvent.id],
      )
    ).rows[0]?.value,
  ).toEqual({ ...oldEvent.value, company_id: null, assignment_result: null });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,project_id,company_id,payload,occurred_at) VALUES('knowledge.record_changed',$1,$2,'{}',now())",
      [project.id, company.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_owner_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('task.created',$1,'{}',now())",
      [company.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        run,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: "1",
          restrictions: [],
        }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "runs_knowledge_access_check",
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        run,
        JSON.stringify({ schemaVersion: 1, state: "complete", generation: 1 }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "runs_knowledge_access_check",
  });
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  expect((await database.pool.query("SELECT id FROM companies")).rows).toEqual(
    company.rows,
  );
  await expect(
    database.pool.query(
      "INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(original)||jsonb_build_object('id','duplicate-legacy-event'))).* FROM runs original WHERE original.id=$1",
      [run],
    ),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "runs_agent_trigger_event_uq",
  });
});

it("IT-CBX-01 populated Brain upgrade preserves honest legacy provenance and pending proposals", async () => {
  const legacy = await startMainPostgresTestDb({
    databaseName: "legacy_brain_upgrade",
  });
  const directory = await mkdtemp(join(tmpdir(), "maister-brain-baseline-"));

  try {
    const journal = JSON.parse(
      await readFile("./lib/db/brain-migrations/meta/_journal.json", "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string; when: number }[];
    };
    const entries = journal.entries.filter((entry) => entry.idx <= 5);

    await mkdir(join(directory, "meta"));
    await writeFile(
      join(directory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries)
      await cp(
        `./lib/db/brain-migrations/${entry.tag}.sql`,
        join(directory, `${entry.tag}.sql`),
      );
    await migrate(legacy.db, {
      migrationsFolder: directory,
      migrationsTable: "__drizzle_brain_migrations",
    });
    const project = await seedProjectRow(legacy.db);

    await legacy.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES('legacy-claim',$1,'state_fact','Original','Original assertion',0.99,'legacy-hash')",
      [project.id],
    );
    await legacy.pool.query(
      'INSERT INTO brain_proposals(id,project_id,kind,draft,actor) VALUES(\'legacy-proposal\',$1,\'state\',\'{"text":"Pending improvement"}\',\'{"type":"system","id":"legacy-harvest"}\')',
      [project.id],
    );
    await migrate(legacy.db, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT source_restrictions,source_acl_key FROM brain_proposals WHERE id='legacy-proposal'",
        )
      ).rows,
    ).toEqual([
      {
        source_restrictions: null,
        source_acl_key:
          "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      },
    ]);
    const table = await legacy.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.brain_record_revisions') IS NOT NULL AS present",
    );

    expect(table.rows[0]?.present).toBe(true);
    const revision = await legacy.pool.query(
      "SELECT assertion,basis,provenance,attribution,freshness FROM brain_record_revisions WHERE record_id='legacy-claim' AND revision=1",
    );

    expect(revision.rows).toEqual([
      expect.objectContaining({
        assertion: "Original assertion",
        basis: "unknown",
        provenance: "legacy_migration",
        attribution: {
          kind: "legacy_unknown",
          id: null,
          runId: null,
          attemptId: null,
        },
        freshness: expect.objectContaining({
          applicability: "unknown",
          observedAt: null,
          sourceAt: null,
        }),
      }),
    ]);
    expect(
      await legacy.pool.query(
        "SELECT id FROM brain_record_changes WHERE record_id='legacy-claim'",
      ),
    ).toMatchObject({ rowCount: 0 });
    expect(
      (
        await legacy.pool.query(
          "SELECT id,status,draft FROM brain_proposals WHERE id='legacy-proposal'",
        )
      ).rows,
    ).toEqual([
      {
        id: "legacy-proposal",
        status: "pending",
        draft: { text: "Pending improvement" },
      },
    ]);
    await migrate(legacy.db, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    expect(
      await legacy.pool.query(
        "SELECT record_id FROM brain_record_revisions WHERE record_id='legacy-claim'",
      ),
    ).toMatchObject({ rowCount: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await legacy.stop();
  }
});

it("IT-CBX-01 company grant receipt migration preserves existing policy without inventing historical delivery or revocation authority", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "company_grant_upgrade" },
    "0231_company_knowledge_events",
  );

  try {
    const companyId = String(
      (await legacy.pool.query("SELECT id FROM companies")).rows[0].id,
    );

    await legacy.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES('existing-policy-author','existing-policy-author@example.test','admin','active')",
    );
    await legacy.pool.query(
      "INSERT INTO company_grants(id,company_id,principal_type,principal_id,action,created_by,revoked_at) VALUES('existing-live-policy',$1,'user','existing-policy-author','knowledge:read','existing-policy-author',NULL),('existing-revoked-policy',$1,'user','existing-policy-author','knowledge:review','existing-policy-author',now())",
      [companyId],
    );
    const before = (
      await legacy.pool.query(
        "SELECT to_jsonb(g) AS value FROM company_grants g ORDER BY id",
      )
    ).rows.map((row) => row.value);

    await legacy.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0232_company_grant_requests");
    });
    const after = (
      await legacy.pool.query(
        "SELECT to_jsonb(g) AS value FROM company_grants g ORDER BY id",
      )
    ).rows.map((row) => row.value);

    expect(after).toEqual(
      before.map((value) => ({
        ...value,
        creation_key: null,
        creation_digest: null,
        revocation_key: null,
        revocation_digest: null,
        revoked_by: null,
        revocation_reason: null,
      })),
    );
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET principal_id='a-new-principal' WHERE id='existing-live-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_history_immutable",
    });
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET revoked_at=NULL WHERE id='existing-revoked-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_history_immutable",
    });
    await expect(
      legacy.pool.query(
        "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by,creation_key) VALUES($1,'user','existing-policy-author','knowledge:propose','existing-policy-author','incomplete_receipt')",
        [companyId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_creation_receipt_check",
    });
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET revoked_at=now(),revision=2,revocation_key='incomplete_revocation' WHERE id='existing-live-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_revocation_receipt_check",
    });
    await legacy.pool.query(
      "UPDATE company_grants SET revoked_at=now() WHERE id='existing-live-policy'",
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT revision,revoked_by,revocation_key FROM company_grants WHERE id='existing-live-policy'",
        )
      ).rows,
    ).toEqual([{ revision: 1, revoked_by: null, revocation_key: null }]);
  } finally {
    await legacy.stop();
  }
}, 180000);

it("IT-CBX-01 assignment-question migration preserves legacy task decisions without inventing assignment or answer provenance", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "specialist_question_upgrade" },
    "0261_specialist_context_mutation_credentials",
  );

  try {
    const project = await seedProjectRow(legacy.db);
    const taskId = randomUUID();
    const runId = randomUUID();
    const questionId = randomUUID();
    const form = {
      schemaVersion: 1,
      fields: [{ name: "component", type: "string", required: true }],
    };

    await declareCurrentTestDatabaseWriter(legacy);
    await legacy.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Existing clarification','Preserve the historical task question')",
      [taskId, project.id],
    );
    await legacy.pool.query(
      "INSERT INTO runs(id,project_id,task_id,flow_version,status) VALUES($1,$2,$3,'legacy-question','Done')",
      [runId, project.id, taskId],
    );
    await legacy.pool.query(
      "INSERT INTO hitl_requests(id,run_id,step_id,kind,task_id,activation_state,retrigger_mode,schema,prompt) VALUES($1,$2,'agent','agent_question',$3,'active','agent',$4::jsonb,'Which configured component?')",
      [questionId, runId, taskId, JSON.stringify(form)],
    );
    const before = (
      await legacy.pool.query(
        "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
        [questionId],
      )
    ).rows[0]!.value;

    await legacy.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0262_specialist_question_subject");
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
          [questionId],
        )
      ).rows[0]!.value,
    ).toEqual({
      ...before,
      specialist_assignment_id: null,
      specialist_input_revision: null,
      specialist_answer_input_revision: null,
    });
    const subjectUpgrade = (
      await legacy.pool.query(
        "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
        [questionId],
      )
    ).rows[0]!.value;

    await legacy.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0263_specialist_question_answer");
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
          [questionId],
        )
      ).rows[0]!.value,
    ).toEqual({ ...subjectUpgrade, specialist_answer: null });
    const answerUpgrade = (
      await legacy.pool.query(
        "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
        [questionId],
      )
    ).rows[0]!.value;

    await legacy.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0264_specialist_flow_question");
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(question) AS value FROM hitl_requests question WHERE id=$1",
          [questionId],
        )
      ).rows[0]!.value,
    ).toEqual(answerUpgrade);
    await expect(
      legacy.pool.query(
        "UPDATE hitl_requests SET specialist_answer='{}'::jsonb WHERE id=$1",
        [questionId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "hitl_specialist_question_answer",
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT to_regclass('public.brain_items')::text AS brain",
        )
      ).rows,
    ).toEqual([{ brain: null }]);
    await expect(
      legacy.pool.query(
        "INSERT INTO hitl_requests(id,run_id,step_id,kind,activation_state,retrigger_mode,schema,prompt,specialist_assignment_id,specialist_input_revision) VALUES($1,$2,'agent','agent_question','pending_termination','agent',$3::jsonb,'A caller cannot invent an assignment subject',$4,1)",
        [randomUUID(), runId, JSON.stringify(form), randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "hitl_specialist_question_reference",
    });
    await legacy.pool.query(
      "UPDATE hitl_requests SET response=$2::jsonb,responded_at=now() WHERE id=$1",
      [
        questionId,
        JSON.stringify({ component: "another configured component" }),
      ],
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT response,specialist_assignment_id,specialist_answer_input_revision FROM hitl_requests WHERE id=$1",
          [questionId],
        )
      ).rows,
    ).toEqual([
      {
        response: { component: "another configured component" },
        specialist_assignment_id: null,
        specialist_answer_input_revision: null,
      },
    ]);
    await legacy.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
    expect(
      (
        await legacy.pool.query(
          "SELECT count(*)::int AS count FROM hitl_requests WHERE id=$1",
          [questionId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await legacy.stop();
  }
}, 180000);
