// ADR-138 (Task 11): branch-sync crash-window recovery — reconcile arms (W2/W3),
// the system-sweep W1/W4 orphan-op + W5 active-time duration cap, and the
// in-process driver registry (the skip-vs-abort discriminant). The supervisor
// boundary is injected via opts (deleteSession/listSessions); no live agent.

import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// promoteNextPending is the slot-release contract; stub it (no spawn side effects).
vi.mock("@/lib/scheduler", async (orig) => {
  const actual = await orig<typeof import("@/lib/scheduler")>();

  return { ...actual, promoteNextPending: vi.fn(async () => undefined) };
});

const {
  recoverSyncAttemptOnReconcile,
  runSyncRecoverySweep,
  SYNC_ATTEMPT_MAX_MINUTES,
} = await import("@/lib/runs/sync-recovery");
const { registerSyncDriver, unregisterSyncDriver, hasSyncDriver } =
  await import("@/lib/runs/sync-driver-registry");

let testDatabase: StartedPostgresTestDb;
let pool: Pool;

function newId(): string {
  return randomUUID();
}

async function seedGraph(): Promise<{
  projectId: string;
  flowId: string;
  taskId: string;
}> {
  const projectId = newId();
  const flowId = newId();
  const taskId = newId();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `rec-${short}`,
      `Rec ${short}`,
      `/tmp/rec-${short}`,
      `T${short.toUpperCase()}`,
    ],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1.0.0', '/tmp/flows/bugfix', '{"schemaVersion":1,"name":"B","nodes":[]}', 1)`,
    [flowId, projectId],
  );
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id)
     values ($1, $2, 1, 'Rec task', 'x', $3)`,
    [taskId, projectId, flowId],
  );

  return { projectId, flowId, taskId };
}

async function seedRunAttempt(opts: {
  status: string;
  mode: "mechanical" | "agent";
  phase: string;
  agentRunningSince?: Date | null;
}): Promise<{ runId: string; workspaceId: string; attemptId: string }> {
  const { projectId, taskId } = await seedGraph();
  const runId = newId();
  const workspaceId = newId();
  const attemptId = newId();

  await pool.query(
    `insert into runs (id, project_id, task_id, run_kind, status, flow_version, flow_revision, started_at)
     values ($1, $2, $3, 'flow', $4, 'v1', 'manual', now())`,
    [runId, projectId, taskId, opts.status],
  );
  await pool.query(
    `insert into workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, lifecycle_operation_name, lifecycle_operation_state)
     values ($1, $2, $3, 'maister/rec', $4, '/tmp/repo', 'sync', 'claiming')`,
    [workspaceId, runId, projectId, `/tmp/wt-${workspaceId.slice(0, 8)}`],
  );
  await pool.query(
    `insert into run_sync_attempts (id, run_id, workspace_id, attempt, strategy, mode, phase, agent_running_since, head_sha_before)
     values ($1, $2, $3, 1, 'rebase', $4, $5, $6, NULL)`,
    [
      attemptId,
      runId,
      workspaceId,
      opts.mode,
      opts.phase,
      opts.agentRunningSince ?? null,
    ],
  );

  return { runId, workspaceId, attemptId };
}

async function readRunStatus(runId: string): Promise<string> {
  const r = await pool.query(`select status from runs where id = $1`, [runId]);

  return r.rows[0].status;
}

async function readAttemptPhase(id: string): Promise<string> {
  const r = await pool.query(
    `select phase from run_sync_attempts where id = $1`,
    [id],
  );

  return r.rows[0].phase;
}

const noSessions = async (): Promise<SupervisorSessionRecord[]> => [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "sync_recovery_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const id of [...hasSyncDriverIds()]) unregisterSyncDriver(id);
});

// Track registered ids so beforeEach can clear the module-level registry.
const registered = new Set<string>();

function register(runId: string): void {
  registered.add(runId);
  registerSyncDriver(runId);
}

function hasSyncDriverIds(): string[] {
  return [...registered];
}

describe("sync-driver registry", () => {
  it("tracks membership and clears on unregister", () => {
    const runId = newId();

    expect(hasSyncDriver(runId)).toBe(false);
    registerSyncDriver(runId);
    expect(hasSyncDriver(runId)).toBe(true);
    unregisterSyncDriver(runId);
    expect(hasSyncDriver(runId)).toBe(false);
  });
});

describe("runSyncRecoverySweep — W5 active-time duration cap", () => {
  it("kills a Running agent_running attempt past the cap and returns the run to Review", async () => {
    const past = new Date(Date.now() - (SYNC_ATTEMPT_MAX_MINUTES + 1) * 60_000);
    const { runId, attemptId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: past,
    });
    const deleteSession = vi.fn(async () => undefined);

    const summary = await runSyncRecoverySweep({
      db,
      deleteSession,
      listSessions: noSessions,
    });

    expect(summary.durationCapKilled).toBe(1);
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });

  it("does NOT kill a recently-active resolver (within the cap)", async () => {
    const recent = new Date(Date.now() - 5 * 60_000);
    const { runId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: recent,
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.durationCapKilled).toBe(0);
    expect(await readRunStatus(runId)).toBe("Running");
  });

  it("does NOT kill a resolver paused in NeedsInput (human-wait time never counts)", async () => {
    const past = new Date(
      Date.now() - (SYNC_ATTEMPT_MAX_MINUTES + 10) * 60_000,
    );
    const { runId } = await seedRunAttempt({
      status: "NeedsInput",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: past,
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.durationCapKilled).toBe(0);
    expect(await readRunStatus(runId)).toBe("NeedsInput");
  });
});

describe("runSyncRecoverySweep — W1/W4 orphan + skip-vs-abort discriminant", () => {
  it("aborts an orphaned mechanical rebasing attempt with NO in-proc driver", async () => {
    const { attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "rebasing",
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });

  it("SKIPS a mechanical starting attempt when an in-proc driver owns it (periodic sweep)", async () => {
    const { runId, attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "starting",
    });

    register(runId);

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(0);
    expect(await readAttemptPhase(attemptId)).toBe("starting");
  });
});

describe("recoverSyncAttemptOnReconcile — W2 orphaned live session", () => {
  it("deletes the orphaned session, fails the attempt, and CASes the run to Review", async () => {
    const { runId, attemptId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: new Date(),
    });
    const deleteSession = vi.fn(async () => undefined);

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: "sess-orphan",
      db,
      deleteSession,
    });

    expect(result.window).toBe("w2");
    expect(deleteSession).toHaveBeenCalledWith("sess-orphan");
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });
});
