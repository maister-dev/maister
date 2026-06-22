// Phase 3 of cost-budget governance — the breach-enforcement watchdog
// (runBudgetPass, folded into runSweepTick). The warn → escalate → terminate
// ladder at run / task / tree scope, branching on run_kind (D7) BEFORE routing.
//
// Harness mirrors time-limit-watchdog.integration.test.ts: testcontainers
// postgres:16-alpine, drizzle migrate against ./lib/db/migrations, rows seeded
// directly. The supervisor client (deleteSession / listSessions /
// checkpointSession) and @/lib/flows/runner (runFlow) are mocked to spies so no
// real teardown / flow execution runs and the calls are observable.
//
// The watchdog reads token sums from run_cost_rollups (queryRunTokens etc.). It
// force-reconciles via reconcileRunCostRollups first, but with no cost.jsonl on
// disk that returns `missing-cost-file` BEFORE any delete — the seeded rollup
// rows survive, so seeding run_cost_rollups directly drives the meters.

import type {
  BudgetAxis,
  BudgetState,
  ExecutionPolicy,
} from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";

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

// Supervisor seam: ESCALATE halts the live session via checkpointSession;
// TERMINATE tears it down via deleteSession. listSessions is how a run is
// matched to a live supervisor session (mirrors the time-limit pass).
const deleteSessionSpy = vi.fn(async (_id: string) => undefined);
const listSessionsSpy = vi.fn(async () => [] as unknown[]);
const checkpointSessionSpy = vi.fn(async (_id: string) => ({}) as unknown);

// Partial mock: the agent / scratch terminate arms lazy-import heavy modules
// (@/lib/agents/launch, @/lib/scratch-runs/service) whose module-level
// defaultSupervisorApi objects destructure many supervisor-client exports at
// load (createSession, cancelPermission, sendPrompt, streamSession, …). Spread
// the real module so every such access resolves, and override only the three
// functions the watchdog actually calls with spies. None of the spawn/prompt
// paths run in these tests.
vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual = await importOriginal<object>();

  return {
    ...actual,
    deleteSession: (id: string) => deleteSessionSpy(id),
    listSessions: () => listSessionsSpy(),
    checkpointSession: (id: string) => checkpointSessionSpy(id),
  };
});

// A terminate kill frees a scheduler slot and promotes the next Pending run via
// a lazy import of runFlow; mock it so the dispatch is observable and no real
// flow execution runs.
const runFlowSpy = vi.fn(async (_runId: string) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (id: string) => runFlowSpy(id),
}));

// The scratch terminate arm lazy-imports @/lib/scratch-runs/service, which
// statically imports @/lib/authz → next-auth → next/server (unresolvable in the
// vitest node env). markScratchCrashed never calls these — stub them inert so
// the module loads (the standard integration-test pattern).
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "wd-user",
    email: "wd@test",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

let runSweepTick: (opts?: { db?: unknown }) => Promise<unknown>;

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let userId: string;

// Wrap a budget axis into a full execution_policy snapshot (supervised preset +
// a budget override) — the shape budgetFromSnapshot parses.
function policyWithBudget(budget: BudgetAxis): ExecutionPolicy {
  return { preset: "supervised", overrides: { budget } };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("budget_wd_test")
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
    slug: "budget-wd",
    name: "Budget Watchdog App",
    repoPath: "/repos/budget-wd",
    maisterYamlPath: "/repos/budget-wd/maister.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  ({ runSweepTick } = await import("../keepalive-sweeper"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.assignments);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.scratchRuns);
  await db.delete(schema.nodeAttemptCostRollups);
  await db.delete(schema.runCostRollups);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.flows);
  deleteSessionSpy.mockReset();
  deleteSessionSpy.mockResolvedValue(undefined);
  listSessionsSpy.mockReset();
  listSessionsSpy.mockResolvedValue([]);
  checkpointSessionSpy.mockReset();
  checkpointSessionSpy.mockResolvedValue({});
  runFlowSpy.mockClear();
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

