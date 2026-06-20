// M36 (ADR-095) T5.1: the orchestrator park-vs-complete decision + the park-time
// checkpoint + slot-release, end-to-end through the real graph runner. The agent
// turn is scripted to end NORMALLY (ok:true, needsInput unset) — so the REAL
// `runOrchestratorStep` decision runs from the run's pending children (NOT a
// forced needsInput like orchestrator-node.integration.test). Asserts:
//   - 1 pending child  → parks on WaitingOnChildren, acp_session_id retained,
//     the live supervisor session is checkpointed (SIGTERM) AND releaseSlotOnIdle
//     fires (the parked coordinator must not hold a cap slot);
//   - 0 pending children → the node completes (success → transition downstream),
//     the run ends Review, NOT WaitingOnChildren.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

// A scripted coordinator whose single turn ends NORMALLY (clean end_turn).
// runOrchestratorStep then makes the park-vs-complete call from pending children.
vi.mock("@/lib/flows/runner-agent", () => ({
  runAgentStep: vi.fn(async () => ({
    ok: true,
    stdout: "",
    vars: {},
    durationMs: 1,
    acpSessionId: "acp-coordinator-1",
  })),
}));

// Supervisor seam: listSessions returns a live session keyed on the coordinator's
// acp handle so the park-time checkpoint path is exercised; checkpointSession is a
// spy. Partial mock (importOriginal) so the rest of the client surface that other
// modules import transitively stays intact.
const checkpointCalls: string[] = [];

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    listSessions: vi.fn(async () => [
      {
        sessionId: "sup-coordinator-1",
        runId: "ignored",
        projectSlug: "ignored",
        stepId: "coordinate",
        status: "live",
        pid: 1,
        startedAt: new Date().toISOString(),
        logPath: "/tmp/x.log",
        monotonicId: 1,
        acpSessionId: "acp-coordinator-1",
      },
    ]),
    checkpointSession: vi.fn(async (sessionId: string) => {
      checkpointCalls.push(sessionId);

      return { alreadyCheckpointed: false, sessionId, monotonicId: 1 };
    }),
  };
});

// Scheduler seam: spy releaseSlotOnIdle (assert the park frees the slot) but keep
// promoteNextPending a real no-op against the empty queue.
const releaseSlotSpy = vi.fn(async () => ({ promotedRunId: null }));

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    releaseSlotOnIdle: (_args: { runId: string; db?: unknown }) =>
      releaseSlotSpy(),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_orc_park")
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
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(() => {
  checkpointCalls.splice(0);
  releaseSlotSpy.mockClear();
});

afterEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "tasks"`);
});

const orchestratorFlow = {
  schemaVersion: 1,
  name: "Orchestrator",
  compat: { engine_min: "1.6.0" },
  nodes: [
    {
      id: "coordinate",
      type: "orchestrator",
      action: { prompt: "/coordinate the delivery" },
      transitions: { success: "done" },
    },
  ],
};

let projectId: string;
let executorId: string;
let flowId: string;

async function seedOrchestratorRun(): Promise<{ runId: string }> {
  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const projectSlug = `proj-${projectId.slice(0, 8)}`;

  const repo = await mkdtemp(join(tmpdir(), "maister-orcp-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-orcp-wt-"));

  createdPaths.push(repo, wtRoot);

  const worktree = join(wtRoot, runId);
  const branch = `maister/${runId.slice(0, 8)}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectSlug,
    name: "Test",
    repoPath: repo,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "orc",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/orc",
    manifest: orchestratorFlow,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
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
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch,
    worktreePath: worktree,
    parentRepoPath: repo,
    baseBranch: "main",
  });

  return { runId };
}

// A child run under the orchestrator at the given status.
async function seedChild(parentRunId: string, status: string): Promise<void> {
  const childTaskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: childTaskId,
    projectId,
    title: "child",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: randomUUID(),
    taskId: childTaskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status,
    parentRunId,
    rootRunId: parentRunId,
  });
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

describe("orchestrator park-vs-complete (M36 T5.1)", () => {
  it("parks on WaitingOnChildren when a pending child exists; checkpoints + releases the slot", async () => {
    const { runId } = await seedOrchestratorRun();

    await seedChild(runId, "Running"); // one pending (non-terminal) child

    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, { db, runtimeRoot: process.cwd() });

    const run = await getRun(runId);

    expect(run.status).toBe("WaitingOnChildren");
    expect(run.currentStepId).toBe("coordinate");
    expect(run.acpSessionId).toBe("acp-coordinator-1");

    // The live session was checkpointed (SIGTERM) at park.
    expect(checkpointCalls).toEqual(["sup-coordinator-1"]);
    // The slot was released so the parked coordinator does not hold the cap.
    expect(releaseSlotSpy).toHaveBeenCalledTimes(1);
  });

  it("completes the node (transition downstream, run Review) when NO pending children", async () => {
    const { runId } = await seedOrchestratorRun();

    // A child that already finished — terminal, so NOT pending.
    await seedChild(runId, "Done");

    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, { db, runtimeRoot: process.cwd() });

    const run = await getRun(runId);

    // No pending children → the orchestrator node completed → terminal Review.
    expect(run.status).toBe("Review");
    expect(run.currentStepId).toBeNull();

    // No park ⇒ no checkpoint, no idle slot-release.
    expect(checkpointCalls).toEqual([]);
    expect(releaseSlotSpy).not.toHaveBeenCalled();
  });
});
