import type {
  TaskLaunchInputSnapshot,
  TaskLaunchSettingsSnapshot,
} from "@/lib/tasks/launch-types";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { taskLaunchIntents, runs, flows, flowRevisions } from "@/lib/db/schema";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { retryDigest } from "@/lib/agents/retry-guards";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

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
          "SELECT to_jsonb(i)-ARRAY['preparation_identity','preparation_phase','cleanup_state','dispatch_receipt'] AS value FROM task_launch_intents i WHERE id=$1",
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