// Seed a run row carrying an execution_policy snapshot (and optional
// budget_state). currentStepId defaults per run_kind so the watchdog's
// (runId, stepId) live-session match works uniformly: flow→node id,
// scratch→"dialog", agent→"agent".
async function seedRun(opts: {
  runKind?: "flow" | "scratch" | "agent";
  taskId?: string | null;
  rootRunId?: string | null;
  parentRunId?: string | null;
  status?: string;
  startedAt?: Date;
  flowId?: string | null;
  currentStepId?: string | null;
  acpSessionId?: string | null;
  executionPolicy?: ExecutionPolicy;
  budgetState?: BudgetState | null;
  agentId?: string | null;
}): Promise<string> {
  const runId = randomUUID();
  const kind = opts.runKind ?? "flow";
  const defaultStep =
    kind === "scratch" ? "dialog" : kind === "agent" ? "agent" : "implement";

  await db.insert(schema.runs).values({
    id: runId,
    runKind: kind,
    taskId: opts.taskId ?? null,
    projectId,
    flowId: opts.flowId ?? null,
    rootRunId: opts.rootRunId ?? null,
    parentRunId: opts.parentRunId ?? null,
    agentId: opts.agentId ?? null,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: opts.status ?? "Running",
    currentStepId:
      opts.currentStepId === undefined ? defaultStep : opts.currentStepId,
    acpSessionId: opts.acpSessionId ?? null,
    executionPolicy: opts.executionPolicy ?? { preset: "supervised" },
    budgetState: opts.budgetState ?? null,
    startedAt: opts.startedAt ?? new Date(),
  });

  return runId;
}

// Seed a run_cost_rollups row carrying the four BASE token columns — the budget
// token meter sums these. resume* columns are a subset already folded into the
// base, set low to prove they are not double-counted.
async function seedRollup(
  runId: string,
  taskId: string | null,
  totalBaseTokens: number,
): Promise<void> {
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
    taskId,
    inputTokens: totalBaseTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    resumeInputTokens: 0,
    resumeOutputTokens: 0,
    resumeCacheReadTokens: 0,
    resumeCacheCreationTokens: 0,
    sourceEventCount: 1,
  });
}

async function seedAttempt(opts: {
  runId: string;
  nodeId?: string;
  attempt: number;
  status: string;
}): Promise<void> {
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId: opts.runId,
    nodeId: opts.nodeId ?? "implement",
    nodeType: "ai_coding",
    attempt: opts.attempt,
    status: opts.status,
    startedAt: new Date(),
  });
}

async function seedScratch(
  runId: string,
  taskId: string | null,
): Promise<void> {
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    name: "scratch",
    initialPrompt: "p",
    workMode: "auto",
    reasoningEffort: "high",
    planMode: "off",
    linkedTaskId: taskId,
    baseBranch: "main",
    baseCommit: "abc123",
    targetBranch: "main",
    dialogStatus: "Running",
    createdByUserId: userId,
    updatedAt: new Date(),
  });
}

