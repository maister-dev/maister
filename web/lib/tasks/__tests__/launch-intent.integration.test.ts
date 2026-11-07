import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  platformAcpRunners,
  tasks,
  taskLaunchIntents,
  taskClarifications,
  flows,
  flowRevisions,
  capabilityRecords,
  runs,
} from "@/lib/db/schema";
import { getTaskClarificationProjection } from "@/lib/queries/task-clarifications";
import { taskLaunchEffectivePrompt } from "@/lib/tasks/launch-input";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  acceptAutomaticTaskLaunch,
  acceptTokenTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { resolveTaskLaunchHold } from "@/lib/tasks/launch-hold";
import {
  applyTriageFlag,
  sendTaskToTriageInTransaction,
} from "@/lib/services/triage";
import { tokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import { cancelTokenTaskLaunch } from "@/lib/tasks/launch-cancel";
import { replaceTokenTaskLaunch } from "@/lib/tasks/launch-replace";
import { issueToken } from "@/lib/tokens/issue";
import { recordTokenAudit } from "@/lib/tokens/audit";
import { MaisterError } from "@/lib/errors";
import { updateTask } from "@/lib/services/tasks";
import {
  prepareTaskQualification,
  loadTaskQualificationInput,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { prepareTaskDeliveryAdmission } from "@/lib/tasks/qualification-admission";
import { operationalContractFixture } from "@/test-support/operational-agent";
import { git } from "@/test-support/git-fixture";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let userId: string;
let projectId: string;
let flowId: string;
let runnerId: string;
let repo: string;
let sequence = 0;
let sessionUserOverride: string | null = null;

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: sessionUserOverride ?? userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_intents",
  });
  root = await mkdtempReal("task-launch-intents-");
  ({ userId, projectId, flowId, runnerId, repo } = await seedTaskLaunchFixture(
    database,
    root,
  ));
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function request(taskId: string) {
  const [task] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return {
    taskId,
    expectedTaskRevision: task.revision,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
    autoPromote: true,
    deliveryPolicy: {
      strategy: "pull_request" as const,
      push: "on_success" as const,
      trigger: "auto_on_ready" as const,
      targetBranch: "main",
    },
  };
}
async function task(): Promise<string> {
  const id = randomUUID();

  await database.db.insert(tasks).values({
    id,
    projectId,
    number: ++sequence,
    title: "Explicit launch",
    prompt: "Implement this exact request",
    flowId,
    runnerId,
    triageStatus: "flagged",
    triageFlagOrigin: "qualification",
    launchIntent: "none",
  });

  return id;
}
async function publishReadyQualification(taskId: string): Promise<void> {
  const prepared = await prepareTaskQualification(database.db, {
    projectId,
    taskId,
    author: { kind: "user", identity: userId, userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(prepared.apply);
}

async function cancelFixture(db: Db, id: string): Promise<void> {
  await db
    .update(taskLaunchIntents)
    .set({ state: "cancelled", stateVersion: 2 })
    .where(eq(taskLaunchIntents.id, id));
}

it("LA01/02/04 accepts explicit manual intent without changing missing, negative or stale assessments, and never launches on configuration alone", async () => {
  const principal = await interactiveTaskLaunchPrincipal();

  for (const decision of [
    null,
    "needs_information",
    "needs_review",
    "not_actionable",
    "stale",
  ] as const) {
    const taskId = await task();

    if (decision) {
      const fixture = qualificationFixture();
      const prepared = await prepareTaskQualification(database.db, {
        projectId,
        taskId,
        author: { kind: "user", identity: userId, userId },
        request: {
          requestKey: randomUUID(),
          expectedInputRevision: 1,
          expectedQualificationRevision: null,
          qualification:
            decision === "stale"
              ? fixture
              : {
                  ...fixture,
                  decision,
                  checks: fixture.checks.map((check) =>
                    check.dimension === "acceptance"
                      ? {
                          ...check,
                          state: "unknown",
                          rationale: "Acceptance requires a decision",
                        }
                      : check,
                  ),
                  reasonCodes: ["acceptance_incomplete"],
                  nextActions: ["Clarify acceptance"],
                },
          enqueue: false,
        },
      });

      await database.db.transaction(prepared.apply);
      if (decision === "stale")
        await requireTaskRequalification(database.db, projectId, taskId);
    }
    const before = (
      await database.pool.query(
        "SELECT to_jsonb(t) AS task,(SELECT jsonb_agg(q) FROM task_qualifications q WHERE q.task_id=t.id) AS assessments FROM tasks t WHERE id=$1",
        [taskId],
      )
    ).rows[0];

    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
          [taskId],
        )
      ).rows[0].n,
    ).toBe(0);
    const receipt = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      await request(taskId),
      randomUUID(),
    );

    expect(receipt).toMatchObject({
      state: "queued",
      basis: "manual",
      runId: null,
      snapshot: {
        promotionMode: "pull_request",
        autoPromote: true,
        runnerIds: [runnerId],
      },
    });
    const [stored] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, receipt.intentId));

    expect(stored.inputSnapshot.prompt).toBe("Implement this exact request");
    expect(
      stored.settingsSnapshot.sessions[0].runnerSnapshot,
    ).not.toHaveProperty("provider");
    expect(
      stored.settingsSnapshot.sessions[0].runnerSnapshot,
    ).not.toHaveProperty("env");
    expect(stored.actorUserId).toBe(userId);
    expect(
      (
        await database.pool.query(
          "SELECT to_jsonb(t) AS task,(SELECT jsonb_agg(q) FROM task_qualifications q WHERE q.task_id=t.id) AS assessments FROM tasks t WHERE id=$1",
          [taskId],
        )
      ).rows[0],
    ).toEqual(before);
    await cancelFixture(database.db, receipt.intentId);
  }
});

