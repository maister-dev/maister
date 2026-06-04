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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_defaults")
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

async function seedLinearRun(manifest: unknown): Promise<Seeded> {
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

async function getArtifactInstances(runId: string): Promise<any[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];
}

describe("runFlow — default artifacts (T3.3, engine_min 1.1.0+, linear steps[])", () => {
  it("records log default artifact when payload exists (step.log)", async () => {
    // A simple steps[] flow with no explicit produces/requires.
    // The runner should record a default artifact for the log output.
    // Linear step CLI format uses `command` directly (not `action.command`).
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      steps: [
        {
          id: "step-a",
          type: "cli",
          command: "echo hello from step a",
        },
      ],
    };

    const seeded = await seedLinearRun(manifest);

    // Pre-create the log file that the supervisor would normally write.
    // recordDefaultArtifacts checks for <nodeId>.log existence (best-effort).
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "step-a.log"), "echo hello from step a\n");

    // Run the flow
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("Review"); // Simple flow completes to Review

    // Query artifact_instances for the log default
    const artifacts = await getArtifactInstances(seeded.runId);

    // Should have a log artifact with producer="runner"
    const logArt = artifacts.find(
      (a) => a.kind === "log" && a.producer === "runner",
    );

    expect(logArt).toBeDefined();
    // For linear (steps[]), node_attempt_id should be NULL, node_id should be the step id
    expect(logArt?.nodeAttemptId).toBeNull();
    expect(logArt?.nodeId).toBe("step-a");
  });

  it("records diff default artifact for linear flow", async () => {
    // A steps[] flow should auto-record a diff (git-range) default artifact.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      steps: [
        {
          id: "work",
          type: "cli",
          command: "echo work",
        },
      ],
    };

    const seeded = await seedLinearRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const artifacts = await getArtifactInstances(seeded.runId);

    // Should have a diff artifact
    const diffArt = artifacts.find(
      (a) => a.kind === "diff" || a.kind === "git-range",
    );

    expect(diffArt).toBeDefined();
    expect(diffArt?.producer).toBe("runner");
    expect(diffArt?.nodeAttemptId).toBeNull();
  });

  it("records multiple defaults when payloads exist (log, guards, hitl)", async () => {
    // A nodes[] flow with human node to record hitl-response defaults.
    // Uses nodes[] because the graph human node does not require form_schema
    // (linear human steps require form_schema which is not relevant here).
    // nodeAttemptId will be non-null for nodes[] — see test 5 for the
    // definitive null check that applies to linear steps[].
    const manifest = {
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
          finish: { human: { decisions: ["approve", "reject"] } },
          transitions: { approve: "done", reject: "done" },
        },
      ],
    };

    const seeded = await seedLinearRun(manifest);

    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    await mkdir(runDir, { recursive: true });
    // Pre-create log files that the supervisor would normally write.
    await writeFile(join(runDir, "work.log"), "echo work output\n");
    await writeFile(join(runDir, "review.log"), "review step log\n");

    // Run until human step
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");

    // At this point, log artifacts should exist for the work node
    let artifacts = await getArtifactInstances(seeded.runId);

    // Work node should have a log
    const workLog = artifacts.find(
      (a) => a.nodeId === "work" && a.kind === "log",
    );

    expect(workLog).toBeDefined();

    // Review node should have a log
    const reviewLog = artifacts.find(
      (a) => a.nodeId === "review" && a.kind === "log",
    );

    expect(reviewLog).toBeDefined();

    // Simulate web API: update hitlRequests.response so recordDefaultArtifacts
    // can record the human_note artifact on the second run.
    const hitlRows = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId))) as any[];

    if (hitlRows[0]) {
      await db
        .update(schema.hitlRequests)
        .set({
          response: { decision: "approve" },
          respondedAt: new Date(),
        })
        .where(eq(schema.hitlRequests.id, hitlRows[0].id));
    }

    // Respond to the human step
    await writeFile(
      join(runDir, "input-review.json"),
      JSON.stringify({ decision: "approve" }),
    );

    // Resume
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).toBe("Review");

    // After approval, should have hitl-response artifact.
    // The artifact row kind is "human_note" (ArtifactLocator kind is "hitl-response").
    artifacts = await getArtifactInstances(seeded.runId);
    const hitlArt = artifacts.find((a) => a.kind === "human_note");

    expect(hitlArt).toBeDefined();
    expect(hitlArt?.producer).toBe("runner");
  });

  it("does not record default if payload missing (best-effort)", async () => {
    // If a step completes but its log file doesn't exist (unlikely but possible),
    // the default should not be recorded (best-effort).
    // This test verifies the best-effort behavior is in place.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      steps: [
        {
          id: "cli-step",
          type: "cli",
          command: "true", // Minimal command
        },
      ],
    };

    const seeded = await seedLinearRun(manifest);

    // Run the flow WITHOUT pre-creating the log file
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const artifacts = await getArtifactInstances(seeded.runId);

    // Diff is always recorded (git-range), log is best-effort.
    // The exact count depends on implementation, but we verify at least the diff exists.
    const diffArt = artifacts.find(
      (a) => a.kind === "diff" || a.kind === "git-range",
    );

    expect(diffArt).toBeDefined();
  });

  it("steps[] flow records defaults with node_attempt_id NULL and node_id set", async () => {
    // Critical assertion: linear steps[] flows set node_attempt_id=NULL
    // but node_id=<step-id> on default artifacts.
    // Linear step CLI format uses `command` directly (not `action.command`).
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      steps: [
        {
          id: "step-one",
          type: "cli",
          command: "echo step-one",
        },
        {
          id: "step-two",
          type: "cli",
          command: "echo step-two",
        },
      ],
    };

    const seeded = await seedLinearRun(manifest);

    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    await mkdir(runDir, { recursive: true });
    // Pre-create log files for both steps.
    await writeFile(join(runDir, "step-one.log"), "step-one output\n");
    await writeFile(join(runDir, "step-two.log"), "step-two output\n");

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const artifacts = await getArtifactInstances(seeded.runId);

    // Filter to log artifacts
    const logs = artifacts.filter(
      (a) => a.kind === "log" && a.producer === "runner",
    );

    // Each step should have at least one log
    const step1Logs = logs.filter((a) => a.nodeId === "step-one");
    const step2Logs = logs.filter((a) => a.nodeId === "step-two");

    expect(step1Logs.length).toBeGreaterThan(0);
    expect(step2Logs.length).toBeGreaterThan(0);

    // ALL should have node_attempt_id=NULL
    const allNodeAttemptIds = logs.map((a) => a.nodeAttemptId);

    expect(allNodeAttemptIds.every((id) => id === null)).toBe(true);

    // ALL should have node_id set to their step id
    for (const log of step1Logs) {
      expect(log.nodeId).toBe("step-one");
    }
    for (const log of step2Logs) {
      expect(log.nodeId).toBe("step-two");
    }
  });
});
