// Phase 3 (ADR-108 / M40) — escalateHookTrip, the web-side halt escalation for
// a guardrail trip. Mirrors the budget-watchdog harness: testcontainers
// postgres:16-alpine, drizzle migrate against ./lib/db/migrations, rows seeded
// directly. checkpointSession is INJECTED into escalateHookTrip (not imported),
// so no supervisor-client mock is needed for it; a spy is passed per call.

import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// createHitlAssignmentForRun (via escalateHookTrip) lazily reaches actor helpers;
// stub authz inert so the module tree loads in the vitest node env (the standard
// integration-test pattern — these helpers are never exercised here).
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "ht-user",
    email: "ht@test",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { escalateHookTrip } from "@/lib/runs/hook-trip";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let userId: string;

beforeAll(async () => {
  process.env.MAISTER_RUNTIME_ROOT = path.join(
    tmpdir(),
    `hook-trip-${randomUUID().slice(0, 8)}`,
  );

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("hook_trip_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();
  userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@test.local`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: "hook-trip",
    name: "Hook Trip App",
    repoPath: "/repos/hook-trip",
    maisterYamlPath: "/repos/hook-trip/maister.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.assignments);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
});

async function seedTask(): Promise<string> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    projectId,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });

  return taskId;
}

async function seedRun(opts: {
  runKind?: "flow" | "agent";
  taskId?: string | null;
  status?: string;
  currentStepId?: string | null;
  executionPolicy?: ExecutionPolicy;
}): Promise<string> {
  const runId = randomUUID();
  const kind = opts.runKind ?? "flow";
  const defaultStep = kind === "agent" ? "agent" : "implement";

  await db.insert(schema.runs).values({
    id: runId,
    runKind: kind,
    taskId: opts.taskId ?? null,
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: opts.status ?? "Running",
    currentStepId:
      opts.currentStepId === undefined ? defaultStep : opts.currentStepId,
    executionPolicy: opts.executionPolicy ?? { preset: "supervised" },
    startedAt: new Date(),
  });

  return runId;
}

async function seedAttempt(runId: string, nodeId: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id,
    runId,
    nodeId,
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    startedAt: new Date(),
  });

  return id;
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

async function getHitl(runId: string): Promise<any[]> {
  return db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId));
}

async function getAssignments(runId: string): Promise<any[]> {
  return db
    .select()
    .from(schema.assignments)
    .where(eq(schema.assignments.runId, runId));
}

async function getAttempt(attemptId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.id, attemptId));

  return rows[0];
}

async function getDomainEvents(runId: string): Promise<any[]> {
  return db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId));
}

describe("escalateHookTrip", () => {
  it("flow halt: checkpoint → NeedsInput, hook_trip HITL + assignment, node attempt NeedsInput, run.escalated", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({
      runKind: "flow",
      taskId,
      currentStepId: "implement",
    });
    const attemptId = await seedAttempt(runId, "implement");
    const checkpointSession = vi.fn(async (_id: string) => ({}));

    const result = await escalateHookTrip({
      db,
      runId,
      stepId: "implement",
      supervisorSessionId: "sup-1",
      rule: "repetition",
      toolCall: { title: "Edit src/x.ts", kind: "edit" },
      runKind: "flow",
      checkpointSession,
    });

    expect(result.escalated).toBe(true);
    expect(checkpointSession).toHaveBeenCalledWith("sup-1");

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("implement");

    const hitls = await getHitl(runId);

    expect(hitls).toHaveLength(1);
    expect(hitls[0].kind).toBe("hook_trip");
    expect(hitls[0].stepId).toBe("implement");
    expect((hitls[0].schema as { rule?: string }).rule).toBe("repetition");
    expect((hitls[0].schema as { decisions?: string[] }).decisions).toEqual([
      "resume",
      "abort",
    ]);
    expect(hitls[0].respondedAt).toBeNull();

    const assignmentRows = await getAssignments(runId);

    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0].actionKind).toBe("hook_trip");

    const attempt = await getAttempt(attemptId);

    expect(attempt.status).toBe("NeedsInput");

    const events = await getDomainEvents(runId);
    const escalated = events.filter((e) => e.kind === "run.escalated");

    expect(escalated).toHaveLength(1);
    expect((escalated[0].payload as { reason?: string }).reason).toBe(
      "hook_trip",
    );
    expect((escalated[0].payload as { rule?: string }).rule).toBe("repetition");
  });

  it("notify_only: HITL created but NO assignment (emit-and-don't-route)", async () => {
    const runId = await seedRun({
      runKind: "flow",
      currentStepId: "implement",
      executionPolicy: {
        preset: "supervised",
        overrides: { onStuck: "notify_only" },
      },
    });

    await seedAttempt(runId, "implement");
    const checkpointSession = vi.fn(async (_id: string) => ({}));

    const result = await escalateHookTrip({
      db,
      runId,
      stepId: "implement",
      supervisorSessionId: "sup-2",
      rule: "no_progress",
      runKind: "flow",
      checkpointSession,
    });

    expect(result.escalated).toBe(true);
    expect(await getHitl(runId)).toHaveLength(1);
    expect(await getAssignments(runId)).toHaveLength(0);
  });

  it("CAS rejects a non-Running run: no escalate, no HITL", async () => {
    const runId = await seedRun({
      runKind: "flow",
      status: "Review",
      currentStepId: "implement",
    });
    const checkpointSession = vi.fn(async (_id: string) => ({}));

    const result = await escalateHookTrip({
      db,
      runId,
      stepId: "implement",
      supervisorSessionId: "sup-3",
      rule: "repetition",
      runKind: "flow",
      checkpointSession,
    });

    expect(result.escalated).toBe(false);
    expect(await getHitl(runId)).toHaveLength(0);
    const run = await getRun(runId);

    expect(run.status).toBe("Review");
  });

  it("agent halt: NeedsInput + hook_trip HITL, no node_attempts touched", async () => {
    const runId = await seedRun({ runKind: "agent", currentStepId: "agent" });
    const checkpointSession = vi.fn(async (_id: string) => ({}));

    const result = await escalateHookTrip({
      db,
      runId,
      stepId: "agent",
      supervisorSessionId: "sup-4",
      rule: "no_progress",
      runKind: "agent",
      checkpointSession,
    });

    expect(result.escalated).toBe(true);
    expect(checkpointSession).toHaveBeenCalledWith("sup-4");
    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    const hitls = await getHitl(runId);

    expect(hitls).toHaveLength(1);
    expect(hitls[0].kind).toBe("hook_trip");
    expect(hitls[0].stepId).toBe("agent");
  });

  it("EXECUTOR_UNAVAILABLE checkpoint: THROWS (live halt undeliverable) — no mutation, run stays Running, no HITL", async () => {
    const runId = await seedRun({
      runKind: "flow",
      currentStepId: "implement",
    });

    await seedAttempt(runId, "implement");
    const checkpointSession = vi.fn(async (_id: string) => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503");
    });

    // The supervisor halts once and never re-emits; a swallowed bail would let
    // the run advance as if the guardrail never fired. escalateHookTrip must
    // re-throw so the consumer surfaces a recoverable CRASH.
    await expect(
      escalateHookTrip({
        db,
        runId,
        stepId: "implement",
        supervisorSessionId: "sup-5",
        rule: "repetition",
        runKind: "flow",
        checkpointSession,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    // No split-brain: the bail mutates nothing — the consumer owns the CRASH flip.
    expect(await getHitl(runId)).toHaveLength(0);
    const run = await getRun(runId);

    expect(run.status).toBe("Running");
  });
});
