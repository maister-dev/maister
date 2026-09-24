// M19 Phase 2 (T2.2 / T2.4): runReconcileSweep against a real Postgres
// testcontainer. The advisory-lock + count-then-update crash/promote path
// and the runs⨝workspaces⨝flow_revisions/flows-manifest join are not
// faithfully mockable, so the DB is real; the supervisor (`listSessions`),
// git (`listWorktrees`) and durable Flow wake (`runFlow`) are INJECTED
// via opts and asserted
// via the returned summary + DB state.
//
// Scenarios (plan T2.4 + the QA contract):
//   1. orphan Running whose worktreePath ∉ listWorktrees → Crashed + oldest
//      Pending promoted (summary.crashed ≥ 1).
//   2. agent run, no live session, latest attempt OLDER than grace → Crashed.
//   3. live session (listSessions returns its acpSessionId, status 'live') →
//      NOT crashed; the durable Flow driver is scheduled (summary.reattached).
//   4. in-flight recover within grace (resumeStartedAt = now) → NOT crashed
//      (summary.skipped).
//   5. cli node mid-step, no live session → Crashed, runFlow NOT called for it.
//   6. check/judge node, no live session → runFlow called (redispatched),
//      NOT crashed.
//   7. takeover-return candidate (node_attempts ownerUserId+returnedDiff+
//      endedAt all set) → EXCLUDED (not a candidate, not crashed).
//   8. listSessions THROWS → whole tick skipped, zeroed summary, NO run
//      crashed.

