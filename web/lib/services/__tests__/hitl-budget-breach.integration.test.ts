import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { respondToHitl, HitlActor } from "@/lib/services/hitl";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/supervisor-client", () => ({
  checkpointSession: vi.fn(async (sessionId: string) => ({
    alreadyCheckpointed: false,
    sessionId,
    monotonicId: 1,
  })),
  deliverPermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));
vi.mock("@/lib/agents/launch", () => ({
  startAgentSession: vi.fn(async () => {}),
  launchAgentRun: vi.fn(async () => ({
    runId: "agent-restart-new",
    status: "Pending",
    queuePosition: 1,
  })),
}));
vi.mock("@/lib/services/runs", () => ({
  launchRun: vi.fn(async () => ({
    runId: "flow-restart-new",
    status: "Pending",
    queuePosition: 7,
  })),
}));
vi.mock("@/lib/runs/resume", () => ({
  resumeRun: vi.fn(async () => ({
    ok: true,
    newSupervisorSessionId: "sup-resume",
    acpSessionId: "acp-resume",
  })),
}));
vi.mock("@/lib/runs/resume-driver", () => ({
  scheduleResumedSessionDrive: vi.fn(() => {}),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));
vi.mock("@/lib/workbench-lifecycle/service", () => ({
  archiveWorkbench: vi.fn(async (runId: string) => ({
    ok: true,
    runId,
    runStatus: "Abandoned",
    archivedBranch: "maister/archive",
  })),
  createWorkbenchHandoffBranch: vi.fn(async () => ({
    pushedRef: "origin/maister/parked",
  })),
  dropWorkbench: vi.fn(async (runId: string) => ({
    ok: true,
    runId,
    runStatus: "Abandoned",
    workspaceRemoved: true,
    archivedBranch: null,
  })),
  getWorkbenchHandoffMetadata: vi.fn(async () => ({
    defaultRemote: "origin",
  })),
  isCleanWorkbenchPrecondition: (err: unknown) =>
    err instanceof Error && err.message.includes("worktree is clean"),
  snapshotWorkbenchCommit: vi.fn(async () => ({
    commit: "deadbeef",
  })),
  stopThenArchive: vi.fn(async (runId: string) => ({
    ok: true,
    runId,
    runStatus: "Abandoned",
    archivedBranch: "maister/archive",
  })),
  stopWorkbenchRun: vi.fn(async (runId: string) => ({
    ok: true,
    runId,
    runStatus: "Abandoned",
  })),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("hitl_budget_test")
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

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-budget-int-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
});

async function seedProject(slug: string) {
  const projectId = randomUUID();

  await (db as any).insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function seedRunner() {
  const executorId = randomUUID();

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return executorId;
}

async function seedRun(
  projectId: string,
  budgetState?: unknown,
  opts: {
    runKind?: "flow" | "agent";
    status?: string;
    acpSessionId?: string | null;
    taskId?: string | null;
    flowId?: string | null;
    agentId?: string | null;
    agentWorkspace?: "none" | "repo_read" | "worktree" | null;
  } = {},
) {
  const runId = randomUUID();
  const executorId = await seedRunner();

  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: opts.runKind ?? "flow",
    taskId: opts.taskId ?? null,
    flowId: opts.flowId ?? null,
    agentId: opts.agentId ?? null,
    agentWorkspace: opts.agentWorkspace ?? null,
    status: opts.status ?? "NeedsInput",
    currentStepId: "plan",
    flowVersion: "v1.0.0",
    budgetState: budgetState ?? null,
  });
  await (db as any).insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "main",
    runnerId: executorId,
    runnerResolutionTier: "platformDefault",
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    acpSessionId: opts.acpSessionId ?? null,
  });

  return runId;
}

async function seedFlow(projectId: string) {
  const flowId = randomUUID();

  await (db as any).insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: `budget-flow-${flowId.slice(0, 8)}`,
    source: "test",
    version: "v1.0.0",
    revision: "test",
    installedPath: runtimeRoot,
    manifest: {
      schemaVersion: 1,
      name: "Budget Flow",
      nodes: [],
    },
    schemaVersion: 1,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });

  return flowId;
}

async function seedTask(projectId: string, flowId: string) {
  const taskId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "Budget task",
    prompt: "Do the budget task",
    flowId,
    status: "InFlight",
  });

  return taskId;
}

