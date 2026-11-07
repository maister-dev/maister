import type { Db } from "@/lib/execution-host/db";
import type { PreparedTaskDeliveryAdmission } from "@/lib/tasks/qualification-admission";
import type { TaskLaunchFixture } from "@/test-support/task-launch-admission";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { pgErrorOf } from "@/lib/db/pg-error";
import { runs, tasks, taskLaunchIntents } from "@/lib/db/schema";
import {
  acceptAutomaticTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskDeliveryAdmission } from "@/lib/tasks/qualification-admission";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";

type MixedLaunch = Readonly<{
  taskId: string;
  legacy: PreparedTaskDeliveryAdmission;
  candidate: typeof taskLaunchIntents.$inferSelect;
}>;

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_shared_reservation",
  });
  root = await mkdtempReal("task-launch-shared-reservation-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Keep both writers' input authentic; only bypass application checks to exercise the SQL boundary. */
async function mixedLaunch(): Promise<MixedLaunch> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Shared launch reservation",
    prompt: "Execute this qualified request",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
    launchIntent: "triage_then_launch",
  });
  const qualification = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: {
      kind: "user",
      identity: fixture.userId,
      userId: fixture.userId,
    },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: true,
    },
  });

  await database.db.transaction(qualification.apply);
  const [task] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const receipt = await acceptAutomaticTaskLaunch(
    database.db,
    {
      taskId,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
    },
    randomUUID(),
  );
  const [accepted] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  await database.db
    .update(taskLaunchIntents)
    .set({ state: "cancelled", stateVersion: accepted.stateVersion + 1 })
    .where(eq(taskLaunchIntents.id, accepted.id));

  return {
    taskId,
    legacy: await prepareTaskDeliveryAdmission(database.db, {
      projectId: fixture.projectId,
      taskId,
    }),
    candidate: { ...accepted, id: randomUUID(), requestKey: randomUUID() },
  };
}

async function insertLegacyRun(db: Db, launch: MixedLaunch): Promise<string> {
  return db.transaction(async (tx) => {
    const snapshot = await launch.legacy.apply(tx);
    const runId = randomUUID();

    await tx.insert(runs).values({
      id: runId,
      projectId: fixture.projectId,
      taskId: launch.taskId,
      runKind: "flow",
      status: "Pending",
      flowId: fixture.flowId,
      flowVersion: "v1",
      taskAdmissionSnapshot: snapshot,
    });

    return runId;
  });
}

async function expectReservationRefusal(
  operation: Promise<unknown>,
): Promise<void> {
  const outcome = await operation.then(
    () => null,
    (error: unknown) => pgErrorOf(error),
  );

  expect(outcome).toMatchObject({
    code: "23514",
    constraint: "task_launch_shared_reservation",
  });
}

it("rejects a v1 delivery insert after a new intent owns the ordinary reservation", async () => {
  const launch = await mixedLaunch();

  await database.db.insert(taskLaunchIntents).values(launch.candidate);
  await expectReservationRefusal(insertLegacyRun(database.db, launch));
});

it("rejects a new intent at the SQL boundary when a v1 delivery run already owns the task", async () => {
  const launch = await mixedLaunch();

  await insertLegacyRun(database.db, launch);
  await expectReservationRefusal(
    database.db.insert(taskLaunchIntents).values(launch.candidate).execute(),
  );
});

it.each(["intent", "legacy"] as const)(
  "waits for an uncommitted %s winner before deciding the competing writer's reservation",
  async (winnerKind) => {
    const launch = await mixedLaunch();
    const inserted = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const launchDb: Db = database.db;
    const winner = launchDb.transaction(async (tx) => {
      const backend = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );

      if (winnerKind === "intent")
        await tx.insert(taskLaunchIntents).values(launch.candidate);
      else await insertLegacyRun(tx, launch);
      inserted.resolve(backend.rows[0].pid);
      await release.promise;
    });
    const winnerPid = await inserted.promise;
    const rival = (
      winnerKind === "intent"
        ? insertLegacyRun(database.db, launch)
        : database.db
            .insert(taskLaunchIntents)
            .values(launch.candidate)
            .execute()
    ).then(
      () => ({ settled: true as const, error: null }),
      (error: unknown) => ({ settled: true as const, error: pgErrorOf(error) }),
    );
    let earlyOutcome: Awaited<typeof rival> | undefined;

    void rival.then((outcome) => {
      earlyOutcome = outcome;
    });
    try {
      await expect
        .poll(async () => {
          const blocked = await database.pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
            [winnerPid],
          );

          return earlyOutcome ? "settled_before_winner" : blocked.rows[0].count;
        })
        .toBeGreaterThan(0);
    } finally {
      release.resolve();
      await winner;
    }
    expect((await rival).error).toMatchObject({
      code: "23514",
      constraint: "task_launch_shared_reservation",
    });
  },
);

it("preserves historical v1 active continuation and reacquires a released reservation only without a competitor", async () => {
  const launch = await mixedLaunch();
  const runId = await insertLegacyRun(database.db, launch);
  const [original] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, runId));
  const receipt = JSON.stringify(original.taskAdmissionSnapshot);

  for (const status of [
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "Running",
    "Crashed",
    "Running",
  ] as const)
    await database.db.update(runs).set({ status }).where(eq(runs.id, runId));
  const [continued] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, runId));

  expect(JSON.stringify(continued.taskAdmissionSnapshot)).toBe(receipt);
  await database.db
    .update(runs)
    .set({ status: "Crashed" })
    .where(eq(runs.id, runId));
  await database.db.insert(taskLaunchIntents).values(launch.candidate);
  await expectReservationRefusal(
    database.db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, runId))
      .execute(),
  );
  const [held] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, runId));

  expect(held.status).toBe("Crashed");
  expect(JSON.stringify(held.taskAdmissionSnapshot)).toBe(receipt);
});
