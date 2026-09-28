import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db/client";
import { updateTask } from "@/lib/services/tasks";
import { seedProject } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "task_revision" });
  db = database.db as unknown as ReturnType<typeof getDb>;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-TST-02: task revision", () => {
  it("permits one of two concurrent updates at the same expected revision", async () => {
    const projectId = await seedProject(db as unknown as NodePgDatabase);
    const taskId = randomUUID();

    await db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, prompt)
      VALUES (${taskId}, ${projectId}, 1, 'Original', 'Prompt')
    `);

    const results = await Promise.allSettled([
      updateTask(taskId, projectId, { title: "First", expectedRevision: 0 }, db),
      updateTask(taskId, projectId, { title: "Second", expectedRevision: 0 }, db),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const rows = await db.execute(sql`SELECT title, revision FROM tasks WHERE id = ${taskId}`);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "CONFLICT", details: { reason: "stale_revision" } },
    });
    expect(rows.rows[0]).toMatchObject({ title: expect.stringMatching(/^(First|Second)$/), revision: 1 });
  });
});