async function seedWorkspace(
  projectId: string,
  runId: string,
  opts: { removedAt?: Date | null } = {},
) {
  await (db as any).insert(schema.workspaces).values({
    id: randomUUID(),
    projectId,
    runId,
    branch: `maister/${runId}`,
    worktreePath: join(runtimeRoot, `worktree-${runId}`),
    parentRepoPath: join(runtimeRoot, `repo-${runId}`),
    removedAt: opts.removedAt ?? null,
    baseBranch: "main",
    targetBranch: "maister/budget-target",
  });
}

async function seedTaskBoundFlowRun(
  slug: string,
  opts: { acpSessionId?: string | null } = {},
) {
  const projectId = await seedProject(slug);
  const flowId = await seedFlow(projectId);
  const taskId = await seedTask(projectId, flowId);
  const runId = await seedRun(projectId, null, {
    taskId,
    flowId,
    acpSessionId: opts.acpSessionId,
  });

  await seedWorkspace(projectId, runId);

  return { projectId, flowId, taskId, runId };
}

type BudgetBreachSchema = {
  kind: "budget_breach";
  scope: "run" | "task" | "tree";
  meter: "tokens" | "failures" | "wallclock";
  current: number;
  limit: number;
  decisions: ["raise", "abandon"];
};

async function seedBudgetBreachHitl(
  runId: string,
  overrides: Partial<BudgetBreachSchema> = {},
  stepId: string = "plan",
) {
  const hitlRequestId = randomUUID();
  const breachSchema: BudgetBreachSchema = {
    kind: "budget_breach",
    scope: "run",
    meter: "tokens",
    current: 1200,
    limit: 1000,
    decisions: ["raise", "abandon"],
    ...overrides,
  };

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId,
    kind: "budget_breach",
    prompt: "Budget breach",
    schema: breachSchema,
    response: null,
    respondedAt: null,
  });

  return hitlRequestId;
}

// Seed an open assignment so the close-on-terminal path has a row to cancel.
async function seedOpenAssignment(
  projectId: string,
  runId: string,
  hitlRequestId: string,
) {
  const assignmentId = randomUUID();

  await (db as any).insert(schema.assignments).values({
    id: assignmentId,
    projectId,
    runId,
    hitlRequestId,
    actionKind: "budget_breach",
    status: "open",
    title: "Budget breach",
  });

  return assignmentId;
}

const userActor: HitlActor = {
  kind: "user",
  userId: "u-1",
  label: "Test User",
};

describe("respondToHitl budget_breach integration — abandon", () => {
  it("abandon → run Failed (BUDGET_EXCEEDED), assignment cancelled, run.failed emitted", async () => {
    const projectId = await seedProject("budget-abandon");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const assignmentId = await seedOpenAssignment(
      projectId,
      runId,
      hitlRequestId,
    );

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "abandon" } },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(payload).toEqual({ ok: true, runStatus: "Failed" });

    const runRow = (
      await (db as any)
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
    )[0];

    expect(runRow.status).toBe("Failed");
    expect(runRow.endedAt).toBeInstanceOf(Date);

    const hitlRow = (
      await (db as any)
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId))
    )[0];

    expect(hitlRow.respondedAt).toBeInstanceOf(Date);

    const assignmentRow = (
      await (db as any)
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, assignmentId))
    )[0];

    expect(assignmentRow.status).toBe("cancelled");

    const events = await (db as any)
      .select()
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.runId, runId),
          eq(schema.domainEvents.kind, "run.failed"),
        ),
      );

    expect(events.length).toBe(1);
    expect((events[0].payload as any)?.reason).toBe("budget_abandoned");
  });

  it("abandon with dropWorkspace true terminalizes and delegates immediate workspace drop", async () => {
    const { projectId, runId } = await seedTaskBoundFlowRun("budget-drop");
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { dropWorkbench } = await import("@/lib/workbench-lifecycle/service");
    const dropWorkbenchSpy = vi.mocked(dropWorkbench);

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "abandon", response: { dropWorkspace: true } },
      },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    expect(dropWorkbenchSpy).toHaveBeenCalledWith(runId);

    const [runRow] = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(runRow.projectId).toBe(projectId);
    expect(runRow.status).toBe("Failed");
    expect(hitlRow.response).toEqual({
      optionId: "abandon",
      dropWorkspace: true,
    });
  });
});

