import type {
  TaskLaunchInputSnapshot,
  TaskLaunchSettingsSnapshot,
} from "@/lib/tasks/launch-types";
import type { TaskExecutionChildProof } from "@/lib/tasks/qualification-types";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { canonicalCommandJson } from "../../../../runtime/command-json";

import { taskLaunchIntents, runs, flows, flowRevisions } from "@/lib/db/schema";
import { seedLocalHost, seedRun } from "@/test-support/execution-host-seed";
import { qualificationFixture } from "@/test-support/task-qualification";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { retryDigest } from "@/lib/agents/retry-guards";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

async function coordinatorPromptFixture(
  target: StartedPostgresTestDb,
  projectId: string,
  nodeType: "orchestrator" | "ai_coding",
): Promise<
  Readonly<{
    commandId: string;
    runId: string;
    nodeAttemptId: string;
    requestSha256: string;
  }>
> {
  const runId = await seedRun(target.db, { projectId, runKind: "flow" });
  const existingHost = await target.pool.query<{
    id: string;
    host_key: string;
  }>(
    "SELECT id,host_key FROM execution_hosts WHERE retired_at IS NULL LIMIT 1",
  );
  const host =
    existingHost.rows[0] ??
    (await seedLocalHost(target.db).then((value) => ({
      id: value.id,
      host_key: value.hostKey,
    })));
  const assignmentId = randomUUID();
  const nodeAttemptId = randomUUID();
  const commandId = randomUUID();
  const sessionId = randomUUID();

  await target.pool.query(
    "INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason) VALUES($1,$2,$3,1,'active','launch')",
    [assignmentId, runId, host.id],
  );
  await target.pool.query(
    "UPDATE runs SET execution_assignment_id=$2,current_step_id='coordinate' WHERE id=$1",
    [runId, assignmentId],
  );
  await target.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES($1,$2,'coordinate',$3,'Running')",
    [nodeAttemptId, runId, nodeType],
  );
  const request = canonicalCommandJson({
    requestVersion: 2,
    command: {
      id: commandId,
      kind: "session.prompt",
      issuedAt: new Date().toISOString(),
    },
    fence: { hostKey: host.host_key, runId, assignmentId, assignmentEpoch: 1 },
    target: { hostSessionId: sessionId },
    payload: { prompt: "Retained private coordinator request" },
  });
  const requestSha256 = createHash("sha256").update(request).digest("hex");
  const owner = {
    version: 1,
    variant: "node",
    runId,
    runSessionId: randomUUID(),
    incarnationId: randomUUID(),
    assignmentId,
    assignmentEpoch: 1,
    nodeAttemptId,
    promptOrdinal: 0,
  };

  await target.pool.query(
    "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,target_session_id,payload,max_attempts,owner_kind,owner_ref,logical_operation_key,request_schema,request_sha256,request_canonical_json) VALUES($1,$2,$3,$4,1,'session.prompt',$5,'{}',3,'flow_node_attempt',$6,$7,'maister.command.request.v2',$8,$9)",
    [
      commandId,
      runId,
      assignmentId,
      host.id,
      sessionId,
      owner,
      `node:${nodeAttemptId}:0`,
      requestSha256,
      request,
    ],
  );

  return { commandId, runId, nodeAttemptId, requestSha256 };
}

async function insertCoordinatorContext(
  sourceCommandId: string,
  receipts: readonly unknown[],
): Promise<string> {
  const commandId = randomUUID();

  await database.pool.query(
    `
    WITH original AS (
      SELECT *,jsonb_set(request_canonical_json::jsonb,'{command,id}',to_jsonb($2::text))::text AS request
      FROM execution_commands WHERE id=$1
    )
    INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,target_session_id,payload,max_attempts,owner_kind,owner_ref,logical_operation_key,request_schema,request_sha256,request_canonical_json,coordinator_child_launch_context)
    SELECT $2,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,target_session_id,payload,max_attempts,owner_kind,owner_ref,logical_operation_key||':'||$2,request_schema,encode(sha256(convert_to(request,'UTF8')),'hex'),request,
      jsonb_build_object('version',1,'nodeAttemptId',owner_ref->>'nodeAttemptId','promptOrdinal',owner_ref->'promptOrdinal','requestSha256',encode(sha256(convert_to(request,'UTF8')),'hex'),'receipts',$3::jsonb)
    FROM original`,
    [sourceCommandId, commandId, JSON.stringify(receipts)],
  );

  return commandId;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "launch_admission_schema",
  });
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

