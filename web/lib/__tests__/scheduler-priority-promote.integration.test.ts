// ADR-121 (T12, C1 source): the Pending-run promote is ordered by the criticality
// dictionary (weight DESC) then FIFO, replacing the blind started_at FIFO.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { promoteNextPending } from "@/lib/scheduler";

const schema = fullSchema as unknown as Record<string, any>;
const { runs } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_priority_promote_test")
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

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `pp-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `PP ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `P${projectId.slice(0, 8)}`.toUpperCase(),
  });

  return projectId;
}

async function seedPendingRun(
  projectId: string,
  priority: string,
  startedAt: Date,
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    priority,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind: "flow",
    status: "Pending",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt,
  });

  return runId;
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0].status;
}

describe("promoteNextPending priority ordering (ADR-121 C1)", () => {
  it("promotes the higher-criticality Pending run first", async () => {
    const projectId = await seedProject();
    // The 'normal' run is OLDER (would win a blind FIFO), but 'high' must preempt.
    const normalRun = await seedPendingRun(
      projectId,
      "normal",
      new Date(Date.now() - 60_000),
    );
    const highRun = await seedPendingRun(projectId, "high", new Date());

    const promoted: string[] = [];
    const res = await promoteNextPending({
      db,
      runFlow: (id) => promoted.push(id),
    });

    expect(res.promotedRunId).toBe(highRun);
    expect(promoted).toEqual([highRun]);
    expect(await statusOf(highRun)).toBe("Running");
    expect(await statusOf(normalRun)).toBe("Pending");
  });

  it("breaks equal-criticality ties by FIFO (oldest started_at first)", async () => {
    const projectId = await seedProject();
    const older = await seedPendingRun(
      projectId,
      "normal",
      new Date(Date.now() - 120_000),
    );
    const newer = await seedPendingRun(projectId, "normal", new Date());

    const res = await promoteNextPending({ db, runFlow: () => {} });

    expect(res.promotedRunId).toBe(older);
    expect(await statusOf(newer)).toBe("Pending");
  });
});
