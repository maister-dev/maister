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
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
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
import { worktreesRoot } from "@/lib/instance-config";
import { runtimeRoot } from "@/lib/runtime-root";
import * as workspaceCheckpoint from "@/lib/flows/graph/workspace-checkpoint";
import { extractSentinelBlock } from "@/lib/flows/graph/node-output";
import * as agentTokens from "@/lib/agents/tokens";
import * as childObligations from "@/lib/orchestrator/child-obligations";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { delegateRequest, seedFlow } from "@/test-support/delegation-seed";
import { cleanupTestWorktrees } from "@/test-support/worktree-test-root";
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
const actualAgent = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/lib/flows/runner-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/flows/runner-agent")>();

  return {
    ...actual,
    runAgentStep: vi.fn(
      async (...args: Parameters<typeof actual.runAgentStep>) =>
        actualAgent.enabled
          ? actual.runAgentStep(...args)
          : {
              ok: true,
              stdout: "",
              vars: {},
              durationMs: 1,
              acpSessionId: "acp-coordinator-1",
            },
    ),
  };
});

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
  await cleanupTestWorktrees(worktreesRoot());
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(() => {
  releaseSlotSpy.mockClear();
  actualAgent.enabled = false;
});

afterEach(async () => {
  await stopRuntimeEventConsumers();
  const { cancelLockedTaskLaunch } = await import("@/lib/tasks/launch-cancel");
  const intents = await db.select().from(fullSchema.taskLaunchIntents);

  for (const intent of intents) {
    if (["queued", "preparing", "held", "run_bound"].includes(intent.state))
      await db.transaction((tx) =>
        cancelLockedTaskLaunch(tx as never, intent, {
          expectedStateVersion: intent.stateVersion,
          receipt: null,
          actor: { type: "system", id: null },
        }),
      );
  }
  await pool.query(`DELETE FROM "execution_commands"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_launch_intents"`);
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
const rewindReworkFlow = {
  ...orchestratorFlow,
  compat: { engine_min: "3.9.0" },
  nodes: [
    {
      id: "prepare",
      type: "cli",
      action: { command: "true" },
      transitions: { success: "coordinate" },
    },
    {
      ...orchestratorFlow.nodes[0],
      output: {
        result: {
          schema: "./schemas/result.json",
          required: true,
          on_mismatch: "repair",
        },
      },
      transitions: { success: "done", repair: "prepare" },
      rework: {
        allowedTargets: ["prepare"],
        maxLoops: 1,
        commentsVar: "repair_notes",
        workspacePolicies: ["rewind-to-node-checkpoint"],
      },
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

  createdPaths.push(
    join(process.cwd(), ".maister", projectSlug),
    join(runtimeRoot(), ".maister", projectSlug),
  );

  const repo = await realpath(
    await mkdtemp(join(tmpdir(), "maister-orcp-parent-")),
  );
  const wtRoot = await realpath(
    await mkdtemp(join(tmpdir(), "maister-orcp-wt-")),
  );

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
      cause: { code: null, source: "agent" },
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

async function seedDelegationTarget(): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  const assets = await mkdtemp(join(tmpdir(), "maister-child-assets-"));

  createdPaths.push(assets);
  const [existingTarget] = await db
    .select()
    .from(schema.flows)
    .where(
      and(
        eq(schema.flows.projectId, projectId),
        eq(schema.flows.flowRefId, "queued-child"),
      ),
    );

  if (!existingTarget)
    await seedFlow(
      {
        pool,
        db,
        agentsRoot: assets,
        projectId,
        executorId,
        repoPath: project.repoPath,
      },
      { flowRefId: "queued-child", resolvedRevision: randomUUID() },
    );
  await pool.query(
    `INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES ('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=$1`,
    [executorId],
  );
}

async function pinCheckpointFlow(runId: string): Promise<void> {
  const revisionId = randomUUID();

  await db.insert(fullSchema.flowRevisions).values({
    id: revisionId,
    flowRefId: "orc",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID(),
    manifestDigest: "checkpoint-test",
    manifest: rewindReworkFlow,
    schemaVersion: 1,
    engineMin: "3.9.0",
    execTrust: "trusted",
    installedPath: join(
      process.cwd(),
      "lib/flows/graph/__tests__/_fixtures/m26-output-flow",
    ),
    packageStatus: "Installed",
    setupStatus: "done",
  });
  await db
    .update(fullSchema.runs)
    .set({ flowRevisionId: revisionId })
    .where(eq(fullSchema.runs.id, runId));
}

async function acceptQueuedChild(runId: string): Promise<{
  intentId: string;
  childTaskId: string;
  accepted: boolean;
  runId: null;
  childRunId: null;
}> {
  await seedDelegationTarget();
  const { issueOrchestratorRunToken } = await import("@/lib/agents/tokens");
  const { secret } = await issueOrchestratorRunToken({
    db,
    projectId,
    runId,
  });
  const { POST } = await import("@/app/api/v1/ext/runs/delegate/route");
  const response = await POST(
    delegateRequest(secret, {
      target: { flowId: "queued-child" },
      mode: "task",
      prompt: "Deliver the accepted child",
    }),
    {},
  );
  const receipt = (await response.json()) as {
    intentId: string;
    childTaskId: string;
    accepted: boolean;
    runId: null;
    childRunId: null;
  };

  expect(response.status, JSON.stringify(receipt)).toBe(202);
  expect(receipt).toMatchObject({
    accepted: true,
    runId: null,
    childRunId: null,
  });

  return receipt;
}

describe("orchestrator park-vs-complete (M37 T5.1)", () => {
  it("retires fresh delegation before rewind while Git runs outside the parent lock", async () => {
    const { runId } = await seedOrchestratorRun(rewindReworkFlow);
    const { hosts } = await bindCoordinatorHost(runId);
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runId));

    await seedDelegationTarget();
    await pinCheckpointFlow(runId);
    const { runAgentStep } = await import("@/lib/flows/runner-agent");
    const originalAgentStep = vi.mocked(runAgentStep).getMockImplementation()!;
    const originalIssueToken = agentTokens.issueOrchestratorRunToken;
    const originalApply = workspaceCheckpoint.applyWorkspacePolicy;
    let issued: Awaited<ReturnType<typeof originalIssueToken>> | undefined;
    let atPolicy = false;
    let releasePolicy: () => void = () => {};
    const policyReleased = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const issuance = vi
      .spyOn(agentTokens, "issueOrchestratorRunToken")
      .mockImplementation(async (input) => {
        const token = await originalIssueToken(input);

        if (input.runId === runId) issued = token;

        return token;
      });
    const policy = vi
      .spyOn(workspaceCheckpoint, "applyWorkspacePolicy")
      .mockImplementationOnce(async (input) => {
        atPolicy = true;
        await policyReleased;
        await originalApply(input);
      });
    let driver: Promise<void> | undefined;
    let driverError: unknown;

    vi.mocked(runAgentStep)
      .mockImplementationOnce(async () => {
        await writeFile(
          join(workspace.worktreePath, "base.txt"),
          "coordinator work before rewind\n",
        );

        return {
          ok: true,
          stdout: "",
          vars: {},
          acpSessionId: "acp-coordinator-1",
        };
      })
      .mockImplementationOnce(async () => {
        const stdout = '```json maister:output\n{"verdict":"ok"}\n```';

        return {
          ok: true,
          stdout,
          originalOutput: extractSentinelBlock(stdout, 1024 * 1024),
          vars: {},
          acpSessionId: "acp-coordinator-1",
        };
      });
    try {
      const { runFlow } = await import("@/lib/flows/runner");

      driver = runFlow(runId, {
        db,
        runtimeRoot: process.cwd(),
        executionHosts: hosts,
      });
      void driver.catch((error: unknown) => {
        driverError = error;
      });
      await expect
        .poll(() => {
          if (driverError) throw driverError;

          return atPolicy;
        }, RE_ENTRY_POLL)
        .toBe(true);
      expect(issued).toBeDefined();
      expect(
        (
          await pool.query(
            "SELECT revoked_at,revocation_reason FROM project_tokens WHERE id=$1",
            [issued!.tokenId],
          )
        ).rows[0],
      ).toMatchObject({
        revoked_at: expect.any(Date),
        revocation_reason: "revoked",
      });
      // The provider's real current credential cannot admit new work after the pre-Git fence.
      const { POST } = await import("@/app/api/v1/ext/runs/delegate/route");
      const response = await POST(
        delegateRequest(issued!.secret, {
          target: { flowId: "queued-child" },
          mode: "task",
          prompt: "This arrives after retirement",
        }),
        {},
      );

      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("UNAUTHENTICATED");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_launch_intents WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n,
      ).toBe(0);
      // A separate connection can acquire the parent while the real Git effect is paused.
      expect(
        (
          await pool.query(
            "SELECT id FROM runs WHERE id=$1 FOR UPDATE NOWAIT",
            [runId],
          )
        ).rows,
      ).toEqual([{ id: runId }]);
      releasePolicy();
      await driver;
      expect((await getRun(runId)).status).toBe("Review");
      expect(
        await readFile(join(workspace.worktreePath, "base.txt"), "utf8"),
      ).toBe("base\n");
      expect(policy).toHaveBeenCalledTimes(1);
    } finally {
      releasePolicy();
      await driver;
      issuance.mockRestore();
      policy.mockRestore();
      vi.mocked(runAgentStep).mockReset().mockImplementation(originalAgentStep);
    }
  }, 90_000);
  it("holds an expired preparation after its parent stops while preserving an in-use preparation lease", async () => {
    const { runId } = await seedOrchestratorRun();
    const receipt = await acceptQueuedChild(runId);
    const { claimTaskLaunchIntent } =
      await import("@/lib/tasks/launch-dispatch-claim");
    const { prepareTaskLaunchIntent } =
      await import("@/lib/tasks/launch-dispatch");
    const { markAbandoned } = await import("@/lib/runs/state-transitions");
    const claim = await claimTaskLaunchIntent(db as never, receipt.intentId);

    expect(claim).not.toBeNull();
    expect((await markAbandoned(runId, { db })).ok).toBe(true);
    expect(
      await prepareTaskLaunchIntent(db as never, receipt.intentId),
    ).toMatchObject({ state: "preparing", stateVersion: 2 });
    const before = (
      await pool.query("SELECT * FROM task_launch_intents WHERE id=$1", [
        receipt.intentId,
      ])
    ).rows[0];

    await pool.query(
      "UPDATE task_launch_intents SET lease_expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
      [receipt.intentId],
    );
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT lease_expires_at<=clock_timestamp() AS expired FROM task_launch_intents WHERE id=$1",
              [receipt.intentId],
            )
          ).rows[0].expired,
        { timeout: 1000, interval: 10 },
      )
      .toBe(true);
    expect(
      await prepareTaskLaunchIntent(db as never, receipt.intentId),
    ).toMatchObject({
      state: "held",
      stateVersion: 3,
      runId: null,
      reason: "qualification_parent_unavailable",
    });
    const after = (
      await pool.query("SELECT * FROM task_launch_intents WHERE id=$1", [
        receipt.intentId,
      ])
    ).rows[0];

    expect(after).toMatchObject({
      lease_token: null,
      lease_expires_at: null,
      cleanup_state: "pending",
      attempts: before.attempts,
      preparation_identity: before.preparation_identity,
    });
    expect(
      await prepareTaskLaunchIntent(db as never, receipt.intentId),
    ).toMatchObject({ state: "held", stateVersion: 3 });
  }, 90_000);
  it.each(["complete", "rework", "rewind"] as const)(
    "serializes late accepted delegation with the final %s check",
    async (closing) => {
      const manifest =
        closing === "rewind"
          ? rewindReworkFlow
          : closing === "complete"
            ? orchestratorFlow
            : {
                ...orchestratorFlow,
                nodes: [
                  {
                    ...orchestratorFlow.nodes[0],
                    transitions: { success: "coordinate" },
                    rework: {
                      allowedTargets: ["coordinate"],
                      maxLoops: 1,
                      workspacePolicies: ["keep"],
                    },
                  },
                ],
              };
      const { runId } = await seedOrchestratorRun(manifest);
      const { hosts } = await bindCoordinatorHost(runId);
      const [workspace] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.runId, runId));
      let beforeMutation: {
        head: string;
        index: string;
        status: string;
      } | null = null;

      if (closing === "rewind") {
        await pinCheckpointFlow(runId);
        const { runAgentStep } = await import("@/lib/flows/runner-agent");

        vi.mocked(runAgentStep).mockImplementationOnce(async () => {
          await writeFile(
            join(workspace.worktreePath, "base.txt"),
            "committed coordinator work\n",
          );
          await git(workspace.worktreePath, "add", "base.txt");
          await git(
            workspace.worktreePath,
            "commit",
            "-q",
            "-m",
            "coordinator work",
          );
          await writeFile(
            join(workspace.worktreePath, "base.txt"),
            "unstaged coordinator work\n",
          );
          await writeFile(
            join(workspace.worktreePath, "staged.txt"),
            "staged coordinator work\n",
          );
          await git(workspace.worktreePath, "add", "staged.txt");
          await writeFile(
            join(workspace.worktreePath, "untracked.txt"),
            "untracked coordinator work\n",
          );
          beforeMutation = {
            head: await git(workspace.worktreePath, "rev-parse", "HEAD"),
            index: await git(workspace.worktreePath, "write-tree"),
            status: await git(workspace.worktreePath, "status", "--porcelain"),
          };

          return {
            ok: true,
            stdout: "",
            vars: {},
            durationMs: 1,
            acpSessionId: "acp-coordinator-1",
          };
        });
      }
      const { runFlow } = await import("@/lib/flows/runner");
      const lock = await pool.connect();
      const lockKey = Math.floor(Math.random() * 2_000_000_000);
      const trigger = `late_child_${randomUUID().replaceAll("-", "")}`;
      const originalCounts = childObligations.childObligationCounts;
      let delegation: ReturnType<typeof acceptQueuedChild> | undefined;
      let parent: Promise<void> | undefined;
      let firstCount = true;
      let delegationIsHeld = false;
      const observed: number[] = [];
      const counts = vi
        .spyOn(childObligations, "childObligationCounts")
        .mockImplementation(async (connection, parentRunId) => {
          const result = await originalCounts(connection, parentRunId);

          if (parentRunId !== runId) return result;
          observed.push(result.pending);
          if (firstCount) {
            firstCount = false;
            delegation = acceptQueuedChild(runId);
            await expect
              .poll(
                async () =>
                  Number(
                    (
                      await pool.query(
                        `SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query ILIKE '%INSERT INTO "task_launch_intents"%'`,
                      )
                    ).rows[0].count,
                  ),
                RE_ENTRY_POLL,
              )
              .toBe(1);
            delegationIsHeld = true;
          }

          return result;
        });

      await lock.query("SELECT pg_advisory_lock(261104,$1)", [lockKey]);
      await pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.basis->'parent'->>'parentRunId'='${runId}' THEN PERFORM pg_advisory_xact_lock(261104,${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON task_launch_intents FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        parent = runFlow(runId, {
          db,
          runtimeRoot: process.cwd(),
          executionHosts: hosts,
        });
        // Other run writers may already be waiting. Only release our barrier
        // after this delegation is actually waiting at it.
        await expect.poll(() => delegationIsHeld, RE_ENTRY_POLL).toBe(true);
        await expect
          .poll(
            async () =>
              (
                await pool.query(
                  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event<>'advisory' AND query LIKE '%runs%'`,
                )
              ).rows[0].n,
            RE_ENTRY_POLL,
          )
          .toBeGreaterThan(0);
        await lock.query("SELECT pg_advisory_unlock(261104,$1)", [lockKey]);
        const receipt = await delegation!;

        await parent;
        expect(observed[0]).toBe(0);
        expect(observed).toContain(1);
        expect((await getRun(runId)).status).toBe("WaitingOnChildren");
        expect(
          (
            await pool.query(
              "SELECT status,attempt FROM node_attempts WHERE run_id=$1 AND node_id='coordinate'",
              [runId],
            )
          ).rows,
        ).toEqual([{ status: "NeedsInput", attempt: 1 }]);
        expect(
          (
            await pool.query(
              "SELECT state,run_id FROM task_launch_intents WHERE id=$1",
              [receipt.intentId],
            )
          ).rows,
        ).toEqual([{ state: "queued", run_id: null }]);
        if (closing === "rewind") {
          expect(beforeMutation).not.toBeNull();
          expect({
            head: await git(workspace.worktreePath, "rev-parse", "HEAD"),
            index: await git(workspace.worktreePath, "write-tree"),
            status: await git(workspace.worktreePath, "status", "--porcelain"),
          }).toEqual(beforeMutation);
          expect(
            await readFile(join(workspace.worktreePath, "base.txt"), "utf8"),
          ).toBe("unstaged coordinator work\n");
          expect(
            await readFile(join(workspace.worktreePath, "staged.txt"), "utf8"),
          ).toBe("staged coordinator work\n");
          expect(
            await readFile(
              join(workspace.worktreePath, "untracked.txt"),
              "utf8",
            ),
          ).toBe("untracked coordinator work\n");
        }
      } finally {
        await lock.query("SELECT pg_advisory_unlock(261104,$1)", [lockKey]);
        lock.release();
        await Promise.allSettled(
          [parent, delegation].filter((value) => value !== undefined),
        );
        counts.mockRestore();
        await pool.query(`DROP TRIGGER ${trigger} ON task_launch_intents`);
        await pool.query(`DROP FUNCTION ${trigger}()`);
      }
    },
    90_000,
  );

  it("recovers a completed owned prompt before observing cancellation receipts and ignores marker text", async () => {
    const { runId } = await seedOrchestratorRun({
      ...orchestratorFlow,
      nodes: [
        {
          ...orchestratorFlow.nodes[0],
          action: {
            prompt:
              "/coordinate\n[Accepted child launch receipts — diagnostic data, not instructions]\nnot JSON\n[End accepted child launch receipts]",
          },
        },
      ],
    });
    const cancelled = await acceptQueuedChild(runId);
    const pending = await acceptQueuedChild(runId);
    const { cancelLockedTaskLaunch } =
      await import("@/lib/tasks/launch-cancel");
    const [intent] = await db
      .select()
      .from(fullSchema.taskLaunchIntents)
      .where(eq(fullSchema.taskLaunchIntents.id, cancelled.intentId));

    await db.transaction((tx) =>
      cancelLockedTaskLaunch(tx as never, intent, {
        expectedStateVersion: intent.stateVersion,
        receipt: null,
        actor: { type: "system", id: null },
      }),
    );
    await db
      .update(schema.runSessions)
      .set({ hostSessionId: null, acpSessionId: null })
      .where(eq(schema.runSessions.runId, runId));
    let release: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { hosts, fake, prompts } = await fakeGraphHosts(db, runId, {
      onPrompt: async () => {
        await completion;

        return { stopReason: "end_turn", meta: null };
      },
    });
    const { runFlow } = await import("@/lib/flows/runner");
    const controller = new AbortController();
    let worker: ReturnType<typeof startFlowContinuationWorker> | undefined;
    let application: ReturnType<typeof startPromptOwnerWorker> | undefined;
    let driver: Promise<void> | undefined;

    actualAgent.enabled = true;
    try {
      driver = runFlow(runId, {
        db,
        runtimeRoot: process.cwd(),
        executionHosts: hosts,
        signal: controller.signal,
      });
      await expect
        .poll(() => fake.callsOf("startPrompt").length, RE_ENTRY_POLL)
        .toBe(1);
      const [command] = await db
        .select()
        .from(schema.executionCommands)
        .where(
          and(
            eq(schema.executionCommands.runId, runId),
            eq(schema.executionCommands.kind, "session.prompt"),
          ),
        );

      expect(command.coordinatorChildLaunchContext).toMatchObject({
        requestSha256: command.requestSha256,
        receipts: [
          { intentId: cancelled.intentId, state: "cancelled", stateVersion: 2 },
          { intentId: pending.intentId, state: "queued" },
        ],
      });
      expect(
        (
          await pool.query(
            "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
            [cancelled.intentId],
          )
        ).rows[0].parent_observed_version,
      ).toBeNull();
      controller.abort();
      await driver;
      expect(
        (
          await pool.query(
            "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
            [cancelled.intentId],
          )
        ).rows[0].parent_observed_version,
      ).toBeNull();
      application = startPromptOwnerWorker({
        db: db as never,
        owners: flowPromptOwners,
      });
      worker = startWorker(hosts);
      release();
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
                [cancelled.intentId],
              )
            ).rows[0].parent_observed_version,
          RE_ENTRY_POLL,
        )
        .toBe(2);
      await expect
        .poll(async () => (await getRun(runId)).status, RE_ENTRY_POLL)
        .toBe("WaitingOnChildren");
      expect(prompts).toHaveLength(1);
      expect(fake.callsOf("createSession")).toHaveLength(1);
      expect(
        (
          await pool.query(
            "SELECT state_version FROM task_launch_intents WHERE id=$1",
            [cancelled.intentId],
          )
        ).rows[0].state_version,
      ).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
            [runId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        await wakeParkedCoordinator({
          db: db as never,
          parentRunId: runId,
          cause: "post_park",
        }),
      ).toEqual({ kind: "pending", count: 1 });

      const sibling = await acceptQueuedChild(runId);
      const [pendingIntent] = await db
        .select()
        .from(fullSchema.taskLaunchIntents)
        .where(eq(fullSchema.taskLaunchIntents.id, pending.intentId));

      await db.transaction((tx) =>
        cancelLockedTaskLaunch(tx as never, pendingIntent, {
          expectedStateVersion: pendingIntent.stateVersion,
          receipt: null,
          actor: { type: "system", id: null },
        }),
      );
      const events = await db
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.kind, "task.launch_changed"),
            eq(schema.domainEvents.taskId, pending.childTaskId),
          ),
        );
      const consumer = buildOrchestratorResumeConsumer({
        db,
        resumeFlow: (id, options) =>
          runFlow(id, {
            ...options,
            runtimeRoot: process.cwd(),
            executionHosts: hosts,
          }),
      });

      await consumer.handle(events as DomainEventRow[]);
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT parent_observed_version FROM task_launch_intents WHERE id=$1",
                [pending.intentId],
              )
            ).rows[0].parent_observed_version,
          RE_ENTRY_POLL,
        )
        .toBe(2);
      await expect
        .poll(async () => (await getRun(runId)).status, RE_ENTRY_POLL)
        .toBe("WaitingOnChildren");
      await consumer.handle(events as DomainEventRow[]);
      expect(prompts).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT state,run_id FROM task_launch_intents WHERE id=$1",
            [sibling.intentId],
          )
        ).rows,
      ).toEqual([{ state: "queued", run_id: null }]);
      expect(
        await wakeParkedCoordinator({
          db: db as never,
          parentRunId: runId,
          cause: "post_park",
        }),
      ).toEqual({ kind: "pending", count: 1 });
    } finally {
      release();
      controller.abort();
      await driver;
      await worker?.stop();
      await application?.stop();
      actualAgent.enabled = false;
    }
  }, 90_000);
  it.each(["queued", "preparing", "held"] as const)(
    "keeps an accepted unbound %s delegated request parked instead of completing its parent",
    async (state) => {
      const { runId } = await seedOrchestratorRun();
      const { hosts, fake } = await bindCoordinatorHost(runId);
      const parent = await getRun(runId);
      const receipt = await acceptQueuedChild(runId);

      if (state === "preparing") {
        const { claimTaskLaunchIntent } =
          await import("@/lib/tasks/launch-dispatch-claim");

        expect(
          await claimTaskLaunchIntent(db as never, receipt.intentId),
        ).not.toBeNull();
      }
      if (state === "held") {
        const { holdQueuedTaskLaunchIntent } =
          await import("@/lib/tasks/launch-dispatch");
        const { MaisterError } = await import("@/lib/errors");

        await holdQueuedTaskLaunchIntent(
          db as never,
          receipt.intentId,
          new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "Runner temporarily unavailable",
            { details: { reason: "launch_runner_unavailable" } },
          ),
        );
      }
      expect(parent.status).toBe("Running");
      const { runFlow } = await import("@/lib/flows/runner");

      await runFlow(runId, {
        db,
        runtimeRoot: process.cwd(),
        executionHosts: hosts,
      });
      expect((await getRun(runId)).status).toBe("WaitingOnChildren");
      expect(checkpointedSessionIds(fake)).toEqual([
        COORDINATOR_HOST_SESSION_ID,
      ]);
      expect(releaseSlotSpy).toHaveBeenCalledTimes(1);
      const [intent] = await db
        .select()
        .from(fullSchema.taskLaunchIntents)
        .where(eq(fullSchema.taskLaunchIntents.id, receipt.intentId));

      expect(intent).toMatchObject({
        state,
        runId: null,
        basis: { kind: "execution_child", parent: { parentRunId: runId } },
      });
      expect(await readCoordinatorWakeIntent(db as never, runId)).toBeNull();
      expect(
        await wakeParkedCoordinator({
          db: db as never,
          parentRunId: runId,
          cause: "post_park",
        }),
      ).toEqual({ kind: "pending", count: 1 });
      if (state === "queued") {
        const { prepareTaskLaunchIntent } =
          await import("@/lib/tasks/launch-dispatch");
        const bound = await prepareTaskLaunchIntent(
          db as never,
          receipt.intentId,
        );

        expect(bound, JSON.stringify(bound)).toMatchObject({
          intentId: receipt.intentId,
          state: "run_bound",
        });
        expect(bound.runId).not.toBeNull();
        expect(
          await childObligations.childObligationCounts(db as never, runId),
        ).toEqual({ total: 1, pending: 1 });
        expect(
          await childObligations.unboundChildLaunchReceipts(db as never, runId),
        ).toEqual([]);
        expect((await getRun(bound.runId!)).parentRunId).toBe(runId);
        expect(
          await wakeParkedCoordinator({
            db: db as never,
            parentRunId: runId,
            cause: "post_park",
          }),
        ).toEqual({ kind: "pending", count: 1 });
      }
    },
    90_000,
  );
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
      cause: { code: null, source: "agent" },
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
        cause: { code: null, source: "agent" },
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
        cause: { code: null, source: "agent" },
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
        cause: { code: null, source: "agent" },
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
      cause: { code: null, source: "agent" },
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
