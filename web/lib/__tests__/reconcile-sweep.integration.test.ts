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
  runKind?: "flow" | "scratch";
  acpSessionId?: string | null;
  currentStepId?: string | null;
  resumeStartedAt?: Date | null;
  startedAt?: Date;
};

async function seedRun(opts: SeedRunOpts = {}): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
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

  it("crashes a reparked-Running LINEAR run on a human goto target (window-(c)), retaining resume_target_step_id — does NOT redispatch (ADR-052)", async () => {
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
});
