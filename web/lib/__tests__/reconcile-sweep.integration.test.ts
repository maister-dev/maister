// M19 Phase 2 (T2.2 / T2.4): runReconcileSweep against a real Postgres
// testcontainer. The advisory-lock + count-then-update crash/promote path
// and the runs⨝workspaces⨝flow_revisions/flows-manifest join are not
// faithfully mockable, so the DB is real; the supervisor (`listSessions`),
// git (`listWorktrees`), the re-dispatcher (`runFlow`) and the re-attach
// driver (`scheduleResumedSessionDrive`) are INJECTED via opts and asserted
// via the returned summary + DB state.
//
// Scenarios (plan T2.4 + the QA contract):
//   1. orphan Running whose worktreePath ∉ listWorktrees → Crashed + oldest
//      Pending promoted (summary.crashed ≥ 1).
//   2. agent run, no live session, latest attempt OLDER than grace → Crashed.
//   3. live session (listSessions returns its acpSessionId, status 'live') →
//      NOT crashed; scheduleResumedSessionDrive called with the live
//      session's sessionId (summary.reattached).
//   4. in-flight recover within grace (resumeStartedAt = now) → NOT crashed
//      (summary.skipped).
//   5. cli node mid-step, no live session → Crashed, runFlow NOT called for it.
//   6. check/judge node, no live session → runFlow called (redispatched),
//      NOT crashed.
//   7. takeover-return candidate (node_attempts ownerUserId+returnedDiff+
//      endedAt all set) → EXCLUDED (not a candidate, not crashed).
//   8. listSessions THROWS → whole tick skipped, zeroed summary, NO run
//      crashed.

import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

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

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runReconcileSweep } from "@/lib/reconcile";