it("LA06 linearizes competing clicks and replays only the same principal/key/payload, including a lost response after input changes", async () => {
  const taskId = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const input = await request(taskId);
  const key = randomUUID();
  const accepted =
    Promise.withResolvers<
      Awaited<ReturnType<typeof acceptInteractiveTaskLaunch>>
    >();
  const commit = Promise.withResolvers<void>();
  const launchDb: Db = database.db;
  const winner = launchDb.transaction(async (tx) => {
    const receipt = await acceptInteractiveTaskLaunch(
      tx,
      principal,
      input,
      key,
    );

    accepted.resolve(receipt);
    await commit.promise;

    return receipt;
  });

  await accepted.promise;
  const rival = acceptInteractiveTaskLaunch(database.db, principal, input, key);

  try {
    await expect
      .poll(async () => {
        const blocked = await database.pool
          .query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%pg_advisory_xact_lock(1818326382%'`);

        return blocked.rows.length;
      })
      .toBeGreaterThan(0);
  } finally {
    commit.resolve();
  }
  const same = await Promise.all([winner, rival]);

  expect(same[0].intentId).toBe(same[1].intentId);
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      principal,
      { ...input, autoPromote: false },
      key,
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "launch_request_key_conflict" },
  });
  await expect(
    acceptInteractiveTaskLaunch(database.db, principal, input, randomUUID()),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "launch_already_reserved" },
  });
  await database.db
    .update(tasks)
    .set({ prompt: "Future revision", revision: 1 })
    .where(eq(tasks.id, taskId));
  expect(
    (await acceptInteractiveTaskLaunch(database.db, principal, input, key))
      .intentId,
  ).toBe(same[0].intentId);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("LA14 refuses stale task/settings, paused tasks, unavailable runners and revoked launch permission before accepting anything", async () => {
  const taskId = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const input = await request(taskId);

  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      principal,
      { ...input, expectedTaskRevision: 20 },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_input_changed" } });
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      principal,
      { ...input, expectedSettingsToken: "0".repeat(64) },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_settings_changed" } });
  await database.db
    .update(tasks)
    .set({ queuePaused: true })
    .where(eq(tasks.id, taskId));
  await expect(
    acceptInteractiveTaskLaunch(database.db, principal, input, randomUUID()),
  ).rejects.toMatchObject({ details: { reason: "queue_paused" } });
  await database.db
    .update(tasks)
    .set({ queuePaused: false })
    .where(eq(tasks.id, taskId));
  await database.db
    .update(platformAcpRunners)
    .set({ enabled: false })
    .where(eq(platformAcpRunners.id, runnerId));
  await expect(
    acceptInteractiveTaskLaunch(database.db, principal, input, randomUUID()),
  ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  await database.db
    .update(platformAcpRunners)
    .set({ enabled: true })
    .where(eq(platformAcpRunners.id, runnerId));
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [userId],
  );
  try {
    await expect(
      acceptInteractiveTaskLaunch(database.db, principal, input, randomUUID()),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "launch_not_found" },
    });
  } finally {
    await database.pool.query(
      "UPDATE users SET account_status='active' WHERE id=$1",
      [userId],
    );
  }
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA02 atomically saves selected task configuration and accepts its new revision without arming automation", async () => {
  const taskId = await task();

  await database.db
    .update(tasks)
    .set({ flowId: null, runnerId: null })
    .where(eq(tasks.id, taskId));
  const principal = await interactiveTaskLaunchPrincipal();
  const input = await request(taskId);
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      ...input,
      flowId,
      runnerId,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        taskId,
        { flowId, runnerId },
      ),
    },
    randomUUID(),
  );
  const [configured] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  expect(configured).toMatchObject({
    flowId,
    runnerId,
    revision: 1,
    launchIntent: "none",
    launchMode: null,
    triageStatus: "flagged",
    triageFlagOrigin: "qualification",
    currentQualificationId: null,
  });
  expect(receipt.taskRevision).toBe(1);
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent.taskRevision).toBe(configured.revision);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM runs WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA05 holds accepted queued input in the same edit transaction and retains the original execution request", async () => {
  const taskId = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    await request(taskId),
    randomUUID(),
  );

  await updateTask(
    taskId,
    projectId,
    { prompt: "User edited the queued request", expectedRevision: 0 },
    database.db,
  );
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent).toMatchObject({
    state: "held",
    stateVersion: 2,
    reason: "launch_input_changed",
  });
  expect(intent.inputSnapshot.prompt).toBe("Implement this exact request");
  const event = (
    await database.pool.query(
      "SELECT payload FROM domain_events WHERE task_id=$1 AND kind='task.launch_changed' ORDER BY id DESC LIMIT 1",
      [taskId],
    )
  ).rows[0];

  expect(event.payload).toMatchObject({
    intentId: receipt.intentId,
    state: "held",
    reason: "launch_input_changed",
  });
  expect(JSON.stringify(event)).not.toContain("User edited");
});

