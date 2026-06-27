// PR1 / F1 (RED): the runner's output.produces loop silently skips declared
// kinds that are NOT diff/commit_set and have NO `path` (lint_report,
// ai_judgment, human_note, test_report, …). A `requiredFor` output is then
// never produced yet the run still reaches Review.
//
// Fix design (Q2=B):
//   - catch-all inline producer: a declared produce that is not diff/commit_set
//     and has no path is recorded under its declared id+kind (file locator to
//     the node's run-dir <nodeId>.log, inline fallback), validity=current,
//     producer="runner".
//   - §3.6 backstop: after the produces loop, any declared produces[].id with
//     no `current` artifact → markNodeFailed(PRECONDITION).
//
// These tests run the REAL graph runner on synthetic cli/check graphs (those
// nodes write a <nodeId>.log to the run dir). RED today: the kind is skipped,
// so getCurrentArtifact returns undefined and the run reaches Review.

import type { NodeAttempt } from "@/lib/db/schema";

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

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as fullSchema from "@/lib/db/schema";
import { getCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_output_producer")
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

type Seeded = { runId: string; slug: string; runtimeRoot: string };

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

describe("F1: runner records non-git/no-path declared output kinds", () => {
  // 1. A node declaring a lint_report produce (no path, non-git) → the runner
  // records it from the node's own output (the <nodeId>.log it writes).
  it("records a lint_report produce with no path from the node output", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "checks",
          type: "check",
          action: { command: "echo lint-ok" },
          output: { produces: [{ id: "lint-x", kind: "lint_report" }] },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve"] } },
          transitions: { approve: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const lint = await getCurrentArtifact(seeded.runId, "lint-x", db);

    expect(lint).toBeDefined();
    expect(lint?.kind).toBe("lint_report");
    expect(lint?.producer).toBe("runner");
    expect(lint?.validity).toBe("current");
  });

  // 2. §3.6 backstop: a declared NO-PATH, non-git produce that yields NOTHING
  // recordable (empty stdout, no <nodeId>.log in the test env) → node
  // Failed(PRECONDITION); the run does NOT reach Review. RED today: the
  // non-git/no-path kind is silently skipped, the node Succeeds, reaches Review.
  it("fails the node with PRECONDITION when a declared no-path output cannot be produced", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "checks",
          type: "check",
          // `true` exits 0 with empty stdout and writes no log → there is
          // nothing for the catch-all producer to record for `report-x`.
          action: { command: "true" },
          output: {
            produces: [{ id: "report-x", kind: "test_report" }],
          },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve"] } },
          transitions: { approve: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);
    const attempts = await getAttempts(seeded.runId);
    const checksAttempt = attempts.find((a) => a.nodeId === "checks");

    expect(checksAttempt?.status).toBe("Failed");
    expect(checksAttempt?.errorCode).toBe("PRECONDITION");
    expect(run.status).not.toBe("Review");
    expect(run.status).toBe("Failed");

    // The missing declared output has no current artifact.
    const report = await getCurrentArtifact(seeded.runId, "report-x", db);

    expect(report).toBeUndefined();
  });

  // 3. Regression guard: diff + path kinds still record as before.
  it("still records diff and path produces (regression guard)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          output: { produces: [{ id: "impl-diff", kind: "diff" }] },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve"] } },
          transitions: { approve: "done" },
        },
      ],
    };

    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const diff = await getCurrentArtifact(seeded.runId, "impl-diff", db);

    expect(diff).toBeDefined();
    expect(diff?.kind).toBe("diff");
    expect(diff?.producer).toBe("runner");
    expect(diff?.validity).toBe("current");
  });
});
