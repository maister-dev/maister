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

import type { DomainEventRow } from "@/lib/db/schema";

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

import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { ConsensusGenerationPending } from "@/lib/flows/graph/consensus/prompt-owner";
import {
  readCoordinatorWakeIntent,
  wakeParkedCoordinator,
} from "@/lib/flows/graph/coordinator-wake";
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
const runConsensusNode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/flows/graph/consensus/runtime", () => ({ runConsensusNode }));

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
const consensusFlow = {
  schemaVersion: 1,
  name: "Consensus",
  compat: { engine_min: "1.5.0" },
  nodes: [
    {
      id: "decide",
      type: "consensus",
      prompt: "Choose a plan",
      participants: [
        { id: "architect", runner: "claude" },
        { id: "qa", runner: "claude" },
      ],
      material_axes: ["scope"],
      rounds: { mode: "single_pass", max: 1 },
      synthesizer: { runner: "claude" },
      output: {
        produces: [
          { id: "consensus_plan", kind: "plan", current: true },
          { id: "debate_log", kind: "human_note", current: true },
        ],
      },
      transitions: { success: "done" },
    },
  ],
};

let projectId: string;
let executorId: string;
let flowId: string;

async function seedOrchestratorRun(
  manifest: unknown = orchestratorFlow,
): Promise<{ runId: string }> {
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
    manifest,
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

async function bindCoordinatorHost(
  runId: string,
  stepId = "coordinate",
): Promise<{
  hosts: Awaited<ReturnType<typeof fakeGraphHosts>>["hosts"];
  fake: FakeExecutionHost;
}> {
  const { hosts, fake } = await fakeGraphHosts(db, runId);

  fake.sessions.set(COORDINATOR_HOST_SESSION_ID, {
    sessionId: COORDINATOR_HOST_SESSION_ID,
    runId,
    stepId,
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
async function seedChild(
  parentRunId: string,
  status: string,
): Promise<{ runId: string; taskId: string }> {
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

  return { runId: childRunId, taskId: childTaskId };
}

// A woken coordinator re-materializes its node before re-parking.
const RE_ENTRY_POLL = { timeout: 10_000, interval: 100 };

function startWorker(
  hosts: Awaited<ReturnType<typeof fakeGraphHosts>>["hosts"],
): ReturnType<typeof startFlowContinuationWorker> {
  return startFlowContinuationWorker({
    db: db as unknown as Parameters<
      typeof startFlowContinuationWorker
    >[0]["db"],
    runtimeRoot: process.cwd(),
    executionHosts: hosts,
  });
}

async function failChild(
  parentRunId: string,
  child: { runId: string; taskId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, child.runId));
    await emitDomainEvent({
      db: tx,
      kind: "run.failed",
      projectId,
      taskId: child.taskId,
      runId: child.runId,
      actor: { type: "system", id: null },
      parentRunId,
      payload: { runKind: "agent", status: "Failed" },
    });
  });
}

async function waitResumeCount(runId: string): Promise<number> {
  const assignments = await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId));

  return assignments.filter((row) => row.placementReason === "wait_resume")
    .length;
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

