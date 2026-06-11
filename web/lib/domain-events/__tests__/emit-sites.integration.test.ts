import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { addTaskComment } from "@/lib/social/comments";
import { createTask } from "@/lib/services/tasks";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

// =============================================================================
// T5 — task-domain emission sites (AC1, ADR-085).
//
//   T-E3: createTask captures exactly one `task.created` domain event in the
//         SAME transaction as the task insert; an injected post-insert failure
//         (subscribe throws after activity + emit) rolls back BOTH the task
//         and the event.
//   T-E4: addTaskComment captures exactly one `task.comment_added` event with
//         { taskKey, commentId, mentionedTaskIds? }; the injected failure
//         rolls back the comment AND the event.
//
// The `subscribe` injection point sits AFTER the domain insert + activity +
// emit inside both transactions, so a throw there proves same-tx coupling.
// =============================================================================

const state = vi.hoisted(() => ({ failSubscribe: false }));

vi.mock("@/lib/social/subscriptions", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@/lib/social/subscriptions")>();

  return {
    ...mod,
    subscribe: async (...args: Parameters<typeof mod.subscribe>) => {
      if (state.failSubscribe) {
        throw new Error("injected subscribe failure");
      }

      return mod.subscribe(...args);
    },
  };
});

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // tasks.created_by_user_id is FK -> users(id); the acting users must exist.
  await db.insert(schema.users).values([
    { id: "user-1", email: "user-1@test.local", role: "member" },
    { id: "user-2", email: "user-2@test.local", role: "member" },
  ]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  state.failSubscribe = false;
  await db.delete(schema.domainEvents);
});

async function seedProjectWithFlow(): Promise<{
  projectId: string;
  flowId: string;
  taskKey: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const taskKey = `T${randomUUID().slice(0, 8)}`.toUpperCase();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    taskKey,
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  return { projectId, flowId, taskKey };
}

describe("createTask → task.created (T-E3)", () => {
  it("winner: emits exactly one task.created in the task's transaction", async () => {
    const { projectId, flowId, taskKey } = await seedProjectWithFlow();

    const created = await createTask(
      { title: "Ship it", prompt: "do", flowId },
      { projectId, actorUserId: "user-1" },
      db,
    );

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    expect(row.kind).toBe("task.created");
    expect(row.projectId).toBe(projectId);
    expect(row.taskId).toBe(created.taskId);
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe("user-1");
    expect(row.payload).toEqual({
      taskKey: `${taskKey}-${created.number}`,
      title: "Ship it",
    });
  });

  it("rollback: an injected post-emit failure leaves no task AND no event", async () => {
    const { projectId, flowId } = await seedProjectWithFlow();

    state.failSubscribe = true;

    await expect(
      createTask(
        { title: "Doomed", prompt: "do", flowId },
        { projectId, actorUserId: "user-1" },
        db,
      ),
    ).rejects.toThrow("injected subscribe failure");

    const taskRows = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projectId));
    const eventRows = await db.select().from(schema.domainEvents);

    expect(taskRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
  });
});

describe("addTaskComment → task.comment_added (T-E4)", () => {
  it("winner: emits exactly one task.comment_added with commentId + mentionedTaskIds", async () => {
    const { projectId, flowId, taskKey } = await seedProjectWithFlow();

    const target = await createTask(
      { title: "Target", prompt: "do", flowId },
      { projectId, actorUserId: null },
      db,
    );
    const mentioned = await createTask(
      { title: "Mentioned", prompt: "do", flowId },
      { projectId, actorUserId: null },
      db,
    );

    await db.delete(schema.domainEvents);

    const comment = await addTaskComment(
      {
        taskId: target.taskId,
        body: `see ${taskKey}-${mentioned.number}`,
        actor: { type: "user", id: "user-2" },
      },
      db,
    );

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    expect(row.kind).toBe("task.comment_added");
    expect(row.projectId).toBe(projectId);
    expect(row.taskId).toBe(target.taskId);
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe("user-2");
    expect(row.payload).toEqual({
      taskKey: `${taskKey}-${target.number}`,
      commentId: comment.id,
      mentionedTaskIds: [mentioned.taskId],
    });
  });

  it("winner: a mention-free comment omits mentionedTaskIds", async () => {
    const { projectId, flowId, taskKey } = await seedProjectWithFlow();

    const target = await createTask(
      { title: "Target", prompt: "do", flowId },
      { projectId, actorUserId: null },
      db,
    );

    await db.delete(schema.domainEvents);

    const comment = await addTaskComment(
      { taskId: target.taskId, body: "plain note", actor: { type: "user", id: "user-2" } },
      db,
    );

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).payload).toEqual({
      taskKey: `${taskKey}-${target.number}`,
      commentId: comment.id,
    });
  });

  it("rollback: an injected post-emit failure leaves no comment AND no event", async () => {
    const { projectId, flowId } = await seedProjectWithFlow();

    const target = await createTask(
      { title: "Target", prompt: "do", flowId },
      { projectId, actorUserId: null },
      db,
    );

    await db.delete(schema.domainEvents);
    state.failSubscribe = true;

    await expect(
      addTaskComment(
        {
          taskId: target.taskId,
          body: "doomed comment",
          actor: { type: "user", id: "user-2" },
        },
        db,
      ),
    ).rejects.toThrow("injected subscribe failure");

    const commentRows = await db
      .select()
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, target.taskId));
    const eventRows = await db.select().from(schema.domainEvents);

    expect(commentRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
  });
});