describe("respondToHitl budget_breach integration — restart and park composites", () => {
  it("restart terminalizes the old run, launches through launchRun, and records lineage", async () => {
    const { flowId, runId, taskId } =
      await seedTaskBoundFlowRun("budget-restart");
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { launchRun } = await import("@/lib/services/runs");
    const launchRunSpy = vi.mocked(launchRun);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "restart" } },
      userActor,
      { db },
    );
    const payload = await res.json();

    expect(res.status).toBe(202);
    expect(payload).toMatchObject({
      ok: true,
      runStatus: "Failed",
      newRunId: "flow-restart-new",
      newRunStatus: "Pending",
      queuePosition: 7,
    });
    expect(launchRunSpy).toHaveBeenCalledWith(
      {
        taskId,
        flowId,
        runnerId: expect.any(String),
        baseBranch: "main",
        targetBranch: "maister/budget-target",
        triggerSource: "manual",
        triggerPayload: {
          kind: "budget_restart",
          oldRunId: runId,
          hitlRequestId,
        },
        allowConcurrent: false,
      },
      expect.anything(),
      db,
    );

    const [runRow] = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const comments = await (db as any)
      .select()
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, taskId));

    expect(runRow.status).toBe("Failed");
    expect(hitlRow.response).toMatchObject({
      optionId: "restart",
      stage: "terminalized",
      ref: "flow-restart-new",
    });
    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
    expect(comments[0]?.body).toContain("flow-restart-new");
  });

  it("restart checkpoints a live paused session before terminalizing the old run", async () => {
    const { runId } = await seedTaskBoundFlowRun("budget-restart-checkpoint", {
      acpSessionId: "sup-budget-live",
    });
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { checkpointSession } = await import("@/lib/supervisor-client");
    const checkpointSpy = vi.mocked(checkpointSession);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "restart" } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);
    expect(checkpointSpy).toHaveBeenCalledWith("sup-budget-live");
  });

  it("restart re-drives from a terminalized staged claim after a crash window", async () => {
    const { runId } = await seedTaskBoundFlowRun("budget-restart-redrive");
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { launchRun } = await import("@/lib/services/runs");
    const launchRunSpy = vi.mocked(launchRun);

    await (db as any)
      .update(schema.runs)
      .set({ status: "Failed", endedAt: new Date() })
      .where(eq(schema.runs.id, runId));
    await (db as any)
      .update(schema.hitlRequests)
      .set({
        response: { optionId: "restart", stage: "terminalized" },
        respondedAt: null,
      })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "restart" } },
      userActor,
      { db },
    );
    const payload = await res.json();

    expect(res.status).toBe(202);
    expect(payload.newRunId).toBe("flow-restart-new");
    expect(launchRunSpy).toHaveBeenCalledTimes(1);
  });

  it("restart retry after launch recovers the existing new run instead of launching a duplicate", async () => {
    const { projectId, flowId, runId, taskId } = await seedTaskBoundFlowRun(
      "budget-restart-post-launch",
    );
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const existingRunId = await seedRun(projectId, null, {
      taskId,
      flowId,
      status: "Pending",
    });
    const { launchRun } = await import("@/lib/services/runs");
    const launchRunSpy = vi.mocked(launchRun);

    await (db as any)
      .update(schema.runs)
      .set({ status: "Failed", endedAt: new Date() })
      .where(eq(schema.runs.id, runId));
    await (db as any)
      .update(schema.runs)
      .set({
        triggerSource: "manual",
        triggerPayload: {
          kind: "budget_restart",
          oldRunId: runId,
          hitlRequestId,
        },
      })
      .where(eq(schema.runs.id, existingRunId));
    await (db as any)
      .update(schema.hitlRequests)
      .set({
        response: { optionId: "restart", stage: "terminalized" },
        respondedAt: null,
      })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "restart" } },
      userActor,
      { db },
    );
    const payload = await res.json();

    expect(res.status).toBe(202);
    expect(payload).toMatchObject({
      ok: true,
      runStatus: "Failed",
      newRunId: existingRunId,
      newRunStatus: "Pending",
    });
    expect(launchRunSpy).not.toHaveBeenCalled();

    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(hitlRow.response).toMatchObject({
      optionId: "restart",
      stage: "terminalized",
      ref: existingRunId,
    });
    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
  });

  it.each([
    [
      "flagged",
      async (taskId: string) => {
        await (db as any)
          .update(schema.tasks)
          .set({ triageStatus: "flagged" })
          .where(eq(schema.tasks.id, taskId));
      },
    ],
    [
      "busy",
      async (taskId: string, projectId: string, flowId: string) => {
        await seedRun(projectId, null, {
          taskId,
          flowId,
          status: "Running",
        });
      },
    ],
    [
      "blocked",
      async (taskId: string, projectId: string, flowId: string) => {
        const blockerId = await seedTask(projectId, flowId);

        await (db as any)
          .update(schema.tasks)
          .set({ status: "Backlog" })
          .where(eq(schema.tasks.id, blockerId));
        await (db as any).insert(schema.taskRelations).values({
          projectId,
          fromTaskId: blockerId,
          kind: "blocks",
          toTaskId: taskId,
          actorType: "system",
        });
      },
    ],
  ])(
    "restart refuses a %s task before claiming the HITL row",
    async (_caseName, arrange) => {
      const { projectId, flowId, runId, taskId } = await seedTaskBoundFlowRun(
        `budget-restart-${_caseName}`,
      );
      const hitlRequestId = await seedBudgetBreachHitl(runId);
      const { launchRun } = await import("@/lib/services/runs");
      const launchRunSpy = vi.mocked(launchRun);

      await arrange(taskId, projectId, flowId);

      await expect(
        respondToHitl(
          { runId, hitlRequestId, body: { optionId: "restart" } },
          userActor,
          { db },
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION" });

      const [runRow] = await (db as any)
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId));
      const [hitlRow] = await (db as any)
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId));

      expect(runRow.status).toBe("NeedsInput");
      expect(hitlRow.response).toBeNull();
      expect(hitlRow.respondedAt).toBeNull();
      expect(launchRunSpy).not.toHaveBeenCalled();
    },
  );

  it("restart launch failure leaves the old run terminal and records relaunch_failed", async () => {
    const { runId, taskId } = await seedTaskBoundFlowRun("budget-restart-fail");
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { launchRun } = await import("@/lib/services/runs");
    const launchRunSpy = vi.mocked(launchRun);

    launchRunSpy.mockRejectedValueOnce(new Error("launch unavailable"));

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "restart" } },
        userActor,
        { db },
      ),
    ).rejects.toThrow(/launch unavailable/);

    const [runRow] = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const comments = await (db as any)
      .select()
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, taskId));

    expect(runRow.status).toBe("Failed");
    expect(hitlRow.response).toMatchObject({
      optionId: "restart",
      stage: "relaunch_failed",
      error: "launch unavailable",
    });
    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
    expect(comments[0]?.body).toContain("failed after terminalizing");
  });

  it("park snapshot preserves through the workbench lifecycle before resolving the row", async () => {
    const { runId, taskId } = await seedTaskBoundFlowRun("budget-park", {
      acpSessionId: "sup-budget-park",
    });
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { checkpointSession } = await import("@/lib/supervisor-client");
    const {
      archiveWorkbench,
      snapshotWorkbenchCommit,
      stopThenArchive,
      stopWorkbenchRun,
    } = await import("@/lib/workbench-lifecycle/service");
    const checkpointSpy = vi.mocked(checkpointSession);
    const archiveWorkbenchSpy = vi.mocked(archiveWorkbench);
    const snapshotWorkbenchCommitSpy = vi.mocked(snapshotWorkbenchCommit);
    const stopThenArchiveSpy = vi.mocked(stopThenArchive);
    const stopWorkbenchRunSpy = vi.mocked(stopWorkbenchRun);

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "park", response: { mode: "snapshot" } },
      },
      userActor,
      { db },
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      runStatus: "Abandoned",
      ref: "deadbeef",
    });
    expect(snapshotWorkbenchCommitSpy).toHaveBeenCalledWith(runId, {
      commitMessage: `Budget park snapshot for ${runId}`,
      allowPausedBudgetRun: true,
    });
    expect(checkpointSpy).toHaveBeenCalledWith("sup-budget-park");
    expect(archiveWorkbenchSpy).toHaveBeenCalledWith(runId, {
      allowPausedBudgetRun: true,
    });
    expect(stopThenArchiveSpy).not.toHaveBeenCalled();
    expect(stopWorkbenchRunSpy).not.toHaveBeenCalled();

    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const [runRow] = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const comments = await (db as any)
      .select()
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, taskId));

    expect(runRow.status).toBe("Abandoned");
    expect(hitlRow.response).toMatchObject({
      optionId: "park",
      mode: "snapshot",
      stage: "terminalized",
      ref: "deadbeef",
    });
    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
    expect(comments[0]?.body).toContain("deadbeef");
  });

  it("park retry after terminalization resolves without replaying preservation", async () => {
    const { runId } = await seedTaskBoundFlowRun("budget-park-redrive");
    const hitlRequestId = await seedBudgetBreachHitl(runId);
    const { archiveWorkbench, snapshotWorkbenchCommit } = await import(
      "@/lib/workbench-lifecycle/service"
    );
    const archiveWorkbenchSpy = vi.mocked(archiveWorkbench);
    const snapshotWorkbenchCommitSpy = vi.mocked(snapshotWorkbenchCommit);

    await (db as any)
      .update(schema.runs)
      .set({ status: "Abandoned", endedAt: new Date() })
      .where(eq(schema.runs.id, runId));
    await (db as any)
      .update(schema.hitlRequests)
      .set({
        response: {
          optionId: "park",
          mode: "snapshot",
          branchName: null,
          stage: "terminalized",
          ref: "deadbeef",
        },
        respondedAt: null,
      })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "park", response: { mode: "snapshot" } },
      },
      userActor,
      { db },
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      runStatus: "Abandoned",
      ref: "deadbeef",
    });
    expect(snapshotWorkbenchCommitSpy).not.toHaveBeenCalled();
    expect(archiveWorkbenchSpy).not.toHaveBeenCalled();

    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(hitlRow.response).toMatchObject({
      optionId: "park",
      stage: "terminalized",
      ref: "deadbeef",
    });
    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
  });

  it("park without an available worktree fails before the HITL row is consumed", async () => {
    const projectId = await seedProject("budget-park-gc");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId);

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { optionId: "park", response: { mode: "snapshot" } },
        },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const [hitlRow] = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(hitlRow.response).toBeNull();
    expect(hitlRow.respondedAt).toBeNull();
  });
});