import type { SupervisorSessionRecord } from "@/lib/execution-host";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
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

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runReconcileSweep } from "@/lib/reconcile";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;
const {
  executionCommands,
  flowRevisions,
  flows,
  nodeAttempts,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let projectId: string;
let projectRepoPath: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;
let userId: string;
let originalCap: string | undefined;
let originalGrace: string | undefined;

// A graph manifest carrying one node of each kind we classify. currentStepId
// on the run selects which node the reconciler resolves.
const MANIFEST = {
  schemaVersion: 1,
  name: "recon",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "build" },
    },
    {
      id: "build",
      type: "cli",
      action: { command: "echo build" },
      transitions: { success: "verify" },
    },
    {
      id: "verify",
      type: "check",
      action: { command: "true" },
      transitions: { success: "done" },
    },
  ],
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "reconcile_sweep_test",
  });
  container = testDatabase.container;
  pool = testDatabase.pool;
  db = testDatabase.db;

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  projectId = randomUUID();
  projectRepoPath = `/repos/reconcile-${randomUUID()}`;
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();
  userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `recon-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "reconcile-app",
    name: "Reconcile App",
    repoPath: projectRepoPath,
    maisterYamlPath: `${projectRepoPath}/maister.yaml`,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "recon",
    source: "github.com/x/recon",
    version: "v1.0.0",
    installedPath: "/tmp/flows/recon",
    manifest: MANIFEST,
    schemaVersion: 1,
  });

  await db.insert(flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "recon",
    source: "github.com/x/recon",
    versionLabel: "v1.0.0",
    resolvedRevision: "deadbeef",
    manifestDigest: "sha256:recon",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/recon",
    packageStatus: "Installed",
  });

  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
  originalGrace = process.env.MAISTER_RECONCILE_GRACE_SECONDS;
  process.env.MAISTER_RECONCILE_GRACE_SECONDS = "90";
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  if (originalGrace === undefined) {
    delete process.env.MAISTER_RECONCILE_GRACE_SECONDS;
  } else {
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = originalGrace;
  }
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(nodeAttempts);
  await db.delete(workspaces);
  // Command evidence protects its run from deletion (D6), so a fixture reset
  // discharges it explicitly instead of relying on the FK cascade.
  await db.delete(executionCommands);
  await db.delete(runs);
  await db.delete(tasks);
});

type SeedRunOpts = {
  status?: string;
  runKind?: "flow" | "scratch" | "agent";
  acpSessionId?: string | null;
  currentStepId?: string | null;
  resumeStartedAt?: Date | null;
  startedAt?: Date;
  // M37 (ADR-098) T7.1: the delegator run id (orphan detection / cascade).
  parentRunId?: string | null;
};

async function seedRun(opts: SeedRunOpts = {}): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    runKind: opts.runKind ?? "flow",
    status: opts.status ?? "Running",
    currentStepId:
      opts.currentStepId === undefined ? "implement" : opts.currentStepId,
    flowVersion: "v1",
    startedAt: opts.startedAt ?? new Date(),
    resumeStartedAt: opts.resumeStartedAt ?? null,
    parentRunId: opts.parentRunId ?? null,
  });
  // M42 (ADR-114): the runner mirror + the resume handle moved off `runs` to
  // the run's `default` `run_sessions` row — the sweep reads acp_session_id
  // from there (loadActiveRunSessionsByRunId).
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    acpSessionId:
      opts.acpSessionId === undefined ? "acp-default" : opts.acpSessionId,
  });

  return runId;
}

// Seed a workspace whose worktreePath we control so the injected
// listWorktrees can include/exclude it.
async function seedWorkspace(
  runId: string,
  worktreePath: string,
): Promise<void> {
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath,
    parentRepoPath: projectRepoPath,
  });
}

async function seedNodeAttempt(
  runId: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    startedAt: new Date(),
    ...fields,
  });
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

// Inject a healthy supervisor that reports the given live records, an empty
// worktree set by default (overridden per test), and a spy for runFlow.
// ADR-166: the sweep addresses the host through `ExecutionHosts` — a fresh
// fake local host per call whose session list (and, when given, teardown)
// ride the injected functions.
async function makeOpts(over: {
  liveSessions?: SupervisorSessionRecord[];
  worktreePaths?: string[];
  listSessions?: () => Promise<SupervisorSessionRecord[]>;
  deleteSession?: (sessionId: string) => Promise<void>;
  getCommandReceipt?: (commandId: string) => Promise<unknown>;
  now?: () => Date;
}) {
  const runFlow = vi.fn(async () => {});

  const listWorktrees = vi.fn(
    async (): Promise<WorktreeInfo[]> =>
      (over.worktreePaths ?? []).map((p) => ({
        path: p,
        branch: "b",
        head: "h",
        bare: false,
        locked: false,
        prunable: false,
      })),
  );

  const listSessions =
    over.listSessions ??
    (async (): Promise<SupervisorSessionRecord[]> => over.liveSessions ?? []);
  const fake = createFakeExecutionHost();

  Object.assign(fake.transport, {
    listSessions,
    // ADR-177: the evidence probe's ONLY host call. Overridden per case so the
    // `accepted`-with-no-terminal-evidence window is exercised without a real
    // supervisor; left alone the fake answers from its own command store.
    ...(over.getCommandReceipt
      ? { getCommandReceipt: over.getCommandReceipt }
      : {}),
    ...(over.deleteSession
      ? {
          deleteSession: async (sessionId: string) => {
            await over.deleteSession!(sessionId);

            return { outcome: "terminated" as const };
          },
        }
      : {}),
  });
  const { hosts, hostId } = await fakeExecutionHosts(db, { fake });

  return {
    opts: {
      db,
      executionHosts: hosts,
      listWorktrees,
      runFlow,
      now: over.now ?? (() => new Date()),
    },
    runFlow,
    listWorktrees,
    hosts,
    hostId,
    fake,
  };
}

function liveRecord(
  runId: string,
  acpSessionId: string,
  stepId = "implement",
): SupervisorSessionRecord {
  return {
    sessionId: `sup-${runId}`,
    runId,
    projectSlug: "reconcile-app",
    stepId,
    status: "live",
    pid: 1234,
    startedAt: new Date().toISOString(),
    monotonicId: 1,
    acpSessionId,
  };
}

describe("runReconcileSweep (integration)", () => {
  it("activates a naturally exited pending agent question and preserves its terminal-origin assignment on later sweeps", async () => {
    const runId = await seedRun({
      runKind: "agent",
      status: "Done",
      acpSessionId: null,
      currentStepId: "agent",
    });
    const source = await readRun(runId);
    const hitlRequestId = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId,
      stepId: "agent",
      kind: "agent_question",
      taskId: source.taskId,
      activationState: "pending_termination",
      reTriggerMode: "agent",
      prompt: "Which deployment target should be used?",
      schema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
    });
    await db.insert(schema.taskClarifications).values({
      id: randomUUID(),
      taskId: source.taskId,
      seq: 1,
      sourceHitlRequestId: hitlRequestId,
      originRunId: runId,
      originAgentId: "test:clarifier",
      question: "Which deployment target should be used?",
      questionSchema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
      reTriggerMode: "agent",
    });

    const { opts } = await makeOpts({ liveSessions: [] });

    await runReconcileSweep(opts);
    await runReconcileSweep(opts);

    const [request] = await db
      .select({ activationState: schema.hitlRequests.activationState })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));
    const [assignment] = await db
      .select({
        status: schema.assignments.status,
        actionKind: schema.assignments.actionKind,
      })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, hitlRequestId));

    expect(request?.activationState).toBe("active");
    expect(assignment).toEqual({
      status: "open",
      actionKind: "agent_question",
    });
  }, 60_000);

  it("stops a live supervisor session that belongs to a D2-terminalized run", async () => {
    const cutoverRunId = await seedRun({
      status: "Failed",
      acpSessionId: "acp-cutover",
    });

    await db.insert(schema.domainEvents).values({
      kind: "run.failed",
      projectId,
      runId: cutoverRunId,
      actorType: "system",
      actorId: null,
      occurredAt: new Date(),
      payload: {
        reason: "legacy_steps_engine_3_cutover",
        source: "upgrade_cutover",
      },
    });
    const stopSession = vi.fn(async () => undefined);
    const { opts } = await makeOpts({
      liveSessions: [liveRecord(cutoverRunId, "acp-cutover")],
      deleteSession: stopSession,
    });

    const summary = await runReconcileSweep(opts);

    expect(stopSession).toHaveBeenCalledWith(`sup-${cutoverRunId}`);
    expect(summary.cutoverSessionsStopped).toBe(1);
    expect((await readRun(cutoverRunId)).status).toBe("Failed");
  }, 60_000);

  // Codex review F2 (ADR-163): the cascade flips a descendant's row before its
  // session teardown runs, and that teardown is best-effort — a web crash or a
  // supervisor hiccup in between leaves an agent spending under an `Abandoned`
  // row the Running-only candidate query never revisits. The sweep reaps
  // exactly that: a live session whose run row is `Abandoned`.
  it("reaps a live supervisor session whose run row is already Abandoned, and leaves a live Running run alone", async () => {
    const orphan = await seedRun({
      status: "Abandoned",
      acpSessionId: "acp-orphan",
    });
    const live = await seedRun({ status: "Running", acpSessionId: "acp-live" });

    await seedWorkspace(live, "/worktrees/reap-live");

    const stopSession = vi.fn(async () => undefined);
    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/reap-live"],
      liveSessions: [
        liveRecord(orphan, "acp-orphan"),
        liveRecord(live, "acp-live"),
      ],
      deleteSession: stopSession,
    });

    const summary = await runReconcileSweep(opts);

    expect(stopSession).toHaveBeenCalledWith(`sup-${orphan}`);
    expect(stopSession).not.toHaveBeenCalledWith(`sup-${live}`);
    expect(summary.orphanSessionsReaped).toBe(1);
    expect((await readRun(orphan)).status).toBe("Abandoned");
    expect((await readRun(live)).status).toBe("Running");
  }, 60_000);

  it("crashes an orphan Running whose worktree is gone and promotes the oldest Pending", async () => {
    const orphan = await seedRun({
      status: "Running",
      currentStepId: "implement",
    });

    await seedWorkspace(orphan, "/worktrees/orphan");

    // Fill the cap with two more Running rows (their worktrees PRESENT so
    // they aren't crashed), then a queued Pending that must be promoted.
    const live1 = await seedRun({ status: "Running" });

    await seedWorkspace(live1, "/worktrees/live1");

    const live2 = await seedRun({ status: "Running" });

    await seedWorkspace(live2, "/worktrees/live2");

    const oldestPending = await seedRun({
      status: "Pending",
      acpSessionId: null,
      startedAt: new Date(Date.now() - 60_000),
    });

    await seedWorkspace(oldestPending, "/worktrees/pending");

    // live1/live2 carry live sessions so they reattach (not crash); the
    // orphan's worktree is absent from listWorktrees.
    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/live1", "/worktrees/live2"],
      liveSessions: [
        liveRecord(live1, "acp-default"),
        liveRecord(live2, "acp-default"),
      ],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(orphan)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
    expect((await readRun(oldestPending)).status).toBe("Running");
  }, 60_000);

  it("crashes an agent run with no live session whose latest attempt is older than grace", async () => {
    const stale = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-stale",
      resumeStartedAt: null,
    });

    await seedWorkspace(stale, "/worktrees/stale");
    await seedNodeAttempt(stale, {
      startedAt: new Date(Date.now() - 600_000),
    });

    // worktree present, NO live session → agent past grace → crash.
    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/stale"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(stale)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("does NOT crash a Running agent whose acp_session_id is null mid-prompt when a live (runId, stepId) session exists", async () => {
    // Inverse of the previous case: acp_session_id is persisted only AFTER a
    // node's prompt returns, so a long in-flight agent node has a null run-row
    // acp_session_id and the acp-keyed match misses. The supervisor DOES have a
    // live (runId, stepId) session → the node is alive → SKIP, not crash (and
    // not reattach, which would double-drive an actively-running node).
    const inflight = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: null,
      resumeStartedAt: null,
    });

    await seedWorkspace(inflight, "/worktrees/inflight");
    await seedNodeAttempt(inflight, {
      startedAt: new Date(Date.now() - 600_000), // past the 90s grace
    });

    // Live session for (runId, "implement") whose acpSessionId does NOT match
    // the run row (which is null).
    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/inflight"],
      liveSessions: [
        liveRecord(inflight, "acp-inflight-unmatched", "implement"),
      ],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(inflight)).status).toBe("Running"); // NOT crashed
    expect(summary.crashed).toBe(0);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  // The same guard, with the session carrying a stepId that is NOT the run's
  // node cursor — a consensus substep (`<node>-verify`), a gate (the gate id),
  // or any run whose last prompt relabelled the host record. Keyed by stepId
  // the guard can never match those, and a live node is crashed as
  // `agent-session-gone`.
  it("does NOT crash a live in-flight node whose session stepId is not the node cursor", async () => {
    const substep = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: null,
      resumeStartedAt: null,
    });

    await seedWorkspace(substep, "/worktrees/substep");
    await seedNodeAttempt(substep, {
      startedAt: new Date(Date.now() - 600_000), // past the 90s grace
    });

    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/substep"],
      liveSessions: [
        liveRecord(substep, "acp-substep-unmatched", "implement-verify"),
      ],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(substep)).status).toBe("Running"); // NOT crashed
    expect(summary.crashed).toBe(0);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  it("reattaches a live Running Flow through its durable driver without a permission resume", async () => {
    const attached = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-live",
    });

    await seedWorkspace(attached, "/worktrees/attached");

    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/attached"],
      liveSessions: [liveRecord(attached, "acp-live")],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(attached)).status).toBe("Running");
    expect(summary.reattached).toBeGreaterThanOrEqual(1);
    await expect.poll(() => runFlow.mock.calls.length).toBe(1);
    // ADR-175: the reattach carries the crash-resume signal when the run holds a
    // committed recover intent, and `undefined` when it does not — this run was
    // never recovered, so it takes the ordinary durable continuation.
    expect(runFlow).toHaveBeenCalledWith(attached, undefined);
    // REQ-18: a `Running` run holding a live session with no driver is
    // CLASSIFIED and COUNTED, never silently skipped — asserted here rather
    // than left to a log grep, which is the whole point of the counter.
    expect(summary.runningIdleSession).toBeGreaterThanOrEqual(1);
    expect(summary.crashRecoverReentered).toBe(0);
  }, 60_000);

  it("does NOT reattach/crash a live Running scratch dialog — leaves it Running, no resume driver", async () => {
    // Regression: a freshly-launched scratch run answers its first prompt
    // (end_turn) and its supervisor session stays live waiting for the next
    // user message. A reconcile tick must NOT drive it through the resume
    // driver (continuation prompt + permission replay only fit flow HITL
    // recovery) — doing so falsely crashed it with resume-prompt-no-permission.
    const scratch = await seedRun({
      status: "Running",
      runKind: "scratch",
      currentStepId: "dialog",
      acpSessionId: "acp-scratch-live",
    });

    await seedWorkspace(scratch, "/worktrees/scratch");

    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/scratch"],
      liveSessions: [liveRecord(scratch, "acp-scratch-live")],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(scratch)).status).toBe("Running");
    expect(summary.reattached).toBe(0);
    expect(summary.crashed).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  it("skips an in-flight recover within grace (resumeStartedAt = now) — not crashed", async () => {
    const recovering = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-recovering",
      resumeStartedAt: new Date(),
    });

    await seedWorkspace(recovering, "/worktrees/recovering");

    // worktree present, NO live session, but fresh resumeStartedAt → grace.
    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/recovering"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(recovering)).status).toBe("Running");
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("crashes a cli node mid-step with no live session and does NOT redispatch it", async () => {
    const cliRun = await seedRun({
      status: "Running",
      currentStepId: "build", // 'build' is the cli node in MANIFEST
      acpSessionId: "acp-cli",
    });

    await seedWorkspace(cliRun, "/worktrees/cli");

    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/cli"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(cliRun)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
    expect(runFlow).not.toHaveBeenCalledWith(cliRun);
  }, 60_000);

  it("redispatches a check node with no live session via runFlow (not crashed)", async () => {
    const checkRun = await seedRun({
      status: "Running",
      currentStepId: "verify", // 'verify' is the check node in MANIFEST
      acpSessionId: "acp-check",
    });

    await seedWorkspace(checkRun, "/worktrees/check");

    const { opts, runFlow } = await makeOpts({
      worktreePaths: ["/worktrees/check"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(checkRun)).status).toBe("Running");
    expect(summary.redispatched).toBeGreaterThanOrEqual(1);
    expect(runFlow).toHaveBeenCalledWith(checkRun);
  }, 60_000);

  it("excludes a takeover-return candidate (ownerUserId + returnedDiff + endedAt all set)", async () => {
    // This Running row's worktree is GONE and it has no live session — it
    // would normally crash — but the takeover ledger marks it as the
    // takeover-return sweep's candidate, so reconcile must EXCLUDE it.
    const takeover = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-takeover",
    });

    await seedWorkspace(takeover, "/worktrees/takeover");
    await seedNodeAttempt(takeover, {
      nodeId: "review",
      nodeType: "human",
      ownerUserId: userId,
      returnedDiff: "diff --git a b",
      baseRef: "base",
      returnedCommits: "abc commit",
      endedAt: new Date(),
    });

    const { opts, runFlow } = await makeOpts({
      worktreePaths: [], // takeover's worktree absent — would crash if a candidate
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(takeover)).status).toBe("Running");
    expect(summary.candidates).toBe(0);
    expect(summary.crashed).toBe(0);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  it("does NOT crash a no-worktree agent run (workspace none/repo_read) whose worktreePath is null", async () => {
    // Regression guard for reconcile.ts:483-486. A run_kind='agent' run with
    // NO workspace row (workspace none/repo_read) carries a null worktreePath,
    // which MUST read as worktreeExists=true — there is no worktree to lose.
    // worktree-gone is decision step 2 (before live-session and grace), so if
    // the `runKind === "agent"` derivation regressed, every idle no-worktree
    // agent run would crash on every reconcile pass. Fresh startedAt → within
    // grace → skip; the ONLY thing keeping it out of the step-2 crash is the
    // null-worktree-is-present derivation.
    const agentId = `recon-agent-${randomUUID().slice(0, 8)}`;

    await pool.query(
      `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
       VALUES ($1, 'recon-pkg', 'v1.0.0', 'git', 'Recon Agent', 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
      [agentId],
    );

    const taskId = randomUUID();
    const agentRunId = randomUUID();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status")
       VALUES ($1, $2, $3, 't', 'p', 'InFlight')`,
      [taskId, projectId, Math.trunc(Math.random() * 1e9) + 1],
    );
    // No workspace row → worktreePath is null in the candidate set.
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "agent_workspace", "task_id", "project_id", "flow_version", "flow_revision", "status", "current_step_id", "started_at")
       VALUES ($1, 'agent', $2, 'manual', 'none', $3, $4, 'agent', 'manual', 'Running', 'agent', now())`,
      [agentRunId, agentId, taskId, projectId],
    );
    // M42 (ADR-114): the resume handle lives on the run's `default`
    // `run_sessions` row, which the sweep reads for the live-session match.
    await db.insert(schema.runSessions).values({
      id: randomUUID(),
      runId: agentRunId,
      sessionName: "default",
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      acpSessionId: "acp-agent-noworktree",
    });

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    // The run IS evaluated (not silently excluded by the candidate query) —
    // otherwise this guard would pass vacuously.
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect((await readRun(agentRunId)).status).toBe("Running");
    expect(summary.crashed).toBe(0);

    await pool.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
  }, 60_000);

  it("crashes a project-less assistant scratch run (project_id NULL, no workspace) whose session is dead, freeing its slot", async () => {
    // The Studio local-package AI assistant: run_kind='scratch', project_id NULL,
    // local_package_id set, NO workspaces row. The per-project candidate loop
    // never sees it (no project references it) — the project-less candidate
    // source must. Its null worktreePath reads as present (project_id IS NULL ⇒
    // no worktree to lose), its grace anchor is run.started_at, so a dead session
    // past grace classifies agent-session-gone → markScratchCrashed. Without the
    // fix it stays Running forever and leaks its concurrency slot.
    const lpId = randomUUID();

    await pool.query(
      `INSERT INTO "local_packages" ("id", "name", "slug", "working_dir") VALUES ($1, 'Recon LP', $2, '/tmp/recon-lp')`,
      [lpId, `recon-lp-${randomUUID().slice(0, 8)}`],
    );

    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "local_package_id", "project_id", "task_id", "flow_version", "flow_revision", "status", "current_step_id", "started_at")
       VALUES ($1, 'scratch', $2, NULL, NULL, 'scratch', 'manual', 'Running', 'scratch-dialog', $3)`,
      [runId, lpId, new Date(Date.now() - 5 * 60_000)],
    );
    await db.insert(schema.runSessions).values({
      id: randomUUID(),
      runId,
      sessionName: "default",
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      acpSessionId: "acp-assistant-dead",
    });

    // Dead: the supervisor reports NO live session.
    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect((await readRun(runId)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);

    // Cascades the run + its run_sessions row.
    await pool.query(`DELETE FROM "local_packages" WHERE "id" = $1`, [lpId]);
  }, 60_000);

  it("does NOT crash a LIVE project-less assistant scratch run — leaves it Running (live-scratch-session skip)", async () => {
    // Load-bearing guard for the worktreeExists change: a project-less assistant
    // run's null worktreePath must NOT read as worktree-gone (decision step 2,
    // BEFORE the live-session skip), so a LIVE assistant chat is never crashed.
    const lpId = randomUUID();

    await pool.query(
      `INSERT INTO "local_packages" ("id", "name", "slug", "working_dir") VALUES ($1, 'Recon LP Live', $2, '/tmp/recon-lp-live')`,
      [lpId, `recon-lp-live-${randomUUID().slice(0, 8)}`],
    );

    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "local_package_id", "project_id", "task_id", "flow_version", "flow_revision", "status", "current_step_id", "started_at")
       VALUES ($1, 'scratch', $2, NULL, NULL, 'scratch', 'manual', 'Running', 'scratch-dialog', now())`,
      [runId, lpId],
    );
    await db.insert(schema.runSessions).values({
      id: randomUUID(),
      runId,
      sessionName: "default",
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      acpSessionId: "acp-assistant-live",
    });

    const { opts, runFlow } = await makeOpts({
      worktreePaths: [],
      liveSessions: [liveRecord(runId, "acp-assistant-live", "scratch-dialog")],
    });

    const summary = await runReconcileSweep(opts);

    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect((await readRun(runId)).status).toBe("Running");
    expect(summary.crashed).toBe(0);
    expect(runFlow).not.toHaveBeenCalled();

    await pool.query(`DELETE FROM "local_packages" WHERE "id" = $1`, [lpId]);
  }, 60_000);

  it("skips the whole tick (zeroed summary, nothing crashed) when listSessions throws", async () => {
    const orphan = await seedRun({
      status: "Running",
      currentStepId: "implement",
    });

    await seedWorkspace(orphan, "/worktrees/orphan-throw");

    const { opts } = await makeOpts({
      worktreePaths: [], // worktree gone — would crash on a healthy tick
      listSessions: async () => {
        throw new Error("supervisor unavailable");
      },
    });

    const summary = await runReconcileSweep(opts);

    expect(summary).toEqual({
      candidates: 0,
      crashed: 0,
      abandoned: 0,
      redispatched: 0,
      reattached: 0,
      skipped: 0,
      cutoverSessionsStopped: 0,
      staleClaimsCleared: 0,
      // ADR-141: the sweep also recovers orphaned branch-sync attempts.
      syncRecovered: 0,
      // And puts an observer back on a live agent session that has none.
      reobserved: 0,
      // Codex review F2: and reaps live sessions under Abandoned rows.
      orphanSessionsReaped: 0,
      handlesLost: 0,
      // ADR-175: and classifies the two crash-recover re-entry shapes.
      crashRecoverReentered: 0,
      runningIdleSession: 0,
      // ADR-177: and classifies from durable command evidence. This assertion
      // pins the WHOLE literal on purpose — a counter added to the summary
      // without a zero in `ZERO_SUMMARY` is a silent zero on every skipped
      // tick, so the expectation growing with the contract is the point of it.
      evidencePending: 0,
      evidenceApplied: 0,
      turnLost: 0,
      ownerPoisoned: 0,
    });
    expect((await readRun(orphan)).status).toBe("Running");
  }, 60_000);

  // M37 (ADR-098) T7.1: seed an agent child under a parent run (orphan/cascade).
  async function seedChildRun(
    parentRunId: string,
    status: string,
  ): Promise<string> {
    return seedRun({
      runKind: "agent",
      status,
      parentRunId,
      acpSessionId: null,
      currentStepId: null,
    });
  }

  it("crashes a parked orchestrator (WaitingOnChildren) that is stuck — no live session, all children terminal, past grace", async () => {
    const orchestrator = await seedRun({
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
      acpSessionId: "acp-coord",
    });

    await seedWorkspace(orchestrator, "/worktrees/orch");
    // A node attempt older than the 90s grace → the parked coordinator is past
    // its wake window.
    await seedNodeAttempt(orchestrator, {
      nodeId: "coordinate",
      startedAt: new Date(Date.now() - 600_000),
    });
    // Both children already terminal → nothing left to wake the coordinator.
    await seedChildRun(orchestrator, "Done");
    await seedChildRun(orchestrator, "Abandoned");

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/orch"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(orchestrator)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("re-converges the orchestrator after a mid-cascade crash window: children already Abandoned by the cascade, own terminal flip missing (M-2)", async () => {
    // M37 (ADR-098) M-2: cancel/abandon cascades the children-first commit and
    // the orchestrator's OWN terminal flip across TWO transactions. If the
    // process dies between them, the children are already Abandoned (the cascade
    // tx committed) but the orchestrator is still parked WaitingOnChildren (its
    // flip never ran). The reconcile sweep is the crash-window backstop: with no
    // live session, every child settled (here: ALL Abandoned by the cascade), and
    // past grace, it must re-converge the coordinator to a terminal state and
    // leave NO run in the tree holding a slot.
    const orchestrator = await seedRun({
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
      acpSessionId: "acp-coord-crashwin",
    });

    await seedWorkspace(orchestrator, "/worktrees/orch-crashwin");
    await seedNodeAttempt(orchestrator, {
      nodeId: "coordinate",
      startedAt: new Date(Date.now() - 600_000), // past the 90s grace
    });
    // The mid-cascade partial state: the children-first cascade tx already
    // landed both children in Abandoned; the orchestrator's own flip is the part
    // that the crashed process never reached.
    const childA = await seedChildRun(orchestrator, "Abandoned");
    const childB = await seedChildRun(orchestrator, "Abandoned");

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/orch-crashwin"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    // The orchestrator re-converged to a terminal state (Crashed) — the missing
    // own-flip is now done.
    const orch = await readRun(orchestrator);

    expect(orch.status).toBe("Crashed");
    // The terminal flip cleared current_step_id (retained in resume_target_step_id).
    expect(orch.currentStepId).toBeNull();
    expect(orch.resumeTargetStepId).toBe("coordinate");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);

    // No orphan holds a slot: every run in the tree is terminal — the
    // orchestrator is no longer WaitingOnChildren and the already-Abandoned
    // children stayed Abandoned, so the whole tree is out of any slot-holding
    // (live / parked / queued) state.
    const liveInTree = await pool.query(
      `SELECT count(*)::int AS n FROM "runs"
       WHERE ("id" = $1 OR "parent_run_id" = $1)
         AND "status" IN ('Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren','Pending')`,
      [orchestrator],
    );

    expect(liveInTree.rows[0].n).toBe(0);
    expect((await readRun(childA)).status).toBe("Abandoned");
    expect((await readRun(childB)).status).toBe("Abandoned");
  }, 60_000);

  it("does NOT crash a parked orchestrator that still has a pending child", async () => {
    const orchestrator = await seedRun({
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
      acpSessionId: "acp-coord",
    });

    await seedWorkspace(orchestrator, "/worktrees/orch-wait");
    await seedNodeAttempt(orchestrator, {
      nodeId: "coordinate",
      startedAt: new Date(Date.now() - 600_000), // past grace, but…
    });
    // …a still-running child keeps the batch incomplete → it will be woken.
    await seedChildRun(orchestrator, "Running");
    await seedChildRun(orchestrator, "Done");

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/orch-wait"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(orchestrator)).status).toBe("WaitingOnChildren");
    expect(summary.crashed).toBe(0);
  }, 60_000);

  it("crashes a Running child whose parent is Crashed (orphaned-child) regardless of session", async () => {
    const deadParent = await seedRun({
      status: "Crashed",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "Running");

    await seedWorkspace(orphan, "/worktrees/orphan-child");
    // A fresh attempt would normally hold the grace window — orphan detection
    // fires BEFORE the grace check, so the child still crashes.
    await seedNodeAttempt(orphan, { startedAt: new Date() });

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/orphan-child"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(orphan)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("does NOT treat a Running child of a HEALTHY (WaitingOnChildren) parent as orphaned", async () => {
    const liveParent = await seedRun({
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
      acpSessionId: "acp-parent",
    });

    await seedWorkspace(liveParent, "/worktrees/live-parent");

    const child = await seedChildRun(liveParent, "Running");

    await seedWorkspace(child, "/worktrees/healthy-child");
    // The agent child has a fresh attempt (within the 90s grace) and no live
    // session. With a HEALTHY parent the orphan short-circuit does NOT fire, so
    // the child takes the normal agent path → grace-window → skip (survives).
    // (An orphaned child would crash here regardless of grace.)
    await seedNodeAttempt(child, { startedAt: new Date() });

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/live-parent", "/worktrees/healthy-child"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(child)).status).toBe("Running");
    // The parent (also a candidate) still has this pending child, so it too
    // survives — neither is crashed.
    expect((await readRun(liveParent)).status).toBe("WaitingOnChildren");
    expect(summary.crashed).toBe(0);
  }, 60_000);

  it("does not leave a PENDING child stranded under an Abandoned parent", async () => {
    // The orphaned-child arm (2.5) sits below the `Running`-only allow-list and
    // the candidate query loads only Running/WaitingOnChildren, so a child in
    // any OTHER non-terminal status under a terminal parent is never revisited.
    // A Running orchestrator that crashes via worktree-gone / heartbeat does not
    // cascade, so this shape is reachable: the queued child holds its pool slot
    // forever and promoteNextPending will happily start it under a dead
    // coordinator. This pins only "not stranded" — the recovery outcome is the
    // arm's decision, not this test's.
    const deadParent = await seedRun({
      status: "Abandoned",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "Pending");

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    // Never started ⇒ nothing to recover ⇒ Abandoned, not a "Crashed" run
    // offering a Recover that has no session to resume.
    expect((await readRun(orphan)).status).toBe("Abandoned");
    expect(summary.abandoned).toBe(1);
  }, 60_000);

  for (const status of ["NeedsInput", "NeedsInputIdle", "Review"] as const) {
    it(`crashes a ${status} child stranded under a Crashed parent (recoverable, like the Running orphan)`, async () => {
      // A paused or reviewing child waits on a resume / promotion decision its
      // coordinator can no longer make. Crashed surfaces Recover-or-discard to
      // the operator; the work is not destroyed.
      const deadParent = await seedRun({
        status: "Crashed",
        acpSessionId: null,
        currentStepId: null,
      });
      const orphan = await seedChildRun(deadParent, status);

      const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

      const summary = await runReconcileSweep(opts);

      expect((await readRun(orphan)).status).toBe("Crashed");
      expect(summary.crashed).toBeGreaterThanOrEqual(1);
    }, 60_000);
  }

  it("leaves a HumanWorking child of a dead coordinator in place", async () => {
    // A person holds that worktree. Terminalizing it would destroy their work;
    // it is skipped (and logged at WARN — it needs a human to settle it).
    const deadParent = await seedRun({
      status: "Abandoned",
      acpSessionId: null,
      currentStepId: null,
    });
    const held = await seedChildRun(deadParent, "HumanWorking");

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(held)).status).toBe("HumanWorking");
    expect(summary.crashed).toBe(0);
    expect(summary.abandoned).toBe(0);
  }, 60_000);

  it("cascades a parked sub-orchestrator's own children before crashing it, when ITS parent is gone", async () => {
    // Depth 2: a dead root, a WaitingOnChildren sub-orchestrator, a Running
    // grandchild. The sub-orchestrator's `orchestrator-waiting` skip used to
    // win (it has a pending child) and the grandchild's orphan arm never fired
    // (its OWN parent was non-terminal) — a whole sub-tree left running with
    // no recovery. Routed through the stuck path, children first.
    const deadRoot = await seedRun({
      status: "Abandoned",
      acpSessionId: null,
      currentStepId: null,
    });
    const subOrchestrator = await seedChildRun(deadRoot, "WaitingOnChildren");
    const grandchild = await seedChildRun(subOrchestrator, "Running");

    await seedWorkspace(grandchild, "/worktrees/grandchild");

    const { opts } = await makeOpts({
      worktreePaths: ["/worktrees/grandchild"],
      liveSessions: [],
    });

    await runReconcileSweep(opts);

    expect((await readRun(grandchild)).status).toBe("Abandoned");
    expect((await readRun(subOrchestrator)).status).toBe("Crashed");
  }, 60_000);

  it("recovers a NeedsInput child stranded under a FAILED parent", async () => {
    // Failed is terminal too, and reachable without a cascade: a Running
    // orchestrator that trips its own run-scope token ceiling is terminated to
    // Failed by the run-scope arm, which never touches its children. Treating
    // only Crashed/Abandoned as coordinator death left those children invisible.
    const deadParent = await seedRun({
      status: "Failed",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "NeedsInput");

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    await runReconcileSweep(opts);

    expect((await readRun(orphan)).status).toBe("Crashed");
  }, 60_000);

  it("abandons a Pending child stranded under a DONE parent", async () => {
    const deadParent = await seedRun({
      status: "Done",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "Pending");

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    await runReconcileSweep(opts);

    expect((await readRun(orphan)).status).toBe("Abandoned");
  }, 60_000);
  it("F1: a Running candidate that a racer moves before the crash CAS is neither counted crashed nor stripped of its assignments", async () => {
    // The flow crash arm ignored crashRunningRun's result. A run that a
    // concurrent transition moved between candidate load and the CAS (here:
    // paused into NeedsInput with a fresh assignment) lost the status-guarded
    // CAS — and then had its materializations cleaned, its assignments closed,
    // a slot promoted and `crashed` incremented as if the crash had landed.
    const racer = await seedRun({
      status: "Running",
      currentStepId: "implement",
    });

    // Absent from listWorktrees → classified `worktree-gone`.
    await seedWorkspace(racer, "/worktrees/racer-f1");

    const hitlRequestId = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId: racer,
      stepId: "implement",
      kind: "permission",
      prompt: "May I run the tests?",
    });
    await db.insert(schema.assignments).values({
      id: randomUUID(),
      projectId,
      runId: racer,
      hitlRequestId,
      actionKind: "permission",
      status: "open",
      title: "Permission",
    });

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });
    // listWorktrees runs AFTER candidate load and BEFORE classification — the
    // deterministic slot for a concurrent transition.
    const listWorktrees = vi.fn(async (): Promise<WorktreeInfo[]> => {
      await db
        .update(runs)
        .set({ status: "NeedsInput" })
        .where(eq(runs.id, racer));

      return [];
    });

    const summary = await runReconcileSweep({ ...opts, listWorktrees });

    expect((await readRun(racer)).status).toBe("NeedsInput");
    expect(summary.crashed).toBe(0);
    expect(summary.skipped).toBe(1);

    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, hitlRequestId));

    expect(assignment?.status).toBe("open");
  }, 60_000);

  it("F2: stops an orphaned sub-orchestrator's OWN live session before cascading its children and crashing it", async () => {
    // `orphaned-orchestrator` is the one crash reason that can carry a live
    // session (coordinator death is checked before liveness). The cascade tears
    // down the DESCENDANTS' sessions only, and nothing reaps a live session
    // under a Crashed row — so the coordinator's own adapter kept spending
    // under a terminal row with nothing left to coordinate.
    const deadRoot = await seedRun({
      status: "Abandoned",
      acpSessionId: null,
      currentStepId: null,
    });
    const subOrchestrator = await seedRun({
      status: "WaitingOnChildren",
      parentRunId: deadRoot,
      acpSessionId: "acp-sub-f2",
      currentStepId: "orchestrate",
    });
    const grandchild = await seedChildRun(subOrchestrator, "Running");
    const stopSession = vi.fn(async () => {});
    const { opts } = await makeOpts({
      worktreePaths: [],
      liveSessions: [liveRecord(subOrchestrator, "acp-sub-f2", "orchestrate")],
      deleteSession: stopSession,
    });

    await runReconcileSweep(opts);

    expect(stopSession).toHaveBeenCalledWith(`sup-${subOrchestrator}`);
    expect((await readRun(subOrchestrator)).status).toBe("Crashed");
    expect((await readRun(grandchild)).status).toBe("Abandoned");
  }, 60_000);

  it("F2: leaves an orphaned sub-orchestrator and its sub-tree untouched when its own session cannot be confirmed stopped", async () => {
    // E5: a supervisor 5xx means "cannot confirm the agent stopped". Flipping
    // the row (and cascading the children) with the coordinator still spending
    // is exactly what the budget tree arm refuses to do — next tick instead.
    const deadRoot = await seedRun({
      status: "Abandoned",
      acpSessionId: null,
      currentStepId: null,
    });
    const subOrchestrator = await seedRun({
      status: "WaitingOnChildren",
      parentRunId: deadRoot,
      acpSessionId: "acp-sub-f2-5xx",
      currentStepId: "orchestrate",
    });
    const grandchild = await seedChildRun(subOrchestrator, "Running");
    const stopSession = vi.fn(async () => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503");
    });
    const { opts } = await makeOpts({
      worktreePaths: [],
      liveSessions: [
        liveRecord(subOrchestrator, "acp-sub-f2-5xx", "orchestrate"),
      ],
      deleteSession: stopSession,
    });

    const summary = await runReconcileSweep(opts);

    expect(stopSession).toHaveBeenCalledWith(`sup-${subOrchestrator}`);
    expect((await readRun(subOrchestrator)).status).toBe("WaitingOnChildren");
    expect((await readRun(grandchild)).status).toBe("Running");
    expect(summary.crashed).toBe(0);
  }, 60_000);

  it("F4: crashing an agent orphan closes its open HITL row so the inbox stops asking for a dead run", async () => {
    // The flow crash transition closes the run's open hitl_requests in the same
    // transaction; the agent choke point only does so when asked. Left open, a
    // permission request kept counting toward "Needs you" for a Crashed run.
    const deadParent = await seedRun({
      status: "Crashed",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "NeedsInput");
    const hitlRequestId = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId: orphan,
      stepId: "agent",
      kind: "permission",
      prompt: "May I write the file?",
    });

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });

    await runReconcileSweep(opts);

    expect((await readRun(orphan)).status).toBe("Crashed");

    const [request] = await db
      .select({ respondedAt: schema.hitlRequests.respondedAt })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(request?.respondedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("F4: an agent orphan that a concurrent transition terminalizes before the finalize CAS is not counted as crashed", async () => {
    // finalizeAgentRun returns `finalized: false` (no row touched) when its
    // status CAS loses — or when the finalize is deferred to a pending
    // human-ask activation, the same branch. The crash arm ignored that and
    // reported a crash plus closed the run's assignments anyway. Here an
    // operator abandons the orphan between candidate load and the CAS.
    const deadParent = await seedRun({
      status: "Crashed",
      acpSessionId: null,
      currentStepId: null,
    });
    const orphan = await seedChildRun(deadParent, "Running");

    const { opts } = await makeOpts({ worktreePaths: [], liveSessions: [] });
    const listWorktrees = vi.fn(async (): Promise<WorktreeInfo[]> => {
      await db
        .update(runs)
        .set({ status: "Abandoned", endedAt: new Date() })
        .where(eq(runs.id, orphan));

      return [];
    });

    const summary = await runReconcileSweep({ ...opts, listWorktrees });

    expect(listWorktrees).toHaveBeenCalled();
    expect((await readRun(orphan)).status).toBe("Abandoned");
    expect(summary.crashed).toBe(0);
    expect(summary.skipped).toBe(1);
  }, 60_000);
});

