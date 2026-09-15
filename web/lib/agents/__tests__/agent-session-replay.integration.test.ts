// Re-observing an agent session after the process that observed it died is a
// replay of a DURABLE stream FROM THE BEGINNING — the new reader has no
// `lastEventId` to resume from. Every side effect on that path must therefore be
// idempotent. `recordAgentPermissionRequest` was not: it inserted a fresh
// `randomUUID()` row on every `session.permission_request` it saw, so a replay
// asked the human the same question twice and left an unanswerable row behind.
//
// The DB is a real testcontainer; the execution seam is the fake host (a real
// `BoundClient` over the run's real ACTIVE assignment, so the owned-permission
// path resolves exactly as it does in production) with an admin whose stream
// re-yields the same events on every call.

import type { SupervisorEvent, HostAdminClient } from "@/lib/execution-host";
import type {
  AgentExecution,
  consumeAgentSession as ConsumeFn,
} from "@/lib/agents/launch";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let consumeAgentSession: typeof ConsumeFn;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_session_replay_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ consumeAgentSession } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

afterEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

const SESSION_ID = "sup-replay";

function permissionEvent(monotonicId: number): SupervisorEvent {
  return {
    type: "session.permission_request",
    sessionId: SESSION_ID,
    monotonicId,
    requestId: "req-7",
    toolCall: { toolCallId: "call-1", title: "write file", kind: "edit" },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  } as SupervisorEvent;
}

/** An admin surface whose stream re-yields the same events on EVERY call —
 * the shape a fresh observer sees when it re-enters a durable log with no
 * resume point. */
function replayingAdmin(events: SupervisorEvent[]): HostAdminClient {
  return {
    async *streamSession(): AsyncGenerator<SupervisorEvent> {
      for (const event of events) yield event;
    },
  } as unknown as HostAdminClient;
}

async function seedRunningAgent(): Promise<{
  runId: string;
  execution: AgentExecution;
}> {
  const runId = randomUUID();
  const projectId = randomUUID();
  const runnerId = randomUUID();

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
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status",
       "flow_version", "flow_revision", "agent_workspace")
     VALUES ($1, 'agent', $2, 'Running', 'agent', 'manual', 'none')`,
    [runId, projectId],
  );
  await (db as any).insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: { capabilityAgent: "claude" },
    hostSessionId: SESSION_ID,
  });

  // The run's real ACTIVE assignment — without it the owned-permission recorder
  // short-circuits and the UNOWNED recorder under test is never reached.
  const { hosts, assignment } = await fakeExecutionHosts(db, { runId });
  const bound = await hosts.executionFor(runId, {
    assignmentId: assignment!.id,
  });

  return {
    runId,
    execution: {
      client: bound.client,
      admin: replayingAdmin([permissionEvent(1)]),
    },
  };
}

async function permissionRows(runId: string): Promise<any[]> {
  return db
    .select()
    .from(schema.hitlRequests)
    .where(
      and(
        eq(schema.hitlRequests.runId, runId),
        eq(schema.hitlRequests.kind, "permission"),
      ),
    );
}

describe("re-observing an agent session replays the stream idempotently", () => {
  it("a second observation of the same permission does not open a second HITL request", async () => {
    const { runId, execution } = await seedRunningAgent();

    await consumeAgentSession({ db, execution, runId, sessionId: SESSION_ID });

    const first = await permissionRows(runId);

    expect(first).toHaveLength(1);
    expect(
      (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]
        .status,
    ).toBe("NeedsInput");

    // The web process dies here; a sweep puts a NEW observer on the same live
    // session, which re-enters the stream from its first event.
    await consumeAgentSession({ db, execution, runId, sessionId: SESSION_ID });

    const second = await permissionRows(runId);

    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    // A replay is not a new decision: the reader was already told about this
    // one, so it must not be announced twice either.
    expect(
      await db
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.runId, runId),
            eq(schema.domainEvents.kind, "run.needs_input"),
          ),
        ),
    ).toHaveLength(1);
  }, 120_000);

  it("the replay delivers no input — the open request still awaits its human", async () => {
    const { runId, execution } = await seedRunningAgent();

    await consumeAgentSession({ db, execution, runId, sessionId: SESSION_ID });
    await consumeAgentSession({ db, execution, runId, sessionId: SESSION_ID });

    const [row] = await permissionRows(runId);

    expect(row.respondedAt).toBeNull();
    expect(row.response).toBeNull();
    expect(
      await db
        .select()
        .from(schema.executionCommands)
        .where(
          and(
            eq(schema.executionCommands.runId, runId),
            eq(schema.executionCommands.kind, "session.input"),
          ),
        ),
    ).toHaveLength(0);
  }, 120_000);
});