describe("respondToHitl budget_breach integration — raise (valid)", () => {
  it("raise > limit → NeedsInput, ceilingOverride[scope].maxTokens=raiseTo, notified[scope] cleared, budget_raised audit, scheduleResume, 202", async () => {
    const projectId = await seedProject("budget-raise");
    const runId = await seedRun(projectId, {
      notified: { run: "escalate", task: "warn" },
      ceilingOverride: { task: { maxTokens: 5000 } },
    });
    const hitlRequestId = await seedBudgetBreachHitl(runId, {
      scope: "run",
      meter: "tokens",
      limit: 1000,
      current: 1200,
    });

    await seedOpenAssignment(projectId, runId, hitlRequestId);

    const { runFlow } = await import("@/lib/flows/runner");
    const runFlowSpy = vi.mocked(runFlow);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);
    const payload = await res.json();

    expect(payload).toEqual({
      ok: true,
      runStatus: "NeedsInput",
      state: "resume-in-progress",
    });

    const runRow = (
      await (db as any)
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
    )[0];

    expect(runRow.status).toBe("NeedsInput");
    const state = runRow.budgetState as any;

    expect(state.ceilingOverride.run.maxTokens).toBe(2000);
    // other scopes' overrides untouched
    expect(state.ceilingOverride.task.maxTokens).toBe(5000);
    // notified[run] cleared so the raised band re-warns; other scope untouched
    expect(state.notified.run).toBeUndefined();
    expect(state.notified.task).toBe("warn");

    // scheduleResume runs runFlow after commit (queueMicrotask)
    await new Promise((r) => setTimeout(r, 0));
    expect(runFlowSpy).toHaveBeenCalledWith(runId);

    const hitlRow = (
      await (db as any)
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId))
    )[0];

    expect(hitlRow.respondedAt).toBeInstanceOf(Date);
  });

  it("raise on a failures-meter breach sets ceilingOverride[scope].consecutiveFailures", async () => {
    const projectId = await seedProject("budget-raise-fail");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, {
      scope: "task",
      meter: "failures",
      limit: 3,
      current: 3,
    });

    await seedOpenAssignment(projectId, runId, hitlRequestId);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 6 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);

    const runRow = (
      await (db as any)
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
    )[0];

    expect(
      (runRow.budgetState as any).ceilingOverride.task.consecutiveFailures,
    ).toBe(6);
  });
});

