import type { Db } from "@/lib/execution-host/db";
import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flows,
  flowRevisions,
  tasks,
  runs,
  domainEvents,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { buildRalphLoopConsumer } from "@/lib/runs/ralph-loop";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));
vi.mock("@/lib/flows/runner", () => ({ runFlow: async () => undefined }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "ralph_task_admission",
  });
  root = await mkdtempReal("ralph-task-admission-");
  fixture = await seedTaskLaunchFixture(database, root);
  await fakeExecutionHosts(database.db);
  const installed = path.join(root, "flow");

  await mkdir(installed, { recursive: true });
  await database.db
    .update(flows)
    .set({ installedPath: installed })
    .where(eq(flows.id, fixture.flowId));
  await database.db
    .update(flowRevisions)
    .set({ installedPath: installed })
    .where(eq(flowRevisions.flowRefId, fixture.flowId));
  await writeFile(
    path.join(fixture.repo, "README.md"),
    "# Owned retry evidence\n",
  );
  await git(fixture.repo, "add", "README.md");
  await git(fixture.repo, "commit", "-m", "Seed retry evidence");
  vi.stubEnv("MAISTER_RALPH_MAX_ATTEMPTS", "5");
}, 180_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await database?.stop();
  if (fixture)
    for (const line of (
      await git(fixture.repo, "worktree", "list", "--porcelain")
    ).split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== fixture.repo)
        await git(fixture.repo, "worktree", "remove", "--force", line.slice(9));
    }
  if (root) await rm(root, { recursive: true, force: true });
});

async function failedManual(): Promise<{
  taskId: string;
  sourceRunId: string;
  event: DomainEventRow;
}> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Retry bounded fixture",
    prompt: "Verify the current task fixture",
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
      executionPolicy: {
        preset: "supervised",
        overrides: { crashRetry: "ralph_loop" },
      },
      autoPromote: false,
    },
    randomUUID(),
  );
  const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

  if (!bound.runId) throw new Error("Expected manual fixture run");
  // Simulate failure only on this newly created fixture Run; no historical or production row is touched.
  await database.db
    .update(runs)
    .set({ status: "Failed", endedAt: new Date() })
    .where(eq(runs.id, bound.runId));
  const [event] = await database.db
    .insert(domainEvents)
    .values({
      kind: "run.failed",
      projectId: fixture.projectId,
      taskId,
      runId: bound.runId,
      actorType: "system",
      actorId: null,
      occurredAt: new Date(),
      payload: {
        runKind: "flow",
        parentRunId: null,
        cause: { code: "CRASH", source: "runner", reason: "owned_fixture" },
      },
    })
    .returning();

  return { taskId, sourceRunId: bound.runId, event };
}

async function qualify(taskId: string): Promise<void> {
  const sha = await git(fixture.repo, "rev-parse", "HEAD");
  const qualification = qualificationFixture();

  qualification.evidenceRefs = [
    { id: "repo", kind: "repository", reference: `git:${sha}:README.md` },
  ];
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification,
      flowId: fixture.flowId,
      runnerId: fixture.runnerId,
      enqueue: false,
    },
  });

  await database.db.transaction((tx: Db) => prepared.apply(tx));
}

it("a manual source without qualification produces one actionable retry refusal and never transfers manual admission", async () => {
  const item = await failedManual();
  const consumer = buildRalphLoopConsumer({ db: database.db });

  await consumer.handle([item.event]);
  await consumer.handle([item.event]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM task_launch_intents WHERE task_id=$1 AND principal_kind='system'",
        [item.taskId],
      )
    ).rows,
  ).toEqual([]);
  const comments = await database.pool.query(
    "SELECT body FROM task_comments WHERE task_id=$1",
    [item.taskId],
  );

  expect(comments.rows).toEqual([
    {
      body: expect.stringMatching(
        /qualification.*manual launch|manual launch.*qualification/i,
      ),
    },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT triage_flag_origin FROM tasks WHERE id=$1",
        [item.taskId],
      )
    ).rows,
  ).toEqual([{ triage_flag_origin: null }]);
});

it("current qualified retry acceptance is durable and pending across repeated failure delivery, then survives its own allocation", async () => {
  const item = await failedManual();

  await qualify(item.taskId);
  const consumer = buildRalphLoopConsumer({ db: database.db });

  await consumer.handle([item.event]);
  await consumer.handle([item.event]);
  const accepted = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, item.taskId));
  const retry = accepted.filter((intent) => intent.principalKind === "system");

  expect(retry).toHaveLength(1);
  expect(retry[0]).toMatchObject({
    runId: null,
    state: "queued",
    basis: { kind: "automatic" },
    settingsSnapshot: {
      serverExecution: { kind: "ralph_retry", id: item.sourceRunId },
    },
  });
  const bound = await prepareTaskLaunchIntent(database.db, retry[0].id);

  expect(bound).toMatchObject({
    state: "run_bound",
    runId: expect.any(String),
  });
  await consumer.handle([item.event]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int n FROM task_launch_intents WHERE task_id=$1 AND principal_kind='system'",
        [item.taskId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("a queued automatic retry cannot execute a later task revision", async () => {
  const item = await failedManual();

  await qualify(item.taskId);
  await buildRalphLoopConsumer({ db: database.db }).handle([item.event]);
  const [retry] = (
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, item.taskId))
  ).filter((intent) => intent.principalKind === "system");

  expect(retry).toBeDefined();
  await database.db
    .update(tasks)
    .set({ prompt: "A later request needs a fresh decision" })
    .where(eq(tasks.id, item.taskId));
  expect(await prepareTaskLaunchIntent(database.db, retry.id)).toMatchObject({
    state: "held",
    runId: null,
    reason: "launch_input_changed",
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM runs WHERE task_launch_intent_id=$1",
        [retry.id],
      )
    ).rows,
  ).toEqual([]);
});
