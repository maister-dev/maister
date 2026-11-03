import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  agents,
  evaluationParticipants,
  evaluationStudies,
  executionAssignments,
  flowRevisions,
  flows,
  runs,
  tasks,
  taskLaunchIntents,
  projectTokens,
  workspaces,
  taskRelations,
  hitlRequests,
} from "@/lib/db/schema";
import { respondToHitl } from "@/lib/services/hitl";
import { previewBudgetRestart } from "@/lib/tasks/launch-budget-restart";
import { MaisterError } from "@/lib/errors";
import { projectHitlAnswer } from "@/lib/hitl-answer-view";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import {
  captureTaskLaunchRelaunchSource,
  captureConcurrentTaskLaunchRelaunchSource,
  assertTaskLaunchRelaunchSource,
  interactiveTaskLaunchRecoveryAuthority,
  tokenTaskLaunchRecoveryAuthority,
} from "@/lib/tasks/launch-continuation";
import { tokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import { issueToken } from "@/lib/tokens/issue";
import {
  establishExecutionChildAdmission,
  prepareTaskDeliveryAdmission,
} from "@/lib/tasks/qualification-admission";
import { taskLaunchInputForRun } from "@/lib/tasks/launch-execution-input";
import {
  bindPendingTaskLaunchFixture,
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { prepareTaskLaunchFirstDispatch } from "@/lib/tasks/launch-first-dispatch";
import { takeSchedulerLock } from "@/lib/scheduler";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { resumeCrashedRun } from "@/lib/runs/recover";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let number = 0;
let hostFixture: Awaited<ReturnType<typeof fakeExecutionHosts>>;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async () => ({ id: fixture.userId, role: "admin" }),
    requireProjectAction: (
      projectId: string,
      action: import("@/lib/authz").ProjectAction,
    ) => actual.requireProjectActionForUser(fixture.userId, projectId, action),
  };
});
vi.mock("@/lib/supervisor-client", async (original) => ({
  ...(await original<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: async () => ({ kind: "available" }),
  listSessions: async () => [],
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_continuation",
  });
  root = await mkdtempReal("task-launch-continuation-");
  fixture = await seedTaskLaunchFixture(database, root);
  hostFixture = await fakeExecutionHosts(database.db);
  vi.stubEnv("MAISTER_WORKTREES_ROOT", path.join(root, "worktrees"));
  vi.stubEnv("MAISTER_RUNTIME_ROOT", path.join(root, "runtime"));
  const manifest = {
    schemaVersion: 1,
    name: "Continuation",
    nodes: [
      {
        id: "check",
        type: "check",
        action: { command: "true" },
        retry_safe: true,
        transitions: { success: "done" },
      },
    ],
  };
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));

  if (!flow.enabledRevisionId)
    throw new Error("Continuation fixture has no revision");
  await database.db
    .update(flowRevisions)
    .set({ manifest })
    .where(eq(flowRevisions.id, flow.enabledRevisionId));
  await database.db
    .update(flows)
    .set({ manifest })
    .where(eq(flows.id, flow.id));
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function committedRun(): Promise<{
  taskId: string;
  intentId: string;
  runId: string;
}> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++number,
    title: "Recover frozen input",
    prompt: "Original committed prompt",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
    },
    randomUUID(),
  );
  const prepared = await prepareTaskLaunchIntent(
    database.db,
    accepted.intentId,
  );

  if (!prepared.runId)
    throw new Error(`Run preparation failed: ${prepared.reason}`);
  const runId = prepared.runId;
  const dispatch = await prepareTaskLaunchFirstDispatch(database.db, runId);

  if (!dispatch) throw new Error("Expected the first dispatch witness");
  await database.db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await dispatch.apply(tx as unknown as Db);
    await tx
      .update(runs)
      .set({ status: "Running", currentStepId: "check" })
      .where(eq(runs.id, runId));
  });

  return { taskId, intentId: accepted.intentId, runId };
}

async function committedCrash(): Promise<
  Awaited<ReturnType<typeof committedRun>>
> {
  const source = await committedRun();

  await crashRunningRun(source.runId, "agent-session-gone", {
    db: database.db,
  });

  return source;
}