it("LA01/03 requires current accepted qualification for automatic admission and keeps the manual and automatic reservation shared", async () => {
  const taskId = await task();

  await expect(
    acceptAutomaticTaskLaunch(database.db, await request(taskId), randomUUID()),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
  await publishReadyQualification(taskId);
  await expect(
    acceptAutomaticTaskLaunch(database.db, await request(taskId), randomUUID()),
  ).rejects.toMatchObject({
    details: { reason: "launch_automation_not_armed" },
  });
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const automatic = await acceptAutomaticTaskLaunch(
    database.db,
    await request(taskId),
    randomUUID(),
  );

  expect(automatic).toMatchObject({ basis: "automatic", state: "queued" });
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      await request(taskId),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_already_reserved" } });
  const [stored] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, automatic.intentId));

  expect(stored.basis).toMatchObject({
    kind: "automatic",
    qualificationInputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});

it("LA03 refuses automatic admission pinned to an assessed ancestor after the target advances, while retaining manual pinning", async () => {
  const taskId = await task();

  await publishReadyQualification(taskId);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const assessedSha = await git(repo, "rev-parse", "HEAD");

  await git(repo, "commit", "-q", "--allow-empty", "-m", "Advance target");
  const currentSha = await git(repo, "rev-parse", "HEAD");
  const pinnedRequest = { ...(await request(taskId)), baseCommit: assessedSha };

  expect(currentSha).not.toBe(assessedSha);
  await expect(
    acceptAutomaticTaskLaunch(database.db, pinnedRequest, randomUUID()),
  ).rejects.toMatchObject({
    details: { reason: "qualification_evidence_stale" },
  });
  const manual = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    pinnedRequest,
    randomUUID(),
  );

  expect(manual).toMatchObject({
    basis: "manual",
    snapshot: { baseCommit: assessedSha },
  });
});

it("LA04 honors saved task delivery modes and lets explicit launch policy override them", async () => {
  const principal = await interactiveTaskLaunchPrincipal();

  for (const [saved, expected] of [
    ["pull_request", "pull_request"],
    ["local_merge", "local_merge"],
  ] as const) {
    const taskId = await task();

    await database.db
      .update(tasks)
      .set({ promotionMode: saved })
      .where(eq(tasks.id, taskId));
    const { deliveryPolicy: _defaultOverride, ...savedRequest } =
      await request(taskId);
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      savedRequest,
      randomUUID(),
    );

    expect(accepted.snapshot.promotionMode).toBe(expected);
    await cancelFixture(database.db, accepted.intentId);
    const overrideRequest = await request(taskId);
    const overrideStrategy =
      saved === "pull_request" ? "merge" : "pull_request";
    const overridden = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      {
        ...overrideRequest,
        deliveryPolicy: {
          ...overrideRequest.deliveryPolicy,
          strategy: overrideStrategy,
        },
      },
      randomUUID(),
    );

    expect(overridden.snapshot.promotionMode).toBe(
      overrideStrategy === "merge" ? "local_merge" : "pull_request",
    );
  }
});