describe("respondToHitl budget_breach integration — raise resumes by run_kind (ADR-106 M39)", () => {
  it("agent run (NeedsInput escalate): raise CASes →Running and respawns via startAgentSession (not runFlow)", async () => {
    const projectId = await seedProject("budget-agent-resume");
    const runId = await seedRun(projectId, undefined, {
      runKind: "agent",
      acpSessionId: "acp-agent-resume",
    });
    const hitlRequestId = await seedBudgetBreachHitl(
      runId,
      { limit: 1000, current: 1200 },
      "agent",
    );

    await seedOpenAssignment(projectId, runId, hitlRequestId);

    const { startAgentSession } = await import("@/lib/agents/launch");
    const startAgentSessionSpy = vi.mocked(startAgentSession);
    const { runFlow } = await import("@/lib/flows/runner");
    const runFlowSpy = vi.mocked(runFlow);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);

    const runRow = (
      await (db as any)
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
    )[0];

    // The agent resume claims NeedsInput→Running synchronously, then respawns.
    expect(runRow.status).toBe("Running");

    await new Promise((r) => setTimeout(r, 0)); // flush the respawn microtask
    expect(startAgentSessionSpy).toHaveBeenCalledWith(runId, expect.anything());
    // The flow runFlow path is NOT taken for an agent run.
    expect(runFlowSpy).not.toHaveBeenCalled();
  });

  it("agent run (NeedsInputIdle restorable): raise resumes via startAgentSession from the idle pause", async () => {
    const projectId = await seedProject("budget-agent-idle-resume");
    const runId = await seedRun(projectId, undefined, {
      runKind: "agent",
      status: "NeedsInputIdle",
      acpSessionId: "acp-agent-idle",
    });
    const hitlRequestId = await seedBudgetBreachHitl(
      runId,
      { limit: 1000, current: 1200 },
      "agent",
    );

    const { startAgentSession } = await import("@/lib/agents/launch");
    const startAgentSessionSpy = vi.mocked(startAgentSession);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);
    expect(
      (
        await (db as any)
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("Running");

    await new Promise((r) => setTimeout(r, 0));
    expect(startAgentSessionSpy).toHaveBeenCalledWith(runId, expect.anything());
  });
});

