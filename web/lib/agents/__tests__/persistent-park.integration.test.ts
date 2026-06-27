// M37 Phase 8 (ADR-099): persistent park-vs-finalize at the consumeAgentSession
// terminal seam. A persistent agent whose session ends on a clean end_turn
// (exitCode 0, no reason) PARKS (NeedsInputIdle, acp_session_id retained, slot
// released) — it does NOT finalize Done. A non-persistent child with the same
// exit finalizes Done (acp_session_id nulled). The supervisor stream is a fake
// async iterator; the DB is a real testcontainer.

import type {
  AgentSupervisorApi,
  consumeAgentSession as ConsumeFn,
  parkPersistentAgent as ParkFn,
} from "@/lib/agents/launch";
import type { SupervisorEvent } from "@/lib/supervisor-client";

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
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let consumeAgentSession: typeof ConsumeFn;
let parkPersistentAgent: typeof ParkFn;
let releaseSlotSpy: ReturnType<typeof vi.fn>;

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  releaseSlotSpy = vi.fn(async () => ({ promotedRunId: null }));

  return {
    ...actual,
    releaseSlotOnIdle: (args: { runId: string; db?: unknown }) =>
      releaseSlotSpy(args),
    promoteNextPending: vi.fn(async () => ({ promotedRunId: null })),
  };
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("persistent_park_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ consumeAgentSession, parkPersistentAgent } = await import(
    "@/lib/agents/launch"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

afterEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
  releaseSlotSpy?.mockClear();
});

async function seedProject(): Promise<void> {
  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
}

// A Running agent run (workspace=none so the clean Done-path has no worktree to
// flip into Review) with a retained acp handle on its `default` run_session.
//
// M42 (ADR-114): the runner mirror + resume handle moved off `runs` to
// `run_sessions`. A persistent park RETAINS the handle ('acp-keep-me'); the
// non-persistent clean-Done path no longer nulls it on the run row (the column
// is gone) — `finalizeAgentRun` leaves run_sessions untouched — so the
// non-persistent run is seeded with a null handle to mirror the "no live
// resume handle after a terminal Done" assertion.
async function seedRunningAgent(persistent: boolean): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "agent_workspace",
       "persistent", "addressable_key")
     VALUES ($1, 'agent', NULL, $2, 'Running', 'agent', 'manual', 'none',
             $3, $4)`,
    [runId, projectId, persistent, persistent ? "reviewer" : null],
  );
  await (db as any).insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: { capabilityAgent: "claude" },
    acpSessionId: persistent ? "acp-keep-me" : null,
  });

  return runId;
}

// A fake supervisor API that streams exactly one event then ends.
function fakeApi(event: SupervisorEvent): AgentSupervisorApi {
  return {
    createSession: vi.fn(),
    deliverPermission: vi.fn(),
    sendPrompt: vi.fn(),

    streamSession: async function* () {
      yield event;
    },
  } as unknown as AgentSupervisorApi;
}

function cleanExit(sessionId: string): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId,
    monotonicId: 1,
    exitCode: 0,
  };
}

// M42 (ADR-114): the run's resume handle lives on its ACTIVE `run_sessions` row
// (sole source of truth) — surface it as `acpSessionId` so the assertions read
// the same place production does (mirrors sendAgentMessage's lookup).
async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  const active = await loadActiveRunSession(db, runId);

  return { ...rows[0], acpSessionId: active?.acpSessionId ?? null };
}

describe("persistent park-vs-finalize (M37 Phase 8 T8.1)", () => {
  it("a persistent agent parks on clean end_turn: NeedsInputIdle, acp_session_id retained, slot released", async () => {
    await seedProject();
    const runId = await seedRunningAgent(true);

    await consumeAgentSession({
      db,
      api: fakeApi(cleanExit(`sup-${runId}`)),
      runId,
      sessionId: `sup-${runId}`,
    });

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInputIdle");
    expect(run.acpSessionId).toBe("acp-keep-me");
    expect(run.checkpointAt).not.toBeNull();
    expect(releaseSlotSpy).toHaveBeenCalledTimes(1);
  });

  it("a non-persistent agent with the same exit finalizes Done, acp_session_id nulled", async () => {
    await seedProject();
    const runId = await seedRunningAgent(false);

    await consumeAgentSession({
      db,
      api: fakeApi(cleanExit(`sup-${runId}`)),
      runId,
      sessionId: `sup-${runId}`,
    });

    const run = await getRun(runId);

    expect(run.status).toBe("Done");
    expect(run.acpSessionId).toBeNull();
    // The clean-Done path never routes through releaseSlotOnIdle.
    expect(releaseSlotSpy).not.toHaveBeenCalled();
  });

  // The parkPersistentAgent CAS guard directly: Running → NeedsInputIdle is
  // status-guarded, so a non-Running row loses.
  it("parkPersistentAgent rejects a non-Running row (CAS guard)", async () => {
    await seedProject();
    const runId = await seedRunningAgent(true);

    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      runId,
    ]);

    const result = await parkPersistentAgent(runId, { db });

    expect(result.parked).toBe(false);
    expect((await getRun(runId)).status).toBe("Done");
  });

  // C3 (real two-racer): two concurrent parks of one Running persistent member
  // converge to a single winner — the Running→NeedsInputIdle CAS admits one.
  it("concurrent parkPersistentAgent: exactly one wins", async () => {
    await seedProject();
    const runId = await seedRunningAgent(true);

    const [a, b] = await Promise.all([
      parkPersistentAgent(runId, { db }),
      parkPersistentAgent(runId, { db }),
    ]);

    expect([a, b].filter((r) => r.parked).length).toBe(1);
    expect([a, b].filter((r) => !r.parked).length).toBe(1);
    expect((await getRun(runId)).status).toBe("NeedsInputIdle");
  }, 60_000);
});
