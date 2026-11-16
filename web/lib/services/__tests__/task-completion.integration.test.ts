import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  completeTask,
  completeTaskFromConfirmedMerge,
} from "@/lib/services/task-completion";
import { updateTask } from "@/lib/services/tasks";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

type SeedOptions = {
  promotionMode?: "local_merge" | "pull_request";
  promotionState?: string;
  prState?: "open" | "merged" | "closed" | null;
  runStatus?: "Pending" | "Review" | "Done";
  startedAt?: Date;
};

async function seedTaskRun(opts: SeedOptions = {}): Promise<{
  projectId: string;
  taskId: string;
  runId: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `complete-${projectId.slice(0, 8)}`;
  const promotionMode = opts.promotionMode ?? "local_merge";

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey: `CMP${projectId.slice(0, 5)}`.toUpperCase(),
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "dev",
    source: "github.com/example/dev",
    version: "v1.0.0",
    installedPath: `/tmp/${slug}/flow`,
    manifest: {
      schemaVersion: 1,
      name: "Dev",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Delivered task",
    prompt: "Finish it",
    flowId,
    status: "InFlight",
    revision: 4,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    status: opts.runStatus ?? "Done",
    flowVersion: "v1.0.0",
    startedAt: opts.startedAt ?? new Date("2026-10-17T10:00:00Z"),
    deliveryPolicySnapshot: {
      strategy: promotionMode === "pull_request" ? "pull_request" : "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    },
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `task-${taskId}`,
    worktreePath: `/tmp/${slug}/${runId}`,
    parentRepoPath: `/tmp/${slug}`,
    promotionMode,
    promotionState: opts.promotionState ?? "done",
    prState: opts.prState ?? null,
  });

  return { projectId, taskId, runId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("completeTask", () => {
  it("completes a locally delivered task, records activity, and is idempotent", async () => {
    const seeded = await seedTaskRun();
    const first = await completeTask(
      seeded.taskId,
      seeded.projectId,
      { expectedRevision: 4, actor: { type: "system", id: null } },
      db,
    );

    expect(first).toMatchObject({
      status: "Done",
      revision: 5,
      runId: seeded.runId,
      alreadyDone: false,
    });

    const [task] = await db
      .select({ status: schema.tasks.status, revision: schema.tasks.revision })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId));
    const activity = await db
      .select({ eventKind: schema.taskActivity.eventKind })
      .from(schema.taskActivity)
      .where(
        and(
          eq(schema.taskActivity.taskId, seeded.taskId),
          eq(schema.taskActivity.eventKind, "task_completed"),
        ),
      );

    expect(task).toEqual({ status: "Done", revision: 5 });
    expect(activity).toHaveLength(1);

    const retry = await completeTask(
      seeded.taskId,
      seeded.projectId,
      { expectedRevision: 4, actor: { type: "system", id: null } },
      db,
    );

    expect(retry).toMatchObject({
      status: "Done",
      revision: 5,
      alreadyDone: true,
    });
  });

  it("refuses a Done result that was not delivered", async () => {
    const seeded = await seedTaskRun({ promotionState: "none" });

    await expect(
      completeTask(
        seeded.taskId,
        seeded.projectId,
        { actor: { type: "system", id: null } },
        db,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "delivery_not_done" },
    });
  });

  it("requires a pull request to be observed as merged", async () => {
    const seeded = await seedTaskRun({
      promotionMode: "pull_request",
      prState: "open",
    });

    await expect(
      completeTask(
        seeded.taskId,
        seeded.projectId,
        { actor: { type: "system", id: null } },
        db,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "pull_request_not_merged" },
    });

    await db
      .update(schema.workspaces)
      .set({ prState: "merged" })
      .where(eq(schema.workspaces.runId, seeded.runId));

    await expect(
      completeTask(
        seeded.taskId,
        seeded.projectId,
        { actor: { type: "system", id: null } },
        db,
      ),
    ).resolves.toMatchObject({ status: "Done", alreadyDone: false });
  });

  it("refuses completion when a newer flow run is not Done", async () => {
    const seeded = await seedTaskRun();
    const newerRunId = randomUUID();

    await db.insert(schema.runs).values({
      id: newerRunId,
      taskId: seeded.taskId,
      projectId: seeded.projectId,
      flowId: (
        await db
          .select({ id: schema.flows.id })
          .from(schema.flows)
          .where(eq(schema.flows.projectId, seeded.projectId))
      )[0].id,
      status: "Pending",
      flowVersion: "v1.0.0",
      startedAt: new Date("2026-10-17T11:00:00Z"),
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId: newerRunId,
      projectId: seeded.projectId,
      branch: `task-${seeded.taskId}-newer`,
      worktreePath: `/tmp/newer-${newerRunId}`,
      parentRepoPath: "/tmp/newer",
      promotionMode: "local_merge",
      promotionState: "none",
    });

    await expect(
      completeTask(
        seeded.taskId,
        seeded.projectId,
        { actor: { type: "system", id: null } },
        db,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "run_not_done", runId: newerRunId },
    });
  });
});

