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

let runSweepTick: (opts?: { db?: unknown }) => Promise<unknown>;

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;

// A graph manifest with an ai_coding node carrying a 10-minute cap.
function manifestWithCap(maxDurationMinutes?: number): unknown {
  const settings =
    maxDurationMinutes === undefined ? {} : { limits: { maxDurationMinutes } };

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
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

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
  listSessionsSpy.mockReset();
  listSessionsSpy.mockResolvedValue([]);
  checkpointSessionSpy.mockReset();
});

// Seed a Running run with one active node_attempts row. `attemptStartedAt`
// controls the watchdog's elapsed calculation. `acpSessionId` ties the run to a
// live supervisor session record.
async function seedRunningNode(opts: {
  maxDurationMinutes?: number;
  attemptStartedAt: Date;
  acpSessionId: string;
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
    manifest: manifestWithCap(opts.maxDurationMinutes),
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
    executorId,
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

function liveSessionRecord(acpSessionId: string, supervisorSessionId: string) {
  return {
    sessionId: supervisorSessionId,
    runId: "ignored",
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
      liveSessionRecord(acp, supervisorSessionId),
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
      liveSessionRecord(acp, supervisorSessionId),
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
      liveSessionRecord(acp, supervisorSessionId),
    ]);

    await runSweepTick({ db });

    expect(deleteSessionSpy).not.toHaveBeenCalled();
    expect((await getRun(runId)).status).toBe("Running");
  }, 60_000);
});