it("LA06 separates operational activity from delivery reservations and preserves Review relaunch", async () => {
  const operationalTaskId = await task();

  await database.db.insert(runs).values({
    id: randomUUID(),
    projectId,
    taskId: operationalTaskId,
    runKind: "agent",
    status: "Running",
    flowVersion: "agent",
    agentKind: "operational",
    agentWorkspace: "repo_read",
    resultContract: operationalContractFixture("repo_read"),
  });
  const principal = await interactiveTaskLaunchPrincipal();
  const manual = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    await request(operationalTaskId),
    randomUUID(),
  );

  expect(manual).toMatchObject({ basis: "manual", state: "queued" });
  for (const status of ["Pending", "Review"] as const) {
    const taskId = await task();

    await publishReadyQualification(taskId);
    const admission = await prepareTaskDeliveryAdmission(database.db, {
      projectId,
      taskId,
    });

    await database.db.insert(runs).values({
      id: randomUUID(),
      projectId,
      taskId,
      runKind: "flow",
      status,
      flowId,
      flowVersion: "v1",
      taskAdmissionSnapshot: admission.snapshot,
    });
    const launch = acceptInteractiveTaskLaunch(
      database.db,
      principal,
      await request(taskId),
      randomUUID(),
    );

    if (status === "Pending")
      await expect(launch).rejects.toMatchObject({
        details: { reason: "launch_already_reserved" },
      });
    else await expect(launch).resolves.toMatchObject({ basis: "manual" });
  }
});

it("LA04/05 freezes the answered nonblocking clarification actually used for execution without changing qualification hashing", async () => {
  const taskId = await task();
  const qualificationBefore = await loadTaskQualificationInput(
    database.db,
    projectId,
    taskId,
  );
  const clarificationId = randomUUID();

  await database.db.insert(taskClarifications).values({
    id: clarificationId,
    taskId,
    seq: 1,
    originKind: "user",
    reTriggerMode: "none",
    requesterUserId: userId,
    recipientUserId: userId,
    reason: "Capture accepted execution context",
    answerFormat: "text",
    question: "Which behavior should the implementation preserve?",
    blocking: false,
    status: "answered",
    answer: { preserve: "original behavior" },
    answeredAt: new Date(),
    answeredByUserId: userId,
  });
  expect(
    await loadTaskQualificationInput(database.db, projectId, taskId),
  ).toEqual(qualificationBefore);
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    await request(taskId),
    randomUUID(),
  );
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent.inputSnapshot).toMatchObject({
    version: 2,
    clarifications: [
      {
        id: clarificationId,
        seq: 1,
        question: "Which behavior should the implementation preserve?",
        answer: { preserve: "original behavior" },
      },
    ],
  });
  const originalPrompt = (
    await getTaskClarificationProjection(
      database.db,
      taskId,
      intent.inputSnapshot.prompt,
    )
  ).effectivePrompt;

  expect(taskLaunchEffectivePrompt(intent.inputSnapshot)).toBe(originalPrompt);
  await database.db
    .update(taskClarifications)
    .set({ answer: { preserve: "changed behavior" } })
    .where(eq(taskClarifications.id, clarificationId));
  const [frozen] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(frozen.inputSnapshot).toEqual(intent.inputSnapshot);
  expect(taskLaunchEffectivePrompt(frozen.inputSnapshot)).toBe(originalPrompt);
  expect(
    (
      await getTaskClarificationProjection(
        database.db,
        taskId,
        frozen.inputSnapshot.prompt,
      )
    ).effectivePrompt,
  ).not.toBe(originalPrompt);
});

it("LA05 refuses capability material changed after preview without storing that material in the decision", async () => {
  const taskId = await task();
  const capabilityId = randomUUID();

  await database.db.insert(capabilityRecords).values({
    id: capabilityId,
    projectId,
    capabilityRefId: "fixture:launch-rule",
    kind: "rule",
    label: "Launch rule",
    source: "project",
    agents: ["codex"],
    material: { text: "Original rule content" },
  });
  const input = await request(taskId);

  await database.db
    .update(capabilityRecords)
    .set({
      material: { text: "Changed rule content" },
    })
    .where(eq(capabilityRecords.id, capabilityId));
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      input,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_settings_changed" } });
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    await request(taskId),
    randomUUID(),
  );
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  expect(JSON.stringify(intent)).not.toContain("Changed rule content");
});

