import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T7 (HITL) — hitl.responded + (run.needs_input ∧ hitl.requested) emits (TDD red).
//
// Two cleanly-drivable writepoints:
//
//   B. hitl.responded {via:"user"} — `respondToHitl` (@/lib/services/hitl)
//      stamps `hitl_requests.respondedAt` on the permission and form/human
//      respond paths. Driven directly against a seeded NeedsInput run + a
//      permission/form hitl_requests row. Supervisor delivery, the resume
//      runFlow wake, and authz are mocked so only the DB respond path runs.
//
//   C. run.needs_input ∧ hitl.requested (co-emit) — the scratch permission
//      flow `persistPermissionRequest` (@/lib/scratch-runs/events) inserts a
//      hitl_requests row AND flips run→NeedsInput in ONE tx, reached via
//      `sendScratchPromptAndProjectEvents` with a fake supervisor stream that
//      yields one `session.permission_request`. BOTH a run.needs_input AND a
//      hitl.requested row must appear atomically (same projectId/runId).
//
// Pinned data shapes (DQ2; ids/statuses only, NEVER secrets):
//   run.needs_input  {reason:"permission"|"form"|"human_review", nodeId}
//   hitl.requested   {hitlRequestId, kind:"permission"|"form"|"human", nodeId}
//   hitl.responded   {hitlRequestId, kind:"permission"|"form"|"human", via:"user"|"auto"}
// Every row: project_id + run_id == the run's, payload NULL, fanout_at NULL.
//
// Authored TDD-red; the emits are now wired (T7), so these are the green
// regression guards: each asserts the outbox row rides the same tx as the
// respondedAt write / the permission insert+flip.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

// `db` is assigned in beforeAll; the getDb closure reads it lazily.
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

// Service deps that would reach out of process / require a session. Permission
// delivery is faked to succeed so the respond path stamps respondedAt; the
// resume wake + idle resume are stubbed; authz is allowed.
// scratch-runs/events.ts imports sendPrompt + streamSession at module load for
// its defaultSupervisorApi (unused — the scratch test threads an explicit api),
// so the mock must still export them.
vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: vi.fn(async () => ({ ok: true })),
  cancelPermission: vi.fn(async () => undefined),
  sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" })),
  streamSession: vi.fn(async function* () {}),
}));

vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => undefined),
}));

vi.mock("@/lib/runs/resume", () => ({
  resumeRun: vi.fn(async () => ({ ok: false, code: "CLAIM_RACE" })),
}));

vi.mock("@/lib/runs/resume-driver", () => ({
  scheduleResumedSessionDrive: vi.fn(() => "drive-test"),
}));

vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => undefined),
}));

let respondToHitl: typeof import("@/lib/services/hitl").respondToHitl;
let sendScratchPromptAndProjectEvents: typeof import("@/lib/scratch-runs/events").sendScratchPromptAndProjectEvents;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  runtimeRoot = await mkdtemp(join(tmpdir(), "maister-emit-hitl-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;

  ({ respondToHitl } = await import("@/lib/services/hitl"));
  ({ sendScratchPromptAndProjectEvents } = await import(
    "@/lib/scratch-runs/events"
  ));
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

interface EventRow {
  id: string;
  type: string;
  project_id: string;
  run_id: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  fanout_at: Date | null;
}

async function eventsForRun(runId: string): Promise<EventRow[]> {
  const result = await db.execute(sql`
    SELECT id, type, project_id, run_id, data, payload, fanout_at
    FROM webhook_events
    WHERE run_id = ${runId}
  `);

  return result.rows as unknown as EventRow[];
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return (rows[0] as { status: string }).status;
}

// ---------------------------------------------------------------------------
// Path B seed — a flow run in NeedsInput + one hitl_requests row.
// ---------------------------------------------------------------------------
async function seedFlowRunWithHitl(args: {
  kind: "permission" | "form" | "human";
}): Promise<{ projectId: string; runId: string; hitlRequestId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlRequestId = randomUUID();
  const stepId = args.kind === "permission" ? "plan" : "review";

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status: "NeedsInput",
    currentStepId: stepId,
  });

  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId,
    kind: args.kind,
    schema:
      args.kind === "permission"
        ? {
            requestId: "req-1",
            supervisorSessionId: "sup-1",
            options: [{ optionId: "allow" }, { optionId: "deny" }],
          }
        : { fields: [] },
    prompt: "approve?",
  });

  return { projectId, runId, hitlRequestId };
}

