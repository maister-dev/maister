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
  deliverPermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));
vi.mock("@/lib/agents/launch", () => ({
  startAgentSession: vi.fn(async () => {}),
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
  } = {},
) {
  const runId = randomUUID();
  const executorId = await seedRunner();

  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: opts.runKind ?? "flow",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: opts.status ?? "NeedsInput",
    flowVersion: "v1.0.0",
    acpSessionId: opts.acpSessionId ?? null,
    budgetState: budgetState ?? null,
  });

  return runId;
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
