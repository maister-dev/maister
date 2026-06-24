// Phase 3 (ADR-108 / M40): the agent consumer's session.hook_trip handling.
// A halting trip drives consumeAgentSession → escalateHookTrip → NeedsInput +
// a hook_trip HITL (resumable via startAgentSession); a path_guard deny is
// record-only. Real escalateHookTrip against a testcontainer DB; the supervisor
// stream is a fake async iterator (mirrors persistent-park.integration.test.ts).

import type {
  AgentSupervisorApi,
  consumeAgentSession as ConsumeFn,
} from "@/lib/agents/launch";
import type { SupervisorEvent } from "@/lib/supervisor-client";

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
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    releaseSlotOnIdle: vi.fn(async () => ({ promotedRunId: null })),
    promoteNextPending: vi.fn(async () => ({ promotedRunId: null })),
  };
});

let consumeAgentSession: typeof ConsumeFn;
let projectId: string;
let executorId: string;

beforeAll(async () => {
  process.env.MAISTER_RUNTIME_ROOT = path.join(
    tmpdir(),
    `agent-hook-${randomUUID().slice(0, 8)}`,
  );

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("agent_hook_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ consumeAgentSession } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  await pool.query(`DELETE FROM "assignments"`);
  await pool.query(`DELETE FROM "hitl_requests"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
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

async function seedRunningAgent(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status",
       "flow_version", "agent_workspace", "acp_session_id",
       "execution_policy", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, 'Running', 'agent', 'none', 'acp-keep-me',
             '{"preset":"unattended"}'::jsonb,
             '{"capabilityAgent":"claude"}'::jsonb, $3)`,
    [runId, projectId, executorId],
  );

  return runId;
}

function fakeApi(events: SupervisorEvent[]): AgentSupervisorApi & {
  checkpointSpy: ReturnType<typeof vi.fn>;
} {
  const checkpointSpy = vi.fn(async () => ({
    alreadyCheckpointed: false,
    sessionId: "s",
    monotonicId: 0,
  }));

  return {
    createSession: vi.fn(),
    deliverPermission: vi.fn(),
    sendPrompt: vi.fn(),
    checkpointSession: checkpointSpy,
    streamSession: async function* () {
      for (const ev of events) yield ev;
    },
    checkpointSpy,
  } as unknown as AgentSupervisorApi & {
    checkpointSpy: ReturnType<typeof vi.fn>;
  };
}

function hookTrip(
  disposition: "deny" | "halt",
  rule: "path_guard" | "repetition" | "no_progress",
): SupervisorEvent {
  return {
    type: "session.hook_trip",
    sessionId: "sup-1",
    monotonicId: 1,
    rule,
    lifecycle: rule === "no_progress" ? "post_turn" : "pre_tool_call",
    disposition,
    toolCall: { toolCallId: "tc-1", title: "Edit", kind: "edit" },
  };
}

function exitedCheckpoint(): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-1",
    monotonicId: 2,
    exitCode: 0,
    reason: "checkpoint",
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

describe("consumeAgentSession — session.hook_trip", () => {
  it("halt: checkpoint + escalate → NeedsInput + hook_trip HITL", async () => {
    await seedProject();
    const runId = await seedRunningAgent();
    const api = fakeApi([hookTrip("halt", "repetition"), exitedCheckpoint()]);

    await consumeAgentSession({ db, api, runId, sessionId: "sup-1" });

    expect(api.checkpointSpy).toHaveBeenCalledWith("sup-1");
    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");

    const hitls = await getHitl(runId);

    expect(hitls).toHaveLength(1);
    expect(hitls[0].kind).toBe("hook_trip");
    expect(hitls[0].stepId).toBe("agent");
    expect((hitls[0].schema as { rule?: string }).rule).toBe("repetition");
  });

  it("halt + checkpoint EXECUTOR_UNAVAILABLE: stranded → Crashed, no HITL", async () => {
    await seedProject();
    const runId = await seedRunningAgent();
    const api = fakeApi([hookTrip("halt", "repetition")]);

    api.checkpointSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );

    await consumeAgentSession({ db, api, runId, sessionId: "sup-1" });

    expect(api.checkpointSpy).toHaveBeenCalledWith("sup-1");
    const run = await getRun(runId);

    // Recoverable Crashed (surfaced for a human), NEVER a silent Done.
    expect(run.status).toBe("Crashed");
    expect(await getHitl(runId)).toHaveLength(0);
  });

  it("deny: record-only — no escalate, run stays Running, no HITL", async () => {
    await seedProject();
    const runId = await seedRunningAgent();
    const api = fakeApi([hookTrip("deny", "path_guard")]);

    await consumeAgentSession({ db, api, runId, sessionId: "sup-1" });

    expect(api.checkpointSpy).not.toHaveBeenCalled();
    const run = await getRun(runId);

    expect(run.status).toBe("Running");
    expect(await getHitl(runId)).toHaveLength(0);
  });
});
