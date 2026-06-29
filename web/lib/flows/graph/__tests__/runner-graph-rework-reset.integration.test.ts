import type { NodeAttempt, Run, HitlRequest } from "@/lib/db/schema";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";

// ADR-118 runtime: baseline-aware exhaustion + rework `onExhaustion` routing
// (this file) and `resetTargets` re-baseline (added in Phase 5). The loop is
// driven by a human-review rework decision (deterministic, HITL artifact).

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
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
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await pool?.end();
  await container?.stop();
});

type Seeded = { runId: string; slug: string; runtimeRoot: string };

async function seedGraphRun(
  manifest: unknown,
  opts: { executionPolicy?: ExecutionPolicy } = {},
): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
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
    ...(opts.executionPolicy !== undefined
      ? { executionPolicy: opts.executionPolicy }
      : {}),
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

async function getHitl(runId: string): Promise<HitlRequest[]> {
  return (await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId))) as unknown as HitlRequest[];
}

async function writeDecision(
  seeded: Seeded,
  nodeId: string,
  decision: string,
  extra: Record<string, unknown> = {},
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
    JSON.stringify({ decision, ...extra }),
    "utf8",
  );
}

// review (human, maxLoops:1) drives a rework loop; on exhaustion it routes via
// onExhaustion -> human_final instead of the execution-policy A1 action.
function onExhaustionFlow() {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "2.1.0" },
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
        transitions: {
          approve: "done",
          rework: "work",
          exhausted: "human_final",
        },
        rework: {
          allowedTargets: ["work"],
          workspacePolicies: ["keep"],
          maxLoops: 1,
          onExhaustion: "exhausted",
        },
      },
      {
        id: "human_final",
        type: "human",
        finish: { human: { decisions: ["approve", "end"] } },
        transitions: { approve: "done", end: "done" },
      },
    ],
  };
}

// Same loop WITHOUT onExhaustion — exhaustion must take the execution-policy A1
// action (here `fail`), byte-identical to pre-ADR-118.
function noOnExhaustionFlow() {
  return {
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
          maxLoops: 1,
        },
      },
    ],
  };
}

describe("runGraph — ADR-118 onExhaustion routing", () => {
  it("AC-5: a loop exhausting with onExhaustion routes to the human node (usable HITL), not A1", async () => {
    const seeded = await seedGraphRun(onExhaustionFlow(), {
      executionPolicy: { preset: "supervised" }, // A1 default = escalate
    });

    // work -> review (NeedsInput, attempt 1).
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework 1 (within maxLoops:1): review attempt 1 -> Reworked; review attempt 2.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework 2 (overruns maxLoops:1) -> onExhaustion routes to human_final.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("human_final");

    const attempts = await getAttempts(seeded.runId);
    const reviewExhausted = attempts.find(
      (a) => a.nodeId === "review" && a.attempt === 2,
    );

    expect(reviewExhausted?.status).toBe("Succeeded");
    expect(reviewExhausted?.decision).toBe("exhausted");

    // human_final opened a usable HITL with its own non-empty decisions.
    const hitl = await getHitl(seeded.runId);
    const finalHitl = hitl.find((h) =>
      (
        (h.schema as { allowedDecisions?: string[] } | null)
          ?.allowedDecisions ?? []
      ).includes("end"),
    );

    expect(finalHitl).toBeDefined();
    expect(
      (finalHitl!.schema as { allowedDecisions: string[] }).allowedDecisions,
    ).toEqual(["approve", "end"]);
  }, 60_000);

  it("AC-6: WITHOUT onExhaustion, exhaustion takes the A1 action (fail) byte-identical", async () => {
    const seeded = await seedGraphRun(noOnExhaustionFlow(), {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "fail" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Overrunning rework -> A1 fail -> run Failed (unchanged by ADR-118).
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 60_000);
});

// implement (cli, echoes the injected human comment) -> review (human, maxLoops:1,
// onExhaustion -> human_final) -> human_final (human, optional resetTargets:[review]).
function resetLoopFlow(withReset: boolean) {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "2.1.0" },
    nodes: [
      {
        id: "implement",
        type: "cli",
        action: { command: 'echo "doing {{ human_notes }}"' },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "rework"] } },
        transitions: {
          approve: "done",
          rework: "implement",
          exhausted: "human_final",
        },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 1,
          onExhaustion: "exhausted",
        },
      },
      {
        id: "human_final",
        type: "human",
        finish: { human: { decisions: ["approve", "retry"] } },
        transitions: { approve: "done", retry: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
          commentsVar: "human_notes",
          ...(withReset ? { resetTargets: ["review"] } : {}),
        },
      },
    ],
  };
}