it("LA05 refuses an inherited revision-runner default changed after the user preview", async () => {
  const taskId = await task();

  await database.db
    .update(tasks)
    .set({ runnerId: null })
    .where(eq(tasks.id, taskId));
  const [runner] = await database.db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, runnerId));
  const successorRunnerId = randomUUID();

  await database.db
    .insert(platformAcpRunners)
    .values({ ...runner, id: successorRunnerId });
  const input = await request(taskId);
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, flowId));

  await database.db
    .update(flowRevisions)
    .set({ defaultRunnerId: successorRunnerId })
    .where(eq(flowRevisions.id, flow.enabledRevisionId!));
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      input,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_settings_changed" } });
});

it("LA13 a scoped bearer cancels a manual intent without triage or borrowing its human admission", async () => {
  const taskId = await task();
  const manual = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    await request(taskId),
    randomUUID(),
  );
  const token = await issueToken(
    { projectId, name: "Cancel manual intent", scopes: ["runs:launch"] },
    database.db,
  );
  const principal = await tokenTaskLaunchPrincipal(database.db, token.secret);
  const key = randomUUID();
  const cancel = { expectedStateVersion: manual.stateVersion };
  const cancelled = await cancelTokenTaskLaunch(
    database.db,
    principal,
    manual.intentId,
    cancel,
    key,
  );

  expect(cancelled).toMatchObject({
    intentId: manual.intentId,
    state: "cancelled",
    basis: "manual",
  });
  expect(
    await cancelTokenTaskLaunch(
      database.db,
      principal,
      manual.intentId,
      cancel,
      key,
    ),
  ).toEqual(cancelled);
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, manual.intentId));
  const [unchanged] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  expect(intent.cancellationReceipt).toMatchObject({
    principalKind: "project_token",
    principalId: token.tokenId,
    actorUserId: null,
    requestKey: key,
  });
  expect(unchanged).toMatchObject({
    currentQualificationId: null,
    launchIntent: "none",
    triageStatus: "flagged",
    triageFlagOrigin: "qualification",
  });
  await database.pool.query(
    "UPDATE project_tokens SET scopes='[]'::jsonb WHERE id=$1",
    [token.tokenId],
  );
  await expect(
    cancelTokenTaskLaunch(database.db, principal, manual.intentId, cancel, key),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("LA13 a bearer replacement requires fresh automatic admission and preserves manual predecessor history", async () => {
  const taskId = await task();
  const input = await request(taskId);
  const manual = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    input,
    randomUUID(),
  );
  const token = await issueToken(
    { projectId, name: "Replace manual intent", scopes: ["runs:launch"] },
    database.db,
  );
  const principal = await tokenTaskLaunchPrincipal(database.db, token.secret);
  const key = randomUUID();
  const replacement = { ...input, expectedStateVersion: manual.stateVersion };

  await expect(
    replaceTokenTaskLaunch(
      database.db,
      principal,
      manual.intentId,
      replacement,
      key,
    ),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
  expect(
    (
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, manual.intentId))
    )[0].state,
  ).toBe("queued");
  await publishReadyQualification(taskId);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const current = {
    ...(await request(taskId)),
    expectedStateVersion: manual.stateVersion,
  };
  const successor = await replaceTokenTaskLaunch(
    database.db,
    principal,
    manual.intentId,
    current,
    key,
  );

  expect(successor).toMatchObject({
    basis: "automatic",
    state: "queued",
    supersedesIntentId: manual.intentId,
  });
  expect(
    await replaceTokenTaskLaunch(
      database.db,
      principal,
      manual.intentId,
      current,
      key,
    ),
  ).toEqual(successor);
  const [predecessor] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, manual.intentId));
  const [accepted] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, successor.intentId));

  expect(predecessor).toMatchObject({
    state: "cancelled",
    basis: { kind: "manual", userId },
  });
  expect(accepted).toMatchObject({
    principalKind: "project_token",
    principalId: token.tokenId,
    basis: { kind: "automatic", origin: { tokenId: token.tokenId } },
  });
});

