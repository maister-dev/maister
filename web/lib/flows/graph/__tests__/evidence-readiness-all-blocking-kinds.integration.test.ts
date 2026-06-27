// T4.5 INTEGRATION TEST: assertEvidenceReady extended to ALL blocking gate kinds
//
// Validates that assertEvidenceReady now blocks on command_check, ai_judgment,
// and skill_check gates (previously ignored). Ensures blocking gates of all
// kinds on the live attempt are enforced, and advisory gates never block.

import { mkdtemp } from "node:fs/promises";
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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
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
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
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
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, runtimeRoot };
}

async function getNodeAttempts(runId: string) {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as any[];
}

describe("T4.5: assertEvidenceReady (all blocking gate kinds) — integration", () => {
  it("blocking command_check gate failed → ready=false (RED: today returns true)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "cmd-check",
                kind: "command_check",
                mode: "blocking",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // Manually set the command_check gate to failed (simulating executor result).
    // In reality, gates are set by the executor, but for this test we manipulate
    // the DB directly to force the gate status.
    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      await db
        .update(schema.gateResults)
        .set({ status: "failed" })
        .where(eq(schema.gateResults.nodeAttemptId, workAttempt.id));
    }

    // RED: before M15, this returns { ready: true, reasons: [] } because
    // command_check was ignored. After M15, must return ready: false.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("command_check"))).toBe(true);
  });

  it("blocking ai_judgment gate stale → ready=false (RED: today returns true)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "assess",
          type: "cli",
          action: { command: "echo assess" },
          pre_finish: {
            gates: [
              {
                id: "ai-review",
                kind: "ai_judgment",
                mode: "blocking",
                config: {
                  prompt: "Review the code",
                  verdict_type: "pass_fail",
                },
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const assessAttempt = attempts.find((a) => a.nodeId === "assess");

    if (assessAttempt) {
      await db
        .update(schema.gateResults)
        .set({ status: "stale" })
        .where(eq(schema.gateResults.nodeAttemptId, assessAttempt.id));
    }

    // RED: before M15, returns ready: true. After M15, must return ready: false.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("ai_judgment"))).toBe(true);
  });

  it("blocking skill_check gate failed → ready=false (RED: today returns true)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "quality",
          type: "cli",
          action: { command: "echo quality" },
          pre_finish: {
            gates: [
              {
                id: "skill-gate",
                kind: "skill_check",
                mode: "blocking",
                config: {
                  skill: "code_review",
                  expected_outcome: "pass",
                },
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const qualityAttempt = attempts.find((a) => a.nodeId === "quality");

    if (qualityAttempt) {
      await db
        .update(schema.gateResults)
        .set({ status: "failed" })
        .where(eq(schema.gateResults.nodeAttemptId, qualityAttempt.id));
    }

    // RED: before M15, returns ready: true. After M15, must return ready: false.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("skill_check"))).toBe(true);
  });

  it("blocking command_check gate overridden → ready=true (override clears)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "cmd-check",
                kind: "command_check",
                mode: "blocking",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Set the gate to overridden (manual override clears the block).
      await db
        .update(schema.gateResults)
        .set({ status: "overridden", overriddenBy: "admin" })
        .where(eq(schema.gateResults.nodeAttemptId, workAttempt.id));
    }

    // An overridden blocking gate clears enforcement → ready: true.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("advisory command_check gate failed → ready=true (advisory never blocks)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "cmd-check",
                kind: "command_check",
                mode: "advisory",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Set to failed, but mode is advisory (not blocking).
      await db
        .update(schema.gateResults)
        .set({ status: "failed" })
        .where(eq(schema.gateResults.nodeAttemptId, workAttempt.id));
    }

    // Advisory gates do not block → ready: true.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("blocking ai_judgment gate passed → ready=true (passes are clear)", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "assess",
          type: "cli",
          action: { command: "echo assess" },
          pre_finish: {
            gates: [
              {
                id: "ai-review",
                kind: "ai_judgment",
                mode: "blocking",
                config: {
                  prompt: "Review the code",
                  verdict_type: "pass_fail",
                },
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const assessAttempt = attempts.find((a) => a.nodeId === "assess");

    if (assessAttempt) {
      // Set to passed.
      await db
        .update(schema.gateResults)
        .set({ status: "passed" })
        .where(eq(schema.gateResults.nodeAttemptId, assessAttempt.id));
    }

    // A passed blocking gate allows promotion → ready: true.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("multiple blocking gates of different kinds, one failed → ready=false", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "cmd-check",
                kind: "command_check",
                mode: "blocking",
              },
              {
                id: "ai-review",
                kind: "ai_judgment",
                mode: "blocking",
                config: {
                  prompt: "Review",
                  verdict_type: "pass_fail",
                },
              },
              {
                id: "skill-gate",
                kind: "skill_check",
                mode: "blocking",
                config: {
                  skill: "code_review",
                  expected_outcome: "pass",
                },
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Set only the skill_check to failed; others pass.
      const gates = (await db
        .select()
        .from(schema.gateResults)
        .where(eq(schema.gateResults.nodeAttemptId, workAttempt.id))) as any[];

      for (const gate of gates) {
        if (gate.kind === "skill_check") {
          await db
            .update(schema.gateResults)
            .set({ status: "failed" })
            .where(eq(schema.gateResults.id, gate.id));
        } else {
          await db
            .update(schema.gateResults)
            .set({ status: "passed" })
            .where(eq(schema.gateResults.id, gate.id));
        }
      }
    }

    // One blocking gate failed → ready: false, even though others passed.
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("skill_check"))).toBe(true);
  });
});