it("DB01 persists one immutable task reservation and rejects malformed launch snapshots", async () => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role) VALUES($1,$2,'admin')",
    [userId, `${userId}@test.local`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES($1,$2,'Launch admission','/tmp/launch-admission','/tmp/maister.yaml',$3)",
    [
      projectId,
      `p-${projectId}`,
      `L${projectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Request','Original request')",
    [taskId, projectId],
  );
  const exists = await database.pool.query(
    "SELECT to_regclass('public.task_launch_intents') AS relation",
  );

  expect(exists.rows[0].relation).toBe("task_launch_intents");
  const constraints = await database.pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid='task_launch_intents'::regclass",
  );

  expect(
    constraints.rows.map((row: { conname: string }) => row.conname),
  ).toContain("task_launch_intents_snapshot_check");
  await database.pool.query(
    "UPDATE tasks SET qualification_mode='required',triage_status='flagged',triage_flag_origin='qualification' WHERE id=$1",
    [taskId],
  );
  const input: TaskLaunchInputSnapshot = {
    version: 2,
    projectId,
    taskId,
    number: 1,
    title: "Request",
    prompt: "Original request",
    statementRevision: null,
    sourceVersion: null,
    target: "main",
    deliveryTarget: "main",
    clarifications: [],
  };
  const {
    provider: _provider,
    env: _environment,
    ...runnerIdentity
  } = testRunnerSnapshot("fixture-runner");
  const settings: TaskLaunchSettingsSnapshot = {
    version: 2,
    kind: "flow",
    workspace: "worktree",
    agentId: null,
    definitionSha256: null,
    flowId: "fixture-flow",
    flowRefId: "fixture:flow",
    flowRevisionId: "fixture-revision",
    packageInstallId: null,
    sessions: [
      {
        sessionName: "default",
        runnerId: "fixture-runner",
        runnerSnapshot: runnerIdentity,
        runnerConfigDigest: "b".repeat(64),
      },
    ],
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    targetBranch: "main",
    promotionMode: "pull_request",
    autoPromote: true,
    deliveryPolicy: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: "main",
    },
    executionPolicy: { preset: "supervised" },
    resolvedCapabilitySet: {
      flowRevisionId: "fixture-revision",
      flowOrigin: "git",
      capabilities: [],
      mcps: [],
    },
    capabilityResolutionDigest: "8".repeat(64),
    taskSettingsDigest: "c".repeat(64),
    resolutionToken: "d".repeat(64),
  };
  const accepted: typeof taskLaunchIntents.$inferInsert = {
    id: randomUUID(),
    projectId,
    taskId,
    principalKind: "session_user",
    principalId: userId,
    actorUserId: userId,
    launchSource: "web",
    operation: "launch",
    requestKey: randomUUID(),
    payloadDigest: "1".repeat(64),
    taskRevision: 0,
    inputRevision: 1,
    inputDigest: "2".repeat(64),
    inputSnapshot: input,
    settingsDigest: "3".repeat(64),
    settingsSnapshot: settings,
    basis: { kind: "manual", userId },
    dueAt: new Date(),
  };

  await database.db.insert(taskLaunchIntents).values(accepted);
  await expect(
    database.db
      .insert(taskLaunchIntents)
      .values({ ...accepted, id: randomUUID(), requestKey: randomUUID() }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_shared_reservation" },
  });
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({ inputSnapshot: { ...input, prompt: "Changed request" } })
      .where(eq(taskLaunchIntents.id, accepted.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_request_immutable" },
  });
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({ state: "held", reason: "launch_input_changed" })
      .where(eq(taskLaunchIntents.id, accepted.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_state_version" },
  });
  await database.db
    .update(taskLaunchIntents)
    .set({ state: "held", reason: "launch_input_changed", stateVersion: 2 })
    .where(eq(taskLaunchIntents.id, accepted.id));
  await expect(
    database.db
      .insert(taskLaunchIntents)
      .values({ ...accepted, id: randomUUID(), requestKey: randomUUID() }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_shared_reservation" },
  });
  await expect(
    database.db
      .delete(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_active_retention" },
  });
  const cancellation = {
    version: 1 as const,
    principalKind: "session_user" as const,
    principalId: userId,
    actorUserId: userId,
    requestKey: randomUUID(),
    payloadDigest: "5".repeat(64),
    expectedStateVersion: 2,
    cancelledAt: new Date().toISOString(),
  };

  await database.db
    .update(taskLaunchIntents)
    .set({
      state: "cancelled",
      stateVersion: 3,
      cancellationReceipt: cancellation,
    })
    .where(eq(taskLaunchIntents.id, accepted.id));
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({
        cancellationReceipt: { ...cancellation, payloadDigest: "6".repeat(64) },
      })
      .where(eq(taskLaunchIntents.id, accepted.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_cancellation_immutable" },
  });
  await expect(
    database.db.insert(taskLaunchIntents).values({
      ...accepted,
      id: randomUUID(),
      requestKey: randomUUID(),
      settingsSnapshot: { ...settings, sessions: [] },
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_snapshot_check" },
  });
  await expect(
    database.db.insert(taskLaunchIntents).values({
      ...accepted,
      id: randomUUID(),
      requestKey: randomUUID(),
      principalKind: "project_token",
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_token_origin_current" },
  });
  await expect(
    database.db.insert(taskLaunchIntents).values({
      ...accepted,
      id: randomUUID(),
      requestKey: randomUUID(),
      principalKind: "system",
      basis: {
        kind: "automatic",
        qualificationId: "missing",
        qualificationRevision: 1,
        qualificationInputDigest: "2".repeat(64),
        evidenceTarget: "main",
        evidenceSha: settings.baseCommit,
      },
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_automatic_admission" },
  });
  const oldWriter = await database.pool.connect();

  try {
    await oldWriter.query("SET maister.task_launch_writer='v1'");
    await expect(
      oldWriter.query(
        "UPDATE task_launch_intents SET updated_at=clock_timestamp() WHERE id=$1",
        [accepted.id],
      ),
    ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
  } finally {
    await oldWriter.query("SET maister.task_launch_writer='v3'");
    oldWriter.release();
  }
  await expect(
    database.db.insert(taskLaunchIntents).values({
      ...accepted,
      id: randomUUID(),
      requestKey: randomUUID(),
      settingsSnapshot: { ...settings, baseCommit: "a".repeat(41) },
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_snapshot_check" },
  });
  const [ready] = await database.db
    .insert(taskLaunchIntents)
    .values({ ...accepted, id: randomUUID(), requestKey: randomUUID() })
    .returning();
  const unchanged = (
    await database.pool.query(
      "SELECT qualification_mode,triage_status,current_qualification_id FROM tasks WHERE id=$1",
      [taskId],
    )
  ).rows[0];

  expect(unchanged).toEqual({
    qualification_mode: "required",
    triage_status: "flagged",
    current_qualification_id: null,
  });
  await database.db.insert(flowRevisions).values({
    id: settings.flowRevisionId,
    flowRefId: settings.flowRefId,
    source: "local",
    versionLabel: "v1",
    resolvedRevision: "fixture",
    manifestDigest: "4".repeat(64),
    manifest: {},
    schemaVersion: 1,
    installedPath: "/tmp/launch-admission",
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await database.db.insert(flows).values({
    id: settings.flowId,
    projectId,
    flowRefId: settings.flowRefId,
    source: "local",
    version: "v1",
    installedPath: "/tmp/launch-admission",
    manifest: {},
    schemaVersion: 1,
    enabledRevisionId: settings.flowRevisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });
  await database.db
    .update(taskLaunchIntents)
    .set({
      state: "preparing",
      stateVersion: 2,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(eq(taskLaunchIntents.id, ready.id));
  const run: typeof runs.$inferInsert = {
    id: randomUUID(),
    taskId,
    projectId,
    runKind: "flow",
    status: "Pending",
    flowId: settings.flowId,
    flowRevisionId: settings.flowRevisionId,
    flowVersion: "v1",
    taskLaunchIntentId: ready.id,
    executionPolicy: settings.executionPolicy,
    resolvedCapabilitySet: settings.resolvedCapabilitySet,
    taskAdmissionSnapshot: {
      version: 2,
      policyVersion: 2,
      mode: "manual",
      basis: "manual",
      intentId: ready.id,
      inputRevision: 1,
      qualificationId: null,
      qualificationRevision: null,
      evidenceTarget: settings.baseBranch,
      evidenceSha: settings.baseCommit,
      parent: null,
    },
  };

  await expect(
    database.db
      .insert(runs)
      .values({ ...run, executionPolicy: { preset: "unattended" } }),
  ).rejects.toMatchObject({
    cause: { constraint: "runs_task_launch_settings_required" },
  });
  await database.db.insert(runs).values(run);
  const incompatible = await database.pool.connect();

  try {
    await incompatible.query("SET maister.task_launch_writer='v1'");
    await expect(
      incompatible.query("UPDATE runs SET status='Running' WHERE id=$1", [
        run.id,
      ]),
    ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
    await expect(
      incompatible.query("UPDATE tasks SET title='Silent edit' WHERE id=$1", [
        taskId,
      ]),
    ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
  } finally {
    await incompatible.query("SET maister.task_launch_writer='v3'");
    incompatible.release();
  }

  await expect(
    database.db.insert(runs).values({ ...run, id: randomUUID() }),
  ).rejects.toMatchObject({
    cause: { constraint: "runs_task_launch_intent_uq" },
  });
  await database.db
    .update(taskLaunchIntents)
    .set({
      state: "run_bound",
      runId: run.id,
      originalRunId: run.id,
      stateVersion: 3,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(eq(taskLaunchIntents.id, ready.id));
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({ state: "settled", stateVersion: 4, terminalOutcome: "Done" })
      .where(eq(taskLaunchIntents.id, ready.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_terminal_binding" },
  });
  await expect(
    database.db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ status: "Abandoned", endedAt: new Date() })
        .where(eq(runs.id, run.id));
      await tx
        .update(taskLaunchIntents)
        .set({
          state: "cancelled",
          stateVersion: 4,
          cancellationReceipt: { ...cancellation, expectedStateVersion: 3 },
        })
        .where(eq(taskLaunchIntents.id, ready.id));
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_cancel_key_uq" },
  });
  await database.db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "Abandoned", endedAt: new Date() })
      .where(eq(runs.id, run.id));
    await tx
      .update(taskLaunchIntents)
      .set({
        state: "cancelled",
        stateVersion: 4,
        cancellationReceipt: {
          ...cancellation,
          requestKey: randomUUID(),
          expectedStateVersion: 3,
        },
      })
      .where(eq(taskLaunchIntents.id, ready.id));
  });
  await database.db.delete(runs).where(eq(runs.id, run.id));
  const [retained] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, ready.id));

  const noRepository = {
    ...settings,
    kind: "agent" as const,
    workspace: "none" as const,
    agentId: "fixture:code-delivery",
    definitionSha256: "7".repeat(64),
    flowId: null,
    flowRefId: null,
    flowRevisionId: null,
    baseCommit: null,
    resolvedCapabilitySet: null,
  };
  const [repositoryFree] = await database.db
    .insert(taskLaunchIntents)
    .values({
      ...accepted,
      id: randomUUID(),
      requestKey: randomUUID(),
      settingsSnapshot: noRepository,
    })
    .returning();

  expect(repositoryFree.settingsSnapshot.baseCommit).toBeNull();
  await database.db
    .update(taskLaunchIntents)
    .set({ state: "cancelled", stateVersion: 2 })
    .where(eq(taskLaunchIntents.id, repositoryFree.id));
  expect(retained).toMatchObject({
    originalRunId: run.id,
    runId: null,
    stateVersion: 5,
    state: "cancelled",
  });
});

it("DB02 upgrades immutable v1 intent history without inventing missing execution input and fences its old writer", async () => {
  const partial = await startMainPostgresTestDbUpTo(
    { databaseName: "launch_execution_snapshot_upgrade" },
    "0218_task_launch_commit_shape",
  );

  try {
    const [source] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.principalKind, "session_user"),
          eq(taskLaunchIntents.launchSource, "web"),
        ),
      )
      .limit(1);

    if (source.settingsSnapshot.version !== 2)
      throw new Error("Missing current launch snapshot fixture");
    const {
      resolvedCapabilitySet: _capabilities,
      capabilityResolutionDigest: _capabilityDigest,
      ...settingsFields
    } = source.settingsSnapshot;
    const legacySettings = { ...settingsFields, version: 1 as const };
    const legacyInput = { ...source.inputSnapshot, version: 1 as const };

    await partial.pool.query(
      "INSERT INTO users(id,email,role) VALUES($1,$2,'admin')",
      [source.actorUserId, `${source.actorUserId}@test.local`],
    );
    await partial.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Upgrade','/tmp/intent-upgrade','UPGRADE')",
      [source.projectId],
    );
    await partial.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt,revision,qualification_input_revision) VALUES($1,$2,1,$3,$4,$5,$6)",
      [
        source.taskId,
        source.projectId,
        legacyInput.title,
        legacyInput.prompt,
        source.taskRevision,
        source.inputRevision,
      ],
    );
    const historicalRunId = randomUUID();

    await partial.pool.query(
      "INSERT INTO runs(id,project_id,flow_version,status,run_kind) VALUES($1,$2,'v1','Running','flow')",
      [historicalRunId, source.projectId],
    );
    const intentId = randomUUID();

    await partial.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL maister.task_launch_writer='v1'`);
      await tx.execute(sql`INSERT INTO task_launch_intents (
        id,project_id,task_id,principal_kind,principal_id,actor_user_id,launch_source,operation,
        request_key,payload_digest,task_revision,input_revision,input_digest,settings_digest,
        input_snapshot,settings_snapshot,basis,due_at
      ) VALUES (${intentId},${source.projectId},${source.taskId},'session_user',${source.principalId},${source.actorUserId},'web','launch',
        ${randomUUID()},${"9".repeat(64)},${source.taskRevision},${source.inputRevision},${retryDigest(legacyInput)},${retryDigest(legacySettings)},
        ${JSON.stringify(legacyInput)}::jsonb,${JSON.stringify(legacySettings)}::jsonb,${JSON.stringify(source.basis)}::jsonb,clock_timestamp())`);
    });
    const before = (
      await partial.pool.query(
        "SELECT to_jsonb(i) AS value FROM task_launch_intents i WHERE id=$1",
        [intentId],
      )
    ).rows[0].value;

    const historicalTriggerId = randomUUID();
    const historicalScheduleId = randomUUID();

    await partial.pool.query(
      "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,fence,delivery_key,trigger_source,reserved_run_id,claimed_at,due_at,settled_at,outcome) VALUES($1,$2,'historical-agent',$3,$4,1,'historical-fire','domain_event',$5,clock_timestamp(),clock_timestamp()+interval '1 minute',clock_timestamp(),'queued')",
      [
        historicalTriggerId,
        source.projectId,
        historicalScheduleId,
        { version: 1, scheduleId: historicalScheduleId },
        historicalRunId,
      ],
    );
    const historicalTrigger = (
      await partial.pool.query(
        "SELECT to_jsonb(a) value FROM agent_trigger_attempts a WHERE id=$1",
        [historicalTriggerId],
      )
    ).rows[0].value;

    await upgradeMainTestDb(partial, "0218_task_launch_commit_shape");
    await migrate(partial.db, { migrationsFolder: "./lib/db/migrations" });
    expect(
      (
        await partial.pool.query(
          "SELECT to_jsonb(i)-ARRAY['preparation_identity','preparation_phase','cleanup_state','dispatch_receipt','parent_observed_version'] AS value FROM task_launch_intents i WHERE id=$1",
          [intentId],
        )
      ).rows[0].value,
    ).toEqual(before);
    expect(
      (
        await partial.pool.query(
          "SELECT to_jsonb(a) value FROM agent_trigger_attempts a WHERE id=$1",
          [historicalTriggerId],
        )
      ).rows[0].value,
    ).toEqual(historicalTrigger);
    await expect(
      partial.pool.query(
        "UPDATE agent_trigger_attempts SET run_id=$2,original_run_id=$2 WHERE id=$1",
        [historicalTriggerId, historicalRunId],
      ),
    ).rejects.toMatchObject({
      constraint: "agent_trigger_attempt_settlement_immutable",
    });
    await expect(
      partial.pool.query(
        "UPDATE agent_trigger_attempts SET outcome='failed' WHERE id=$1",
        [historicalTriggerId],
      ),
    ).rejects.toMatchObject({
      constraint: "agent_trigger_attempt_settlement_immutable",
    });
    const oldWriter = await partial.pool.connect();

    try {
      await oldWriter.query("SET maister.task_launch_writer='v1'");
      await expect(
        oldWriter.query(
          "UPDATE task_launch_intents SET updated_at=clock_timestamp() WHERE id=$1",
          [intentId],
        ),
      ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
      await oldWriter.query("SET maister.task_launch_writer='v2'");
      await expect(
        oldWriter.query(
          "UPDATE task_launch_intents SET updated_at=clock_timestamp() WHERE id=$1",
          [intentId],
        ),
      ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
      // Existing capacity remains usable; acquiring new capacity requires the new counter-aware binary.
      await oldWriter.query("UPDATE runs SET status='NeedsInput' WHERE id=$1", [
        historicalRunId,
      ]);
      await oldWriter.query("UPDATE runs SET status='Review' WHERE id=$1", [
        historicalRunId,
      ]);
      await expect(
        oldWriter.query("UPDATE runs SET status='Running' WHERE id=$1", [
          historicalRunId,
        ]),
      ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
      await expect(
        oldWriter.query(
          "INSERT INTO runs(id,project_id,flow_version,status,run_kind) VALUES($1,$2,'v1','Pending','flow')",
          [randomUUID(), source.projectId],
        ),
      ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
      await oldWriter.query("SET maister.task_launch_writer='v3'");
      await oldWriter.query("UPDATE runs SET status='Running' WHERE id=$1", [
        historicalRunId,
      ]);
      await oldWriter.query(
        "INSERT INTO runs(id,project_id,flow_version,status,run_kind) VALUES($1,$2,'v1','Pending','flow')",
        [randomUUID(), source.projectId],
      );
    } finally {
      await oldWriter.query("SET maister.task_launch_writer='v3'");
      oldWriter.release();
    }
    await partial.db
      .update(taskLaunchIntents)
      .set({
        state: "preparing",
        stateVersion: 2,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(taskLaunchIntents.id, intentId));
    await expect(
      partial.db.insert(runs).values({
        id: randomUUID(),
        projectId: source.projectId,
        taskId: source.taskId,
        runKind: "flow",
        status: "Pending",
        flowVersion: "v1",
        flowId: legacySettings.flowId,
        flowRevisionId: legacySettings.flowRevisionId,
        executionPolicy: legacySettings.executionPolicy,
        taskLaunchIntentId: intentId,
        taskAdmissionSnapshot: {
          version: 2,
          policyVersion: 2,
          mode: "manual",
          basis: "manual",
          intentId,
          inputRevision: source.inputRevision,
          qualificationId: null,
          qualificationRevision: null,
          parent: null,
          evidenceTarget: legacySettings.baseBranch,
          evidenceSha: legacySettings.baseCommit,
        },
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "runs_task_launch_binding_required" },
    });
  } finally {
    await partial.stop();
  }
}, 180_000);

it("DB03 preserves populated 0226 history and leaves new origin, context and parent witnesses unknown through upgrade and replay", async () => {
  const partial = await startMainPostgresTestDbUpTo(
    { databaseName: "queued_child_upgrade" },
    "0226_session_create_owner_continuation",
  );

  try {
    await partial.pool.query("SET maister.task_launch_writer='v3'");
    const [source] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.principalKind, "session_user"))
      .limit(1);

    await partial.pool.query(
      "INSERT INTO users(id,email,role) VALUES($1,$2,'admin')",
      [source.actorUserId, `${source.actorUserId}@test.local`],
    );
    await partial.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Upgrade','/tmp/child-upgrade','CHILDUP')",
      [source.projectId],
    );
    await partial.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt,revision,qualification_input_revision) VALUES($1,$2,1,$3,$4,$5,$6)",
      [
        source.taskId,
        source.projectId,
        source.inputSnapshot.title,
        source.inputSnapshot.prompt,
        source.taskRevision,
        source.inputRevision,
      ],
    );
    const historicalIntent = (
      await database.pool.query<{ value: Readonly<Record<string, unknown>> }>(
        "SELECT to_jsonb(i)-'parent_observed_version' AS value FROM task_launch_intents i WHERE id=$1",
        [source.id],
      )
    ).rows[0].value;

    await partial.pool.query(
      "INSERT INTO task_launch_intents SELECT (jsonb_populate_record(NULL::task_launch_intents,$1::jsonb)).*",
      [
        JSON.stringify({
          ...historicalIntent,
          state: "queued",
          state_version: 1,
          // Replay the frozen request as a fresh 0226 queue entry, regardless
          // of which lifecycle state the source fixture has reached.
          run_id: null,
          original_run_id: null,
          dispatch_committed_at: null,
          attempts: 0,
          reason: null,
          cancellation_receipt: null,
        }),
      ],
    );
    const command = await coordinatorPromptFixture(
      partial,
      source.projectId,
      "orchestrator",
    );
    const tokenId = randomUUID();
    const qualificationId = randomUUID();

    await partial.pool.query(
      "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash,scopes,revoked_at) VALUES($1,$2,'Historical token','retained','retained-hash','[\"runs:delegate\"]',clock_timestamp())",
      [tokenId, source.projectId],
    );
    await partial.pool.query(
      "UPDATE tasks SET qualification_revision_counter=1 WHERE id=$1",
      [source.taskId],
    );
    await partial.pool.query(
      "INSERT INTO task_qualifications(id,project_id,task_id,revision,input_revision,input_digest,request_key,payload_digest,author_kind,author_identity,author_user_id,evidence_target,evidence_sha,value,routing,publication_state,published_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,'user',$8,$8,'main',$9,$10,'{\"flowId\":null,\"runnerId\":null,\"baseBranch\":null,\"enqueue\":false}','accepted',clock_timestamp())",
      [
        qualificationId,
        source.projectId,
        source.taskId,
        source.inputRevision,
        source.inputDigest,
        randomUUID(),
        "a".repeat(64),
        source.actorUserId,
        "a".repeat(40),
        qualificationFixture(),
      ],
    );
    const readHistory = async () => ({
      run: (
        await partial.pool.query(
          "SELECT to_jsonb(r) value FROM runs r WHERE id=$1",
          [command.runId],
        )
      ).rows[0].value,
      qualification: (
        await partial.pool.query(
          "SELECT to_jsonb(q) value FROM task_qualifications q WHERE id=$1",
          [qualificationId],
        )
      ).rows[0].value,
      token: (
        await partial.pool.query(
          "SELECT to_jsonb(t)-ARRAY['bound_run_id','origin_kind','revocation_reason'] value FROM project_tokens t WHERE id=$1",
          [tokenId],
        )
      ).rows[0].value,
      intent: (
        await partial.pool.query(
          "SELECT to_jsonb(i)-'parent_observed_version' value FROM task_launch_intents i WHERE id=$1",
          [source.id],
        )
      ).rows[0].value,
      command: (
        await partial.pool.query(
          "SELECT to_jsonb(c)-'coordinator_child_launch_context' value FROM execution_commands c WHERE id=$1",
          [command.commandId],
        )
      ).rows[0].value,
    });
    const before = await readHistory();

    await upgradeMainTestDb(partial, "0226_session_create_owner_continuation");
    await migrate(partial.db, { migrationsFolder: "./lib/db/migrations" });
    expect(await readHistory()).toEqual(before);
    expect(
      (
        await partial.pool.query(
          "SELECT bound_run_id,origin_kind,revocation_reason FROM project_tokens WHERE id=$1",
          [tokenId],
        )
      ).rows[0],
    ).toEqual({
      bound_run_id: null,
      origin_kind: null,
      revocation_reason: null,
    });
    expect(
      (
        await partial.pool.query(
          "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
          [source.id],
        )
      ).rows[0].parent_observed_version,
    ).toBeNull();
    expect(
      (
        await partial.pool.query(
          "SELECT coordinator_child_launch_context FROM execution_commands WHERE id=$1",
          [command.commandId],
        )
      ).rows[0].coordinator_child_launch_context,
    ).toBeNull();
    await expect(
      partial.pool.query(
        "UPDATE project_tokens SET origin_kind='orchestrator_run',bound_run_id=$2 WHERE id=$1",
        [tokenId, command.runId],
      ),
    ).rejects.toMatchObject({
      constraint: "project_tokens_run_origin_immutable",
    });
    await expect(
      partial.pool.query(
        "UPDATE project_tokens SET revocation_reason='rotation' WHERE id=$1",
        [tokenId],
      ),
    ).rejects.toMatchObject({
      constraint: "project_tokens_revocation_monotonic",
    });
  } finally {
    await partial.stop();
  }
}, 180_000);