const schema = schemaModule as unknown as Record<string, any>;
const {
  flowRevisions,
  flows,
  nodeAttempts,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

let container: StartedPostgreSqlContainer;
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
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("reconcile_sweep_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

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
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(nodeAttempts);
  await db.delete(workspaces);
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
  // M36 (ADR-095) T7.1: the delegator run id (orphan detection / cascade).
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    runKind: opts.runKind ?? "flow",
    status: opts.status ?? "Running",
    acpSessionId:
      opts.acpSessionId === undefined ? "acp-default" : opts.acpSessionId,
    currentStepId:
      opts.currentStepId === undefined ? "implement" : opts.currentStepId,
    flowVersion: "v1",
    startedAt: opts.startedAt ?? new Date(),
    resumeStartedAt: opts.resumeStartedAt ?? null,
    parentRunId: opts.parentRunId ?? null,
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
// worktree set by default (overridden per test), and spies for runFlow +
// scheduleResumedSessionDrive.
function makeOpts(over: {
  liveSessions?: SupervisorSessionRecord[];
  worktreePaths?: string[];
  listSessions?: () => Promise<SupervisorSessionRecord[]>;
  now?: () => Date;
}) {
  const runFlow = vi.fn(async () => {});
  const scheduleResumedSessionDrive = vi.fn(() => "drive-id");

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

  return {
    opts: {
      db,
      listSessions,
      listWorktrees,
      runFlow,
      scheduleResumedSessionDrive,
      now: over.now ?? (() => new Date()),
    },
    runFlow,
    scheduleResumedSessionDrive,
    listWorktrees,
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
    logPath: "/tmp/log",
    monotonicId: 1,
    acpSessionId,
  };
}

describe("runReconcileSweep (integration)", () => {
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
    const { opts } = makeOpts({
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
    const { opts } = makeOpts({
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
    const { opts, scheduleResumedSessionDrive, runFlow } = makeOpts({
      worktreePaths: ["/worktrees/inflight"],
      liveSessions: [
        liveRecord(inflight, "acp-inflight-unmatched", "implement"),
      ],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(inflight)).status).toBe("Running"); // NOT crashed
    expect(summary.crashed).toBe(0);
    expect(scheduleResumedSessionDrive).not.toHaveBeenCalled(); // skip, not reattach
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  it("reattaches a Running run with a live session (no crash); drives with the live sessionId", async () => {
    const attached = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-live",
    });

    await seedWorkspace(attached, "/worktrees/attached");

    const { opts, scheduleResumedSessionDrive, runFlow } = makeOpts({
      worktreePaths: ["/worktrees/attached"],
      liveSessions: [liveRecord(attached, "acp-live")],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(attached)).status).toBe("Running");
    expect(summary.reattached).toBeGreaterThanOrEqual(1);
    expect(scheduleResumedSessionDrive).toHaveBeenCalledTimes(1);
    expect(scheduleResumedSessionDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: attached,
        supervisorSessionId: `sup-${attached}`,
        acpSessionId: "acp-live",
      }),
    );
    expect(runFlow).not.toHaveBeenCalled();
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

    const { opts, scheduleResumedSessionDrive, runFlow } = makeOpts({
      worktreePaths: ["/worktrees/scratch"],
      liveSessions: [liveRecord(scratch, "acp-scratch-live")],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(scratch)).status).toBe("Running");
    expect(summary.reattached).toBe(0);
    expect(summary.crashed).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(scheduleResumedSessionDrive).not.toHaveBeenCalled();
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
    const { opts } = makeOpts({
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

    const { opts, runFlow } = makeOpts({
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

    const { opts, runFlow } = makeOpts({
      worktreePaths: ["/worktrees/check"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(checkRun)).status).toBe("Running");
    expect(summary.redispatched).toBeGreaterThanOrEqual(1);
    expect(runFlow).toHaveBeenCalledWith(checkRun);
  }, 60_000);

  it("crashes a reparked-Running LINEAR run on a human goto target (window-(c)), retaining resume_target_step_id — does NOT redispatch (ADR-056)", async () => {
    // M17 window-(c): a flat steps[] run reparked onto a human on_reject goto
    // target, whose process died AFTER the repark CAS commit, is Running with
    // currentStepId on the human goto target and no live session. A bare
    // runFlow would restart at step 0 and re-run prior side-effects; reconcile
    // must CRASH it (linear-gate-orphan) so crashRunningRun retains the node in
    // resume_target_step_id and operator Recover resumes from it via crashResume.
    const linearFlowId = randomUUID();
    const linearRevId = randomUUID();
    const LINEAR_MANIFEST = {
      schemaVersion: 1,
      name: "recon-linear-human",
      steps: [
        {
          id: "first-review",
          type: "human",
          form_schema: "./schemas/review.json",
          on_reject: { goto_step: "rework-review", comments_var: "fb" },
        },
        {
          id: "rework-review",
          type: "human",
          form_schema: "./schemas/review.json",
        },
      ],
    };

    await db.insert(flows).values({
      id: linearFlowId,
      projectId,
      flowRefId: "recon-linear",
      source: "github.com/x/recon-linear",
      version: "v1.0.0",
      installedPath: "/tmp/flows/recon-linear",
      manifest: LINEAR_MANIFEST,
      schemaVersion: 1,
    });
    await db.insert(flowRevisions).values({
      id: linearRevId,
      flowRefId: "recon-linear",
      source: "github.com/x/recon-linear",
      versionLabel: "v1.0.0",
      resolvedRevision: "cafef00d",
      manifestDigest: "sha256:recon-linear",
      manifest: LINEAR_MANIFEST,
      schemaVersion: 1,
      installedPath: "/tmp/flows/recon-linear",
      packageStatus: "Installed",
    });

    const taskId = randomUUID();
    const runId = randomUUID();

    await db.insert(tasks).values({
      number: Math.trunc(Math.random() * 1e9) + 1,
      id: taskId,
      projectId,
      title: "t",
      prompt: "p",
      flowId: linearFlowId,
      status: "InFlight",
    });
    await db.insert(runs).values({
      id: runId,
      taskId,
      projectId,
      flowId: linearFlowId,
      flowRevisionId: linearRevId,
      executorId,
      runKind: "flow",
      status: "Running",
      acpSessionId: null,
      currentStepId: "rework-review", // the human goto target after repark
      flowVersion: "v1",
      startedAt: new Date(),
      resumeStartedAt: null,
    });
    await seedWorkspace(runId, "/worktrees/linear-c");

    const { opts, runFlow } = makeOpts({
      worktreePaths: ["/worktrees/linear-c"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
    // crashRunningRun retains the goto target so operator Recover can resume it.
    expect(row.resumeTargetStepId).toBe("rework-review");
    expect(row.currentStepId).toBeNull();
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
    expect(runFlow).not.toHaveBeenCalledWith(runId);
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

    const { opts, runFlow, scheduleResumedSessionDrive } = makeOpts({
      worktreePaths: [], // takeover's worktree absent — would crash if a candidate
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(takeover)).status).toBe("Running");
    expect(summary.candidates).toBe(0);
    expect(summary.crashed).toBe(0);
    expect(runFlow).not.toHaveBeenCalled();
    expect(scheduleResumedSessionDrive).not.toHaveBeenCalled();
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
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
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
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "agent_workspace", "task_id", "project_id", "flow_version", "flow_revision", "status", "acp_session_id", "current_step_id", "started_at")
       VALUES ($1, 'agent', $2, 'manual', 'none', $3, $4, 'agent', 'manual', 'Running', 'acp-agent-noworktree', 'agent', now())`,
      [agentRunId, agentId, taskId, projectId],
    );

    const { opts } = makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    // The run IS evaluated (not silently excluded by the candidate query) —
    // otherwise this guard would pass vacuously.
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect((await readRun(agentRunId)).status).toBe("Running");
    expect(summary.crashed).toBe(0);

    await pool.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
  }, 60_000);

  it("skips the whole tick (zeroed summary, nothing crashed) when listSessions throws", async () => {
    const orphan = await seedRun({
      status: "Running",
      currentStepId: "implement",
    });

    await seedWorkspace(orphan, "/worktrees/orphan-throw");

    const { opts } = makeOpts({
      worktreePaths: [], // worktree gone — would crash on a healthy tick
      listSessions: async () => {
        throw new Error("supervisor unavailable");
      },
    });

    const summary = await runReconcileSweep(opts);

    expect(summary).toEqual({
      candidates: 0,
      crashed: 0,
      redispatched: 0,
      reattached: 0,
      skipped: 0,
    });
    expect((await readRun(orphan)).status).toBe("Running");
  }, 60_000);

  // M36 (ADR-095) T7.1: seed an agent child under a parent run (orphan/cascade).
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

    const { opts } = makeOpts({
      worktreePaths: ["/worktrees/orch"],
      liveSessions: [],
    });

    const summary = await runReconcileSweep(opts);

    expect((await readRun(orchestrator)).status).toBe("Crashed");
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
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

    const { opts } = makeOpts({
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

    const { opts } = makeOpts({
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

    const { opts } = makeOpts({
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
});