// ===========================================================================
// B. hitl.responded {via:"user"}
// ===========================================================================
describe("respondToHitl (permission) → hitl.responded", () => {
  it("winner: a delivered permission response captures exactly one hitl.responded (via=user)", async () => {
    const { projectId, runId, hitlRequestId } = await seedFlowRunWithHitl({
      kind: "permission",
    });

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      { kind: "user", userId: "u-test", label: "Test User" },
      { db },
    );

    expect(res.status).toBe(200);

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hitl.responded");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toMatchObject({
      hitlRequestId,
      kind: "permission",
      via: "user",
    });
  });
});

describe("respondToHitl (form) → hitl.responded", () => {
  it("winner: a delivered form response captures exactly one hitl.responded (via=user)", async () => {
    const { projectId, runId, hitlRequestId } = await seedFlowRunWithHitl({
      kind: "form",
    });

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: { approved: true } } },
      { kind: "user", userId: "u-test", label: "Test User" },
      { db },
    );

    expect(res.status).toBe(200);

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hitl.responded");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toMatchObject({
      hitlRequestId,
      kind: "form",
      via: "user",
    });
  });
});

// ---------------------------------------------------------------------------
// Path C seed — a scratch run in Running with its scratch_runs row.
// ---------------------------------------------------------------------------
async function seedScratchRun(): Promise<{
  projectId: string;
  runId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const runId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@test.local`,
  });

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "scratch",
    status: "Running",
  });

  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    createdByUserId: userId,
    initialPrompt: "do the thing",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus: "Running",
  });

  return { projectId, runId };
}

// Fake supervisor api: stream yields ONLY one permission_request (drives
// persistPermissionRequest → hitl insert + run→NeedsInput in one tx), then the
// generator returns so the consumer loop completes naturally — NeedsInput is the
// terminal observed status (a trailing session.exited would re-project the run
// to Review and mask the co-emit). sendScratchPromptAndProjectEvents aborts +
// awaits the consumer in its finally, so the write commits before the call
// resolves.
function fakePermissionApi() {
  return {
    cancelPermission: async () => undefined,
    sendPrompt: async () => ({ stopReason: "end_turn" as const }),

    streamSession: async function* () {
      yield {
        type: "session.permission_request" as const,
        sessionId: "sess-1",
        monotonicId: 1,
        requestId: "req-scratch-1",
        options: [{ optionId: "allow" }, { optionId: "deny" }],
        toolCall: { title: "Write file" },
      };
    },
  };
}

// ===========================================================================
// C. run.needs_input ∧ hitl.requested (co-emit, atomic)
// ===========================================================================
describe("scratch permission flow → run.needs_input + hitl.requested co-emit", () => {
  it("winner: a permission_request captures BOTH run.needs_input AND hitl.requested atomically", async () => {
    const { projectId, runId } = await seedScratchRun();

    await sendScratchPromptAndProjectEvents({
      runId,
      sessionId: "sess-1",
      stepId: "scratch",
      prompt: "go",
      db,
      api: fakePermissionApi() as never,
    });

    expect(await statusOf(runId)).toBe("NeedsInput");

    const events = await eventsForRun(runId);
    const byType = new Map(events.map((e) => [e.type, e]));

    const needsInput = byType.get("run.needs_input");
    const requested = byType.get("hitl.requested");

    expect(needsInput, "run.needs_input row").toBeDefined();
    expect(requested, "hitl.requested row").toBeDefined();

    for (const row of [needsInput!, requested!]) {
      expect(row.project_id).toBe(projectId);
      expect(row.run_id).toBe(runId);
      expect(row.payload).toBeNull();
      expect(row.fanout_at).toBeNull();
    }

    expect(needsInput!.data).toMatchObject({ reason: "permission" });
    expect(requested!.data).toMatchObject({ kind: "permission" });
    expect(
      typeof (requested!.data as { hitlRequestId: unknown }).hitlRequestId,
    ).toBe("string");
  });
});