it("LA08 a v2 crash recovery requires fresh current recovery authority before claiming the original reservation", async () => {
  const source = await committedCrash();
  const drive = vi.fn(async () => {});

  await expect(
    resumeCrashedRun(source.runId, {
      db: database.db,
      executionHosts: hostFixture.hosts,
      runFlow: drive,
    }),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "launch_recovery_authority_required" },
  });
  expect(drive).not.toHaveBeenCalled();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(intent.state).toBe("settled");
  expect(intent.terminalOutcome).toBe("Crashed");
});

async function budgetSource(): Promise<{
  taskId: string;
  intentId: string;
  runId: string;
  hitlRequestId: string;
}> {
  const source = await committedCrash();

  await resumeCrashedRun(source.runId, {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: async () => {},
    recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(
      await interactiveTaskLaunchPrincipal(),
    ),
  });
  await database.db
    .update(runs)
    .set({ status: "NeedsInput" })
    .where(eq(runs.id, source.runId));
  const hitlRequestId = randomUUID();

  await database.db.insert(hitlRequests).values({
    id: hitlRequestId,
    runId: source.runId,
    stepId: "check",
    kind: "budget_breach",
    prompt: "Budget requires a decision",
    schema: {
      kind: "budget_breach",
      scope: "run",
      meter: "tokens",
      current: 120,
      limit: 100,
      decisions: ["raise", "abandon"],
    },
  });

  return { ...source, hitlRequestId };
}

it("LA08 budget restart without a displayed request witness refuses before changing the source execution", async () => {
  const source = await budgetSource();
  const hitlRequestId = source.hitlRequestId;

  await expect(
    respondToHitl(
      { runId: source.runId, hitlRequestId, body: { optionId: "restart" } },
      { kind: "user", userId: fixture.userId, label: "Fixture user" },
      { db: database.db, executionHosts: hostFixture.hosts },
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "budget_restart_preview_required" },
  });
  const [run] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(run.status).toBe("NeedsInput");
  expect(intent.state).toBe("run_bound");
});

it("LA08 budget restart atomically hands off to one fresh manual intent, rolls back on failed audit and replays its exact stored decision", async () => {
  const source = await budgetSource();
  const principal = await interactiveTaskLaunchPrincipal();
  const preview = await previewBudgetRestart(
    database.db,
    principal,
    source.runId,
    source.hitlRequestId,
  );
  const input = {
    runId: source.runId,
    hitlRequestId: source.hitlRequestId,
    body: { optionId: "restart", restartLaunch: preview.request },
  };
  const actor = {
    kind: "user" as const,
    userId: fixture.userId,
    label: "Fixture user",
  };
  const deps = {
    db: database.db,
    executionHosts: hostFixture.hosts,
    restartPrincipal: principal,
  };

  await expect(
    respondToHitl(input, actor, {
      ...deps,
      recordSuccessAudit: async () => {
        throw new MaisterError("CRASH", "Fixture audit failed");
      },
    }),
  ).rejects.toMatchObject({ code: "CRASH" });
  const [untouched] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));
  const [oldIntent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(untouched.status).toBe("NeedsInput");
  expect(oldIntent.state).toBe("run_bound");
  await database.db
    .update(hitlRequests)
    .set({
      response: {
        optionId: "restart",
        stage: "claimed",
        restartLaunch: preview.request,
      },
    })
    .where(eq(hitlRequests.id, source.hitlRequestId));
  const [stranded] = await database.db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, source.hitlRequestId));

  expect(
    projectHitlAnswer({
      kind: stranded.kind,
      response: stranded.response,
      responseIsNotNull: true,
      respondedAt: stranded.respondedAt,
    }).storedResponse,
  ).toEqual(input.body);
  const responses = await Promise.all([
    respondToHitl(input, actor, deps),
    respondToHitl(input, actor, deps),
  ]);
  const receipts = await Promise.all(
    responses.map((response) => response.json()),
  );

  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(receipts[0]).toMatchObject({
    state: "restart_queued",
    runStatus: "Failed",
  });
  expect(receipts[0]).not.toHaveProperty("newRunId");
  const [successor] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipts[0].intentId));
  const [gate] = await database.db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, source.hitlRequestId));

  expect(successor).toMatchObject({
    basis: { kind: "manual", userId: fixture.userId },
    sourceRunId: source.runId,
    state: "queued",
    inputSnapshot: { prompt: preview.prompt },
  });
  expect(successor.settingsSnapshot).toMatchObject({
    serverExecution: {
      kind: "budget_restart",
      execution: {
        triggerSource: "manual",
        triggerPayload: {
          oldRunId: source.runId,
          hitlRequestId: source.hitlRequestId,
        },
      },
    },
  });
  expect(gate.response).toMatchObject({
    restartLaunch: preview.request,
    launchIntentId: successor.id,
  });
  const bound = await prepareTaskLaunchIntent(database.db, successor.id);

  if (!bound.runId)
    throw new Error(`Budget successor did not bind: ${bound.reason}`);
  const [nextRun] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, bound.runId));

  expect(nextRun.triggerPayload).toMatchObject({
    kind: "budget_restart",
    oldRunId: source.runId,
    hitlRequestId: source.hitlRequestId,
  });
  expect(nextRun.taskLaunchIntentId).toBe(successor.id);
  await database.db
    .update(tasks)
    .set({ prompt: "Future task revision" })
    .where(eq(tasks.id, source.taskId));
  const replay = await respondToHitl(input, actor, deps);

  expect(await replay.json()).toMatchObject({
    intentId: receipts[0].intentId,
    newRunId: bound.runId,
  });
  expect(
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, source.taskId)),
  ).toHaveLength(2);
});

