// ADR-078 D11 — unread inbox counts feeding "Needs you (N)" in both scopes,
// item listing with task refs, and per-project grouping.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

import {
  getInboxItems,
  getUnreadInboxCount,
  getUnreadInboxCountsByProject,
} from "@/lib/queries/inbox";

const fx = {
  userId: randomUUID(),
  otherUserId: randomUUID(),
  projectA: randomUUID(),
  projectB: randomUUID(),
  taskA: randomUUID(),
  taskB: randomUUID(),
};

async function seedItem(
  recipientId: string,
  projectId: string,
  taskId: string,
  read = false,
): Promise<void> {
  await pool.query(
    `insert into inbox_items
       (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref, read_at)
     values ($1, 'user', $2, $3, $4, 'comment_added', '{}', $5)`,
    [randomUUID(), recipientId, projectId, taskId, read ? new Date() : null],
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("inbox_query_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  for (const [projectId, slug, key] of [
    [fx.projectA, "inbox-a", "INA"],
    [fx.projectB, "inbox-b", "INB"],
  ] as const) {
    await pool.query(
      `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
       values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
      [projectId, slug, `/tmp/${slug}`, key],
    );
    await pool.query(
      `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
       values ($1, $2, 'bugfix', 'github.com/x/y', 'v1', '/tmp/f', '{"schemaVersion":1,"name":"B","steps":[]}', 1)`,
      [randomUUID(), projectId],
    );
  }
  for (const [taskId, projectId, title] of [
    [fx.taskA, fx.projectA, "Task in A"],
    [fx.taskB, fx.projectB, "Task in B"],
  ] as const) {
    const flow = await pool.query(
      `select id from flows where project_id = $1`,
      [projectId],
    );

    await pool.query(
      `insert into tasks (id, project_id, number, title, prompt, flow_id)
       values ($1, $2, 1, $3, 'p', $4)`,
      [taskId, projectId, title, flow.rows[0].id],
    );
  }

  await seedItem(fx.userId, fx.projectA, fx.taskA);
  await seedItem(fx.userId, fx.projectA, fx.taskA, true);
  await seedItem(fx.userId, fx.projectB, fx.taskB);
  await seedItem(fx.otherUserId, fx.projectA, fx.taskA);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("inbox queries (ADR-078 D11)", () => {
  it("counts unread cross-project and per-project", async () => {
    expect(await getUnreadInboxCount(fx.userId)).toBe(2);
    expect(await getUnreadInboxCount(fx.userId, fx.projectA)).toBe(1);
    expect(await getUnreadInboxCount(fx.userId, fx.projectB)).toBe(1);
    expect(await getUnreadInboxCount(fx.otherUserId)).toBe(1);
  });

  it("lists unread items newest-first with KEY-N task refs", async () => {
    const items = await getInboxItems(fx.userId);

    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.keyRef))).toEqual(
      new Set(["INA-1", "INB-1"]),
    );
    expect(items.every((i) => !i.read)).toBe(true);
  });

  it("groups unread counts by project", async () => {
    const counts = await getUnreadInboxCountsByProject(fx.userId, [
      fx.projectA,
      fx.projectB,
    ]);

    expect(counts.get(fx.projectA)).toBe(1);
    expect(counts.get(fx.projectB)).toBe(1);
  });
});