describe("respondToHitl budget_breach integration — raise (invalid, fail-closed)", () => {
  it("raise == limit → PRECONDITION (rejected, no mutation)", async () => {
    const projectId = await seedProject("budget-eq");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 1000 } },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const hitlRow = (
      await (db as any)
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId))
    )[0];

    expect(hitlRow.respondedAt).toBeNull();
  });

  it("raise non-integer → PRECONDITION", async () => {
    const projectId = await seedProject("budget-float");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 1500.5 } },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("raise with missing amount → PRECONDITION", async () => {
    const projectId = await seedProject("budget-missing");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "raise" } },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("decision neither raise nor abandon → PRECONDITION", async () => {
    const projectId = await seedProject("budget-bad-decision");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "wat" } },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("respondToHitl budget_breach integration — human-actor-only (D7)", () => {
  it("a machine api_token actor is rejected UNAUTHORIZED before any mutation", async () => {
    const projectId = await seedProject("budget-human-only");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    const machineActor: HitlActor = {
      kind: "api_token",
      tokenId: "tok-1",
      projectId,
      label: "CI token",
    };

    // budget_breach joins human / infra_recovery as a human-only gate: a machine
    // token (even with hitl:respond scope) can never raise or abandon it.
    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 5000 } },
        machineActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // No mutation — the row stays unanswered.
    const hitlRow = (
      await (db as any)
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId))
    )[0];

    expect(hitlRow.respondedAt).toBeNull();
  });
});

describe("respondToHitl budget_breach integration — idempotency", () => {
  it("responded-row second response is a no-op {ok:true, idempotent:true}", async () => {
    const projectId = await seedProject("budget-idem");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId);

    await seedOpenAssignment(projectId, runId, hitlRequestId);

    // First: abandon flips to Failed + sets respondedAt.
    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "abandon" } },
      userActor,
      { db },
    );

    expect(first.status).toBe(200);

    // Second: the row is responded → no-op idempotent.
    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "abandon" } },
      userActor,
      { db },
    );

    const payload = await second.json();

    expect(payload).toMatchObject({ ok: true, idempotent: true });
  });
});

