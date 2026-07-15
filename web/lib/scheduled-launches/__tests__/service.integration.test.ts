import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { createScheduledLaunch } from "@/lib/scheduled-launches/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type Seed = {
  flowId: string;
  projectId: string;
  taskId: string;
  userId: string;
};

async function seed(): Promise<Seed> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@scheduled-launch.test`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `scheduled-${projectId.slice(0, 8)}`,
    name: "Scheduled launch test",
    repoPath: `/tmp/scheduled-${projectId}`,
    maisterYamlPath: `/tmp/scheduled-${projectId}/maister.yaml`,
    taskKey: `S${projectId.slice(0, 8)}`.toUpperCase(),
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "maintenance",
    source: "github.com/test/maintenance",
    version: "v1.0.0",
    installedPath: "/tmp/maintenance",
    manifest: { schemaVersion: 1, name: "Maintenance", nodes: [] },
    schemaVersion: 1,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Preserve this task snapshot",
    prompt: "scheduled maintenance",
    flowId,
    status: "Backlog",
  });

  return { flowId, projectId, taskId, userId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduled_launch_service_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("createScheduledLaunch", () => {
  it("persists an audit-safe pending intent without creating a Run or reservation", async () => {
    const fixture = await seed();

    const created = await createScheduledLaunch({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      actorUserId: fixture.userId,
      idempotencyKey: "scheduled-launch-red-contract",
      scheduledLocalTime: "2026-06-01T10:15",
      timezone: "Europe/Moscow",
      launchRequest: { flowId: fixture.flowId, autoPromote: false },
      now: new Date("2026-01-01T00:00:00.000Z"),
      db,
    });

    expect(created.replayed).toBe(false);
    expect(created.intent).toMatchObject({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskKey: `S${fixture.projectId.slice(0, 8)}`.toUpperCase(),
      taskNumber: 1,
      taskTitle: "Preserve this task snapshot",
      state: "Scheduled",
      attemptCount: 0,
    });

    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, fixture.taskId));
    const reservations = await db
      .select({ id: schema.scheduledTaskLaunchAttempts.id })
      .from(schema.scheduledTaskLaunchAttempts)
      .where(
        eq(
          schema.scheduledTaskLaunchAttempts.scheduledLaunchId,
          created.intent.id,
        ),
      );

    expect(runs).toEqual([]);
    expect(reservations).toEqual([]);
  });

  it("retains the target snapshot after task deletion sets the live FK null", async () => {
    const fixture = await seed();
    const created = await createScheduledLaunch({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      actorUserId: fixture.userId,
      idempotencyKey: "scheduled-launch-deleted-task",
      scheduledLocalTime: "2026-06-01T10:15",
      timezone: "Europe/Moscow",
      launchRequest: { flowId: fixture.flowId },
      now: new Date("2026-01-01T00:00:00.000Z"),
      db,
    });

    await db.delete(schema.tasks).where(eq(schema.tasks.id, fixture.taskId));

    const rows = await db
      .select({
        taskId: schema.scheduledTaskLaunches.taskId,
        taskKey: schema.scheduledTaskLaunches.taskKey,
        taskNumber: schema.scheduledTaskLaunches.taskNumber,
        taskTitle: schema.scheduledTaskLaunches.taskTitle,
      })
      .from(schema.scheduledTaskLaunches)
      .where(
        and(
          eq(schema.scheduledTaskLaunches.id, created.intent.id),
          eq(schema.scheduledTaskLaunches.projectId, fixture.projectId),
        ),
      );

    expect(rows).toEqual([
      {
        taskId: null,
        taskKey: `S${fixture.projectId.slice(0, 8)}`.toUpperCase(),
        taskNumber: 1,
        taskTitle: "Preserve this task snapshot",
      },
    ]);
  });
});
