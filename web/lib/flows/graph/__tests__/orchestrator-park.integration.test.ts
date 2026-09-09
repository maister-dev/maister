// M37 (ADR-098) T5.1: the orchestrator park-vs-complete decision + the park-time
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

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  fakeGraphHosts,
  fencedError,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

// A scripted coordinator whose single turn ends NORMALLY (clean end_turn).
// runOrchestratorStep then makes the park-vs-complete call from pending children.
vi.mock("@/lib/flows/runner-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/flows/runner-agent")>()),
  runAgentStep: vi.fn(async () => ({
    ok: true,
    stdout: "",
    vars: {},
    durationMs: 1,
    acpSessionId: "acp-coordinator-1",
  })),
}));

// Execution-host seam (ADR-166): the coordinator's live host session is
// pre-registered on a fake execution host under the id the create ack persisted
// to `run_sessions.host_session_id`, so the park-time checkpoint goes through
// the run's bound client and is observable as a `session.checkpoint` command.
const COORDINATOR_HOST_SESSION_ID = "sup-coordinator-1";

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

let testDatabase: StartedPostgresTestDb;
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
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test_orc_park",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(() => {
  releaseSlotSpy.mockClear();
});

afterEach(async () => {
  await pool.query(`DELETE FROM "execution_commands"`);
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
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    hostSessionId: COORDINATOR_HOST_SESSION_ID,
    acpSessionId: "acp-coordinator-1",
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

async function bindCoordinatorHost(runId: string): Promise<{
  hosts: Awaited<ReturnType<typeof fakeGraphHosts>>["hosts"];
  fake: FakeExecutionHost;
}> {
  const { hosts, fake } = await fakeGraphHosts(db, runId);

  fake.sessions.set(COORDINATOR_HOST_SESSION_ID, {
    sessionId: COORDINATOR_HOST_SESSION_ID,
    runId,
    stepId: "coordinate",
    acpSessionId: "acp-coordinator-1",
    executionWorkspaceId: "ws_seeded",
    assignmentEpoch: 1,
    createdByCommandId: "seeded",
    status: "live",
  });

  return { hosts, fake };
}

function checkpointedSessionIds(fake: FakeExecutionHost): string[] {
  return fake
    .callsOf("checkpointSession")
    .map((call) => call.args[0] as string);
}

// A child run under the orchestrator at the given status.
async function seedChild(parentRunId: string, status: string): Promise<void> {
  const childTaskId = randomUUID();
  const childRunId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: childTaskId,
    projectId,
    title: "child",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: childRunId,
    taskId: childTaskId,
    projectId,
    flowId,
    flowVersion: "v1.0.0",
    status,
    parentRunId,
    rootRunId: parentRunId,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId: childRunId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

describe("orchestrator park-vs-complete (M37 T5.1)", () => {
  it("parks on WaitingOnChildren when a pending child exists; checkpoints + releases the slot", async () => {
    const { runId } = await seedOrchestratorRun();

    await seedChild(runId, "Running"); // one pending (non-terminal) child
    const { hosts, fake } = await bindCoordinatorHost(runId);

    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });

    const run = await getRun(runId);

    expect(run.status).toBe("WaitingOnChildren");
    expect(run.currentStepId).toBe("coordinate");
    // M42 (ADR-114): the retained resume handle lives on the run's default
    // run_sessions row, not a run-level mirror column.
    const session = await loadActiveRunSession(db, runId);

    expect(session?.acpSessionId).toBe("acp-coordinator-1");

    // The live session was checkpointed (SIGTERM) at park, addressed by the
    // persisted host session id through the run's bound client.
    expect(checkpointedSessionIds(fake)).toEqual([COORDINATOR_HOST_SESSION_ID]);
    expect(fake.sessions.get(COORDINATOR_HOST_SESSION_ID)?.status).toBe(
      "exited",
    );
    // The slot was released so the parked coordinator does not hold the cap.
    expect(releaseSlotSpy).toHaveBeenCalledTimes(1);
  });

  // ADR-166 E-EH-11: a fenced park checkpoint means a newer driver generation
  // owns the run — this driver yields: no slot release, no default artifacts.
  it("a fenced park checkpoint yields — no slot release, no default artifacts", async () => {
    const { runId } = await seedOrchestratorRun();

    await seedChild(runId, "Running");
    const { hosts, fake } = await bindCoordinatorHost(runId);

    fake.failOnce("checkpointSession", fencedError(runId, 1));

    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });

    // The checkpoint fence is checked before publishing a park. The old
    // driver cannot change status or record artifacts after losing authority.
    expect((await getRun(runId)).status).toBe("Running");
    expect(checkpointedSessionIds(fake)).toEqual([COORDINATOR_HOST_SESSION_ID]);
    expect(releaseSlotSpy).not.toHaveBeenCalled();
    const artifacts = await db
      .select({ id: schema.artifactInstances.id })
      .from(schema.artifactInstances)
      .where(eq(schema.artifactInstances.runId, runId));

    expect(artifacts).toHaveLength(0);
  });

  it("completes the node (transition downstream, run Review) when NO pending children", async () => {
    const { runId } = await seedOrchestratorRun();

    // A child that already finished — terminal, so NOT pending.
    await seedChild(runId, "Done");
    const { hosts, fake } = await bindCoordinatorHost(runId);

    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });

    const run = await getRun(runId);

    // No pending children → the orchestrator node completed → terminal Review.
    expect(run.status).toBe("Review");
    expect(run.currentStepId).toBeNull();

    // No park ⇒ no checkpoint, no idle slot-release.
    expect(checkpointedSessionIds(fake)).toEqual([]);
    expect(releaseSlotSpy).not.toHaveBeenCalled();
  });
});