describe("respondToHitl budget_breach integration — DTO has no server handles", () => {
  it("raise response DTO carries no acp_session_id / internal columns", async () => {
    const projectId = await seedProject("budget-dto");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedBudgetBreachHitl(runId, { limit: 1000 });

    await seedOpenAssignment(projectId, runId, hitlRequestId);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    const payload = await res.json();
    const keys = Object.keys(payload).sort();

    expect(keys).toEqual(["ok", "runStatus", "state"]);
    expect(JSON.stringify(payload)).not.toContain("acp_session_id");
    expect(JSON.stringify(payload)).not.toContain("acpSessionId");
  });
});

// A retry whose prior post-commit resume handoff was lost (process died between
// the respondedAt commit and scheduleBudgetBreachResume): the run is still
// awaiting, so the same-payload retry hits the already-delivered branch and MUST
// re-drive the SAME resume dispatcher the first response used — for BOTH the
// NeedsInput (escalate) and NeedsInputIdle (terminate_restorable) pauses, and
// branching on run_kind (agent → respawn, flow → resumeRun). The pre-fix
// self-heal only re-fired scheduleResume (flow + NeedsInput), stranding a
// restorable pause and mis-driving an agent run through runFlow.
describe("respondToHitl budget_breach integration — raise already-delivered retry self-heals (lost-handoff recovery)", () => {
  async function markResponded(hitlRequestId: string) {
    await (db as any)
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(schema.hitlRequests.id, hitlRequestId));
  }

  it("agent run (NeedsInputIdle restorable): re-claims →Running and respawns via startAgentSession", async () => {
    const projectId = await seedProject("budget-idem-agent-idle");
    const runId = await seedRun(projectId, undefined, {
      runKind: "agent",
      status: "NeedsInputIdle",
      acpSessionId: "acp-agent-idle-retry",
    });
    const hitlRequestId = await seedBudgetBreachHitl(
      runId,
      { limit: 1000, current: 1200 },
      "agent",
    );

    await markResponded(hitlRequestId);

    const { startAgentSession } = await import("@/lib/agents/launch");
    const startAgentSessionSpy = vi.mocked(startAgentSession);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, idempotent: true });

    expect(
      (
        await (db as any)
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("Running");

    await new Promise((r) => setTimeout(r, 0));
    expect(startAgentSessionSpy).toHaveBeenCalledWith(runId, expect.anything());
  });

  it("agent run (NeedsInput escalate): re-claims via startAgentSession, never runFlow", async () => {
    const projectId = await seedProject("budget-idem-agent-needsinput");
    const runId = await seedRun(projectId, undefined, {
      runKind: "agent",
      status: "NeedsInput",
      acpSessionId: "acp-agent-retry",
    });
    const hitlRequestId = await seedBudgetBreachHitl(
      runId,
      { limit: 1000, current: 1200 },
      "agent",
    );

    await markResponded(hitlRequestId);

    const { startAgentSession } = await import("@/lib/agents/launch");
    const startAgentSessionSpy = vi.mocked(startAgentSession);
    const { runFlow } = await import("@/lib/flows/runner");
    const runFlowSpy = vi.mocked(runFlow);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    expect(
      (
        await (db as any)
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("Running");

    await new Promise((r) => setTimeout(r, 0));
    expect(startAgentSessionSpy).toHaveBeenCalledWith(runId, expect.anything());
    expect(runFlowSpy).not.toHaveBeenCalled();
  });

  it("flow run (NeedsInputIdle restorable): re-drives the idle resume via resumeRun (not a silent no-op)", async () => {
    const projectId = await seedProject("budget-idem-flow-idle");
    const runId = await seedRun(projectId, undefined, {
      runKind: "flow",
      status: "NeedsInputIdle",
      acpSessionId: "acp-flow-idle-retry",
    });
    const hitlRequestId = await seedBudgetBreachHitl(runId, {
      limit: 1000,
      current: 1200,
    });

    await markResponded(hitlRequestId);

    const { resumeRun } = await import("@/lib/runs/resume");
    const resumeRunSpy = vi.mocked(resumeRun);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "raise", raiseTo: 2000 } },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, idempotent: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(resumeRunSpy).toHaveBeenCalledWith(runId, expect.anything());
  });
});
