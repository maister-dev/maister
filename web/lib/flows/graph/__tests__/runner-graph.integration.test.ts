import type { NodeAttempt, Run } from "@/lib/db/schema";

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { runFlow } from "@/lib/flows/runner";

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
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type Seeded = {
  runId: string;
  slug: string;
  runtimeRoot: string;
};

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function writeDecision(
  seeded: Seeded,
  nodeId: string,
  decision: string,
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify({ decision }),
    "utf8",
  );
}

const cliChain = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "a",
      type: "cli",
      action: { command: "echo a" },
      transitions: { success: "b" },
    },
    {
      id: "b",
      type: "cli",
      action: { command: "echo b" },
      transitions: { success: "done" },
    },
  ],
};

const reviewFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "work",
      type: "cli",
      action: { command: "echo work" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve", "rework"] } },
      transitions: { approve: "done", rework: "work" },
      rework: {
        allowedTargets: ["work"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    },
  ],
};

describe("runGraph — traversal + ledger", () => {
  it("walks a cli-node chain to Review writing append-only node_attempts", async () => {
    const seeded = await seedGraphRun(cliChain);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.nodeId === "a")?.status).toBe("Succeeded");
    expect(attempts.find((a) => a.nodeId === "b")?.status).toBe("Succeeded");
    expect(attempts.every((a) => a.attempt === 1)).toBe(true);
  });

  it("pauses at a human review node, then approve advances to Review", async () => {
    const seeded = await seedGraphRun(reviewFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    const hitl = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(hitl[0].kind).toBe("human");
    expect(
      (hitl[0].schema as { allowedDecisions: string[] }).allowedDecisions,
    ).toEqual(["approve", "rework"]);

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).toBe("Review");

    const review = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review",
    );

    expect(review?.status).toBe("Succeeded");
    expect(review?.decision).toBe("approve");
  });

  it("rework jumps back (review Reworked, work re-runs), then approve finishes", async () => {
    const seeded = await seedGraphRun(reviewFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework -> jump back to work, which re-runs; review re-pauses for a fresh
    // decision (the input artifact is consumed on read).
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    const afterRework = await getAttempts(seeded.runId);

    expect(
      afterRework.find((a) => a.nodeId === "review" && a.attempt === 1)?.status,
    ).toBe("Reworked");
    expect(afterRework.filter((a) => a.nodeId === "work")).toHaveLength(2); // re-ran
    expect(
      afterRework.find((a) => a.nodeId === "review" && a.attempt === 2)?.status,
    ).toBe("NeedsInput");

    // Approve the fresh review -> run reaches Review.
    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).toBe("Review");
  });
});
