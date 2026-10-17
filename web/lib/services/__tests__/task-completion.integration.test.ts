import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { completeTask } from "@/lib/services/task-completion";
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
    taskKey: "CMP",
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
