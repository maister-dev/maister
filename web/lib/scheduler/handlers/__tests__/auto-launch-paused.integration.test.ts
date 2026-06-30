// ADR-121 INV-10: a queue_paused task is excluded from the 60s auto-launch poll
// backstop candidate query — proven by the candidate count, and pause preserves
// the task's config.

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
import { runAutoLaunchTriagedJob } from "@/lib/scheduler/handlers/auto-launch-triaged";

const schema = fullSchema as unknown as Record<string, any>;
const { tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_auto_launch_paused_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedProjectWithFlow(): Promise<{
  projectId: string;
  flowId: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const slug = `alp-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `ALP ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `A${projectId.slice(0, 8)}`.toUpperCase(),
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

  return { projectId, flowId };
}

async function seedArmedTask(
  projectId: string,
  flowId: string,
  opts: { paused: boolean; priority?: string },
): Promise<string> {
  const id = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    flowId,
    status: "Backlog",
    triageStatus: "triaged",
    launchMode: "auto",
    launchArmedAt: new Date(),
    queuePaused: opts.paused,
    priority: opts.priority ?? "normal",
  });

  return id;
}

describe("auto-launch poll backstop excludes paused tasks (INV-10)", () => {
  it("a paused armed task is NOT a candidate; unpausing restores it", async () => {
    const { projectId, flowId } = await seedProjectWithFlow();
    const pausedId = await seedArmedTask(projectId, flowId, {
      paused: true,
      priority: "high",
    });

    await seedArmedTask(projectId, flowId, { paused: false });

    // Stub launch so we never actually spawn — we only assert candidate selection.
    const noopLaunch = async () => ({ runId: randomUUID(), status: "Pending" });

    const first = await runAutoLaunchTriagedJob({
      db,
      launch: noopLaunch as never,
    });

    // Only the unpaused task is in the candidate set.
    expect(first.candidates).toBe(1);

    // Pause preserved the config (flow + priority intact).
    const paused = await db
      .select({
        flowId: tasks.flowId,
        priority: tasks.priority,
        triageStatus: tasks.triageStatus,
        launchMode: tasks.launchMode,
        queuePaused: tasks.queuePaused,
      })
      .from(tasks)
      .where(and(eq(tasks.id, pausedId), eq(tasks.projectId, projectId)));

    expect(paused[0].flowId).toBe(flowId);
    expect(paused[0].priority).toBe("high");
    expect(paused[0].triageStatus).toBe("triaged");
    expect(paused[0].launchMode).toBe("auto");
    expect(paused[0].queuePaused).toBe(true);

    // Unpause → now a candidate.
    await db
      .update(tasks)
      .set({ queuePaused: false })
      .where(eq(tasks.id, pausedId));

    const second = await runAutoLaunchTriagedJob({
      db,
      launch: noopLaunch as never,
    });

    expect(second.candidates).toBe(2);
  });
});
