import type {
  TaskLaunchInputSnapshot,
  TaskLaunchSettingsSnapshot,
} from "@/lib/tasks/launch-types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { taskLaunchIntents, runs, flows, flowRevisions } from "@/lib/db/schema";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
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
    "UPDATE tasks SET qualification_mode='required',triage_status='flagged' WHERE id=$1",
    [taskId],
  );
  const input: TaskLaunchInputSnapshot = {
    version: 1,
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
    version: 1,
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
    cause: { constraint: "task_launch_intents_active_task_uq" },
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
    cause: { constraint: "task_launch_intents_active_task_uq" },
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
    cause: { constraint: "task_launch_intents_snapshot_check" },
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
    await oldWriter.query("SET maister.task_launch_writer=''");
    await expect(
      oldWriter.query(
        "UPDATE task_launch_intents SET updated_at=clock_timestamp() WHERE id=$1",
        [accepted.id],
      ),
    ).rejects.toMatchObject({ constraint: "task_launch_writer_capability" });
  } finally {
    await oldWriter.query("SET maister.task_launch_writer='v1'");
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
    await incompatible.query("SET maister.task_launch_writer=''");
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
    await incompatible.query("SET maister.task_launch_writer='v1'");
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
  await database.db
    .update(runs)
    .set({ status: "Abandoned", endedAt: new Date() })
    .where(eq(runs.id, run.id));
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({
        state: "cancelled",
        stateVersion: 4,
        cancellationReceipt: { ...cancellation, expectedStateVersion: 3 },
      })
      .where(eq(taskLaunchIntents.id, ready.id)),
  ).rejects.toMatchObject({
    cause: { constraint: "task_launch_intents_cancel_key_uq" },
  });
  await database.db
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