describe("runReconcileSweep — workspace handle check (ADR-166 N6)", () => {
  it("warns workspace-handle-lost for an active assignment the host no longer knows and keeps sweeping", async () => {
    const runId = await seedRun({ acpSessionId: "acp-lost" });

    await seedWorkspace(runId, "/worktrees/lost");
    const { opts, hosts } = await makeOpts({
      worktreePaths: ["/worktrees/lost"],
      liveSessions: [liveRecord(runId, "acp-lost")],
    });
    // The run's assignment carries a handle the (fresh) fake host never adopted
    // — the shape a wiped host state dir leaves behind.
    const client = await hosts.forRun(runId);

    await db
      .update(schema.executionAssignments)
      .set({ executionWorkspaceId: `ws_${"0".repeat(32)}` })
      .where(eq(schema.executionAssignments.id, client.assignment.id));

    const summary = await runReconcileSweep(opts);

    expect(summary).toMatchObject({ handlesLost: 1, crashed: 0 });
    expect((await readRun(runId)).status).toBe("Running");
  }, 60_000);
});

// ─── ADR-177: evidence-first crash classification ──────────────────────────
//
// The sweep classifies a sessionless `Running` flow agent node from the current
// attempt's newest OWNED `session.prompt` evidence, and only falls back to the
// grace window when there is no evidence at all.
//
// Every case here is past the 90 s grace **by backdating the attempt's
// `started_at`**, never by waiting and never by shrinking
// `MAISTER_RECONCILE_GRACE_SECONDS` — so a SKIP can only be the evidence arm
// (the in-repo precedent is the `startedAt: Date.now() - 600_000` cases above).