it("LA13 commits bearer audit with admission and replays, rolling back both on audit failure", async () => {
  const taskId = await task();
  const issued = await issueToken(
    { projectId, name: "Atomic launch audit", scopes: ["runs:launch"] },
    database.db,
  );
  const principal = await tokenTaskLaunchPrincipal(database.db, issued.secret);

  await publishReadyQualification(taskId);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const input = await request(taskId);
  const key = randomUUID();
  const endpoint = "POST /api/v1/ext/task-launch-intents";
  const audit = async (tx: Db): Promise<void> =>
    recordTokenAudit(
      {
        tokenId: issued.tokenId,
        projectId,
        actorLabel: "token:fixture",
        scopeUsed: "runs:launch",
        endpoint,
        method: "POST",
        result: "ok",
        statusCode: 202,
      },
      tx,
    );
  const failure = new MaisterError("CRASH", "Audit transaction control");

  await expect(
    acceptTokenTaskLaunch(database.db, principal, input, key, {
      recordSuccessAudit: async (tx) => {
        await audit(tx);
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM token_audit_log WHERE token_id=$1",
        [issued.tokenId],
      )
    ).rows[0].n,
  ).toBe(0);

  const receipt = await acceptTokenTaskLaunch(
    database.db,
    principal,
    input,
    key,
    { recordSuccessAudit: audit },
  );

  expect(
    await acceptTokenTaskLaunch(database.db, principal, input, key, {
      recordSuccessAudit: audit,
    }),
  ).toEqual(receipt);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM token_audit_log WHERE token_id=$1",
        [issued.tokenId],
      )
    ).rows[0].n,
  ).toBe(2);
});

it("LA07 verifies a real user token without treating its owner as a human launch, and refuses revoked receipt replay", async () => {
  const taskId = await task();
  const issued = await issueToken(
    {
      projectId: null,
      tokenKind: "user",
      ownerUserId: userId,
      name: "Task admission bearer",
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const principal = await tokenTaskLaunchPrincipal(database.db, issued.secret);

  await expect(
    acceptTokenTaskLaunch(
      database.db,
      principal,
      await request(taskId),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
  await publishReadyQualification(taskId);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const input = await request(taskId);
  const key = randomUUID();
  const accepted = await acceptTokenTaskLaunch(
    database.db,
    principal,
    input,
    key,
  );

  expect(accepted.basis).toBe("automatic");
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  expect(intent).toMatchObject({
    principalKind: "project_token",
    principalId: issued.tokenId,
    actorUserId: userId,
    basis: {
      kind: "automatic",
      origin: {
        kind: "token",
        tokenKind: "user",
        tokenId: issued.tokenId,
        ownerUserId: userId,
      },
    },
  });
  expect(JSON.stringify(intent)).not.toContain(issued.secret);
  expect(
    await acceptTokenTaskLaunch(database.db, principal, input, key),
  ).toEqual(accepted);
  await cancelFixture(database.db, intent.id);
  if (intent.basis.kind !== "automatic" || !intent.basis.origin)
    throw new Error("Missing automatic token origin fixture");
  const { origin, ...basis } = intent.basis;

  for (const forged of [
    basis,
    { ...basis, origin: { ...origin, ownerUserId: randomUUID() } },
  ]) {
    await expect(
      database.db.insert(taskLaunchIntents).values({
        ...intent,
        id: randomUUID(),
        requestKey: randomUUID(),
        basis: forged,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "task_launch_intents_token_origin_current" },
    });
  }
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=clock_timestamp() WHERE id=$1",
    [issued.tokenId],
  );
  await expect(
    acceptTokenTaskLaunch(database.db, principal, input, key),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "launch_authority_revoked" },
  });
});

it("LA07 serializes membership revocation with an uncommitted human acceptance and rechecks access on replay", async () => {
  const memberId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'viewer','active',false)",
    [memberId, `${memberId}@test.local`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), projectId, memberId],
  );
  sessionUserOverride = memberId;
  const principal = await interactiveTaskLaunchPrincipal();

  sessionUserOverride = null;
  const taskId = await task();
  const input = await request(taskId);
  const key = randomUUID();
  const entered = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const db: Db = database.db;
  const accepting = db.transaction(async (tx) => {
    const result = await acceptInteractiveTaskLaunch(tx, principal, input, key);

    entered.resolve();
    await commit.promise;

    return result;
  });

  await entered.promise;
  let revoked = false;
  const revoking = database.pool
    .query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [
      projectId,
      memberId,
    ])
    .then(() => {
      revoked = true;
    });

  try {
    await expect
      .poll(async () => {
        if (revoked) return "revoked";
        const blocked = await database.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM project_members%'",
        );

        return blocked.rows.length ? "blocked" : "pending";
      })
      .toBe("blocked");
  } finally {
    commit.resolve();
    await Promise.all([accepting, revoking]);
  }
  await expect(
    acceptInteractiveTaskLaunch(database.db, principal, input, key),
  ).rejects.toMatchObject({
    details: { reason: "launch_not_found" },
  });
});

