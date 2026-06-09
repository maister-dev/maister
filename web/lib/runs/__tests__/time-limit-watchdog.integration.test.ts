// M11c Phase 3B — time-limit kill-on-cap watchdog (limits.maxDurationMinutes).
// Agent-agnostic, inherently enforced (NOT subject to the strict/instruct
// table). The watchdog reuses the keep-alive / scheduler sweep: for a `Running`
// node whose effective `limits.maxDurationMinutes` is exceeded (elapsed from the
// active node_attempts.started_at, full-µs), it terminates via supervisor
// `DELETE /sessions/:id`, marks the node `Failed`, and ends the run terminal.
//
// Seam (confirmed by reading lib/runs/keepalive-sweeper.ts): the public entry
// is `runSweepTick({ db })`. The watchdog folds in as a new pass. Tests drive
// the public `runSweepTick`; if the implementor instead exposes a dedicated
// `runTimeLimitPass`, swap the import — the seeding + assertions are the
// contract either way. See "Seam decisions" in the tester report.

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

// Supervisor seam: the watchdog must call deleteSession to tear the agent down
// (the DELETE drives teardown so no permission deferred leaks). listSessions is
// how the run is matched to a live supervisor session (mirrors pass 1).
const deleteSessionSpy = vi.fn(async (_id: string) => undefined);
const listSessionsSpy = vi.fn(async () => [] as unknown[]);
const checkpointSessionSpy = vi.fn(async (_id: string) => ({}) as unknown);

vi.mock("@/lib/supervisor-client", () => ({
  deleteSession: (id: string) => deleteSessionSpy(id),
  listSessions: () => listSessionsSpy(),
  checkpointSession: (id: string) => checkpointSessionSpy(id),
}));

// A watchdog kill frees a scheduler slot and promotes the next Pending run via
// a lazy import of runFlow; mock it to a spy so the dispatch is observable and
// no real flow execution runs in the test.
const runFlowSpy = vi.fn(async (_runId: string) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (id: string) => runFlowSpy(id),
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

// A graph manifest with an ai_coding node carrying the given limits (duration
// cap, cost cap, both, or none).
function manifestWithLimits(limits?: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
}): unknown {
  const inner: Record<string, number> = {};

  if (limits?.maxDurationMinutes !== undefined) {
    inner.maxDurationMinutes = limits.maxDurationMinutes;
  }
  if (limits?.maxCostUsd !== undefined) {
    inner.maxCostUsd = limits.maxCostUsd;
  }

  const settings = Object.keys(inner).length === 0 ? {} : { limits: inner };

  return {
    schemaVersion: 1,
    name: "g",
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement" },
        transitions: { success: "done" },
        settings,
      },
    ],
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("watchdog_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: "wd-app",
    name: "Watchdog App",
    repoPath: "/repos/wd-app",
    maisterYamlPath: "/repos/wd-app/maister.yaml",
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
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.flows);
  deleteSessionSpy.mockClear();
  deleteSessionSpy.mockReset();
  deleteSessionSpy.mockResolvedValue(undefined);
  listSessionsSpy.mockReset();
  listSessionsSpy.mockResolvedValue([]);
  checkpointSessionSpy.mockReset();
  runFlowSpy.mockClear();
});

// Seed a Running run with one active node_attempts row. `attemptStartedAt`
// controls the watchdog's elapsed calculation. `acpSessionId` ties the run to a
// live supervisor session record.
async function seedRunningNode(opts: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
  attemptStartedAt: Date;
  acpSessionId: string | null;
}): Promise<{ runId: string; supervisorSessionId: string }> {
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const supervisorSessionId = `sup-${runId.slice(0, 8)}`;

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: manifestWithLimits({
      maxDurationMinutes: opts.maxDurationMinutes,
      maxCostUsd: opts.maxCostUsd,
    }),
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
    currentStepId: "implement",
    acpSessionId: opts.acpSessionId,
    startedAt: opts.attemptStartedAt,
  });
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    startedAt: opts.attemptStartedAt,
  });

  return { runId, supervisorSessionId };
}

// The watchdog matches a live session by the server-owned (runId, stepId), not
// by acp_session_id (which the runner persists only after the prompt returns).
function liveSessionRecord(
  runId: string,
  supervisorSessionId: string,
  acpSessionId?: string,
) {
  return {
    sessionId: supervisorSessionId,
    runId,
    projectSlug: "wd-app",
    stepId: "implement",
    status: "live" as const,
    pid: 1,
    startedAt: "",
    logPath: "",
    monotonicId: 0,
    acpSessionId,
  };
}

