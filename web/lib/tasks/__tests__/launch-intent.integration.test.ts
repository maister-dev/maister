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
} from "@/lib/db/schema";
import { getTaskClarificationProjection } from "@/lib/queries/task-clarifications";
import { taskLaunchEffectivePrompt } from "@/lib/tasks/launch-input";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  acceptAutomaticTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { updateTask } from "@/lib/services/tasks";
import {
  prepareTaskQualification,
  loadTaskQualificationInput,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
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
let sequence = 0;

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_intents",
  });
  root = await mkdtempReal("task-launch-intents-");
  ({ userId, projectId, flowId, runnerId } = await seedTaskLaunchFixture(
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
    launchIntent: "none",
  });

  return id;
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
    { ...input, flowId, runnerId },
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