it("LA07 keeps project-token scope, identity, expiry and elevated-policy boundaries live on acceptance and replay", async () => {
  const taskId = await task();

  await publishReadyQualification(taskId);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const input = await request(taskId);
  const issued = await issueToken(
    { projectId, name: "Scoped task launch", scopes: ["runs:read"] },
    database.db,
  );
  const principal = await tokenTaskLaunchPrincipal(database.db, issued.secret);

  await expect(
    acceptTokenTaskLaunch(database.db, principal, input, randomUUID()),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "launch_authority_revoked" },
  });
  await database.pool.query(
    "UPDATE project_tokens SET scopes='[\"runs:launch\"]'::jsonb WHERE id=$1",
    [issued.tokenId],
  );
  await expect(
    acceptTokenTaskLaunch(
      database.db,
      {
        ...principal,
        origin: { ...principal.origin, tokenKind: "user" },
      },
      input,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    acceptTokenTaskLaunch(
      database.db,
      principal,
      {
        ...input,
        executionPolicy: { preset: "unattended" },
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const outsideProject = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Outside token scope',$2,'OUTSIDE')",
    [outsideProject, root],
  );
  const outside = await issueToken(
    {
      projectId: outsideProject,
      name: "Outside task launch",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  await expect(
    acceptTokenTaskLaunch(
      database.db,
      await tokenTaskLaunchPrincipal(database.db, outside.secret),
      input,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_not_found" } });
  const key = randomUUID();
  const accepted = await acceptTokenTaskLaunch(
    database.db,
    principal,
    input,
    key,
  );
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  expect(intent).toMatchObject({
    principalKind: "project_token",
    actorUserId: null,
    basis: { kind: "automatic", origin: { tokenKind: "project" } },
  });
  await database.pool.query(
    "UPDATE project_tokens SET scopes='[\"runs:read\"]'::jsonb WHERE id=$1",
    [issued.tokenId],
  );
  await expect(
    acceptTokenTaskLaunch(database.db, principal, input, key),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "UPDATE project_tokens SET scopes='[\"runs:launch\"]'::jsonb,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [issued.tokenId],
  );
  await expect(
    acceptTokenTaskLaunch(database.db, principal, input, key),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it.each(["explicit", "dispatch_failure", "unknown"] as const)(
  "manual admission retains %s triage holds",
  async (origin) => {
    const taskId = await task();

    await database.db
      .update(tasks)
      .set({ triageFlagOrigin: origin })
      .where(eq(tasks.id, taskId));
    await expect(
      acceptInteractiveTaskLaunch(
        database.db,
        await interactiveTaskLaunchPrincipal(),
        await request(taskId),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { reason: "launch_task_held" } });
  },
);

it("only a fresh authorized human can resolve a reasserted hold, without clearing assessments or pause", async () => {
  const taskId = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const flag = () =>
    database.db.transaction((tx) =>
      applyTriageFlag(tx, {
        taskId,
        projectId,
        actor: { type: "user", id: userId },
      }),
    );

  await database.db
    .update(tasks)
    .set({ queuePaused: true })
    .where(eq(tasks.id, taskId));
  await flag();
  const [before] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const stale = {
    taskId,
    expectedRevision: before.revision,
    expectedOrigin: "explicit" as const,
  };

  await flag();
  await expect(
    resolveTaskLaunchHold(database.db, principal, stale),
  ).rejects.toMatchObject({ details: { reason: "launch_hold_changed" } });
  const [held] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  await database.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [
    userId,
  ]);
  try {
    await expect(
      resolveTaskLaunchHold(database.db, principal, {
        ...stale,
        expectedRevision: held.revision,
      }),
    ).rejects.toMatchObject({ details: { reason: "launch_not_found" } });
  } finally {
    await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
      userId,
    ]);
  }
  await database.db.transaction((tx) =>
    sendTaskToTriageInTransaction(tx, {
      taskId,
      projectId,
      taskRef: "HOLD-1",
      title: held.title,
      actor: { type: "system", id: null },
    }),
  );
  const [retriaged] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  expect(retriaged.triageStatus).toBe("flagged");
  expect(retriaged.triageFlagOrigin).toBe("explicit");
  const resolved = await resolveTaskLaunchHold(database.db, principal, {
    ...stale,
    expectedRevision: retriaged.revision,
  });
  const [after] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  expect(resolved.revision).toBe(retriaged.revision + 1);
  expect(after.triageStatus).toBeNull();
  expect(after.triageFlagOrigin).toBeNull();
  expect(after.queuePaused).toBe(true);
  expect(after.currentQualificationId).toBe(retriaged.currentQualificationId);
  expect(after.launchMode).toBeNull();
  expect(
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, taskId)),
  ).toEqual([]);
});

it.each(["qualification", "explicit"] as const)(
  "blocking clarification invalidation retains only independent %s holds",
  async (origin) => {
    const taskId = await task();

    await database.db
      .update(tasks)
      .set({ triageFlagOrigin: origin })
      .where(eq(tasks.id, taskId));
    await database.db.insert(taskClarifications).values({
      id: randomUUID(),
      taskId,
      seq: 1,
      originKind: "user",
      reTriggerMode: "none",
      requesterUserId: userId,
      recipientUserId: userId,
      reason: "Missing target",
      answerFormat: "text",
      question: "Which target?",
      blocking: true,
    });
    const [changed] = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(changed.qualificationInputRevision).toBe(2);
    expect(changed.triageStatus).toBe(origin === "explicit" ? "flagged" : null);
    expect(changed.triageFlagOrigin).toBe(
      origin === "explicit" ? "explicit" : null,
    );
    expect(changed.launchMode).toBeNull();
  },
);

it("hold resolution HTTP requires same-origin strict human input and returns the committed revision", async () => {
  const taskId = await task();

  await database.db.transaction((tx) =>
    applyTriageFlag(tx, {
      taskId,
      projectId,
      actor: { type: "user", id: userId },
    }),
  );
  const [held] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const client = await import("@/lib/db/client");
  const spy = vi.spyOn(client, "getDb").mockReturnValue(database.db);

  try {
    const { POST } = await import("@/app/api/task-launch-holds/resolve/route");
    const input = {
      taskId,
      expectedRevision: held.revision,
      expectedOrigin: "explicit",
    };
    const post = (body: object, origin = "http://localhost") =>
      POST(
        new Request("http://localhost/api/task-launch-holds/resolve", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect((await post(input, "https://other.example")).status).toBe(403);
    expect((await post({ ...input, actorUserId: userId })).status).toBe(400);
    expect(
      (await post({ ...input, expectedRevision: held.revision - 1 })).status,
    ).toBe(409);
    const response = await post(input);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      taskId,
      revision: held.revision + 1,
      triageStatus: null,
      triageFlagOrigin: null,
    });
    expect((await post(input)).status).toBe(409);
  } finally {
    spy.mockRestore();
  }
});

it("SQL manual admission cannot bypass independent holds in either reservation lane", async () => {
  const taskId = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    await request(taskId),
    randomUUID(),
  );
  const [source] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  await cancelInteractiveTaskLaunch(
    database.db,
    principal,
    accepted.intentId,
    { expectedStateVersion: accepted.stateVersion },
    randomUUID(),
  );
  await database.db
    .update(tasks)
    .set({ triageFlagOrigin: "explicit" })
    .where(eq(tasks.id, taskId));
  for (const reservationLane of ["ordinary", "concurrent"] as const) {
    await expect(
      database.db.insert(taskLaunchIntents).values({
        ...source,
        id: randomUUID(),
        requestKey: randomUUID(),
        reservationLane,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "task_launch_manual_hold" },
    });
  }
  await database.db
    .update(tasks)
    .set({ triageFlagOrigin: "qualification" })
    .where(eq(tasks.id, taskId));
  const [valid] = await database.db
    .insert(taskLaunchIntents)
    .values({
      ...source,
      id: randomUUID(),
      requestKey: randomUUID(),
      reservationLane: "concurrent",
    })
    .returning();

  expect(valid.state).toBe("queued");
  expect(valid.basis.kind).toBe("manual");
  await database.db
    .update(tasks)
    .set({ triageFlagOrigin: "unknown" })
    .where(eq(tasks.id, taskId));
  await database.db
    .update(taskLaunchIntents)
    .set({
      state: "held",
      reason: "launch_task_held",
      stateVersion: valid.stateVersion + 1,
    })
    .where(eq(taskLaunchIntents.id, valid.id));
  await expect(
    database.db
      .update(taskLaunchIntents)
      .set({
        state: "queued",
        reason: null,
        stateVersion: valid.stateVersion + 2,
      })
      .where(eq(taskLaunchIntents.id, valid.id)),
  ).rejects.toMatchObject({ cause: { constraint: "task_launch_manual_hold" } });
  const cancelled = await cancelInteractiveTaskLaunch(
    database.db,
    principal,
    valid.id,
    { expectedStateVersion: valid.stateVersion + 1 },
    randomUUID(),
  );

  expect(cancelled.state).toBe("cancelled");
});