it("LA08 budget restart cannot turn actor attribution or a stale preview into manual authority", async () => {
  const source = await budgetSource();
  const principal = await interactiveTaskLaunchPrincipal();
  const preview = await previewBudgetRestart(
    database.db,
    principal,
    source.runId,
    source.hitlRequestId,
  );
  const input = {
    runId: source.runId,
    hitlRequestId: source.hitlRequestId,
    body: { optionId: "restart", restartLaunch: preview.request },
  };
  const actor = {
    kind: "user" as const,
    userId: fixture.userId,
    label: "Fixture user",
  };

  await expect(
    respondToHitl(input, actor, {
      db: database.db,
      executionHosts: hostFixture.hosts,
    }),
  ).rejects.toMatchObject({
    details: { reason: "budget_restart_preview_required" },
  });
  await database.db
    .update(tasks)
    .set({
      prompt: "Changed before confirmation",
      revision: sql`${tasks.revision}+1`,
    })
    .where(eq(tasks.id, source.taskId));
  await expect(
    respondToHitl(input, actor, {
      db: database.db,
      executionHosts: hostFixture.hosts,
      restartPrincipal: principal,
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "launch_input_changed" },
  });
  const [run] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));

  expect(run.status).toBe("NeedsInput");
  expect(
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, source.taskId)),
  ).toHaveLength(1);
});

it("LA08 same-run recovery keeps accepted input and first receipt while minting a new execution epoch", async () => {
  const source = await committedCrash();
  const [original] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));
  const [crashed] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));

  await database.db
    .update(tasks)
    .set({ prompt: "Edited task after crash" })
    .where(eq(tasks.id, source.taskId));
  const drive = vi.fn(async () => {});
  const result = await resumeCrashedRun(source.runId, {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: drive,
    recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(
      await interactiveTaskLaunchPrincipal(),
    ),
  });
  const [recovered] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(result).toEqual({ state: "redispatched" });
  expect(drive).toHaveBeenCalledOnce();
  expect(intent.state).toBe("run_bound");
  expect(intent.dispatchReceipt).toEqual(original.dispatchReceipt);
  expect(intent.dispatchCommittedAt).toEqual(original.dispatchCommittedAt);
  expect(intent.inputSnapshot).toEqual(original.inputSnapshot);
  expect(recovered.executionAssignmentId).not.toBe(
    crashed.executionAssignmentId,
  );
  const epochs = await database.db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, source.runId));

  expect(epochs.map((assignment) => assignment.epoch).sort()).toEqual([1, 2]);
  expect((await taskLaunchInputForRun(database.db, recovered))?.prompt).toBe(
    "Original committed prompt",
  );
  await crashRunningRun(source.runId, "agent-session-gone", {
    db: database.db,
  });
});