type SeededPrompt = { commandId: string; nodeAttemptId: string };

// A `session.prompt` row owned by `nodeAttemptId`, in whatever evidence shape
// the case needs. `request_schema` is deliberately v1 so
// `execution_commands_request_v2_check` takes its short branch — this suite
// asserts CLASSIFICATION, not canonical request identity.
async function seedOwnedPrompt(
  runId: string,
  hostId: string,
  overrides: Record<string, unknown> = {},
  opts: {
    attemptStartedAt?: Date;
    nodeAttemptId?: string;
    // A non-`node` owner (permission_resume, a gate): merged over the node ref.
    ownerRef?: Record<string, unknown>;
    logicalOperationKey?: string;
  } = {},
): Promise<SeededPrompt> {
  const { mintAssignment } = await import("@/lib/execution-host/assignments");
  const existing = await db
    .select({
      id: schema.executionAssignments.id,
      epoch: schema.executionAssignments.epoch,
    })
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId));
  const assignment =
    existing[0] ??
    (await db.transaction(async (tx) =>
      mintAssignment(tx as never, { runId, hostId, reason: "launch" }),
    ));
  const assignmentId = (assignment as { id: string }).id;
  const assignmentEpoch = (assignment as { epoch: number }).epoch;

  let nodeAttemptId = opts.nodeAttemptId;

  if (!nodeAttemptId) {
    nodeAttemptId = randomUUID();
    await db.insert(nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
      executionAssignmentId: assignmentId,
      actionPromptOrdinal: 0,
      // Definitively OUTSIDE the grace window: a skip can only be evidence.
      startedAt: opts.attemptStartedAt ?? new Date(Date.now() - 600_000),
    });
  }
  const commandId = randomUUID();

  await db.insert(executionCommands).values({
    id: commandId,
    runId,
    executionAssignmentId: assignmentId,
    executionHostId: hostId,
    assignmentEpoch,
    kind: "session.prompt",
    targetSessionId: `sess-${runId.slice(0, 8)}`,
    payload: {},
    maxAttempts: 3,
    ownerKind: "flow_node_attempt",
    ownerRef: {
      version: 1,
      variant: "node",
      nodeAttemptId,
      promptOrdinal: 0,
      runId,
      runSessionId: randomUUID(),
      incarnationId: randomUUID(),
      assignmentId,
      assignmentEpoch,
      ...opts.ownerRef,
    },
    logicalOperationKey:
      opts.logicalOperationKey ?? `flow_node_attempt:node:${nodeAttemptId}:0`,
    requestSchema: "maister.command.request.v1",
    requestSha256: "a".repeat(64),
    state: "accepted",
    acceptedAt: new Date(Date.now() - 300_000),
    ...overrides,
  });

  return { commandId, nodeAttemptId };
}