// ADR-207: automatic completion after a confirmed PR merge. Decision branches
// are owned by the evaluator unit table; this suite owns persistence, dedup,
// inbox fan-out and the lock.
describe("completeTaskFromConfirmedMerge", () => {
  async function seedMerged(
    opts: { resolvesTask?: boolean } = {},
  ): Promise<{ projectId: string; taskId: string; runId: string }> {
    const seeded = await seedTaskRun({
      promotionMode: "pull_request",
      prState: "merged",
    });

    await db
      .update(schema.runs)
      .set({
        deliveryPolicySnapshot: {
          strategy: "pull_request",
          push: "on_success",
          trigger: "manual",
          targetBranch: "main",
          ...(opts.resolvesTask === undefined
            ? {}
            : { resolvesTask: opts.resolvesTask }),
        },
      })
      .where(eq(schema.runs.id, seeded.runId));
    await db
      .update(schema.workspaces)
      .set({ prNumber: 42, prUrl: "https://github.com/a/b/pull/42" })
      .where(eq(schema.workspaces.runId, seeded.runId));

    return seeded;
  }

  async function activityOf(taskId: string, kind: string) {
    return db
      .select({
        payload: schema.taskActivity.payload,
        actorType: schema.taskActivity.actorType,
      })
      .from(schema.taskActivity)
      .where(
        and(
          eq(schema.taskActivity.taskId, taskId),
          eq(schema.taskActivity.eventKind, kind),
        ),
      );
  }

  async function complete(seeded: { taskId: string; runId: string }) {
    return db.transaction((tx) =>
      completeTaskFromConfirmedMerge(seeded.taskId, seeded.runId, tx),
    );
  }

  it("C2: completes the task once with cause pr_merged; redelivery is a no-op", async () => {
    const seeded = await seedMerged();

    expect(await complete(seeded)).toEqual({
      kind: "apply",
      runId: seeded.runId,
    });
    expect(await complete(seeded)).toEqual({
      kind: "skip",
      reason: "already_done",
    });

    const [task] = await db
      .select({ status: schema.tasks.status, revision: schema.tasks.revision })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId));

    expect(task).toEqual({ status: "Done", revision: 5 });
    expect(await activityOf(seeded.taskId, "task_completed")).toEqual([
      {
        actorType: "system",
        payload: { runId: seeded.runId, cause: "pr_merged", prNumber: 42 },
      },
    ]);
  });

  it("C3: a refusal is recorded once per (run, reason) and reaches subscribers' inbox", async () => {
    const seeded = await seedMerged({ resolvesTask: false });

    await db.insert(schema.taskSubscribers).values({
      taskId: seeded.taskId,
      subscriberType: "user",
      subscriberId: "watcher-1",
      reason: "manual",
    });

    expect(await complete(seeded)).toEqual({
      kind: "refuse",
      reason: "partial_resolution",
    });
    await complete(seeded);

    expect(
      await activityOf(seeded.taskId, "delivery_completion_not_applied"),
    ).toEqual([
      {
        actorType: "system",
        payload: { runId: seeded.runId, reason: "partial_resolution" },
      },
    ]);

    const inbox = await db
      .select({
        recipientId: schema.inboxItems.recipientId,
        eventKind: schema.inboxItems.eventKind,
      })
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.taskId, seeded.taskId));

    expect(inbox).toEqual([
      {
        recipientId: "watcher-1",
        eventKind: "delivery_completion_not_applied",
      },
    ]);

    const [task] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId));

    expect(task.status).toBe("InFlight");
  });

  it("C3: a statement edit is refused while InFlight, so completion still applies", async () => {
    const seeded = await seedMerged();

    await expect(
      updateTask(seeded.taskId, seeded.projectId, { prompt: "changed" }, db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(await complete(seeded)).toEqual({
      kind: "apply",
      runId: seeded.runId,
    });
  });

  it("C4: completion and a concurrent relaunch serialize on the task lock — never Done with a newer attempt", async () => {
    for (const order of ["completion-first", "relaunch-first"] as const) {
      const seeded = await seedMerged();
      const flowId = (
        await db
          .select({ flowId: schema.runs.flowId })
          .from(schema.runs)
          .where(eq(schema.runs.id, seeded.runId))
      )[0].flowId;
      const newerRunId = randomUUID();
      // The launch claim's critical section (claimTaskLaunchIntent): lock the
      // task row, admit only Backlog/InFlight, insert the newer attempt.
      const relaunch = (holder: { release?: () => void }) =>
        testDatabase.db.transaction(async (tx) => {
          const [task] = await tx
            .select({ status: schema.tasks.status })
            .from(schema.tasks)
            .where(eq(schema.tasks.id, seeded.taskId))
            .for("update");

          if (task.status !== "Backlog" && task.status !== "InFlight") {
            return "refused";
          }
          await tx.insert(schema.runs).values({
            id: newerRunId,
            taskId: seeded.taskId,
            projectId: seeded.projectId,
            flowId,
            status: "Pending",
            flowVersion: "v1.0.0",
            startedAt: new Date("2026-10-17T12:00:00Z"),
          });
          await new Promise<void>((resolve) => (holder.release = resolve));

          return "launched";
        });
      const holder: { release?: () => void } = {};
      let first: Promise<unknown>;
      let second: Promise<unknown>;

      if (order === "relaunch-first") {
        first = relaunch(holder);
        await until(() => holder.release !== undefined);
        second = complete(seeded);
      } else {
        first = db.transaction(async (tx) => {
          const decision = await completeTaskFromConfirmedMerge(
            seeded.taskId,
            seeded.runId,
            tx,
          );

          await new Promise<void>((resolve) => (holder.release = resolve));

          return decision;
        });
        await until(() => holder.release !== undefined);
        second = relaunch({});
      }

      await until(async () => (await lockWaiters()) > 0);
      holder.release!();
      const results = await Promise.all([first, second]);

      const [task] = await db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, seeded.taskId));
      const newer = await db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(eq(schema.runs.id, newerRunId));

      if (order === "completion-first") {
        expect(results).toEqual([
          { kind: "apply", runId: seeded.runId },
          "refused",
        ]);
        expect(task.status).toBe("Done");
        expect(newer).toHaveLength(0);
      } else {
        expect(results).toEqual([
          "launched",
          { kind: "refuse", reason: "superseded_by_newer_attempt" },
        ]);
        expect(task.status).toBe("InFlight");
        expect(newer).toHaveLength(1);
      }
    }
  });
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not reached");
}

// The loser is PARKED on the row lock, proving the two critical sections were
// really concurrent rather than sequential by accident.
async function lockWaiters(): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND datname = current_database()
  `);

  return (result.rows[0] as { n: number }).n;
}