// A queued Pending run (no worktree/attempt needed) used to assert the watchdog
// promotes queued work after a kill frees a scheduler slot.
async function seedPendingRun(startedAt: Date): Promise<string> {
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g-pending",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g-pending",
    manifest: manifestWithLimits({}),
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Pending",
    startedAt,
  });

  return runId;
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

async function getAttempt(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId));

  return rows[0];
}

describe("time-limit watchdog — kill-on-cap (3B.1 / 3B.2)", () => {
  it("kills a run past maxDurationMinutes: deleteSession called, node Failed, run terminal Failed", async () => {
    const acp = "acp-over";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      // 30 minutes ago → well past the 10-minute cap.
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db });

    // Supervisor session torn down (DELETE drives teardown → no leaked
    // permission deferred).
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);

    const run = await getRun(runId);

    expect(run.status).toBe("Failed");

    const attempt = await getAttempt(runId);

    expect(attempt.status).toBe("Failed");
    expect(attempt.errorCode).not.toBeNull();
  }, 60_000);

  it("does NOT kill a run under the cap", async () => {
    const acp = "acp-under";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 60,
      // 1 minute ago → far under the 60-minute cap.
      attemptStartedAt: new Date(Date.now() - 60_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("never arms the watchdog for a node with no limits (no false kill)", async () => {
    const acp = "acp-nolimits";
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: undefined,
      // Ancient start — but with no limits the watchdog must never fire.
      attemptStartedAt: new Date(Date.now() - 24 * 3600_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
  }, 60_000);

  it("never kills on a cost cap alone — maxCostUsd is record-only", async () => {
    const acp = "acp-cost";
    const { runId, supervisorSessionId } = await seedRunningNode({
      // Cost cap only, NO duration cap; ancient start so a duration cap WOULD
      // have fired — proving cost never arms the watchdog.
      maxCostUsd: 0.01,
      attemptStartedAt: new Date(Date.now() - 24 * 3600_000),
      acpSessionId: acp,
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, acp),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("kills a capped node with no acp_session_id (deleteSession skipped, run still Failed)", async () => {
    // A node that exceeded its duration cap but never reported an
    // acp_session_id MUST still be terminated; deleteSession is best-effort and
    // is skipped when no live session matches (regression guard for the
    // acp_session_id candidate filter).
    const { runId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    listSessionsSpy.mockResolvedValue([]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Failed");

    const attempt = await getAttempt(runId);

    expect(attempt.status).toBe("Failed");
    expect(attempt.errorCode).not.toBeNull();
  }, 60_000);

  it("tears down a mid-prompt over-cap session even when acp_session_id is still null (matched by runId+stepId)", async () => {
    // The dangerous path: the run is over cap while the node prompt is still
    // running, so runs.acp_session_id has NOT been persisted yet — but a live
    // supervisor session exists. Matching by (runId, stepId) MUST find and kill
    // it, otherwise the run is marked Failed while the agent keeps running.
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: null,
    });

    listSessionsSpy.mockResolvedValue([
      // No acpSessionId on the record either — matched purely by runId+stepId.
      liveSessionRecord(runId, supervisorSessionId),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect(deleteSessionSpy).toHaveBeenCalledWith(supervisorSessionId);
    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getAttempt(runId)).status).toBe("Failed");
  }, 60_000);

  it("leaves the run Running (retries next tick) when deleteSession fails with a retryable 5xx", async () => {
    // Marking Failed without confirming teardown is split-brain (terminal run,
    // live agent). A retryable supervisor failure must leave the run Running.
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: "acp-5xx",
    });

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, "acp-5xx"),
    ]);
    deleteSessionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503"),
    );

    await runSweepTick({ db });

    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect((await getRun(runId)).status).toBe("Running");
    expect((await getAttempt(runId)).status).toBe("Running");
  }, 60_000);

  it("promotes a queued Pending run after a timeout kill frees the slot", async () => {
    const { runId, supervisorSessionId } = await seedRunningNode({
      maxDurationMinutes: 10,
      attemptStartedAt: new Date(Date.now() - 30 * 60_000),
      acpSessionId: "acp-promote",
    });
    const pendingRunId = await seedPendingRun(new Date(Date.now() - 60_000));

    listSessionsSpy.mockResolvedValue([
      liveSessionRecord(runId, supervisorSessionId, "acp-promote"),
    ]);

    await runSweepTick({ db });

    // The capped run is terminal Failed; the freed slot promotes the Pending
    // run to Running AND dispatches runFlow for it (F3).
    expect((await getRun(runId)).status).toBe("Failed");
    expect((await getRun(pendingRunId)).status).toBe("Running");

    // runFlow is dispatched via queueMicrotask inside promoteNextPending; flush
    // the task queue before asserting the dispatch fired.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runFlowSpy).toHaveBeenCalledWith(pendingRunId);
  }, 60_000);
});
