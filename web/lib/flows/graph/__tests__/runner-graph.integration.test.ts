import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { FlowYamlV1 } from "@/lib/config.schema";

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
import { runFlow } from "@/lib/flows/runner";
import { runReviewHuman } from "@/lib/flows/graph/runner-graph";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { compileManifest } from "@/lib/flows/graph/compile";

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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
    ...(opts.executionPolicy !== undefined
      ? { executionPolicy: opts.executionPolicy }
      : {}),
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

// maxLoops: 1 → initial + 1 rework allowed; 2nd rework must exhaust the limit.
const tightLoopFlow = {
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

  // A.2 (axis A1): rework on-exhaustion. tightLoopFlow has maxLoops: 1 — one
  // rework is allowed; the second rework decision overruns the bound. The
  // run's execution-policy reworkExhaustion action decides what happens then.
  it("rework exhausted with reworkExhaustion=fail → run Failed (A.2)", async () => {
    // Explicit `fail` — the pre-A.2 outcome, now policy-driven at the rework
    // decision site rather than the loop-top backstop.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "fail" },
      },
    });

    // Pass 1: work → review (NeedsInput, attempt 1).
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework 1 (allowed — within maxLoops: 1): review attempt 1 → Reworked,
    // work reruns, review attempt 2 → NeedsInput.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    const afterFirstRework = await getAttempts(seeded.runId);

    expect(afterFirstRework.filter((a) => a.nodeId === "review")).toHaveLength(
      2,
    );
    expect(
      afterFirstRework.find((a) => a.nodeId === "review" && a.attempt === 1)
        ?.status,
    ).toBe("Reworked");

    // Rework 2 (overruns maxLoops: 1) → fail action → run Failed.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 60_000);

  it("rework exhausted with reworkExhaustion=escalate (default) → NeedsInput, no further loop (A.2)", async () => {
    // Default supervised policy → escalate: the overrunning rework re-pauses
    // the review for a human terminal decision instead of failing or looping.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: { preset: "supervised" },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Second (overrunning) rework → escalate → NeedsInput, NOT Failed.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    // No jump-back happened: review stays at 2 attempts and work did not re-run
    // a third time — the loop is held, not advanced.
    const attempts = await getAttempts(seeded.runId);

    expect(attempts.filter((a) => a.nodeId === "review")).toHaveLength(2);
    expect(attempts.filter((a) => a.nodeId === "work")).toHaveLength(2);

    // A fresh escalation HITL request exists so a human is asked to resolve.
    const hitl = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(hitl.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("rework exhausted with reworkExhaustion=ship_with_warning → ships forward to Review (A.2)", async () => {
    // ship_with_warning takes the node's forward (approve) transition past the
    // exhausted loop and records the warning on the attempt.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "ship_with_warning" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Second (overrunning) rework → ship_with_warning → forward to Review.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const review2 = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review" && a.attempt === 2,
    );

    expect(review2?.status).toBe("Succeeded");
    expect(review2?.decision).toBe("approve");
    expect(
      (review2?.vars as Record<string, unknown>)?.execPolicyWarning,
    ).toBeDefined();
  }, 60_000);

  it("injects the reviewer's comments into the rework target's context (commentsVar)", async () => {
    // `fix` is reached ONLY via rework, so its {{ review_comments }} template
    // is rendered exclusively with the injected value present.
    const commentsFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "plan",
          type: "cli",
          action: { command: "echo plan" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              decisions: ["approve", "rework"],
              commentsVar: "review_comments",
            },
          },
          transitions: { approve: "done", rework: "fix" },
          rework: {
            allowedTargets: ["fix"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "review_comments",
          },
        },
        {
          id: "fix",
          type: "cli",
          action: { command: 'echo "rc:{{ review_comments }}"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(commentsFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    await writeDecision(seeded, "review", "rework", {
      comments: "tighten-errors",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.status).toBe("Succeeded");
    expect(fix?.stdout ?? "").toContain("rc:tighten-errors");
  }, 60_000);
});