const TURN_LOST_NESTED = {
  code: "PRECONDITION",
  details: { reason: "turn_lost" },
};
// `foldReceipt`'s accepted-with-no-terminal fallback FLATTENS the reason
// (`recovery.ts`), so a matcher keyed only on `details.reason` never fires on
// this shape. Both are production-reachable; both must classify.
const TURN_LOST_FLAT = { code: "ACP_PROTOCOL", reason: "turn_lost" };

const SETTLED_TURN_LOST = (error: Record<string, unknown>) => ({
  state: "failed" as const,
  completedAt: new Date(Date.now() - 120_000),
  lastError: error,
});

async function readCommand(commandId: string): Promise<any> {
  const rows = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  return rows[0];
}

async function readAttempt(nodeAttemptId: string): Promise<any> {
  const rows = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, nodeAttemptId));

  return rows[0];
}

/** The cause crashRunningRun recorded for THIS run. `summary.turnLost` counts
 * every run the sweep crashed on that path, so it cannot say which one. */
async function crashReasonOf(runId: string): Promise<unknown> {
  const events = await db
    .select({
      kind: schema.domainEvents.kind,
      payload: schema.domainEvents.payload,
    })
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId));

  return events
    .filter((event) => event.kind === "run.crashed")
    .map((event) => (event.payload as { reason?: unknown }).reason);
}