async function seedWorkspace(runId: string): Promise<void> {
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt/${runId}`,
    parentRepoPath: "/repos/budget-wd",
  });
}

// The watchdog matches a live session by the server-owned (runId, stepId).
function liveSessionRecord(
  runId: string,
  supervisorSessionId: string,
  stepId: string,
) {
  return {
    sessionId: supervisorSessionId,
    runId,
    projectSlug: "budget-wd",
    stepId,
    status: "live" as const,
    pid: 1,
    startedAt: "",
    logPath: "",
    monotonicId: 0,
    acpSessionId: undefined,
  };
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

async function getScratch(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));

  return rows[0];
}

// A queued Pending run used to assert the watchdog promotes queued work after a
// terminate frees a scheduler slot.
async function seedPendingRun(): Promise<string> {
  return seedRun({
    status: "Pending",
    currentStepId: null,
    startedAt: new Date(Date.now() - 60_000),
  });
}

describe("budget watchdog — WARN ladder (E3)", () => {
  it("warns at warnAtPct (run scope, flow): run stays Running, notified.run=warn", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, warnAtPct: 80 },
      }),
    });

    await seedRollup(runId, taskId, 850); // 85% ≥ 80% warn, < 100% escalate

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(run.budgetState?.notified?.run).toBe("warn");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("does NOT re-warn on a second tick (idempotent via notified)", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, warnAtPct: 80 },
      }),
      budgetState: { notified: { run: "warn" } },
    });

    await seedRollup(runId, taskId, 850);

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    // Still warn (not escalated/terminated); no session action taken.
    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(run.budgetState?.notified?.run).toBe("warn");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
    expect(await getHitl(runId)).toHaveLength(0);
  }, 60_000);
});

describe("budget watchdog — ESCALATE ladder (E4, D7 each arm)", () => {
  it("flow: 100% maxTokens halts session, run→NeedsInput, budget_breach HITL, run.escalated, worktree kept", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({ run: { maxTokens: 1000 } }),
      acpSessionId: "acp-esc-flow",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    await seedRollup(runId, taskId, 1000); // exactly at 100%, below hard (1250)
    await seedWorkspace(runId);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);

    await runSweepTick({ db });

    expect(checkpointSessionSpy).toHaveBeenCalledWith(sup);
    expect(deleteSessionSpy).not.toHaveBeenCalled();

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.budgetState?.notified?.run).toBe("escalate");

    const hitl = await getHitl(runId);

    expect(hitl).toHaveLength(1);
    expect(hitl[0].kind).toBe("budget_breach");
    expect(hitl[0].schema.scope).toBe("run");
    expect(hitl[0].schema.meter).toBe("tokens");
    expect(hitl[0].schema.current).toBe(1000);
    expect(hitl[0].schema.limit).toBe(1000);
    expect(hitl[0].schema.decisions).toEqual(["raise", "abandon"]);

    // run.escalated domain event emitted.
    const events = await db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.runId, runId));

    expect(events.some((e: any) => e.kind === "run.escalated")).toBe(true);

    // Worktree KEPT (no scheduled removal).
    const ws = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runId));

    expect(ws[0].scheduledRemovalAt).toBeNull();
    expect(ws[0].removedAt).toBeNull();
  }, 60_000);

  it("agent: 100% maxTokens halts session, run→NeedsInput, budget_breach HITL (no node attempt)", async () => {
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      runKind: "agent",
      executionPolicy: policyWithBudget({ run: { maxTokens: 500 } }),
      acpSessionId: "acp-esc-agent",
    });

    await seedRollup(runId, null, 500);

    listSessionsSpy.mockResolvedValue([liveSessionRecord(runId, sup, "agent")]);

    await runSweepTick({ db });

    expect(checkpointSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.budgetState?.notified?.run).toBe("escalate");

    const hitl = await getHitl(runId);

    expect(hitl).toHaveLength(1);
    expect(hitl[0].kind).toBe("budget_breach");
  }, 60_000);

  it("scratch: 100% maxTokens halts session, run→NeedsInput, dialog_status→NeedsInput, budget_breach HITL", async () => {
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      runKind: "scratch",
      executionPolicy: policyWithBudget({ run: { maxTokens: 500 } }),
      acpSessionId: "acp-esc-scratch",
    });

    await seedScratch(runId, null);
    await seedRollup(runId, null, 500);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "dialog"),
    ]);

    await runSweepTick({ db });

    expect(checkpointSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.budgetState?.notified?.run).toBe("escalate");

    const scratch = await getScratch(runId);

    expect(scratch.dialogStatus).toBe("NeedsInput");

    const hitl = await getHitl(runId);

    expect(hitl).toHaveLength(1);
    expect(hitl[0].kind).toBe("budget_breach");
  }, 60_000);

  it("ESCALATE on a retryable supervisor 5xx leaves the run Running (no pause this tick)", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({ run: { maxTokens: 1000 } }),
      acpSessionId: "acp-esc-5xx",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    await seedRollup(runId, taskId, 1000);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);
    checkpointSessionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );

    await runSweepTick({ db });

    expect(checkpointSessionSpy).toHaveBeenCalledTimes(1);

    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(await getHitl(runId)).toHaveLength(0);
  }, 60_000);

  it("HONORS budget_state.ceilingOverride — a raised run does not re-escalate (E10 read side)", async () => {
    // The raise-and-resume top-up: budget_state.ceilingOverride.run.maxTokens
    // OVERRIDES the snapshot ceiling. A run whose token sum is past the SNAPSHOT
    // escalate (1000) AND its snapshot hardMax (1250) but BELOW the RAISED
    // ceiling (100000) and its raised hardMax (125000) must NOT re-escalate or
    // terminate — effectiveLimit reads ceilingOverride on top of the snapshot.
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({ run: { maxTokens: 1000 } }),
      budgetState: { ceilingOverride: { run: { maxTokens: 100000 } } },
      acpSessionId: "acp-raised",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    // ~50000: above snapshot 1000/1250, below raised 100000/125000.
    await seedRollup(runId, taskId, 50000);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);

    await runSweepTick({ db });

    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
    expect(await getHitl(runId)).toHaveLength(0);
    // The raise top-up is preserved (not clobbered by any notified write).
    expect(run.budgetState?.ceilingOverride?.run?.maxTokens).toBe(100000);
  }, 60_000);
});

describe("budget watchdog — TERMINATE ladder (E5, D7 each arm)", () => {
  it("flow: hardMaxTokens deleteSession then run Failed (BUDGET_EXCEEDED) + node Failed", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, hardMaxTokens: 1200 },
      }),
      acpSessionId: "acp-term-flow",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    await seedRollup(runId, taskId, 1300); // ≥ hardMax 1200

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(runId);

    expect(run.status).toBe("Failed");
    expect(run.budgetState?.notified?.run).toBe("terminate");

    const attempt = await db
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.runId, runId));

    expect(attempt[0].status).toBe("Failed");
    expect(attempt[0].errorCode).toBe("BUDGET_EXCEEDED");

    const events = await db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.runId, runId));

    expect(events.some((e: any) => e.kind === "run.failed")).toBe(true);
  }, 60_000);

  it("agent: hardMaxTokens deleteSession then run Failed", async () => {
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      runKind: "agent",
      executionPolicy: policyWithBudget({
        run: { maxTokens: 500, hardMaxTokens: 600 },
      }),
      acpSessionId: "acp-term-agent",
    });

    await seedRollup(runId, null, 700);

    listSessionsSpy.mockResolvedValue([liveSessionRecord(runId, sup, "agent")]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(runId);

    // No budget_state notified stamp on the agent arm — finalizeAgentRun owns
    // the terminal flip and does not touch budget_state; the Failed status IS
    // the idempotency (Fix B).
    expect(run.status).toBe("Failed");
  }, 60_000);

  it("scratch: hardMaxTokens deleteSession then run terminal + dialog terminal", async () => {
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      runKind: "scratch",
      executionPolicy: policyWithBudget({
        run: { maxTokens: 500, hardMaxTokens: 600 },
      }),
      acpSessionId: "acp-term-scratch",
    });

    await seedScratch(runId, null);
    await seedRollup(runId, null, 700);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "dialog"),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(runId);

    // A budget-kill is a DELIBERATE terminal → runs.status=`Failed` (NON-
    // recoverable: Recover gates on runs.status='Crashed'), matching flow/agent.
    // The scratch dialog FSM has no Failed state, so scratch_runs.dialog_status
    // stays `Crashed` (the scratch-UI terminal) with error_code=BUDGET_EXCEEDED.
    // Failed is a valid RunStatus, so D2 holds. No budget_state notified stamp —
    // terminal status IS the idempotency (Fix B).
    expect(run.status).toBe("Failed");

    const scratch = await getScratch(runId);

    expect(scratch.dialogStatus).toBe("Crashed");
    expect(scratch.errorCode).toBe("BUDGET_EXCEEDED");
  }, 60_000);

  it("TERMINATE on EXECUTOR_UNAVAILABLE leaves the run Running for next tick (E5)", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, hardMaxTokens: 1200 },
      }),
      acpSessionId: "acp-term-5xx",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    await seedRollup(runId, taskId, 1300);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);
    deleteSessionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);

    const run = await getRun(runId);

    expect(run.status).toBe("Running");

    const attempt = await db
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.runId, runId));

    expect(attempt[0].status).toBe("Running");
  }, 60_000);

  it("promotes a queued Pending run after a terminate frees the slot", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    const runId = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, hardMaxTokens: 1200 },
      }),
      acpSessionId: "acp-term-promote",
    });

    await seedAttempt({ runId, attempt: 1, status: "Running" });
    await seedRollup(runId, taskId, 1300);
    const pendingRunId = await seedPendingRun();

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, sup, "implement"),
    ]);

    await runSweepTick({ db });

    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getRun(pendingRunId)).status).toBe("Running");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runFlowSpy).toHaveBeenCalledWith(pendingRunId);
  }, 60_000);
});

describe("budget watchdog — TREE scope (E6)", () => {
  it("tree breach cascade-terminates the whole tree (no escalate rung at tree scope)", async () => {
    // 3 children sharing root_run_id; tree.maxTokens summed across them trips
    // TERMINATE directly (tree has no escalate rung). The root carries the tree
    // budget; children are non-root members (evaluate run/task only).
    const rootId = randomUUID();

    await db.insert(schema.runs).values({
      id: rootId,
      runKind: "flow",
      projectId,
      rootRunId: rootId,
      status: "WaitingOnChildren",
      currentStepId: null,
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      flowVersion: "v1.0.0",
      executionPolicy: policyWithBudget({ tree: { maxTokens: 1000 } }),
      startedAt: new Date(Date.now() - 60_000),
    });
    const childA = await seedRun({
      rootRunId: rootId,
      parentRunId: rootId,
      status: "Running",
      acpSessionId: "acp-child-a",
    });
    const childB = await seedRun({
      rootRunId: rootId,
      parentRunId: rootId,
      status: "Running",
      acpSessionId: "acp-child-b",
    });

    await seedRollup(rootId, null, 400);
    await seedRollup(childA, null, 400);
    await seedRollup(childB, null, 400); // tree sum 1200 ≥ 1000

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    // The whole tree is cascade-abandoned; the root is flipped Failed.
    expect((await getRun(childA)).status).toBe("Abandoned");
    expect((await getRun(childB)).status).toBe("Abandoned");

    const root = await getRun(rootId);

    expect(root.status).toBe("Failed");
    // No HITL anywhere (tree never escalates).
    expect(await getHitl(rootId)).toHaveLength(0);
    expect(await getHitl(childA)).toHaveLength(0);
  }, 60_000);
});

describe("budget watchdog — TASK scope (E7)", () => {
  it("task.maxTokens summed across sequential runs trips escalate on the latest run", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    // A prior terminal run of the task contributes tokens to the task sum.
    const priorRun = await seedRun({
      taskId,
      status: "Failed",
      currentStepId: null,
      startedAt: new Date(Date.now() - 120_000),
    });
    const liveRun = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({ task: { maxTokens: 1000 } }),
      acpSessionId: "acp-task",
      startedAt: new Date(Date.now() - 60_000),
    });

    await seedAttempt({ runId: liveRun, attempt: 1, status: "Running" });
    await seedRollup(priorRun, taskId, 600);
    await seedRollup(liveRun, taskId, 500); // task sum 1100 ≥ 1000

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(liveRun, sup, "implement"),
    ]);

    await runSweepTick({ db });

    expect(checkpointSessionSpy).toHaveBeenCalledWith(sup);

    const run = await getRun(liveRun);

    expect(run.status).toBe("NeedsInput");
    expect(run.budgetState?.notified?.task).toBe("escalate");

    const hitl = await getHitl(liveRun);

    expect(hitl[0].schema.scope).toBe("task");
  }, 60_000);

  it("task.consecutiveFailures trips escalate", async () => {
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;

    // Two trailing failed runs satisfy a consecutiveFailures:2 ceiling. They
    // must be OLDER than the live run so the trailing streak (newest→oldest)
    // counts them; the live Running run does not break the streak only if it is
    // the most recent — but a Running run is not a failure, so it WOULD break
    // the streak. The meter counts failures BEFORE the current run; seed the
    // live run as the newest and the failures just under it. Since the live run
    // is Running (not a failure), the streak from newest is 0. So instead the
    // ceiling must be measured over the failed runs alone: set the live run's
    // started_at OLDER so the two failures are newest.
    await seedRun({
      taskId,
      status: "Failed",
      currentStepId: null,
      startedAt: new Date(Date.now() - 1000),
    });
    await seedRun({
      taskId,
      status: "Crashed",
      currentStepId: null,
      startedAt: new Date(Date.now() - 500),
    });
    const liveRun = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({
        task: { consecutiveFailures: 2 },
      }),
      acpSessionId: "acp-task-fail",
      startedAt: new Date(Date.now() - 120_000),
    });

    await seedAttempt({ runId: liveRun, attempt: 1, status: "Running" });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(liveRun, sup, "implement"),
    ]);

    await runSweepTick({ db });

    const run = await getRun(liveRun);

    expect(run.status).toBe("NeedsInput");
    expect(run.budgetState?.notified?.task).toBe("escalate");

    const hitl = await getHitl(liveRun);

    expect(hitl[0].schema.scope).toBe("task");
    expect(hitl[0].schema.meter).toBe("failures");
  }, 60_000);

  it("a parked WaitingOnChildren non-root run is NOT touched even when its task is over hardMax; enforcement relocates to the Running sibling", async () => {
    // Regression for the WaitingOnChildren dead-end: a parked orchestrator
    // (non-root member of a tree) carrying a task budget must NOT be terminated
    // or escalated by run/task scope (its run/task CAS guards on Running → 0
    // rows → silent dead-end). Run+task scope is evaluated for Running
    // candidates only (Fix A); task enforcement fires on the spending Running
    // sibling instead.
    const taskId = await seedTask();
    const rootId = randomUUID();
    const taskBudget = policyWithBudget({
      task: { maxTokens: 1000, hardMaxTokens: 1100 },
    });

    // A real tree root so the parked/sibling root_run_id FKs resolve. The root
    // carries NO budget, so it never trips anything itself.
    await db.insert(schema.runs).values({
      id: rootId,
      runKind: "flow",
      projectId,
      rootRunId: rootId,
      status: "Done",
      currentStepId: null,
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      flowVersion: "v1.0.0",
      startedAt: new Date(Date.now() - 120_000),
    });

    const parkedSup = `sup-parked-${randomUUID().slice(0, 8)}`;
    const parkedRun = await seedRun({
      taskId,
      rootRunId: rootId, // non-root member (rootRunId !== own id)
      parentRunId: rootId,
      status: "WaitingOnChildren",
      currentStepId: null,
      executionPolicy: taskBudget,
      acpSessionId: "acp-parked",
      startedAt: new Date(Date.now() - 90_000),
    });

    const siblingSup = `sup-sibling-${randomUUID().slice(0, 8)}`;
    const siblingRun = await seedRun({
      taskId,
      rootRunId: rootId,
      parentRunId: rootId,
      status: "Running",
      executionPolicy: taskBudget,
      acpSessionId: "acp-sibling",
      startedAt: new Date(Date.now() - 60_000),
    });

    await seedAttempt({ runId: siblingRun, attempt: 1, status: "Running" });
    await seedRollup(parkedRun, taskId, 600);
    await seedRollup(siblingRun, taskId, 600); // task sum 1200 ≥ hardMax 1100

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(parkedRun, parkedSup, "agent"),
      liveSessionRecord(siblingRun, siblingSup, "implement"),
    ]);

    await runSweepTick({ db });

    // The parked run is untouched — no kill, no pause, no HITL, no notified.
    const parked = await getRun(parkedRun);

    expect(parked.status).toBe("WaitingOnChildren");
    expect(parked.budgetState).toBeNull();
    expect(deleteSessionSpy).not.toHaveBeenCalledWith(parkedSup);
    expect(checkpointSessionSpy).not.toHaveBeenCalledWith(parkedSup);
    expect(await getHitl(parkedRun)).toHaveLength(0);

    // Enforcement relocated to the spending Running sibling — it is terminated.
    expect(deleteSessionSpy).toHaveBeenCalledWith(siblingSup);
    expect((await getRun(siblingRun)).status).toBe("Failed");
  }, 60_000);
});

describe("budget watchdog — fail-open / no-refusal (E1, E2)", () => {
  it("a run with NO budget set is never touched", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({ taskId }); // default supervised, budget {}

    await seedRollup(runId, taskId, 9_999_999);

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(run.budgetState).toBeNull();
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("maxTokens:0 ≡ unlimited (never kills)", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({
      taskId,
      // 0 is fail-open unlimited; the strict schema actually rejects 0 (positive
      // int), so this lands as a malformed budget → {} → unlimited. Either way:
      // never killed.
      executionPolicy: {
        preset: "supervised",
        overrides: { budget: { run: { maxTokens: 0 } } },
      } as ExecutionPolicy,
    });

    await seedRollup(runId, taskId, 9_999_999);

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    expect((await getRun(runId)).status).toBe("Running");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("a malformed execution_policy snapshot fails OPEN (never killed/paused)", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({
      taskId,
      executionPolicy: { garbage: true } as unknown as ExecutionPolicy,
    });

    await seedRollup(runId, taskId, 9_999_999);

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    expect((await getRun(runId)).status).toBe("Running");
    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect(checkpointSessionSpy).not.toHaveBeenCalled();
  }, 60_000);
});

describe("budget watchdog — status invariant (E9 / D2)", () => {
  it("never produces a status outside the RunStatus enum", async () => {
    const VALID: ReadonlySet<string> = new Set([
      "Pending",
      "Running",
      "NeedsInput",
      "NeedsInputIdle",
      "HumanWorking",
      "WaitingOnChildren",
      "Review",
      "Crashed",
      "Done",
      "Abandoned",
      "Failed",
    ]);
    const taskId = await seedTask();
    const sup = `sup-${randomUUID().slice(0, 8)}`;
    // Drive an escalate (NeedsInput) and a terminate (Failed) in one tick.
    const escRun = await seedRun({
      taskId,
      executionPolicy: policyWithBudget({ run: { maxTokens: 1000 } }),
      acpSessionId: "acp-inv-esc",
    });

    await seedAttempt({ runId: escRun, attempt: 1, status: "Running" });
    await seedRollup(escRun, taskId, 1000);

    const otherTaskId = await seedTask();
    const termRun = await seedRun({
      taskId: otherTaskId,
      executionPolicy: policyWithBudget({
        run: { maxTokens: 1000, hardMaxTokens: 1100 },
      }),
      acpSessionId: "acp-inv-term",
    });

    await seedAttempt({ runId: termRun, attempt: 1, status: "Running" });
    await seedRollup(termRun, otherTaskId, 1200);

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(escRun, `${sup}-e`, "implement"),
      liveSessionRecord(termRun, `${sup}-t`, "implement"),
    ]);

    await runSweepTick({ db });

    const all = await db.select().from(schema.runs);

    for (const r of all) {
      expect(VALID.has(r.status)).toBe(true);
    }
    expect((await getRun(escRun)).status).toBe("NeedsInput");
    expect((await getRun(termRun)).status).toBe("Failed");
  }, 60_000);
});
