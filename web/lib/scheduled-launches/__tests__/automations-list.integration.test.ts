import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { listProjectAutomations } from "@/lib/scheduled-launches/queries";
import { createScheduledLaunch } from "@/lib/scheduled-launches/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// This query is the project Automations tab's ONLY data source, and every test
// that touched it mocked it out — so nobody ever executed the SQL. It shipped
// with `ORDER BY 0`, which Postgres reads as an ordinal position rather than a
// constant, and the tab fell to the error boundary on every project:
//
//   error: ORDER BY position 0 is not in select list
//
// These tests run the REAL statement. The first case needs no rows at all: the
// ordinal is rejected while the statement is analysed, so an empty project is
// enough to reproduce it.
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
    email: `${userId}@automations-list.test`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `automations-${projectId.slice(0, 8)}`,
    name: "Automations list test",
    repoPath: `/tmp/automations-${projectId}`,
    maisterYamlPath: `/tmp/automations-${projectId}/maister.yaml`,
    taskKey: `A${projectId.slice(0, 8)}`.toUpperCase(),
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
    title: "Automations list task",
    prompt: "scheduled maintenance",
    flowId,
    status: "Backlog",
  });

  return { flowId, projectId, taskId, userId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "automations_list_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("listProjectAutomations — the statement actually runs", () => {
  it("lists an empty project instead of failing to analyse the query", async () => {
    const fixture = await seed();

    await expect(
      listProjectAutomations({ projectId: fixture.projectId, limit: 50 }),
    ).resolves.toEqual({ rows: [], nextCursor: null });
  });

  it("orders by automation kind once the earlier sort keys tie", async () => {
    const fixture = await seed();
    // Both inactive and given the SAME updatedAt, so `active`, `nextActionAt`
    // and `updatedAt` all tie and the kind is the only key left to order by.
    //
    // This pins the MERGE comparator, not the SQL rank: each source is queried
    // separately and `kindRank(type)` orders them in TS. Verified by reverting
    // only the recurring rank to a bare `1` — this test still passed, so do not
    // read it as covering that literal.
    const tie = new Date("2026-03-01T00:00:00.000Z");
    const created = await createScheduledLaunch({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      actorUserId: fixture.userId,
      idempotencyKey: `automations-order-${fixture.projectId}`,
      scheduledLocalTime: "2026-06-01T10:15",
      timezone: "Europe/Moscow",
      launchRequest: { flowId: fixture.flowId, autoPromote: false },
      now: new Date("2026-01-01T00:00:00.000Z"),
      db,
    });

    await db
      .update(schema.scheduledTaskLaunches)
      .set({ nextAttemptAt: null, updatedAt: tie })
      .where(eq(schema.scheduledTaskLaunches.id, created.intent.id));

    await db.insert(schema.runSchedules).values({
      id: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      name: "Nightly maintenance",
      cronExpr: "0 3 * * *",
      timezone: "Europe/Moscow",
      // `next_fire_at` is NOT NULL, but `enabled: false` is what makes the
      // recurring `nextActionAt` CASE resolve to NULL — so this row is inactive
      // and ties with the one-time launch above.
      enabled: false,
      nextFireAt: tie,
      updatedAt: tie,
    });

    const { rows } = await listProjectAutomations({
      projectId: fixture.projectId,
      limit: 50,
    });

    expect(rows.map((row) => row.type)).toEqual([
      "one_time_task_launch",
      "recurring_task_schedule",
    ]);
  });
});