describe("orchestrator park-vs-complete (M37 T5.1)", () => {
  it("yields a typed pending consensus generation without failing its node", async () => {
    runConsensusNode.mockReset();
    runConsensusNode.mockRejectedValueOnce(
      new ConsensusGenerationPending("pending-verdict"),
    );
    const { runId } = await seedOrchestratorRun(consensusFlow);
    const { hosts } = await bindCoordinatorHost(runId, "decide");
    const { runFlow } = await import("@/lib/flows/runner");

    try {
      await runFlow(runId, {
        db,
        runtimeRoot: process.cwd(),
        executionHosts: hosts,
      });
      expect((await getRun(runId)).status).toBe("Running");
      const attempts = await db
        .select()
        .from(schema.nodeAttempts)
        .where(eq(schema.nodeAttempts.runId, runId));

      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        nodeType: "consensus",
        status: "Running",
      });
    } finally {
      runConsensusNode.mockReset();
    }
  }, 90_000);
  it("keeps a failed-child wake intent until the woken coordinator's turn starts", async () => {
    const { runId } = await seedOrchestratorRun();
    const failed = await seedChild(runId, "Running");

    await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    expect((await getRun(runId)).status).toBe("WaitingOnChildren");
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, failed.runId));
    await emitDomainEvent({
      db,
      kind: "run.failed",
      projectId,
      taskId: failed.taskId,
      runId: failed.runId,
      actor: { type: "system", id: null },
      parentRunId: runId,
      payload: { runKind: "agent", status: "Failed" },
    });
    const [event] = (await db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.runId, failed.runId))) as DomainEventRow[];
    const resumed: string[] = [];

    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (candidate) => {
        resumed.push(candidate);
      },
    });

    await consumer.handle([event]);
    expect(resumed).toEqual([runId]);
    expect((await getRun(runId)).status).toBe("Running");
    await consumer.handle([event]);
    expect(resumed).toEqual([runId]);
    expect(await getRun(runId)).toMatchObject({
      resumeRequestedAt: null,
      failedChildWakeAt: expect.any(Date),
    });
    expect(
      await readCoordinatorWakeIntent(
        db as unknown as Parameters<typeof readCoordinatorWakeIntent>[0],
        runId,
      ),
    ).toEqual({
      nodeId: "coordinate",
      nodeType: "orchestrator",
    });
  }, 90_000);
  it("honors a failed child settled while its coordinator waits on its own HITL", async () => {
    const { runId } = await seedOrchestratorRun();
    const failed = await seedChild(runId, "Running");
    const sibling = await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runAgentStep } = await import("@/lib/flows/runner-agent");
    let duringHitl: Record<string, unknown> | undefined;

    vi.mocked(runAgentStep).mockImplementationOnce(async () => {
      // A permission request pauses the live turn; a child fails meanwhile.
      await db
        .update(schema.runs)
        .set({ status: "NeedsInput" })
        .where(eq(schema.runs.id, runId));
      await failChild(runId, failed);
      duringHitl = await getRun(runId);
      await db
        .update(schema.runs)
        .set({ status: "Running" })
        .where(eq(schema.runs.id, runId));

      return {
        ok: true,
        stdout: "",
        vars: {},
        durationMs: 1,
        acpSessionId: "acp-coordinator-1",
      };
    });
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    expect(duringHitl).toMatchObject({
      status: "NeedsInput",
      failedChildWakeAt: expect.any(Date),
      resumeRequestedAt: null,
    });
    await expect.poll(() => waitResumeCount(runId), RE_ENTRY_POLL).toBe(1);
    await expect
      .poll(async () => {
        const parent = await getRun(runId);

        return [parent.status, parent.failedChildWakeAt];
      }, RE_ENTRY_POLL)
      .toEqual(["WaitingOnChildren", null]);
    expect((await getRun(sibling.runId)).status).toBe("Running");
  }, 90_000);
  it("keeps a failed-child intent out of answered-idle C3 admission", async () => {
    const { runId } = await seedOrchestratorRun();
    const failed = await seedChild(runId, "Running");

    await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runAgentStep } = await import("@/lib/flows/runner-agent");
    const { markCheckpointed } = await import("@/lib/runs/state-transitions");
    const { promoteNextPending } = await import("@/lib/scheduler");
    const resumeRun = vi.fn(async () => {});
    const promoteRun = vi.fn(async () => {});
    let idle: Record<string, unknown> | undefined;

    vi.mocked(runAgentStep).mockImplementationOnce(async () => {
      // An unanswered permission request idles past its keep-alive window.
      await db
        .update(schema.runs)
        .set({ status: "NeedsInput" })
        .where(eq(schema.runs.id, runId));
      expect((await markCheckpointed(runId, { db })).ok).toBe(true);
      await failChild(runId, failed);
      idle = await getRun(runId);
      await promoteNextPending({
        db,
        pool: "flow",
        resumeRun,
        runFlow: promoteRun,
      });
      await new Promise((resolve) => setImmediate(resolve));

      return {
        ok: true,
        stdout: "",
        vars: {},
        durationMs: 1,
        acpSessionId: "acp-coordinator-1",
      };
    });
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    expect(idle).toMatchObject({
      status: "NeedsInputIdle",
      failedChildWakeAt: expect.any(Date),
      resumeRequestedAt: null,
    });
    expect(resumeRun).not.toHaveBeenCalled();
    expect(promoteRun).not.toHaveBeenCalled();
  }, 90_000);
  it("wakes a consensus coordinator whose last child settles before park", async () => {
    runConsensusNode.mockReset();
    runConsensusNode
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        vars: {},
        durationMs: 1,
        needsInput: true,
        waitsForChildren: true,
      })
      .mockResolvedValue({
        ok: false,
        stdout: "consensus children failed",
        vars: {},
        durationMs: 1,
        errorCode: "CRASH",
      });
    const { runId } = await seedOrchestratorRun(consensusFlow);
    const child = await seedChild(runId, "Running");
    const { hosts, fake } = await bindCoordinatorHost(runId, "decide");
    let entered!: () => void;
    let release!: () => void;
    const atCheckpoint = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    fake.onCall("checkpointSession", async () => {
      entered();
      await barrier;
    });
    const { runFlow } = await import("@/lib/flows/runner");
    const driving = runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });

    try {
      await atCheckpoint;
      await db
        .update(schema.runs)
        .set({ status: "Failed" })
        .where(eq(schema.runs.id, child.runId));
      await emitDomainEvent({
        db,
        kind: "run.failed",
        projectId,
        taskId: child.taskId,
        runId: child.runId,
        actor: { type: "system", id: null },
        parentRunId: runId,
        payload: { runKind: "agent", status: "Failed" },
      });
      const [event] = (await db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.runId, child.runId))) as DomainEventRow[];

      await buildOrchestratorResumeConsumer({ db }).handle([event]);
      expect((await getRun(runId)).status).toBe("Running");
    } finally {
      release();
    }
    await driving;
    const continuation = startWorker(hosts);

    try {
      await expect
        .poll(async () => (await getRun(runId)).status, { timeout: 10_000 })
        .toBe("Crashed");
      expect(runConsensusNode).toHaveBeenCalledTimes(2);
      expect(await waitResumeCount(runId)).toBe(1);
    } finally {
      await continuation.stop();
      runConsensusNode.mockReset();
    }
  }, 90_000);
  it("catches a settled child consumed while the coordinator is still parking", async () => {
    const { runId } = await seedOrchestratorRun();
    const child = await seedChild(runId, "Running");
    const { hosts, fake } = await bindCoordinatorHost(runId);
    let entered!: () => void;
    let release!: () => void;
    const atCheckpoint = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    fake.onCall("checkpointSession", async () => {
      entered();
      await barrier;
    });
    const { runFlow } = await import("@/lib/flows/runner");
    const driving = runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });

    try {
      await atCheckpoint;
      expect((await getRun(runId)).status).toBe("Running");
      await db
        .update(schema.runs)
        .set({ status: "Failed" })
        .where(eq(schema.runs.id, child.runId));
      await emitDomainEvent({
        db,
        kind: "run.failed",
        projectId,
        taskId: child.taskId,
        runId: child.runId,
        actor: { type: "system", id: null },
        parentRunId: runId,
        payload: { runKind: "agent", status: "Failed" },
      });
      const [event] = (await db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.runId, child.runId))) as DomainEventRow[];

      await buildOrchestratorResumeConsumer({ db }).handle([event]);
      expect((await getRun(runId)).status).toBe("Running");
    } finally {
      release();
    }
    await driving;
    await expect.poll(() => waitResumeCount(runId)).toBe(1);
    const continuation = startWorker(hosts);

    try {
      await expect
        .poll(async () => (await getRun(runId)).status, { timeout: 10_000 })
        .toBe("Review");
      expect(await waitResumeCount(runId)).toBe(1);
    } finally {
      await continuation.stop();
    }
  }, 90_000);
  it("wakes on an early failed child while another child is still pending", async () => {
    const { runId } = await seedOrchestratorRun();
    const first = await seedChild(runId, "Running");
    const second = await seedChild(runId, "Running");
    const { hosts, fake } = await bindCoordinatorHost(runId);
    let entered!: () => void;
    let release!: () => void;
    const atCheckpoint = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    fake.onCall("checkpointSession", async () => {
      entered();
      await barrier;
    });
    const { runFlow } = await import("@/lib/flows/runner");
    const driving = runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: (targetRunId, options) =>
        runFlow(targetRunId, {
          ...options,
          db,
          runtimeRoot: process.cwd(),
          executionHosts: hosts,
        }),
    });

    async function settle(child: {
      runId: string;
      taskId: string;
    }): Promise<void> {
      await db
        .update(schema.runs)
        .set({ status: "Failed" })
        .where(eq(schema.runs.id, child.runId));
      await emitDomainEvent({
        db,
        kind: "run.failed",
        projectId,
        taskId: child.taskId,
        runId: child.runId,
        actor: { type: "system", id: null },
        parentRunId: runId,
        payload: { runKind: "agent", status: "Failed" },
      });
      const [event] = (await db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.runId, child.runId))) as DomainEventRow[];

      await consumer.handle([event]);
    }

    try {
      await atCheckpoint;
      await settle(first);
      expect((await getRun(runId)).status).toBe("Running");
    } finally {
      release();
    }
    await driving;
    await expect.poll(() => waitResumeCount(runId)).toBe(1);
    expect((await getRun(second.runId)).status).toBe("Running");
    await expect
      .poll(async () => {
        const parent = await getRun(runId);

        return [parent.status, parent.failedChildWakeAt];
      }, RE_ENTRY_POLL)
      .toEqual(["WaitingOnChildren", null]);
    await settle(second);
    await expect
      .poll(async () => (await getRun(runId)).status, RE_ENTRY_POLL)
      .toBe("Review");
    expect(await getRun(runId)).toMatchObject({
      failedChildWakeAt: null,
      resumeRequestedAt: null,
    });
    expect(await waitResumeCount(runId)).toBe(2);
  }, 90_000);
  it.each(["orchestrator", "consensus"] as const)(
    "recovers a %s parent after the last child settles without a delivered wake",
    async (nodeType) => {
      if (nodeType === "consensus") {
        runConsensusNode.mockReset();
        runConsensusNode
          .mockResolvedValueOnce({
            ok: false,
            stdout: "",
            vars: {},
            durationMs: 1,
            needsInput: true,
            waitsForChildren: true,
          })
          .mockResolvedValue({
            ok: false,
            stdout: "consensus children failed",
            vars: {},
            durationMs: 1,
            errorCode: "CRASH",
          });
      }
      const { runId } = await seedOrchestratorRun(
        nodeType === "consensus" ? consensusFlow : orchestratorFlow,
      );
      const child = await seedChild(runId, "Running");
      const { hosts } = await bindCoordinatorHost(
        runId,
        nodeType === "consensus" ? "decide" : "coordinate",
      );
      const { runFlow } = await import("@/lib/flows/runner");

      await runFlow(runId, {
        db,
        runtimeRoot: process.cwd(),
        executionHosts: hosts,
      });
      expect((await getRun(runId)).status).toBe("WaitingOnChildren");
      await db
        .update(schema.runs)
        .set({ status: "Failed" })
        .where(eq(schema.runs.id, child.runId));
      const continuation = startWorker(hosts);

      try {
        await expect
          .poll(() => waitResumeCount(runId), { timeout: 10_000 })
          .toBe(1);
      } finally {
        await continuation.stop();
        runConsensusNode.mockReset();
      }
    },
    90_000,
  );
  it("worker honors a failed-child intent while a sibling remains pending", async () => {
    const { runId } = await seedOrchestratorRun();
    const failed = await seedChild(runId, "Running");
    const sibling = await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    expect((await getRun(runId)).status).toBe("WaitingOnChildren");
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, failed.runId));
    await emitDomainEvent({
      db,
      kind: "run.failed",
      projectId,
      taskId: failed.taskId,
      runId: failed.runId,
      actor: { type: "system", id: null },
      parentRunId: runId,
      payload: { runKind: "agent", status: "Failed" },
    });
    const continuation = startWorker(hosts);

    try {
      await expect
        .poll(() => waitResumeCount(runId), { timeout: 10_000 })
        .toBe(1);
      expect((await getRun(sibling.runId)).status).toBe("Running");
    } finally {
      await continuation.stop();
    }
  }, 90_000);
  it("gives simultaneous event and post-park wake attempts one CAS winner", async () => {
    const { runId } = await seedOrchestratorRun();
    const child = await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    expect((await getRun(runId)).status).toBe("WaitingOnChildren");
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, child.runId));
    const dispatch = vi.fn(async () => {});
    const [event, catchup] = await Promise.all([
      wakeParkedCoordinator({
        db: db as unknown as Parameters<typeof wakeParkedCoordinator>[0]["db"],
        parentRunId: runId,
        cause: "settled_child",
        resumeFlow: dispatch,
      }),
      wakeParkedCoordinator({
        db: db as unknown as Parameters<typeof wakeParkedCoordinator>[0]["db"],
        parentRunId: runId,
        cause: "post_park",
        resumeFlow: dispatch,
      }),
    ]);

    expect(
      [event.kind, catchup.kind].filter((kind) => kind === "woken"),
    ).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await waitResumeCount(runId)).toBe(1);
    const continuation = startWorker(hosts);

    try {
      await expect
        .poll(async () => (await getRun(runId)).status, { timeout: 10_000 })
        .toBe("Review");
    } finally {
      await continuation.stop();
    }
  }, 90_000);
  it.each(["orchestrator", "consensus"] as const)(
    "re-drives a rebound %s coordinator after death before its first command",
    async (nodeType) => {
      if (nodeType === "consensus") {
        runConsensusNode.mockReset();
        runConsensusNode
          .mockResolvedValueOnce({
            ok: false,
            stdout: "",
            vars: {},
            durationMs: 1,
            needsInput: true,
            waitsForChildren: true,
          })
          .mockResolvedValue({ ok: true, stdout: "", vars: {}, durationMs: 1 });
      }
      const { runId } = await seedOrchestratorRun(
        nodeType === "consensus" ? consensusFlow : orchestratorFlow,
      );
      const child = await seedChild(runId, "Running");
      const { hosts } = await bindCoordinatorHost(
        runId,
        nodeType === "consensus" ? "decide" : "coordinate",
      );
      const { runFlow } = await import("@/lib/flows/runner");

      try {
        await runFlow(runId, {
          db,
          runtimeRoot: process.cwd(),
          executionHosts: hosts,
        });
        await db
          .update(schema.runs)
          .set({ status: "Failed" })
          .where(eq(schema.runs.id, child.runId));
        const wake = await wakeParkedCoordinator({
          db: db as unknown as Parameters<
            typeof wakeParkedCoordinator
          >[0]["db"],
          parentRunId: runId,
          cause: "settled_child",
          resumeFlow: async () => {},
        });

        if (wake.kind !== "woken")
          throw new Error(`coordinator wake refused: ${wake.kind}`);
        const active = await getRun(runId);

        // Death after the re-entry rebound the attempt to the wait epoch but
        // before its first prompt command.
        await db
          .update(schema.nodeAttempts)
          .set({
            status: "Running",
            executionAssignmentId: active.executionAssignmentId,
            endedAt: null,
          })
          .where(eq(schema.nodeAttempts.id, wake.nodeAttemptId));
        const continuation = startWorker(hosts);

        try {
          if (nodeType === "consensus")
            // The mocked runtime publishes no declared outputs, so the proof is
            // the worker re-entering THIS attempt rather than the run's end.
            await expect
              .poll(
                () =>
                  runConsensusNode.mock.calls
                    .slice(1)
                    .map(([input]) => input.nodeAttemptId),
                RE_ENTRY_POLL,
              )
              .toContain(wake.nodeAttemptId);
          else
            await expect
              .poll(async () => (await getRun(runId)).status, RE_ENTRY_POLL)
              .toBe("Review");
          const attempts = await db
            .select()
            .from(schema.nodeAttempts)
            .where(eq(schema.nodeAttempts.runId, runId));

          expect(attempts).toHaveLength(1);
        } finally {
          await continuation.stop();
        }
      } finally {
        runConsensusNode.mockReset();
      }
    },
    90_000,
  );
  it("wakes only the parked attempt it names, and never a terminal parent", async () => {
    const { runId } = await seedOrchestratorRun();
    const child = await seedChild(runId, "Running");
    const { hosts } = await bindCoordinatorHost(runId);
    const { runFlow } = await import("@/lib/flows/runner");
    const wakeDb = db as unknown as Parameters<
      typeof wakeParkedCoordinator
    >[0]["db"];

    await runFlow(runId, {
      db,
      runtimeRoot: process.cwd(),
      executionHosts: hosts,
    });
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, child.runId));

    expect(
      await wakeParkedCoordinator({
        db: wakeDb,
        parentRunId: runId,
        cause: "settled_child",
        expectedAttemptId: randomUUID(),
        resumeFlow: async () => {},
      }),
    ).toEqual({ kind: "skipped", reason: "stale_attempt" });
    await db
      .update(schema.runs)
      .set({ status: "Abandoned" })
      .where(eq(schema.runs.id, runId));
    expect(
      await wakeParkedCoordinator({
        db: wakeDb,
        parentRunId: runId,
        cause: "continuation_worker",
        resumeFlow: async () => {},
      }),
    ).toEqual({ kind: "skipped", reason: "parent_not_parked_coordinator" });
    expect(await waitResumeCount(runId)).toBe(0);
  }, 90_000);
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