// B2/B3: human-gate auto-pass + on-stuck routing. reviewFlow has a forward
// "approve" decision (safe default); noForwardFlow has only a rework decision,
// so auto-pass can never fire → the can't-auto-pass routing (onStuck) is
// exercised without an expensive evidence-not-ready fixture.
const noForwardFlow = {
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
      finish: { human: { decisions: ["redo"] } },
      transitions: { redo: "work", approve: "done" },
      rework: {
        allowedTargets: ["work"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    },
  ],
};

async function hitlCount(runId: string): Promise<number> {
  return (
    await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId))
  ).length;
}

async function assignmentCount(runId: string): Promise<number> {
  return (
    await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.runId, runId))
  ).length;
}

async function escalatedEventCount(runId: string): Promise<number> {
  const rows = (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId))) as Array<{ kind: string }>;

  return rows.filter((e) => e.kind === "run.escalated").length;
}

describe("runGraph — B2/B3 human-gate auto-pass + on-stuck routing", () => {
  it("auto-passes a human gate with the forward decision when machine review is ready", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // No blocking gates / required artifacts → evidence ready → auto-pass
    // resolves "approve" and the run reaches Review with NO HITL.
    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(await hitlCount(seeded.runId)).toBe(0);

    const review = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review",
    );

    expect(review?.status).toBe("Succeeded");
    expect(review?.decision).toBe("approve");
  }, 60_000);

  it("supervised (humanGate=stop) still pauses for a human (regression)", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: { preset: "supervised" },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await escalatedEventCount(seeded.runId)).toBe(0);
  }, 60_000);

  it("auto_pass with no safe default → escalate: NeedsInput + assignment + run.escalated", async () => {
    const seeded = await seedGraphRun(noForwardFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBeGreaterThanOrEqual(1);
    expect(await escalatedEventCount(seeded.runId)).toBe(1);
  }, 60_000);

  it("auto_pass + onStuck=notify_only → NeedsInput WITHOUT an assignment + run.escalated", async () => {
    const seeded = await seedGraphRun(noForwardFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass", onStuck: "notify_only" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    // The HITL request still exists (a response CAN resolve it) but no human
    // is assigned — notify-and-don't-block.
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBe(0);
    expect(await escalatedEventCount(seeded.runId)).toBe(1);
  }, 60_000);

  // F1 regression: the A.2 rework-exhaustion escalate path calls runReviewHuman
  // with forcePause=true and then flips the run to NeedsInput. Under an
  // unattended policy (humanGate=auto_pass) a plain call would auto-pass / ship
  // and create NO HITL row — orphaning the NeedsInput run (invisible to the
  // inbox, unresolvable). forcePause MUST skip the auto-pass/on-stuck
  // short-circuit and always create the HITL + assignment.
  it("forcePause forces a real HITL pause under humanGate=auto_pass (escalate never orphans)", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });
    const loaded = await loadRun(db, seeded.runId);
    const node = compileManifest(reviewFlow as unknown as FlowYamlV1).nodes.get(
      "review",
    );

    expect(node).toBeDefined();

    // Control: WITHOUT forcePause, auto_pass + ready evidence (no attempts → no
    // blocking gates) + safe default "approve" → auto-passes, creating NO HITL.
    const autoPassed = await runReviewHuman(node!, loaded, "review", {
      runtimeRoot: seeded.runtimeRoot,
      db,
      gateAttempt: 1,
    });

    expect(autoPassed.needsInput).toBe(false);
    expect(autoPassed.decision).toBe("approve");
    expect(await hitlCount(seeded.runId)).toBe(0);

    // Fix: WITH forcePause, the same call creates a real HITL request +
    // assignment, so the caller's NeedsInput flip can never orphan the run.
    const paused = await runReviewHuman(node!, loaded, "rework limit reached", {
      runtimeRoot: seeded.runtimeRoot,
      db,
      gateAttempt: 2,
      forcePause: true,
    });

    expect(paused.needsInput).toBe(true);
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
