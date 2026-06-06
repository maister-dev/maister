import type { NodeAttempt } from "@/lib/db/schema";
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

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
    .withDatabase("maister_test_artifacts")
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
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
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

async function getRun(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as any[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function getArtifactInstances(runId: string): Promise<any[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];
}

describe("runGraph — artifact enforcement (T3.2, engine_min 1.2.0)", () => {
  it("missing input artifact fails the node with PRECONDITION before action runs", async () => {
    // A node requiring an upstream artifact that doesn't exist should fail
    // before the action is even executed.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "touch /tmp/marker-work && echo work" },
          input: {
            requires: ["upstream-art"],
          },
          transitions: { success: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    // Run without seeding the upstream artifact.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);
    const attempts = await getAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    // The run should have failed
    expect(run.status).toBe("Failed");
    // The node should be marked Failed with PRECONDITION error code
    expect(workAttempt?.status).toBe("Failed");
    expect(workAttempt?.errorCode).toBe("PRECONDITION");
    // The action should NOT have been executed (marker file should not exist)
    // This is the key assertion: if the file exists, the action ran when it shouldn't have.
    // We use stdout as an indirect marker since we control the command.
    expect(workAttempt?.stdout ?? "").not.toContain("work");
  });

  it("input artifact present allows node to proceed past input check", async () => {
    // When a required artifact is already current, the node should proceed.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "produce",
          type: "cli",
          action: { command: "echo produced > /dev/null" },
          output: {
            produces: [
              { id: "upstream-art", kind: "generic_file", path: "dummy.txt" },
            ],
          },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "cli",
          action: { command: "echo consuming" },
          input: {
            requires: ["upstream-art"],
          },
          transitions: { success: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    // Create the dummy.txt file that produce is supposed to output
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "dummy.txt"), "dummy content");

    // Run the flow. The produce node creates the artifact, then consume should succeed.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);
    const attempts = await getAttempts(seeded.runId);
    const produceAttempt = attempts.find((a) => a.nodeId === "produce");
    const consumeAttempt = attempts.find((a) => a.nodeId === "consume");

    // Both should succeed
    expect(produceAttempt?.status).toBe("Succeeded");
    expect(consumeAttempt?.status).toBe("Succeeded");
    expect(run.status).toBe("Review");
  });

  it("missing output file fails node with PRECONDITION before finish", async () => {
    // A node declaring an output produce that doesn't exist should fail.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          output: {
            produces: [
              { id: "out-x", kind: "generic_file", path: "missing.txt" },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    // Run the flow. The action succeeds, but the output file doesn't exist.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);
    const attempts = await getAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    // The run and node should fail
    expect(run.status).toBe("Failed");
    expect(workAttempt?.status).toBe("Failed");
    expect(workAttempt?.errorCode).toBe("PRECONDITION");
  });

  it("records output artifact and supersedes prior on rework", async () => {
    // When a node produces an artifact and then is reworked (re-run),
    // the new attempt's artifact should supersede the prior.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          output: {
            produces: [{ id: "impl-diff", kind: "diff" }],
          },
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
            maxLoops: 2,
          },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    // First run: work -> review (NeedsInput, work attempt 1)
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");

    let artifacts = await getArtifactInstances(seeded.runId);
    // Should have recorded the impl-diff artifact from work attempt 1
    const firstDiffArt = artifacts.find((a) => a.artifactDefId === "impl-diff");

    expect(firstDiffArt).toBeDefined();
    expect(firstDiffArt?.validity).toBe("current");
    const firstDiffId = firstDiffArt?.id;

    // Rework: write decision, resume
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "input-review.json"),
      JSON.stringify({ decision: "rework" }),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    // Should be back at NeedsInput (review attempt 2)
    expect(run.status).toBe("NeedsInput");

    artifacts = await getArtifactInstances(seeded.runId);
    // Now there should be TWO impl-diff artifacts: the first superseded, the second current
    const allDiffs = artifacts.filter((a) => a.artifactDefId === "impl-diff");

    expect(allDiffs).toHaveLength(2);

    const superseded = allDiffs.find((a) => a.validity === "superseded");
    const current = allDiffs.find((a) => a.validity === "current");

    expect(superseded?.id).toBe(firstDiffId);
    expect(superseded?.supersededById).toBeDefined();
    expect(current?.supersededById).toBeNull();
  });
});