it("LA08 a newer ordinary launch blocks old recovery without stealing its reservation or dispatching", async () => {
  const source = await committedCrash();
  const principal = await interactiveTaskLaunchPrincipal();
  const [task] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, source.taskId));
  const successor = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: source.taskId,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        source.taskId,
        { relaunchOfRunId: source.runId },
      ),
      relaunchOfRunId: source.runId,
    },
    randomUUID(),
  );
  const drive = vi.fn(async () => {});
  const result = await resumeCrashedRun(source.runId, {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: drive,
    recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(principal),
  });
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));
  const [owner] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, successor.intentId));

  expect(result).toEqual({ state: "launch-conflict" });
  expect(drive).not.toHaveBeenCalled();
  expect(intent.state).toBe("settled");
  expect(owner.state).toBe("queued");
  expect(owner.sourceRunId).toBe(source.runId);
});

it("LA08 current recovery scope permits continuation and revoked or launch-only tokens cannot reuse it", async () => {
  const source = await committedCrash();
  const launchToken = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Launch only",
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const recoverToken = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Recover only",
      scopes: ["runs:recover"],
    },
    database.db,
  );
  const launchAuthority = tokenTaskLaunchRecoveryAuthority(
    await tokenTaskLaunchPrincipal(database.db, launchToken.secret),
  );
  const authority = tokenTaskLaunchRecoveryAuthority(
    await tokenTaskLaunchPrincipal(database.db, recoverToken.secret),
  );
  const drive = vi.fn(async () => {});
  const options = {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: drive,
  };

  await expect(
    resumeCrashedRun(source.runId, {
      ...options,
      recoveryAuthority: launchAuthority,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(
    await resumeCrashedRun(source.runId, {
      ...options,
      recoveryAuthority: authority,
    }),
  ).toEqual({ state: "redispatched" });
  expect(drive).toHaveBeenCalledOnce();
  await crashRunningRun(source.runId, "agent-session-gone", {
    db: database.db,
  });
  await database.db
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(eq(projectTokens.id, recoverToken.tokenId));
  await expect(
    resumeCrashedRun(source.runId, {
      ...options,
      recoveryAuthority: authority,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(drive).toHaveBeenCalledOnce();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(intent.state).toBe("settled");
});

it("LA08 a busy workspace refuses recovery without reacquiring the settled launch", async () => {
  const source = await committedCrash();

  await database.db
    .update(workspaces)
    .set({
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "discardChanges",
      lifecycleOperationAttemptId: randomUUID(),
      lifecycleOperationExpectedRunStatus: "Crashed",
      lifecycleOperationClaimedAt: new Date(),
      lifecycleOperationLeaseExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(eq(workspaces.runId, source.runId));
  const drive = vi.fn(async () => {});
  const result = await resumeCrashedRun(source.runId, {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: drive,
    recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(
      await interactiveTaskLaunchPrincipal(),
    ),
  });
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(result).toEqual({ state: "workspace-busy" });
  expect(intent.state).toBe("settled");
  expect(drive).not.toHaveBeenCalled();
});

it("LA08 a v2 manual parent derives real child admission, and changed plan, input or parent cannot reuse it", async () => {
  const source = await committedCrash();

  await resumeCrashedRun(source.runId, {
    db: database.db,
    executionHosts: hostFixture.hosts,
    runFlow: async () => {},
    recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(
      await interactiveTaskLaunchPrincipal(),
    ),
  });
  const childTaskId = randomUUID();

  await database.db.insert(tasks).values({
    id: childTaskId,
    projectId: fixture.projectId,
    number: ++number,
    title: "Derived execution child",
    prompt: "The scoped child objective",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  await database.db.insert(taskRelations).values({
    projectId: fixture.projectId,
    fromTaskId: source.taskId,
    toTaskId: childTaskId,
    kind: "parent_of",
    actorType: "system",
  });
  const lineage = {
    projectId: fixture.projectId,
    parentRunId: source.runId,
    childTaskId,
  };

  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(tx as unknown as Db, {
      ...lineage,
      planRevision: "plan-v1",
    }),
  );
  const obsoletePlan = await prepareTaskDeliveryAdmission(database.db, {
    projectId: fixture.projectId,
    taskId: childTaskId,
  });

  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(tx as unknown as Db, {
      ...lineage,
      planRevision: "plan-v2",
    }),
  );
  await expect(
    database.db.transaction((tx) => obsoletePlan.apply(tx as unknown as Db)),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "qualification_stale" },
  });
  const admitted = await prepareTaskDeliveryAdmission(database.db, {
    projectId: fixture.projectId,
    taskId: childTaskId,
  });
  const childRunId = randomUUID();

  await database.db.transaction(async (tx) => {
    const snapshot = await admitted.apply(tx as unknown as Db);

    await tx.insert(runs).values({
      id: childRunId,
      projectId: fixture.projectId,
      taskId: childTaskId,
      status: "Pending",
      runKind: "flow",
      flowId: fixture.flowId,
      flowVersion: "v1",
      taskAdmissionSnapshot: snapshot,
    });
  });
  const [child] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, childRunId));

  expect(child.taskAdmissionSnapshot).toMatchObject({
    mode: "execution_child",
    qualificationId: null,
    parent: {
      parentRunId: source.runId,
      parentLegacy: false,
      planRevision: "plan-v2",
    },
  });
  await database.db
    .update(tasks)
    .set({ prompt: "A different child objective" })
    .where(eq(tasks.id, childTaskId));
  await expect(
    prepareTaskDeliveryAdmission(database.db, {
      projectId: fixture.projectId,
      taskId: childTaskId,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(tx as unknown as Db, {
      ...lineage,
      planRevision: "plan-v3",
    }),
  );
  await crashRunningRun(source.runId, "agent-session-gone", {
    db: database.db,
  });
  await expect(
    prepareTaskDeliveryAdmission(database.db, {
      projectId: fixture.projectId,
      taskId: childTaskId,
    }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_parent_unavailable" },
  });
});

async function pendingSource(
  initialRunContext?: Parameters<typeof bindPendingTaskLaunchFixture>[2],
): Promise<{ taskId: string; sourceRunId: string; projectId: string }> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++number,
    title: "Fresh retry",
    prompt: "Original frozen source",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
    },
    randomUUID(),
  );
  const bound = await bindPendingTaskLaunchFixture(
    database,
    accepted.intentId,
    initialRunContext,
  );

  return { taskId, sourceRunId: bound.runId, projectId: fixture.projectId };
}

it("LA08 scoped source lineage retains the real Flow pin and scheduled request, without borrowing active-run authority", async () => {
  const agentId = `fixture:${randomUUID()}`;

  await database.db.insert(agents).values({
    id: agentId,
    packageName: "fixture",
    versionLabel: "v1",
    origin: "authored",
    name: "Scheduled delivery",
    description: "Fixture",
    workspace: "worktree",
    mode: "session",
    triggers: ["cron"],
    riskTier: "standard",
    sourcePath: "fixture.md",
  });
  const scheduledRequestSnapshot = {
    version: 1 as const,
    scheduleId: randomUUID(),
    triggerAttemptId: randomUUID(),
    requestAtLaunch: "Frozen scheduled request",
  };

  const source = await pendingSource({ agentId, scheduledRequestSnapshot });

  await expect(
    captureTaskLaunchRelaunchSource(database.db, source),
  ).rejects.toMatchObject({
    details: { reason: "launch_source_status_invalid" },
  });
  expect(
    await captureConcurrentTaskLaunchRelaunchSource(database.db, source),
  ).toMatchObject({
    runId: source.sourceRunId,
    projectId: source.projectId,
    taskId: source.taskId,
    packageInstallId: null,
  });
  await database.db
    .update(runs)
    .set({ status: "Failed" })
    .where(eq(runs.id, source.sourceRunId));
  const captured = await captureTaskLaunchRelaunchSource(database.db, source);

  expect(captured).toMatchObject({
    runId: source.sourceRunId,
    taskId: source.taskId,
    agentId,
    scheduledRequestSnapshot,
    packageInstallId: null,
    evaluation: null,
  });
  expect(captured.flowRevisionId).toBeTruthy();
  expect(captured).not.toHaveProperty("prompt");
  await expect(
    captureTaskLaunchRelaunchSource(database.db, {
      ...source,
      taskId: randomUUID(),
    }),
  ).rejects.toMatchObject({ details: { reason: "launch_source_unavailable" } });
  await expect(
    captureTaskLaunchRelaunchSource(database.db, {
      ...source,
      projectId: randomUUID(),
    }),
  ).rejects.toMatchObject({ details: { reason: "launch_source_unavailable" } });
});

it("LA08 queued lineage detects source removal and study policy drift while keeping ordinal allocation out of its immutable identity", async () => {
  const source = await pendingSource();

  await database.db
    .update(runs)
    .set({ status: "Failed" })
    .where(eq(runs.id, source.sourceRunId));
  const studyId = randomUUID();
  const participantId = randomUUID();

  await database.db.insert(evaluationStudies).values({
    id: studyId,
    projectId: source.projectId,
    taskId: source.taskId,
    title: "Lineage",
    status: "open",
  });
  await database.db.insert(evaluationParticipants).values({
    id: participantId,
    studyId,
    runId: source.sourceRunId,
    sourceType: "launched",
    label: "Recipe #1",
    replicateGroup: "recipe",
    replicateOrdinal: 1,
    launchReason: "initial",
  });
  const captured = await captureTaskLaunchRelaunchSource(database.db, source);

  expect(captured.evaluation).toEqual({
    studyId,
    recipeId: null,
    replicateGroup: "recipe",
    sourceRemoved: false,
  });
  await database.db.insert(evaluationParticipants).values({
    id: randomUUID(),
    studyId,
    runId: null,
    sourceType: "launched",
    label: "Recipe #2",
    replicateGroup: "recipe",
    replicateOrdinal: 2,
    launchReason: "replicate",
  });
  await expect(
    assertTaskLaunchRelaunchSource(database.db, captured),
  ).resolves.toBeUndefined();
  await database.db
    .update(evaluationParticipants)
    .set({ removedAt: new Date() })
    .where(eq(evaluationParticipants.id, participantId));
  await expect(
    assertTaskLaunchRelaunchSource(database.db, captured),
  ).rejects.toMatchObject({ details: { reason: "launch_source_changed" } });
  const removed = await captureTaskLaunchRelaunchSource(database.db, source);

  expect(removed.evaluation?.sourceRemoved).toBe(true);
  await database.db
    .update(evaluationStudies)
    .set({ status: "archived" })
    .where(eq(evaluationStudies.id, studyId));
  await expect(
    assertTaskLaunchRelaunchSource(database.db, removed),
  ).rejects.toMatchObject({ details: { reason: "launch_source_changed" } });
  expect(
    (await captureTaskLaunchRelaunchSource(database.db, source)).evaluation,
  ).toBeNull();
});

it("LA08 observes a crash committed after recovery navigation and reacquires the original reservation under the Run lock", async () => {
  const source = await committedRun();
  const principal = await interactiveTaskLaunchPrincipal();
  const drive = vi.fn(async () => {});
  let recovering: ReturnType<typeof resumeCrashedRun> | undefined;

  await database.db.transaction(async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, source.runId))
      .for("update");
    recovering = resumeCrashedRun(source.runId, {
      db: database.db,
      executionHosts: hostFixture.hosts,
      runFlow: drive,
      recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(principal),
    });
    await expect
      .poll(
        async () => {
          const blocked = await database.pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
          );

          return blocked.rows[0].n;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    expect(
      await crashRunningRun(source.runId, "agent-session-gone", {
        db: tx as unknown as Db,
      }),
    ).toMatchObject({ ok: true });
  });
  expect(await recovering).toEqual({ state: "redispatched" });
  expect(drive).toHaveBeenCalledOnce();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, source.intentId));

  expect(intent).toMatchObject({ state: "run_bound", terminalOutcome: null });
  expect(intent.dispatchReceipt).not.toBeNull();
  await crashRunningRun(source.runId, "agent-session-gone", {
    db: database.db,
  });
});
