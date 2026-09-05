// ADR-166 T4.1 — flow launch + runner-agent + runner-graph through the
// execution-host seam (P1–P4). P1 drives the real `launchRun`; P2–P4 drive the
// graph runner over a fake host scripted turn by turn.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  getActiveAssignment,
  mintAssignment,
} from "@/lib/execution-host/assignments";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { runFlow } from "@/lib/flows/runner";
import { launchRun } from "@/lib/services/runs";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  readyExecutionHostCapabilities,
  readySupervisorHealth,
} from "@/test-support/supervisor-health-fixture";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: async () => readySupervisorHealth(),
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    listBranches: async () => ["main"],
    resolveBaseCommit: async () => "feedface00000000000000000000000000000000",
    listRemoteUrls: async () => [],
  };
});

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: async () => ({ started: false, queuePosition: 1 }),
  };
});

const instructManifest = {
  schemaVersion: 1,
  name: "Instruct",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "instruct" } },
    },
  ],
};

const agentFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();

    if (value) return value as T;
    if (Date.now() > deadline) throw new Error("condition never met");
    await sleep(25);
  }
}

async function seedLaunchableTask(): Promise<{ taskId: string }> {
  const projectId = randomUUID();
  const slug = `lp-${projectId.slice(0, 8)}`;
  const revisionId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
    mainBranch: "main",
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });
  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: projectId.replace(/-/g, "").padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${projectId}`,
    manifest: instructManifest,
    schemaVersion: 1,
    installedPath: `/cache/${projectId}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${projectId}`,
    manifest: instructManifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "launch task",
    prompt: "do it",
    flowId,
  });

  return { taskId };
}

async function runsForTask(taskId: string) {
  return (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId))) as unknown as Array<{
    id: string;
    status: string;
    executionAssignmentId: string | null;
  }>;
}

async function runStatus(runId: string): Promise<string> {
  const rows = (await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<{ status: string }>;

  return rows[0].status;
}

async function attemptsFor(runId: string) {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as Array<{
    nodeId: string;
    status: string;
    executionAssignmentId: string | null;
  }>;
}

async function sessionFor(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as unknown as Array<{
    hostSessionId: string | null;
    acpSessionId: string | null;
    executionAssignmentId: string | null;
  }>;

  return rows[0] ?? null;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_launch_paths_test",
  });
  db = testDatabase.db;
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("claude-default", "claude"));
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });
  resetRegistrarStateForTests();
  resetResolverForTests();
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("flow launch + graph driver (ADR-166 T4.1)", () => {
  it("P1: launchRun mints epoch 1 `launch` in the SAME transaction as the run — a tx abort leaves neither", async () => {
    const aborted = await seedLaunchableTask();

    await expect(
      launchRun(
        { taskId: aborted.taskId },
        {
          authorize: async () => {},
          recordSuccessAudit: async () => {
            throw new Error("injected: launch audit write failed");
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/injected/);

    expect(await runsForTask(aborted.taskId)).toHaveLength(0);
    const assignments = (await db
      .select()
      .from(schema.executionAssignments)) as unknown as Array<{
      runId: string;
    }>;

    expect(assignments.map((a) => a.runId)).not.toContain(aborted.taskId);

    const launched = await seedLaunchableTask();
    const result = await launchRun(
      { taskId: launched.taskId },
      { authorize: async () => {} },
      db as never,
    );
    const [run] = await runsForTask(launched.taskId);

    expect(run.id).toBe(result.runId);
    const assignment = await getActiveAssignment(db as never, run.id);

    expect(assignment).toMatchObject({
      epoch: 1,
      state: "active",
      placementReason: "launch",
    });
    expect(run.executionAssignmentId).toBe(assignment!.id);
    const [host] = (await db
      .select()
      .from(schema.executionHosts)
      .where(
        eq(schema.executionHosts.id, assignment!.executionHostId),
      )) as Array<{
      hostKey: string;
    }>;

    expect(host.hostKey).toBe(readySupervisorHealth().health.host.hostKey);
  }, 60_000);

  it("P2: the first node adopts, creates, and prompts through the ledger; the attempt is stamped and run_sessions binds the host session BEFORE the prompt completes", async () => {
    const seeded = await seedGraphRun(db, agentFlow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { hosts, fake } = await fakeGraphHosts(db, seeded.runId, {
      onPrompt: async () => {
        await gate;

        return { stopReason: "end_turn", meta: null };
      },
    });
    const assignment = (await getActiveAssignment(db as never, seeded.runId))!;
    const driving = runFlow(seeded.runId, {
      db: db as never,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: hosts,
    });

    await until(async () => fake.callsOf("sendPrompt").length > 0);

    // Mid-turn: the create ack already bound the logical session to the host.
    const session = await sessionFor(seeded.runId);

    expect(session?.hostSessionId).toBe(fake.callsOf("sendPrompt")[0].args[0]);
    expect(session?.acpSessionId).toMatch(/^acp-/);
    expect(session?.executionAssignmentId).toBe(assignment.id);

    const [attempt] = await attemptsFor(seeded.runId);

    expect(attempt.executionAssignmentId).toBe(assignment.id);

    const midTurn = await listCommandsForRun(db as never, seeded.runId);

    expect(midTurn.map((c) => `${c.kind}:${c.state}`)).toEqual(
      expect.arrayContaining([
        "workspace.adopt:succeeded",
        "session.create:succeeded",
      ]),
    );
    expect(midTurn.find((c) => c.kind === "session.prompt")?.state).toMatch(
      /delivering|accepted/,
    );

    release();
    await driving;

    expect(await runStatus(seeded.runId)).toBe("Review");
    const done = await listCommandsForRun(db as never, seeded.runId);

    expect(done.find((c) => c.kind === "session.prompt")?.state).toBe(
      "succeeded",
    );
    expect(done.find((c) => c.kind === "session.delete")?.state).toBe(
      "succeeded",
    );
  }, 60_000);

  it("P3: a newer epoch minted mid-prompt fences the first driver — it yields without writing run or ledger state", async () => {
    const seeded = await seedGraphRun(db, agentFlow);
    const { hosts, fake } = await fakeGraphHosts(db, seeded.runId, {
      onPrompt: () => new Promise(() => {}),
    });
    const first = (await getActiveAssignment(db as never, seeded.runId))!;
    const driving = runFlow(seeded.runId, {
      db: db as never,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: hosts,
    });

    await until(async () => fake.callsOf("sendPrompt").length > 0);
    const [attemptBefore] = await attemptsFor(seeded.runId);
    const firstSessionId = fake.callsOf("sendPrompt")[0].args[0] as string;

    // A re-entry (resume/recover/...) mints the next epoch and the host's
    // fence advances with its first command on the run's live session —
    // evicting the first driver's session (F6: the higher-epoch checkpoint
    // finds it already gone).
    const second = await db.transaction((tx) =>
      mintAssignment(tx as never, {
        runId: seeded.runId,
        hostId: first.executionHostId,
        reason: "resume",
      }),
    );
    const successor = await hosts.forAssignment(second);

    expect(
      (await successor.checkpoint(firstSessionId)).alreadyCheckpointed,
    ).toBe(true);
    expect(fake.sessions.get(firstSessionId)?.fencedByEpoch).toBe(2);

    await driving;

    // The first driver wrote NOTHING: the run is still Running, the attempt
    // is still open, and its prompt is recorded `fenced` under epoch 1.
    expect(await runStatus(seeded.runId)).toBe("Running");
    const [attemptAfter] = await attemptsFor(seeded.runId);

    expect(attemptAfter.status).toBe(attemptBefore.status);
    expect(attemptAfter.status).not.toMatch(/Failed|Succeeded/);
    const prompt = (await listCommandsForRun(db as never, seeded.runId)).find(
      (c) => c.kind === "session.prompt",
    );

    expect(prompt).toMatchObject({ state: "fenced", assignmentEpoch: 1 });
    expect(fake.callsOf("deleteSession")).toHaveLength(0);
  }, 60_000);

  it("P4: a checkpoint mid-permission still yields STEP_CHECKPOINTED (regression)", async () => {
    const seeded = await seedGraphRun(db, agentFlow);
    const { hosts, fake } = await fakeGraphHosts(db, seeded.runId);

    fake.setStreamEvents([
      {
        type: "session.permission_request",
        sessionId: "fake",
        monotonicId: 1,
        requestId: randomUUID(),
        options: [
          { optionId: "allow", kind: "allow_always", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
        toolCall: { toolCallId: "tc-1", title: "Edit", kind: "execute" },
      },
      {
        type: "session.exited",
        sessionId: "fake",
        monotonicId: 2,
        exitCode: 0,
        reason: "checkpoint",
      },
    ] as never);

    await runFlow(seeded.runId, {
      db: db as never,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: hosts,
    });

    expect(await runStatus(seeded.runId)).toBe("NeedsInputIdle");
    const [attempt] = await attemptsFor(seeded.runId);

    expect(attempt.status).not.toMatch(/Failed|Succeeded/);
    const hitl = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId))) as Array<{
      kind: string;
    }>;

    expect(hitl.map((h) => h.kind)).toContain("permission");
  }, 60_000);
});

export { isMaisterError };