async function markHostStreamLost(hostId: string): Promise<void> {
  await db.insert(schema.executionEventStreams).values({
    id: randomUUID(),
    executionHostId: hostId,
    streamId: `lost-${randomUUID().slice(0, 8)}`,
    state: "lost",
  });
}

// A v1 `accepted` + `inflight:false` receipt: the host restarted mid-turn.
// Answered for ANY command, so only the command the lookup picks is probed.
const turnLostReceipt =
  (runId: string) =>
  async (commandId: string): Promise<unknown> => ({
    commandId,
    runId,
    kind: "session.prompt",
    assignmentEpoch: 1,
    phase: "accepted",
    httpStatus: 202,
    body: {},
    receivedAt: new Date().toISOString(),
    completedAt: null,
    eventId: null,
    inflight: false,
  });

// The pre-permission action turn a permission resume or a gate follows: it was
// applied, and it is OLDER than the turn that is live now.
const APPLIED_EARLIER = {
  state: "succeeded" as const,
  createdAt: new Date(Date.now() - 200_000),
  completedAt: new Date(Date.now() - 190_000),
  applicationState: "applied" as const,
  completionAppliedAt: new Date(Date.now() - 180_000),
};

describe("runReconcileSweep — evidence-first crash classification (ADR-177)", () => {
  it("RED 1: a settled turn_lost past grace crashes turn-lost through ONE boundary — attempt closed, command discharged", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/turn-lost");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/turn-lost"],
      liveSessions: [],
    });
    const { commandId, nodeAttemptId } = await seedOwnedPrompt(
      runId,
      hostId,
      SETTLED_TURN_LOST(TURN_LOST_NESTED),
    );

    const summary = await runReconcileSweep(opts);
    const run = await readRun(runId);
    const attempt = await readAttempt(nodeAttemptId);
    const command = await readCommand(commandId);

    expect(run.status).toBe("Crashed");
    // On this HEAD the run IS Crashed — but as `agent-session-gone`, by age,
    // with the attempt untouched and the command stranded. The three facts
    // below are what the boundary adds, and what fails today.
    expect(
      run.resumeTargetStepId,
      "the run must stay recoverable: crashRunningRun stamps resume_target_step_id",
    ).toBe("implement");
    expect(
      {
        status: attempt.status,
        decision: attempt.decision,
        errorCode: attempt.errorCode,
      },
      "the attempt must be CLOSED by the boundary: Reworked/turn_lost/CRASH (this HEAD leaves it Running with decision NULL)",
    ).toEqual({
      status: "Reworked",
      decision: "turn_lost",
      errorCode: "CRASH",
    });
    expect(attempt.endedAt).not.toBeNull();
    expect(
      {
        applicationState: command.applicationState,
        applied: command.completionAppliedAt !== null,
      },
      "the command must be discharged in the SAME transaction, or it strands owner_unapplied forever (C3)",
    ).toEqual({ applicationState: "applied", applied: true });
    expect(summary.turnLost).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 1b: the FLAT turn_lost shape foldReceipt writes classifies identically", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/turn-lost-flat");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/turn-lost-flat"],
      liveSessions: [],
    });
    const { nodeAttemptId } = await seedOwnedPrompt(
      runId,
      hostId,
      SETTLED_TURN_LOST(TURN_LOST_FLAT),
    );

    await runReconcileSweep(opts);
    const attempt = await readAttempt(nodeAttemptId);

    expect(
      attempt.decision,
      "a matcher keyed only on details.reason misses foldReceipt's flattened error",
    ).toBe("turn_lost");
  }, 60_000);

  it("RED 2a: a settled-unapplied command past grace is SKIPPED (evidence-pending), not crashed", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/pending-app");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/pending-app"],
      liveSessions: [],
    });

    await seedOwnedPrompt(runId, hostId, {
      state: "succeeded",
      completedAt: new Date(Date.now() - 5_000),
      result: { stopReason: "end_turn" },
    });

    const summary = await runReconcileSweep(opts);

    expect(
      (await readRun(runId)).status,
      "the prompt-owner worker owes the next move within ~1s — crashing here discards a finished turn",
    ).toBe("Running");
    expect(summary.evidencePending).toBeGreaterThanOrEqual(1);
    expect(summary.crashed).toBe(0);
  }, 60_000);

  it("RED 2b: an accepted command whose receipt says completed is SKIPPED (pending_ingest)", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/pending-ingest");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/pending-ingest"],
      liveSessions: [],
      getCommandReceipt: async (commandId: string) => ({
        commandId,
        runId,
        kind: "session.prompt",
        assignmentEpoch: 1,
        phase: "completed",
        httpStatus: 200,
        body: {},
        receivedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        eventId: null,
        inflight: false,
      }),
    });

    await seedOwnedPrompt(runId, hostId);

    const summary = await runReconcileSweep(opts);

    expect((await readRun(runId)).status).toBe("Running");
    expect(summary.evidencePending).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 2c: an accepted command still in flight on the host is SKIPPED (evidence-inflight)", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/inflight-evidence");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/inflight-evidence"],
      liveSessions: [],
      getCommandReceipt: async (commandId: string) => ({
        commandId,
        runId,
        kind: "session.prompt",
        assignmentEpoch: 1,
        phase: "accepted",
        httpStatus: 202,
        body: {},
        receivedAt: new Date().toISOString(),
        completedAt: null,
        eventId: null,
        inflight: true,
      }),
    });

    await seedOwnedPrompt(runId, hostId);

    const summary = await runReconcileSweep(opts);

    expect(
      (await readRun(runId)).status,
      "the turn is genuinely still running on the host — age is not evidence it died",
    ).toBe("Running");
    expect(summary.crashed).toBe(0);
  }, 60_000);

  it("a v2 accepted receipt proves nothing, so the GRACE rule still decides it", async () => {
    // The composition guard for the `indeterminate` probe answer. Each link is
    // pinned by a unit suite — the probe returns `indeterminate` for a v2
    // accepted receipt, `indeterminate` classifies `none`, and `none` past
    // grace crashes — but nothing pinned them TOGETHER, and the whole point of
    // this arm is which of two sweep outcomes a real candidate reaches.
    //
    // Under the `pending_ingest` reading this case is `Running` with
    // `evidencePending >= 1`: skipped regardless of grace, forever, by every
    // sweep, with no writer that owes the next move. Since v2 IS the production
    // request schema, that reading silently deleted the pre-ADR-177 safety net
    // from the production path.
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/v2-indeterminate");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/v2-indeterminate"],
      liveSessions: [],
      getCommandReceipt: async (commandId: string) => ({
        commandId,
        runId,
        kind: "session.prompt",
        assignmentEpoch: 1,
        phase: "accepted",
        httpStatus: 202,
        body: {},
        receivedAt: new Date().toISOString(),
        completedAt: null,
        eventId: null,
        // What `normalizeCommandReceiptV2` produces: the v2 wire shape has no
        // liveness field, so this is hardcoded and means NOTHING here.
        inflight: false,
        evidenceV2: { receiptVersion: 2, commandId, phase: "accepted" },
      }),
    });

    await seedOwnedPrompt(runId, hostId);

    const summary = await runReconcileSweep(opts);

    expect(
      (await readRun(runId)).status,
      "a receipt that proves nothing must leave the long-standing grace net in place",
    ).toBe("Crashed");
    expect(
      summary.turnLost ?? 0,
      "and it must never be read as PROOF of a lost turn in the other direction",
    ).toBe(0);
    expect(
      summary.evidencePending ?? 0,
      "claiming a writer owes the next move is what would skip this row forever",
    ).toBe(0);
  }, 60_000);

  it("RED 2d: an APPLIED completion past grace is SKIPPED (evidence-applied) — the continuation worker owns it", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/applied");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/applied"],
      liveSessions: [],
    });

    await seedOwnedPrompt(runId, hostId, {
      state: "succeeded",
      completedAt: new Date(Date.now() - 5_000),
      applicationState: "applied",
      completionAppliedAt: new Date(Date.now() - 4_000),
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(runId)).status).toBe("Running");
    expect(summary.evidenceApplied).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 2e: pending evidence on a host whose event stream is LOST crashes stream-lost — the only bound", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/stream-lost");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/stream-lost"],
      liveSessions: [],
    });
    // An `accepted` row whose terminal event was never ingested: the evidence
    // is still ON THE HOST, which is the only shape a dead stream can strand.
    // (A settled-but-unapplied row is NOT stranded by it — that evidence is
    // already in Postgres and its writer reads it from there.)
    const { commandId, nodeAttemptId } = await seedOwnedPrompt(runId, hostId);

    await markHostStreamLost(hostId);

    await runReconcileSweep(opts);

    expect((await readRun(runId)).status).toBe("Crashed");
    expect(
      (await readAttempt(nodeAttemptId)).decision,
      "a stream that can never deliver the evidence is an impasse, not a wait",
    ).toBe("turn_lost");
    expect((await readCommand(commandId)).applicationState).toBe("applied");
  }, 60_000);

  // `commandStreamLost` asserted DIRECTLY, and deliberately so. Routing this
  // through the sweep looked like a regression guard and was not: the old
  // implementation read ONE arbitrary row, so its answer for a mixed host was
  // undefined — a sweep-level case passed against the unfixed code on the first
  // falsification run. What CAN be pinned is the contract itself, over every
  // shape a host can be in. The old code could satisfy this only by luck.
  const STREAM_SHAPES: Array<{
    states: string[];
    lost: boolean;
    why: string;
  }> = [
    {
      states: ["lost", "active"],
      lost: false,
      why: "a recovered host: evidence flows on the live stream",
    },
    { states: ["active"], lost: false, why: "healthy" },
    { states: ["lost"], lost: true, why: "given up, nothing flowing" },
    {
      states: ["lost", "lost"],
      lost: true,
      why: "several dead streams, still nothing flowing",
    },
    {
      states: ["lost", "closed"],
      lost: true,
      why: "a closed stream carries nothing either",
    },
  ];

  it.each(STREAM_SHAPES)(
    "commandStreamLost: $states -> $lost ($why)",
    async ({ states, lost }) => {
      const { commandStreamLost } = await import(
        "@/lib/execution-host/events/stream-health"
      );
      const runId = await seedRun({ acpSessionId: null });

      await seedWorkspace(runId, `/worktrees/sl-${randomUUID().slice(0, 8)}`);
      const { hostId } = await makeOpts({ liveSessions: [] });
      const { commandId } = await seedOwnedPrompt(runId, hostId);

      for (const state of states) {
        await db.insert(schema.executionEventStreams).values({
          id: randomUUID(),
          executionHostId: hostId,
          streamId: `s-${randomUUID().slice(0, 8)}`,
          state,
        });
      }

      expect(await commandStreamLost({ db: db as never, commandId })).toBe(
        lost,
      );
    },
    60_000,
  );

  it("RED 4a: a poisoned application crashes owner-poisoned and keeps its diagnostic", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/poisoned");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/poisoned"],
      liveSessions: [],
    });
    const { commandId, nodeAttemptId } = await seedOwnedPrompt(runId, hostId, {
      state: "failed",
      completedAt: new Date(Date.now() - 5_000),
      lastError: { code: "ACP_PROTOCOL" },
      applicationState: "poisoned",
      applicationError: {
        reason: "owner_invariant",
        phase: "apply",
        causeCode: "x",
      },
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(runId)).status).toBe("Crashed");
    expect((await readAttempt(nodeAttemptId)).decision).toBe("turn_lost");
    const command = await readCommand(commandId);

    expect(command.applicationState).toBe("applied");
    expect(
      command.applicationError,
      "the boundary must NOT null the poison diagnostic — an operator needs it",
    ).not.toBeNull();
    expect(summary.ownerPoisoned).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 4b: a quarantined conflict found AFTER application still crashes owner-poisoned, never reads as healthy", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/quarantined");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/quarantined"],
      liveSessions: [],
    });
    // `quarantine()` writes applicationState = completionAppliedAt ? 'applied'
    // : 'poisoned'. Keying the quarantine arm on 'poisoned' alone would let
    // THIS row classify as `applied` → SKIP, hiding a disagreeing turn forever.
    const { nodeAttemptId } = await seedOwnedPrompt(runId, hostId, {
      state: "succeeded",
      completedAt: new Date(Date.now() - 5_000),
      applicationState: "applied",
      completionAppliedAt: new Date(Date.now() - 4_000),
      applicationError: {
        reason: "prompt_terminal_conflict",
        phase: "prepare",
        causeCode: "x",
      },
    });

    const summary = await runReconcileSweep(opts);

    expect(
      (await readRun(runId)).status,
      "row 3 (quarantined) MUST precede row 5 (applied) in the derivation order",
    ).toBe("Crashed");
    expect((await readAttempt(nodeAttemptId)).decision).toBe("turn_lost");
    expect(summary.ownerPoisoned).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 5b: a run whose only command is still QUEUED derives `none` and keeps the grace/agent-session-gone path", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/queued");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/queued"],
      liveSessions: [],
    });
    const { nodeAttemptId } = await seedOwnedPrompt(runId, hostId, {
      state: "queued",
      acceptedAt: null,
    });

    const summary = await runReconcileSweep(opts);

    // GREEN on this HEAD and after: the regression guard that the change does
    // not move the no-evidence path.
    expect((await readRun(runId)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
    const attempt = await readAttempt(nodeAttemptId);

    expect(
      attempt.decision,
      "nothing was dispatched to lose — this is agent-session-gone, not turn-lost",
    ).toBeNull();
    expect(summary.turnLost ?? 0).toBe(0);
  }, 60_000);

  it("evidence is read from the CURRENT NODE's open attempt, not the run's newest (review fix)", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/attempt-scope");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/attempt-scope"],
      liveSessions: [],
    });
    // A lost turn on a CLOSED attempt of a DIFFERENT node. It is the run's
    // newest row by `started_at`, so a run-scoped probe would classify from it
    // — and the boundary, which resolves the open attempt at `current_step_id`,
    // would then act somewhere else or not at all.
    const stale = await seedOwnedPrompt(
      runId,
      hostId,
      SETTLED_TURN_LOST(TURN_LOST_NESTED),
      // NEWER than the current node's attempt (so a run-scoped probe would pick
      // it) but still well past the 90 s grace (so the grace arm cannot be what
      // decides this case).
      { attemptStartedAt: new Date(Date.now() - 300_000) },
    );

    await db
      .update(nodeAttempts)
      .set({ nodeId: "build", status: "Succeeded", endedAt: new Date() })
      .where(eq(nodeAttempts.id, stale.nodeAttemptId));
    // The node the run is actually parked on, with no evidence of its own.
    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 2,
      status: "Running",
      actionPromptOrdinal: 0,
      startedAt: new Date(Date.now() - 600_000),
    });

    const summary = await runReconcileSweep(opts);

    // `none` for the current attempt → the unchanged grace path, NOT a
    // turn-lost crash inherited from a closed attempt of another node.
    expect((await readRun(runId)).status).toBe("Crashed");
    expect(summary.turnLost ?? 0).toBe(0);
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("RED 5c: a SCRATCH run with a settled turn_lost command keeps its own arm — the evidence probe is flow-only", async () => {
    const runId = await seedRun({
      runKind: "scratch",
      acpSessionId: null,
      currentStepId: "dialog",
    });

    await seedWorkspace(runId, "/worktrees/scratch-lost");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/scratch-lost"],
      liveSessions: [],
    });
    const { nodeAttemptId } = await seedOwnedPrompt(
      runId,
      hostId,
      SETTLED_TURN_LOST(TURN_LOST_NESTED),
    );

    await runReconcileSweep(opts);

    // Scope guard (trap 7): scratch keeps `markScratchCrashed`; the classifier
    // arm is not widened to it. GREEN on this HEAD and after.
    expect((await readRun(runId)).status).toBe("Crashed");
    expect((await readAttempt(nodeAttemptId)).decision).toBeNull();
  }, 60_000);

  it("AC-D7.1: the probe is served by execution_commands_run_created_idx, not a sequential scan", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/explain");
    const { hostId } = await makeOpts({
      worktreePaths: ["/worktrees/explain"],
      liveSessions: [],
    });
    const { nodeAttemptId } = await seedOwnedPrompt(runId, hostId);

    // D7's claim is "no migration AND no index" — the second half is a COST
    // claim, so it is measured rather than asserted. `enable_seqscan = off`
    // makes this deterministic on a fixture-sized table, where the planner
    // would otherwise pick a sequential scan for two rows no matter what
    // indexes exist; what it proves is that the index CAN serve this exact
    // predicate-plus-sort, which is the thing in question.
    await pool.query("SET enable_seqscan = off");
    try {
      const plan = await pool.query(
        `EXPLAIN SELECT id FROM execution_commands
           WHERE run_id = $1 AND kind = 'session.prompt'
             AND owner_ref->>'variant' = 'node'
             AND owner_ref->>'nodeAttemptId' = $2
           ORDER BY created_at DESC LIMIT 1`,
        [runId, nodeAttemptId],
      );
      const text = plan.rows.map((r: any) => r["QUERY PLAN"]).join("\n");

      expect(
        text,
        "the leading column is the equality predicate and the second is the sort, so one run's commands are walked newest-first",
      ).toContain("execution_commands_run_created_idx");
      expect(text).not.toContain("Seq Scan on execution_commands");
    } finally {
      await pool.query("SET enable_seqscan = on");
    }
  }, 60_000);

  it("RED 6: the boundary makes the command RETIREMENT-eligible — at Crashed, and again at Done", async () => {
    const { classifyCommandRetirement } = await import(
      "@/lib/execution-host/retirement"
    );
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/retire");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/retire"],
      liveSessions: [],
    });
    const { commandId } = await seedOwnedPrompt(
      runId,
      hostId,
      SETTLED_TURN_LOST(TURN_LOST_NESTED),
    );

    await runReconcileSweep(opts);
    const command = await readCommand(commandId);
    const row = {
      ...command,
      runStatus: (await readRun(runId)).status,
      terminalHostSequence: 1n,
      ackConfirmedSequence: 1n,
      terminalEventId: "evt-1",
    };

    // `Crashed` is NOT in RETAINED_RUN_STATUSES, so eligibility does not have
    // to wait for a Recover to reach Done.
    expect(
      classifyCommandRetirement(row as never, {
        now: new Date(Date.now() + 86_400_000),
        graceMs: 0,
      }),
      "an unapplied command answers owner_unapplied forever and blocks deleting the run",
    ).toBeNull();
    expect(
      classifyCommandRetirement({ ...row, runStatus: "Done" } as never, {
        now: new Date(Date.now() + 86_400_000),
        graceMs: 0,
      }),
    ).toBeNull();
  }, 60_000);
  // ADR-177 amendment 2026-09-23: "the current attempt's newest owned
  // session.prompt" is the turn that is live NOW — a permission-resumed action
  // or a gate evaluation runs on the same attempt as a NEWER command than the
  // applied `node` turn before it. Reading `node` alone answered `applied` for
  // a turn the classifier never looked at.
  it("RED 7: a permission-resumed action turn the host lost crashes turn-lost — not skipped as the applied pre-permission turn", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/permission-resume-lost");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/permission-resume-lost"],
      liveSessions: [],
      getCommandReceipt: turnLostReceipt(runId),
    });
    const before = await seedOwnedPrompt(runId, hostId, APPLIED_EARLIER);
    const hitlRequestId = randomUUID();
    const resumed = await seedOwnedPrompt(
      runId,
      hostId,
      { createdAt: new Date(Date.now() - 100_000) },
      {
        nodeAttemptId: before.nodeAttemptId,
        ownerRef: { variant: "permission_resume", hitlRequestId },
        logicalOperationKey: `flow_node_attempt:permission_resume:${before.nodeAttemptId}:0`,
      },
    );

    await runReconcileSweep(opts);
    const run = await readRun(runId);

    expect(
      run.status,
      "the live turn is the permission_resume command; the applied node turn before it is history",
    ).toBe("Crashed");
    expect(await crashReasonOf(runId)).toEqual(["turn-lost"]);
    expect(await readAttempt(before.nodeAttemptId)).toMatchObject({
      status: "Reworked",
      decision: "turn_lost",
      errorCode: "CRASH",
    });
    expect(
      (await readCommand(resumed.commandId)).applicationState,
      "the boundary discharges the command it classified",
    ).toBe("applied");
    expect(
      (await readCommand(before.commandId)).completionAppliedAt?.getTime(),
      "the earlier applied turn is not rewritten",
    ).toBe(APPLIED_EARLIER.completionAppliedAt.getTime());
  }, 60_000);

  it("RED 8: a gate turn the host lost stales its evaluation and crashes turn-lost, keeping the action's completion", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/gate-lost");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/gate-lost"],
      liveSessions: [],
      getCommandReceipt: turnLostReceipt(runId),
    });
    const action = await seedOwnedPrompt(runId, hostId, APPLIED_EARLIER);

    // Gates run AFTER the action persisted its completion on the SAME attempt.
    await db
      .update(nodeAttempts)
      .set({
        actionCompletion: {
          version: 1,
          commandId: action.commandId,
          promptOrdinal: 0,
          result: { ok: true, stdout: "action done", vars: {} },
          originalOutput: { kind: "sentinel", text: "done", truncated: false },
        },
      })
      .where(eq(nodeAttempts.id, action.nodeAttemptId));
    const evaluationId = randomUUID();

    await db.insert(schema.gateResults).values({
      id: evaluationId,
      runId,
      nodeAttemptId: action.nodeAttemptId,
      gateId: "review",
      kind: "ai_judgment",
      mode: "blocking",
      status: "running",
    });
    const gate = await seedOwnedPrompt(
      runId,
      hostId,
      { createdAt: new Date(Date.now() - 100_000) },
      {
        nodeAttemptId: action.nodeAttemptId,
        ownerRef: { variant: "gate_ai", gateId: "review", evaluationId },
        logicalOperationKey: `flow_node_attempt:gate_ai:${evaluationId}:0`,
      },
    );

    await runReconcileSweep(opts);
    const attempt = await readAttempt(action.nodeAttemptId);
    const [evaluation] = await db
      .select()
      .from(schema.gateResults)
      .where(eq(schema.gateResults.id, evaluationId));

    expect((await readRun(runId)).status).toBe("Crashed");
    expect(await crashReasonOf(runId)).toEqual(["turn-lost"]);
    expect(attempt).toMatchObject({
      status: "Reworked",
      decision: "turn_lost",
    });
    expect(
      attempt.actionCompletion,
      "a lost gate turn does not discard the action's own result",
    ).not.toBeNull();
    // `stale`, not `failed`: a host restart is not a gate verdict (ADR-177 D3).
    expect(evaluation.status).toBe("stale");
    expect((await readCommand(gate.commandId)).applicationState).toBe(
      "applied",
    );
  }, 60_000);

  it("an APPLIED gate turn after the action is still SKIPPED (evidence-applied) — the continuation worker owns it", async () => {
    const runId = await seedRun({ acpSessionId: null });

    await seedWorkspace(runId, "/worktrees/gate-applied");
    const { opts, hostId } = await makeOpts({
      worktreePaths: ["/worktrees/gate-applied"],
      liveSessions: [],
    });
    const action = await seedOwnedPrompt(runId, hostId, APPLIED_EARLIER);
    const evaluationId = randomUUID();

    await db.insert(schema.gateResults).values({
      id: evaluationId,
      runId,
      nodeAttemptId: action.nodeAttemptId,
      gateId: "review",
      kind: "ai_judgment",
      mode: "blocking",
      status: "passed",
    });
    await seedOwnedPrompt(
      runId,
      hostId,
      {
        ...APPLIED_EARLIER,
        createdAt: new Date(Date.now() - 100_000),
        completionAppliedAt: new Date(Date.now() - 90_000),
      },
      {
        nodeAttemptId: action.nodeAttemptId,
        ownerRef: { variant: "gate_ai", gateId: "review", evaluationId },
        logicalOperationKey: `flow_node_attempt:gate_ai:${evaluationId}:0`,
      },
    );

    const summary = await runReconcileSweep(opts);

    expect((await readRun(runId)).status).toBe("Running");
    expect(summary.evidenceApplied).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
