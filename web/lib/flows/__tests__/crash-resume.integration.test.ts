// M19 crash-recover (ADR-034, Codex round-3): drives the REAL graph + linear
// runners (NOT a mocked runFlow) for a crashed `retry_safe` session-less node.
// Proves the crash-resume mode added to runGraph/runFlow:
//   - graph: a `Running` run with prior attempts + `crashResume.targetStepId`
//     RE-RUNS the crashed node (fresh attempt) instead of no-op'ing, and does
//     NOT re-run upstream nodes;
//   - single-winner: two concurrent crash-resume dispatches → exactly ONE
//     traversal executes (CAS-clear resume_started_at claim);
//   - linear: resumes FROM the crashed step, not from step 0 (no upstream
//     re-run / duplicated side effects).

import type { NodeAttempt, Run, StepRun } from "@/lib/db/schema";

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
import { closeDb } from "@/lib/db/client";
import {
  appendNodeAttempt,
  getNodeAttemptsForRun,
  markNodeFailed,
  markNodeSucceeded,
} from "@/lib/flows/graph/ledger";
import { runFlow } from "@/lib/flows/runner";
import {
  createStepRun,
  getStepRunsForRun,
  markStepSucceeded,
} from "@/lib/flows/step-runs";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("crash_resume_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await closeDb();
  await pool?.end();
  await container?.stop();
});

type Seeded = { runId: string; runtimeRoot: string };

// Seed a run already in the post-crash, mid-recover state: status Running,
// current_step_id = the retained target, resume_started_at set (the claim
// token), resume_target_step_id = the target.
async function seedCrashResumeRun(
  manifest: unknown,
  targetStepId: string,
): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "cr-wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "cr-rt-"));

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
    currentStepId: targetStepId,
    resumeStartedAt: new Date(),
    resumeTargetStepId: targetStepId,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
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

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

const cliChain = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "a",
      type: "cli",
      action: { command: "true" },
      transitions: { success: "b" },
    },
    {
      id: "b",
      type: "cli",
      action: { command: "true" },
      retry_safe: true,
      transitions: { success: "done" },
    },
  ],
};

const linearChain = {
  schemaVersion: 1,
  name: "lin",
  steps: [
    { id: "s1", type: "cli", command: "true", retry_safe: true },
    { id: "s2", type: "cli", command: "true", retry_safe: true },
  ],
};

describe("graph runner — crash-resume re-runs the crashed node", () => {
  it("re-dispatches the crashed retry_safe node (fresh attempt), NOT a no-op, and does not re-run upstream", async () => {
    const seeded = await seedCrashResumeRun(cliChain, "b");

    // Prior history: a Succeeded, b crashed (Failed attempt). The no-op guard
    // would fire here (attempts exist) WITHOUT the crash-resume mode.
    const a1 = await appendNodeAttempt({
      runId: seeded.runId,
      nodeId: "a",
      nodeType: "cli",
      db,
    });

    await markNodeSucceeded(a1.id, { decision: "success" }, db);

    const b1 = await appendNodeAttempt({
      runId: seeded.runId,
      nodeId: "b",
      nodeType: "cli",
      db,
    });

    await markNodeFailed(b1.id, { errorCode: "CRASH" }, db);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      crashResume: { targetStepId: "b" },
    });

    const attempts = (await getNodeAttemptsForRun(
      seeded.runId,
      db,
    )) as NodeAttempt[];
    const aAttempts = attempts.filter((x) => x.nodeId === "a");
    const bAttempts = attempts.filter((x) => x.nodeId === "b");

    // Upstream node NOT re-run.
    expect(aAttempts).toHaveLength(1);
    // Crashed node re-ran → a fresh attempt was appended and executed.
    expect(bAttempts.length).toBeGreaterThanOrEqual(2);
    expect(bAttempts.some((x) => x.status === "Succeeded")).toBe(true);

    // The run progressed past the crash (not stuck Crashed/Running) and the
    // claim cleared the marker.
    const run = await getRun(seeded.runId);

    expect(run.status).not.toBe("Crashed");
    expect(run.resumeStartedAt).toBeNull();
  }, 60_000);

  it("single-winner: two concurrent crash-resume dispatches → exactly ONE re-runs the node", async () => {
    const seeded = await seedCrashResumeRun(cliChain, "b");

    const a1 = await appendNodeAttempt({
      runId: seeded.runId,
      nodeId: "a",
      nodeType: "cli",
      db,
    });

    await markNodeSucceeded(a1.id, { decision: "success" }, db);

    const b1 = await appendNodeAttempt({
      runId: seeded.runId,
      nodeId: "b",
      nodeType: "cli",
      db,
    });

    await markNodeFailed(b1.id, { errorCode: "CRASH" }, db);

    // Two concurrent dispatches race on the CAS-clear resume_started_at claim.
    await Promise.all([
      runFlow(seeded.runId, {
        db,
        runtimeRoot: seeded.runtimeRoot,
        crashResume: { targetStepId: "b" },
      }),
      runFlow(seeded.runId, {
        db,
        runtimeRoot: seeded.runtimeRoot,
        crashResume: { targetStepId: "b" },
      }),
    ]);

    const attempts = (await getNodeAttemptsForRun(
      seeded.runId,
      db,
    )) as NodeAttempt[];
    const bAttempts = attempts.filter((x) => x.nodeId === "b");

    // Only the claim winner appended a fresh attempt: the pre-seeded crash
    // attempt + exactly ONE re-run = 2 (the loser bailed, no 3rd attempt).
    expect(bAttempts).toHaveLength(2);
  }, 60_000);
});

describe("linear runner — crash-resume resumes from the crashed step", () => {
  it("re-runs the crashed step forward, NOT from step 0 (no upstream duplication)", async () => {
    const seeded = await seedCrashResumeRun(linearChain, "s2");

    // s1 already Succeeded before the crash at s2.
    const s1 = await createStepRun({
      runId: seeded.runId,
      stepId: "s1",
      stepType: "cli",
      db,
    });

    await markStepSucceeded(s1.id, {}, db);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      crashResume: { targetStepId: "s2" },
    });

    const stepRuns = (await getStepRunsForRun(seeded.runId, db)) as StepRun[];
    const s1Runs = stepRuns.filter((x) => x.stepId === "s1");
    const s2Runs = stepRuns.filter((x) => x.stepId === "s2");

    // s1 NOT re-run (the round-3 bug restarted linear flows from step 0).
    expect(s1Runs).toHaveLength(1);
    // s2 (the crashed step) ran.
    expect(s2Runs.length).toBeGreaterThanOrEqual(1);

    const run = await getRun(seeded.runId);

    expect(run.resumeStartedAt).toBeNull();
  }, 60_000);
});