it("DB04 fresh SQL binds machine origins immutably and refuses unstamped or backwards rotation", async () => {
  const projectId = (
    await database.pool.query<{ project_id: string }>(
      "SELECT project_id FROM task_launch_intents LIMIT 1",
    )
  ).rows[0].project_id;
  const owner = await coordinatorPromptFixture(
    database,
    projectId,
    "orchestrator",
  );
  const tokenId = randomUUID();
  const otherProjectId = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Other','/tmp/other-origin','OTHEROR')",
    [otherProjectId],
  );
  await expect(
    database.pool.query(
      "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash,origin_kind,bound_run_id) VALUES($1,$2,'Cross project','cross','hash','orchestrator_run',$3)",
      [randomUUID(), otherProjectId, owner.runId],
    ),
  ).rejects.toMatchObject({ constraint: "project_tokens_run_origin_owner" });
  await database.pool.query(
    "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash,scopes,origin_kind,bound_run_id) VALUES($1,$2,'Bound coordinator','bound','hash','[\"runs:delegate\"]','orchestrator_run',$3)",
    [tokenId, projectId, owner.runId],
  );
  // Audit-only updates must not plan the INSERT-only Run ownership query.
  const runLock = await database.pool.connect();

  try {
    await runLock.query("BEGIN");
    await runLock.query("LOCK TABLE runs IN ACCESS EXCLUSIVE MODE");
    const auditUpdate = await database.pool.connect();

    try {
      await auditUpdate.query("BEGIN");
      await auditUpdate.query("SET LOCAL lock_timeout='500ms'");
      const updated = await auditUpdate.query(
        "UPDATE project_tokens SET last_used_at=clock_timestamp() WHERE id=$1 RETURNING id",
        [tokenId],
      );

      expect(updated.rowCount).toBe(1);
    } finally {
      try {
        await auditUpdate.query("ROLLBACK");
      } finally {
        auditUpdate.release();
      }
    }
  } finally {
    try {
      await runLock.query("ROLLBACK");
    } finally {
      runLock.release();
    }
  }
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET bound_run_id=$2 WHERE id=$1",
      [tokenId, randomUUID()],
    ),
  ).rejects.toMatchObject({
    constraint: "project_tokens_run_origin_immutable",
  });
  await expect(
    database.pool.query("UPDATE project_tokens SET project_id=$2 WHERE id=$1", [
      tokenId,
      otherProjectId,
    ]),
  ).rejects.toMatchObject({
    constraint: "project_tokens_run_origin_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revocation_reason='rotation' WHERE id=$1",
      [tokenId],
    ),
  ).rejects.toMatchObject({
    constraint: "project_tokens_revocation_reason_check",
  });
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=clock_timestamp(),revocation_reason='rotation' WHERE id=$1",
    [tokenId],
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revoked_at=NULL,revocation_reason=NULL WHERE id=$1",
      [tokenId],
    ),
  ).rejects.toMatchObject({
    constraint: "project_tokens_revocation_monotonic",
  });
  await database.pool.query(
    "UPDATE project_tokens SET revocation_reason='revoked' WHERE id=$1",
    [tokenId],
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revocation_reason='rotation' WHERE id=$1",
      [tokenId],
    ),
  ).rejects.toMatchObject({
    constraint: "project_tokens_revocation_monotonic",
  });
  const ordinaryToken = randomUUID();

  await database.pool.query(
    "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash) VALUES($1,$2,'Ordinary token','ordinary','hash')",
    [ordinaryToken, projectId],
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revoked_at=clock_timestamp(),revocation_reason='rotation' WHERE id=$1",
      [ordinaryToken],
    ),
  ).rejects.toMatchObject({
    constraint: "project_tokens_rotation_origin_check",
  });
});

