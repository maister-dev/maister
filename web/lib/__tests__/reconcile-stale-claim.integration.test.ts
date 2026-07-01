// ADR-121 (T15, F1): the reconcile sweep clears STALE C2 admission claims — a
// tasks.queue_claimed_at set past the grace window means the claimer crashed
// between the CAS and launchRun. A recent claim (a live in-flight launch) is
// preserved. Real-PG.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { runReconcileSweep } from "@/lib/reconcile";

const schema = fullSchema as unknown as Record<string, any>;
const { tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_stale_claim_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `sc-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `SC ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `P${projectId.slice(0, 8)}`.toUpperCase(),
  });

  return projectId;
}

async function seedClaimedTask(
  projectId: string,
  claimedAt: Date,
): Promise<string> {
  const taskId = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    status: "Backlog",
    queueClaimedAt: claimedAt,
  });

  return taskId;
}

async function claimOf(taskId: string): Promise<Date | null> {
  const rows = await db
    .select({ c: tasks.queueClaimedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return rows[0].c;
}

const noSessions = async () => [];
const noWorktrees = async () => [];

describe("reconcile stale C2 claim sweep (ADR-121 T15)", () => {
  it("clears a claim older than the grace window; preserves a recent one", async () => {
    const projectId = await seedProject();
    const now = new Date();
    const stale = await seedClaimedTask(
      projectId,
      new Date(now.getTime() - 11 * 60 * 1000), // 11 min > 10 min grace
    );
    const fresh = await seedClaimedTask(
      projectId,
      new Date(now.getTime() - 30 * 1000), // 30s — a live in-flight launch
    );

    const summary = await runReconcileSweep({
      db,
      listSessions: noSessions,
      listWorktrees: noWorktrees,
      now: () => now,
    });

    expect(summary.staleClaimsCleared).toBe(1);
    expect(await claimOf(stale)).toBeNull();
    expect(await claimOf(fresh)).not.toBeNull();
  });

  it("runs even on a no-run-candidates tick (the sweep is task-scoped)", async () => {
    const projectId = await seedProject();
    const now = new Date();

    await seedClaimedTask(projectId, new Date(now.getTime() - 20 * 60 * 1000));

    const summary = await runReconcileSweep({
      db,
      listSessions: noSessions,
      listWorktrees: noWorktrees,
      now: () => now,
    });

    expect(summary.candidates).toBe(0);
    expect(summary.staleClaimsCleared).toBe(1);
  });
});
