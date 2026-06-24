// Phase 3 (ADR-108 / M40): respondToHitl for the hook_trip kind — a
// resume-or-abort decision routed through each run_kind's resume path (flow →
// runFlow; agent → startAgentSession) or terminal abort. Mirrors
// hitl-budget-breach.integration.test.ts (testcontainer DB; runFlow +
// startAgentSession + authz mocked).

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
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn(async () => {}) }));
vi.mock("@/lib/agents/launch", () => ({
  startAgentSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("hitl_hook_trip_test")
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
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-hook-trip-int-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool.query(`DELETE FROM "assignments"`);
  await pool.query(`DELETE FROM "hitl_requests"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await (db as any).insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function seedRun(
  projectId: string,
  opts: { runKind?: "flow" | "agent"; acpSessionId?: string } = {},
): Promise<string> {
  const runId = randomUUID();
  const executorId = randomUUID();

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await (db as any).insert(schema.runs).values({
    id: runId,
    runKind: opts.runKind ?? "flow",
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "NeedsInput",
    currentStepId: opts.runKind === "agent" ? "agent" : "implement",
    acpSessionId: opts.acpSessionId ?? null,
    flowVersion: "v1.0.0",
  });

  return runId;
}

async function seedHookTripHitl(
  runId: string,
  stepId = "implement",
): Promise<string> {
  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId,
    kind: "hook_trip",
    prompt: "Guardrail tripped",
    schema: {
      kind: "hook_trip",
      rule: "repetition",
      decisions: ["resume", "abort"],
    },
    response: null,
    respondedAt: null,
  });

  return hitlRequestId;
}

async function seedOpenAssignment(
  projectId: string,
  runId: string,
  hitlRequestId: string,
): Promise<string> {
  const assignmentId = randomUUID();

  await (db as any).insert(schema.assignments).values({
    id: assignmentId,
    projectId,
    runId,
    hitlRequestId,
    actionKind: "hook_trip",
    status: "open",
    title: "Guardrail tripped",
  });

  return assignmentId;
}

async function getRun(runId: string): Promise<any> {
  return (
    await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
  )[0];
}

async function getAssignment(id: string): Promise<any> {
  return (
    await (db as any)
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.id, id))
  )[0];
}

const userActor: HitlActor = {
  kind: "user",
  userId: "u-1",
  label: "Test User",
};

describe("respondToHitl hook_trip integration", () => {
  it("abort → run Failed, assignment cancelled, run.failed (hook_trip_abandoned)", async () => {
    const projectId = await seedProject("ht-abort");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedHookTripHitl(runId);
    const assignmentId = await seedOpenAssignment(
      projectId,
      runId,
      hitlRequestId,
    );

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "abort" } },
      userActor,
      { db },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runStatus: "Failed" });
    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getAssignment(assignmentId)).status).toBe("cancelled");

    const events = await (db as any)
      .select()
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.runId, runId),
          eq(schema.domainEvents.kind, "run.failed"),
        ),
      );

    expect(events).toHaveLength(1);
    expect((events[0].payload as any)?.reason).toBe("hook_trip_abandoned");
  });

  it("flow resume → 202, runFlow scheduled, assignment cancelled, hitl responded", async () => {
    const projectId = await seedProject("ht-flow-resume");
    const runId = await seedRun(projectId, { runKind: "flow" });
    const hitlRequestId = await seedHookTripHitl(runId);
    const assignmentId = await seedOpenAssignment(
      projectId,
      runId,
      hitlRequestId,
    );

    const { runFlow } = await import("@/lib/flows/runner");
    const { startAgentSession } = await import("@/lib/agents/launch");

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "resume-in-progress" });

    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(runFlow)).toHaveBeenCalledWith(runId);
    expect(vi.mocked(startAgentSession)).not.toHaveBeenCalled();
    expect((await getAssignment(assignmentId)).status).toBe("cancelled");
  });

  it("agent resume → 202 NeedsInput, run claimed Running async + startAgentSession respawns", async () => {
    const projectId = await seedProject("ht-agent-resume");
    const runId = await seedRun(projectId, {
      runKind: "agent",
      acpSessionId: "acp-keep",
    });
    const hitlRequestId = await seedHookTripHitl(runId, "agent");

    const { runFlow } = await import("@/lib/flows/runner");
    const { startAgentSession } = await import("@/lib/agents/launch");

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(res.status).toBe(202);
    // The response reports NeedsInput (built before the claim) — the runner, not
    // the response tx, owns NeedsInput→Running and claims it off the response
    // path. The DB row flips to Running shortly after (async claim).
    expect(await res.json()).toMatchObject({
      runStatus: "NeedsInput",
      state: "resume-in-progress",
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId)).status).toBe("Running");
    });
    expect(vi.mocked(startAgentSession)).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ db }),
    );
    expect(vi.mocked(runFlow)).not.toHaveBeenCalled();
  });

  it("a machine token may NOT resolve a hook_trip (human-actor-only)", async () => {
    const projectId = await seedProject("ht-machine");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedHookTripHitl(runId);
    const machineActor: HitlActor = {
      kind: "api_token",
      tokenId: "t-1",
      projectId,
      label: "bot",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "resume" } },
        machineActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // unchanged: no respondedAt, run still NeedsInput
    expect((await getRun(runId)).status).toBe("NeedsInput");
  });

  it("idempotent: a second response returns already-delivered (200), no double-spawn", async () => {
    const projectId = await seedProject("ht-idem");
    const runId = await seedRun(projectId, {
      runKind: "agent",
      acpSessionId: "acp",
    });
    const hitlRequestId = await seedHookTripHitl(runId, "agent");

    const { startAgentSession } = await import("@/lib/agents/launch");

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(first.status).toBe(202);
    // Let the first claim land (run Running) before retrying.
    await vi.waitFor(async () => {
      expect((await getRun(runId)).status).toBe("Running");
    });
    expect(vi.mocked(startAgentSession)).toHaveBeenCalledTimes(1);

    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ idempotent: true });
    // The run already advanced (Running) → the retry must NOT re-claim/respawn.
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(startAgentSession)).toHaveBeenCalledTimes(1);
  });

  it("flow already-delivered retry self-heals: re-queues runFlow when still NeedsInput", async () => {
    const projectId = await seedProject("ht-flow-reheal");
    const runId = await seedRun(projectId, { runKind: "flow" });
    const hitlRequestId = await seedHookTripHitl(runId);

    const { runFlow } = await import("@/lib/flows/runner");

    // First resume: commits respondedAt + schedules runFlow, leaving the flow
    // run NeedsInput (runFlow is mocked → no advance).
    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(first.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(runFlow)).toHaveBeenCalledTimes(1);
    vi.mocked(runFlow).mockClear();

    // Crash window: the original microtask was lost; the run is still
    // NeedsInput. A same-payload retry MUST re-queue the resume (durable
    // recovery), not return 200 inertly and strand the run.
    const retry = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      runStatus: "NeedsInput",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(runFlow)).toHaveBeenCalledWith(runId);
  });

  it("already-delivered retry does NOT re-queue runFlow once the run advanced", async () => {
    const projectId = await seedProject("ht-flow-advanced");
    const runId = await seedRun(projectId, { runKind: "flow" });
    const hitlRequestId = await seedHookTripHitl(runId);

    const { runFlow } = await import("@/lib/flows/runner");

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(first.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    vi.mocked(runFlow).mockClear();

    // The run has since advanced past NeedsInput.
    await (db as any)
      .update(schema.runs)
      .set({ status: "Review" })
      .where(eq(schema.runs.id, runId));

    const retry = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      runStatus: "Review",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(runFlow)).not.toHaveBeenCalled();
  });

  it("agent already-delivered retry self-heals: re-claims + respawns when still NeedsInput", async () => {
    const projectId = await seedProject("ht-agent-reheal");
    const runId = await seedRun(projectId, {
      runKind: "agent",
      acpSessionId: "acp",
    });
    const hitlRequestId = await seedHookTripHitl(runId, "agent");

    // Simulate a lost post-commit handoff: respondedAt committed, but the run
    // was left NeedsInput because the original claim never landed (process
    // restart between the commit and claimAndResumeAgentRun).
    await (db as any)
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const { startAgentSession } = await import("@/lib/agents/launch");

    const retry = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      runStatus: "NeedsInput",
    });
    // Durable recovery: the same-payload retry re-claims the awaiting run and
    // respawns — not an inert 200 that strands it (the pre-fix behavior).
    await vi.waitFor(async () => {
      expect((await getRun(runId)).status).toBe("Running");
    });
    expect(vi.mocked(startAgentSession)).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ db }),
    );
  });

  it("agent already-delivered retry does NOT re-claim once the run advanced", async () => {
    const projectId = await seedProject("ht-agent-advanced");
    const runId = await seedRun(projectId, {
      runKind: "agent",
      acpSessionId: "acp",
    });
    const hitlRequestId = await seedHookTripHitl(runId, "agent");

    await (db as any)
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    // The run already advanced past awaiting (e.g. the claim landed and the run
    // moved on, or reconcile crashed it).
    await (db as any)
      .update(schema.runs)
      .set({ status: "Review" })
      .where(eq(schema.runs.id, runId));

    const { startAgentSession } = await import("@/lib/agents/launch");

    const retry = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      runStatus: "Review",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(startAgentSession)).not.toHaveBeenCalled();
  });

  it("rejects an unknown optionId (PRECONDITION)", async () => {
    const projectId = await seedProject("ht-bad-option");
    const runId = await seedRun(projectId);
    const hitlRequestId = await seedHookTripHitl(runId);

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "frobnicate" } },
        userActor,
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});