it("DB05 fresh SQL requires an immutable bounded coordinator-owned prompt and completed witness before parent observation", async () => {
  const [source] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.principalKind, "session_user"))
    .limit(1);
  const coordinator = await coordinatorPromptFixture(
    database,
    source.projectId,
    "orchestrator",
  );
  const ordinary = await coordinatorPromptFixture(
    database,
    source.projectId,
    "ai_coding",
  );
  const taskId = randomUUID();
  const intentId = randomUUID();
  const proof: TaskExecutionChildProof = {
    version: 1,
    parentRunId: coordinator.runId,
    parentTaskId: null,
    parentAdmissionDigest: "a".repeat(64),
    parentLegacy: true,
    planRevision: "migration-guard",
    childInputDigest: source.inputDigest,
    relationId: null,
  };

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt,qualification_mode,qualification_child_proof) VALUES($1,$2,2,$3,$4,'execution_child',$5)",
    [
      taskId,
      source.projectId,
      source.inputSnapshot.title,
      source.inputSnapshot.prompt,
      proof,
    ],
  );
  await database.db.insert(taskLaunchIntents).values({
    id: intentId,
    projectId: source.projectId,
    taskId,
    principalKind: "system",
    principalId: "migration-coordinator",
    launchSource: "execution_child",
    operation: "launch",
    requestKey: randomUUID(),
    payloadDigest: "e".repeat(64),
    taskRevision: 0,
    inputRevision: 1,
    inputDigest: source.inputDigest,
    inputSnapshot: { ...source.inputSnapshot, taskId, number: 2 },
    settingsDigest: source.settingsDigest,
    settingsSnapshot: source.settingsSnapshot,
    basis: { kind: "execution_child", parent: proof },
    dueAt: new Date(),
  });
  await database.pool.query(
    "UPDATE task_launch_intents SET state='cancelled',state_version=2 WHERE id=$1",
    [intentId],
  );
  const receipt = {
    intentId,
    taskId,
    state: "cancelled",
    stateVersion: 2,
    reason: null,
  };

  await expect(
    insertCoordinatorContext(ordinary.commandId, [receipt]),
  ).rejects.toMatchObject({
    constraint: "execution_commands_coordinator_context_owner",
  });
  for (const malformed of [
    { ...receipt, stateVersion: -1 },
    { ...receipt, reason: "unsafe\nreason" },
    { ...receipt, prompt: "Not diagnostic data" },
  ]) {
    await expect(
      insertCoordinatorContext(coordinator.commandId, [malformed]),
    ).rejects.toMatchObject({
      constraint: "execution_commands_coordinator_context_receipt",
    });
  }
  const commandId = await insertCoordinatorContext(coordinator.commandId, [
    receipt,
  ]);

  await expect(
    database.pool.query(
      "UPDATE execution_commands SET coordinator_child_launch_context=NULL WHERE id=$1",
      [commandId],
    ),
  ).rejects.toMatchObject({
    constraint: "execution_commands_coordinator_context_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE execution_commands SET coordinator_child_launch_context='{}' WHERE id=$1",
      [coordinator.commandId],
    ),
  ).rejects.toMatchObject({
    constraint: "execution_commands_coordinator_context_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE task_launch_intents SET parent_observed_version=2 WHERE id=$1",
      [intentId],
    ),
  ).rejects.toMatchObject({
    constraint: "task_launch_parent_observation_owner",
  });
  expect(
    (
      await database.pool.query(
        "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
        [intentId],
      )
    ).rows[0].parent_observed_version,
  ).toBeNull();
  expect(
    (
      await database.pool.query(
        "SELECT transport_state,application_state FROM execution_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0],
  ).toEqual({ transport_state: "not_sent", application_state: "pending" });
});
