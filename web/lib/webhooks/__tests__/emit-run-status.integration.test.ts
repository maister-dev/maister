import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  crashResumedRun,
  crashRunningRun,
  failResumedRun,
  markAbandoned,
} from "@/lib/runs/state-transitions";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches webhooks-schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T6 — run-status webhook emits (TDD red).
//
// Pins the two DQ1 invariants the implementor will apply across every run.*
// emit site, proven on the cleanest DB-CAS transition helpers in
// `@/lib/runs/state-transitions`:
//
//   1. Same-tx capture — a SUCCESSFUL taxonomy transition writes ONE
//      `webhook_events` outbox row of the correct `type` + `data`, committed
//      atomically with the status flip.
//   2. CAS-winner-only — a transition helper whose status-guarded CAS does NOT
//      win (precondition unmet → 0 rows affected) emits NOTHING.
//
// Pinned type↔data map (per docs/system-analytics/outbound-webhooks.md):
//   markAbandoned   → run.abandoned, data.source === "user"
//   failResumedRun  → run.failed,    data.errorCode is string|null
//   crashRunningRun → run.crashed,   data.errorCode is string|null
//   crashResumedRun → run.crashed,   data.errorCode is string|null
// Every row: project_id + run_id == the run's, payload NULL, fanout_at NULL.
//
// The emits are NOT wired yet, so the winner cases MUST fail on
// "expected 1 webhook_events row, got 0". The testcontainers boot + the helper
// calls themselves succeed — the only red is the absent outbox row.
// =============================================================================

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

type RunStatus =
  | "Pending"
  | "Running"
  | "NeedsInput"
  | "NeedsInputIdle"
  | "Review"
  | "Crashed";

async function seedRun(
  status: RunStatus,
  opts: { withWorkspace?: boolean } = {},
): Promise<{ projectId: string; runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
    number: Number.parseInt(crypto.randomUUID().slice(0, 6), 16),
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
    status,
  });

  // markAbandoned stamps workspaces.scheduled_removal_at in the SAME tx as the
  // status flip — seed a workspace so the helper runs exactly as in production.
  if (opts.withWorkspace) {
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: `maister/${runId.slice(0, 8)}`,
      worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
      parentRepoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    });
  }

  return { projectId, runId };
}

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
// markAbandoned — run.abandoned, data.source === "user". Already a tx.
//   CAS guard: status ∈ {Pending, Running, NeedsInput, NeedsInputIdle,
//   Review, Crashed}. Production call: markAbandoned(runId, { db }).
// ---------------------------------------------------------------------------
describe("markAbandoned → run.abandoned", () => {
  it("winner: a discarded run captures exactly one run.abandoned event (source=user)", async () => {
    const { projectId, runId } = await seedRun("Running", {
      withWorkspace: true,
    });

    const res = await markAbandoned(runId, { db });

    expect(res.ok).toBe(true);
    expect(await statusOf(runId)).toBe("Abandoned");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.abandoned");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toMatchObject({ source: "user" });
  });
});

// ---------------------------------------------------------------------------
// failResumedRun — run.failed, data.errorCode is string|null. Bare CAS.
//   CAS guard: status ∈ {NeedsInputIdle, NeedsInput}. Production call:
//   failResumedRun(runId, "<reason>", { db }).
// ---------------------------------------------------------------------------
describe("failResumedRun → run.failed", () => {
  it("winner: a failed resume captures exactly one run.failed event with errorCode", async () => {
    const { projectId, runId } = await seedRun("NeedsInputIdle");

    const res = await failResumedRun(runId, "supervisor-400-spawn-refused", {
      db,
    });

    expect(res.ok).toBe(true);
    expect(await statusOf(runId)).toBe("Failed");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.failed");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toHaveProperty("errorCode");

    const errorCode = (events[0].data as { errorCode: unknown }).errorCode;

    expect(errorCode === null || typeof errorCode === "string").toBe(true);
  });

  it("loser: a CAS-missing status (Running) emits nothing", async () => {
    const { runId } = await seedRun("Running");

    const res = await failResumedRun(runId, "supervisor-400-spawn-refused", {
      db,
    });

    expect(res.ok).toBe(false);
    expect(await statusOf(runId)).toBe("Running");
    expect(await eventsForRun(runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// crashRunningRun — run.crashed, data.errorCode is string|null. Bare CAS.
//   CAS guard: status === Running. Production call:
//   crashRunningRun(runId, "<CrashReason>", { db }).
// ---------------------------------------------------------------------------
describe("crashRunningRun → run.crashed", () => {
  it("winner: a crashed Running run captures exactly one run.crashed event with errorCode", async () => {
    const { projectId, runId } = await seedRun("Running");

    const res = await crashRunningRun(runId, "agent-session-gone", { db });

    expect(res.ok).toBe(true);
    expect(await statusOf(runId)).toBe("Crashed");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.crashed");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toHaveProperty("errorCode");

    const errorCode = (events[0].data as { errorCode: unknown }).errorCode;

    expect(errorCode === null || typeof errorCode === "string").toBe(true);
  });

  it("loser: a CAS-missing status (NeedsInput) emits nothing", async () => {
    const { runId } = await seedRun("NeedsInput");

    const res = await crashRunningRun(runId, "agent-session-gone", { db });

    expect(res.ok).toBe(false);
    expect(await statusOf(runId)).toBe("NeedsInput");
    expect(await eventsForRun(runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// crashResumedRun — run.crashed, data.errorCode is string|null. Bare CAS.
//   CAS guard: status === NeedsInput. Production call:
//   crashResumedRun(runId, "<reason>", { db }).
// ---------------------------------------------------------------------------
describe("crashResumedRun → run.crashed", () => {
  it("winner: a crashed resumed run captures exactly one run.crashed event with errorCode", async () => {
    const { projectId, runId } = await seedRun("NeedsInput");

    const res = await crashResumedRun(runId, "resume-prompt-no-permission", {
      db,
    });

    expect(res.ok).toBe(true);
    expect(await statusOf(runId)).toBe("Crashed");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.crashed");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toHaveProperty("errorCode");

    const errorCode = (events[0].data as { errorCode: unknown }).errorCode;

    expect(errorCode === null || typeof errorCode === "string").toBe(true);
  });

  it("loser: a CAS-missing status (Review) emits nothing", async () => {
    const { runId } = await seedRun("Review");

    const res = await crashResumedRun(runId, "resume-prompt-no-permission", {
      db,
    });

    expect(res.ok).toBe(false);
    expect(await statusOf(runId)).toBe("Review");
    expect(await eventsForRun(runId)).toHaveLength(0);
  });
});
