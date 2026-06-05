// TASK 4 RED TEST: Drop engine gating at the readiness chokepoint
//
// GROUND TRUTH (per readiness.md §Review chokepoint enforcement + ADR-048):
// The Review choicepoint guard (runner-graph.ts L1476-1499) evaluates readiness
// via assertEvidenceReady(), which checks all blocking gates on live attempts
// including external_check gates (M16). The guard is:
//   if (artifactEnforcementActive && !isRework && resolveTransition(...) === null) {
//     const readiness = await assertEvidenceReady(runId, "review", db);
//     if (!readiness.ready) { markNodeFailed(...); }
//   }
//
// Task 4 removes the `artifactEnforcementActive &&` term, so enforcement applies
// to ALL graph flows, not just flows with engine_min >= 1.2.0.
//
// RED TEST SCENARIO (from Task 4 spec):
// - Flow with compat.engine_min = "1.1.0" (LOW → artifactEnforcementActive = false)
// - Work node has a blocking external_check gate in pre_finish
// - external_check gates record status "pending" and do NOT fail the node
//   (they are deferred to the choicepoint per gates-exec.ts line 412-421)
// - Node finishes successfully and transitions to review (terminal)
// - Review choicepoint attempts assertEvidenceReady
//
// TODAY (guard active):
// - artifactEnforcementActive = semverGte("1.1.0", "1.2.0") = false
// - The guard condition is FALSE → choicepoint is SKIPPED
// - Run reaches Review status (no readiness check)
// - Test FAILS with "expected Failed, got Review"
//
// AFTER Task 4 (guard removed):
// - The guard `if (artifactEnforcementActive && ...)` becomes `if (...)`
// - Choicepoint always runs
// - assertEvidenceReady sees pending blocking external_check → ready=false
// - markNodeFailed PRECONDITION → run Failed
// - Test PASSES (run is Failed as expected)

import type { Run } from "@/lib/db/schema";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
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

describe("TASK 4 RED: engine gate drop at review chokepoint", () => {
  it("blocking external_check pending at choicepoint: run reaches Review TODAY (FAILS after Task 4)", async () => {
    // RED TEST: this FAILS today (expected Failed, got Review) and will PASS
    // after Task 4 removes the artifactEnforcementActive guard.
    //
    // Flow structure:
    // - engine_min "1.1.0" (LOW) → artifactEnforcementActive = false
    // - work node: cli action + blocking external_check gate in pre_finish
    //   external_check records "pending" and does NOT fail the node (gates-exec.ts:412-421)
    // - review node: human (terminal)
    //
    // Execution:
    // 1st runFlow: work succeeds, external_check gate recorded as "pending",
    //   node finishes, transitions to review, pauses for HITL (NeedsInput)
    // 2nd runFlow: review approves, reaches Review choicepoint
    //   TODAY: artifactEnforcementActive=false → guard skipped → run → Review
    //   AFTER T4: guard removed → choicepoint runs → sees pending blocking
    //   external_check → ready=false → markNodeFailed PRECONDITION → run Failed
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
                id: "ci",
                kind: "external_check",
                mode: "blocking",
              },
            ],
          },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              role: "maintainer",
              decisions: ["approve"],
            },
          },
          transitions: { approve: "done" },
        },
      ],
    });

    // First run: work completes, external_check pending recorded, review pauses.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");

    // Write approval for review.
    await writeDecision(seeded, "review", "approve");

    // Second run: review approves, node finishes, reaches choicepoint.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    run = await getRun(seeded.runId);

    // RED ASSERTION:
    // TODAY: run reaches Review (guard skips choicepoint for engine_min < 1.2.0)
    //   → this assertion FAILS: expected Failed, got Review
    // AFTER Task 4: guard removed, choicepoint runs, sees pending blocking
    //   external_check → ready=false → run is Failed
    //   → this assertion PASSES: expected Failed, got Failed
    expect(run.status).toBe("Failed");
  });
});
