// ADR-121 §3 (T7/T8): priority + advisory-confidence + pause write paths against
// real Postgres. Covers the shared SET/CLEAR mapper from BOTH the human task
// service and the agent triage service, plus the Backlog gate / pause exemption.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { updateTask } from "@/lib/services/tasks";
import {
  applyTriageFlag,
  applyTriageVerdict,
  setTaskQueueFields,
} from "@/lib/services/triage";

const schema = fullSchema as unknown as Record<string, any>;
const { tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let userId: string;

let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_queue_write_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `qw-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedTask(
  status: "Backlog" | "InFlight" = "Backlog",
): Promise<{ projectId: string; taskId: string }> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const slug = `qw-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `QW ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `Q${projectId.slice(0, 8)}`.toUpperCase(),
  });

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    status,
  });

  return { projectId, taskId };
}

async function readTask(
  taskId: string,
  projectId: string,
): Promise<{
  priority: string;
  triageConfidence: string | null;
  queuePaused: boolean;
  triageStatus: string | null;
}> {
  const rows = await db
    .select({
      priority: tasks.priority,
      triageConfidence: tasks.triageConfidence,
      queuePaused: tasks.queuePaused,
      triageStatus: tasks.triageStatus,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  return rows[0] as any;
}

const ACTOR = (id: string) => ({ type: "user" as const, id });

describe("ADR-121 human write path (updateTask)", () => {
  it("round-trips priority + confidence: SET → CLEAR → re-SET", async () => {
    const { projectId, taskId } = await seedTask();

    await updateTask(
      taskId,
      projectId,
      { priority: "high", triageConfidence: 0.5 },
      db,
    );
    let row = await readTask(taskId, projectId);

    expect(row.priority).toBe("high");
    expect(Number(row.triageConfidence)).toBe(0.5);

    // CLEAR: priority → 'normal', confidence → NULL.
    await updateTask(
      taskId,
      projectId,
      { priority: null, triageConfidence: null },
      db,
    );
    row = await readTask(taskId, projectId);
    expect(row.priority).toBe("normal");
    expect(row.triageConfidence).toBeNull();

    // re-SET.
    await updateTask(taskId, projectId, { priority: "urgent" }, db);
    row = await readTask(taskId, projectId);
    expect(row.priority).toBe("urgent");
  });

  it("writes queuePaused and exempts it from the Backlog gate (INV-10)", async () => {
    const backlog = await seedTask("Backlog");

    await updateTask(
      backlog.taskId,
      backlog.projectId,
      { queuePaused: true },
      db,
    );
    expect(
      (await readTask(backlog.taskId, backlog.projectId)).queuePaused,
    ).toBe(true);

    const inflight = await seedTask("InFlight");

    // Pause works while InFlight (dequeue a resume / stop auto-relaunch).
    await updateTask(
      inflight.taskId,
      inflight.projectId,
      { queuePaused: true },
      db,
    );
    expect(
      (await readTask(inflight.taskId, inflight.projectId)).queuePaused,
    ).toBe(true);

    // ...but a config field (priority) on an InFlight task is refused.
    try {
      await updateTask(
        inflight.taskId,
        inflight.projectId,
        { priority: "high" },
        db,
      );
      throw new Error("expected PRECONDITION");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });
});

describe("ADR-121 agent write path (triage service)", () => {
  it("applyTriageVerdict sets priority+confidence alongside the verdict (triaged)", async () => {
    const { projectId, taskId } = await seedTask();

    await db.transaction(async (tx) => {
      await applyTriageVerdict(tx as any, {
        taskId,
        projectId,
        verdict: {},
        actor: ACTOR(userId),
        queueFields: { priority: "urgent", triageConfidence: 0.9 },
      });
    });

    const row = await readTask(taskId, projectId);

    expect(row.priority).toBe("urgent");
    expect(Number(row.triageConfidence)).toBe(0.9);
    expect(row.triageStatus).toBe("triaged");
  });

  it("applyTriageFlag accepts priority alongside a flag (F6 independence)", async () => {
    const { projectId, taskId } = await seedTask();

    await db.transaction(async (tx) => {
      await applyTriageFlag(tx as any, {
        taskId,
        projectId,
        actor: ACTOR(userId),
        queueFields: { priority: "low" },
      });
    });

    const row = await readTask(taskId, projectId);

    expect(row.priority).toBe("low");
    expect(row.triageStatus).toBe("flagged");
  });

  it("setTaskQueueFields is a pure update — no triage stamp", async () => {
    const { projectId, taskId } = await seedTask();

    await db.transaction(async (tx) => {
      await setTaskQueueFields(tx as any, {
        taskId,
        projectId,
        actor: ACTOR(userId),
        queueFields: { priority: "high", triageConfidence: 0.25 },
      });
    });

    const row = await readTask(taskId, projectId);

    expect(row.priority).toBe("high");
    expect(Number(row.triageConfidence)).toBe(0.25);
    expect(row.triageStatus).toBeNull();
  });
});