// Drives the loop to onExhaustion -> human_final pausing for a retry decision.
// Returns the seeded run at human_final NeedsInput (review has 2 attempts).
async function driveToHumanFinal(withReset: boolean): Promise<Seeded> {
  const seeded = await seedGraphRun(resetLoopFlow(withReset), {
    executionPolicy: { preset: "supervised" },
  });

  // implement a1 -> review a1 NeedsInput.
  await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
  // rework 1 (within maxLoops:1): implement a2 -> review a2.
  await writeDecision(seeded, "review", "rework");
  await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
  // rework 2 (exhausts) -> onExhaustion -> human_final a1 NeedsInput.
  await writeDecision(seeded, "review", "rework");
  await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

  return seeded;
}

describe("runGraph — ADR-118 resetTargets re-baseline", () => {
  it("AC-7: a human rework with resetTargets gives the loop a FRESH maxLoops budget + injects the comment", async () => {
    const seeded = await driveToHumanFinal(true);

    expect((await getRun(seeded.runId)).currentStepId).toBe("human_final");

    // Retry with a comment: resets review's counter AND reworks to implement.
    await writeDecision(seeded, "human_final", "retry", {
      comments: "try harder",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // review re-ran a 3rd time (beyond the original maxLoops+1 = 2) — a fresh
    // budget. Without the reset this rework would have re-exhausted (see AC-8).
    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    let attempts = await getAttempts(seeded.runId);
    const impl3 = attempts
      .filter((a) => a.nodeId === "implement")
      .sort((a, b) => b.attempt - a.attempt)[0];

    // AC-7: the human comment is present in the loop's next resolved input.
    expect(impl3.stdout ?? "").toContain("try harder");

    // The fresh budget allows another full rework round at review.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).not.toBe("Failed");
    attempts = await getAttempts(seeded.runId);
    expect(
      attempts.filter((a) => a.nodeId === "review").length,
    ).toBeGreaterThanOrEqual(4);
  }, 90_000);

  it("AC-8: WITHOUT resetTargets, re-entering the exhausted loop re-exhausts (maxLoops backstop → Failed)", async () => {
    const seeded = await driveToHumanFinal(false);

    // Retry reworks to implement but does NOT reset review's counter. The loop
    // stays exhausted: re-entering review (attempt 3, baseline 0 → effective
    // 2 > maxLoops 1) trips the baseline-aware loop-top backstop → CONFIG. This
    // is the contrast to AC-7: without a reset the loop cannot make progress.
    await writeDecision(seeded, "human_final", "retry", { comments: "again" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 90_000);

  it("AC-9: the reset, markNodeReworked and markDownstreamStale land together (atomic write set)", async () => {
    const seeded = await driveToHumanFinal(true);

    await writeDecision(seeded, "human_final", "retry", { comments: "fix" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getAttempts(seeded.runId);

    // The reset re-stamped review's exhausted attempt to its current count (2).
    const reviewExhausted = attempts.find(
      (a) => a.nodeId === "review" && a.attempt === 2,
    );

    expect(reviewExhausted?.reworkBaseline).toBe(2);

    // The human node's rework write landed in the same commit.
    expect(attempts.find((a) => a.nodeId === "human_final")?.status).toBe(
      "Reworked",
    );

    // The fresh re-entry carried the reset baseline forward (proves the next
    // appendNodeAttempt read the persisted baseline — crash-after-commit safe).
    const reviewReentry = attempts.find(
      (a) => a.nodeId === "review" && a.attempt === 3,
    );

    expect(reviewReentry?.reworkBaseline).toBe(2);
  }, 90_000);
});
