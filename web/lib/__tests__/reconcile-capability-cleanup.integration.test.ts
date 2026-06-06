// M14 T4.3 — sub-cycle C2 (RED): the crash reconciler must clean a crashed
// run's per-node capability dirs as it drives the run terminal. This pins the
// OBSERVABLE result of the reconcile crash seam wiring
// cleanupRunMaterializations:
//   - a Running run whose worktree is gone is classified crash → Crashed
//     (existing reconcile behavior — already works);
//   - the on-disk per-node capability dir is GONE (the seam ran cleanup);
//   - the node_attempt's materializationPlan.cleanup.status === "done";
//   - the sweep did not throw.
//
// Expected RED: the reconciler does NOT yet call any cleanup function in its
// `case "crash"` dispatch, so the materialized dir SURVIVES and cleanup.status
// stays "pending" after the run is Crashed. (The Crashed transition passes; only
// the capability-dir cleanup is missing.)
//
// Harness mirrors reconcile-sweep.integration.test.ts for the crash-eligible
// seed (Running run + workspace whose worktreePath is ABSENT from the injected
// listWorktrees + empty listSessions) and the C1 seed shape
// (cleanup.integration.test.ts) for the node_attempt's materializationPlan + a
// REAL provisioned dir at capabilityMaterializationRootPath(worktreePath, runId,
// nodeAttemptId).

import type { MaterializationPlan } from "@/lib/db/schema";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
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
let projectId: string;
let projectRepoPath: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;
let userId: string;
let originalCap: string | undefined;
let originalGrace: string | undefined;

// A graph manifest whose `implement` ai_coding node is the run's currentStepId.
// worktree-gone classification crashes BEFORE node-kind resolution matters, but
// keep the manifest faithful to the reconcile harness.
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
    .withDatabase("reconcile_cleanup_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  process.env.DB_URL = container.getConnectionUri();

  projectId = randomUUID();
  projectRepoPath = `/repos/reconcile-clean-${randomUUID()}`;
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();
  userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `recon-clean-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(projects).values({
    id: projectId,
    slug: "reconcile-clean-app",
    name: "Reconcile Clean App",
    repoPath: projectRepoPath,
    maisterYamlPath: `${projectRepoPath}/maister.yaml`,
  });

  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));

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
    manifestDigest: "sha256:recon-clean",
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
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(nodeAttempts);
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
});

// A minimal but VALID MaterializationPlan body (cleanup defaults to pending).
function makePlan(): MaterializationPlan {
  return {
    profileDigest: "digest-c2-reconcile",
    resolvedRevisions: [{ refId: "github", kind: "mcp", sha: "sha-reconcile" }],
    materializedFiles: ["/tmp/profile.json", "/tmp/.mcp.json"],
    enforcedClasses: ["github"],
    instructedClasses: ["my-skill"],
    refusedClasses: [],
    cleanup: { status: "pending" },
  };
}

// Seed a Running run (currentStepId implement, with an acpSessionId), a real
// mkdtemp worktree workspace, and one node_attempt carrying a materializationPlan.
async function seedCrashEligibleRun(): Promise<{
  runId: string;
  nodeAttemptId: string;
  worktreePath: string;
}> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-recon-clean-"));

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
    runKind: "flow",
    status: "Running",
    acpSessionId: "acp-crash",
    currentStepId: "implement",
    flowVersion: "v1",
    startedAt: new Date(),
    resumeStartedAt: null,
  });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath,
    parentRepoPath: projectRepoPath,
    removedAt: null,
  });

  await db.insert(nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date(),
    materializationPlan: makePlan(),
  });

  return { runId, nodeAttemptId, worktreePath };
}

// Inject a healthy supervisor reporting NO live sessions and a worktree set that
// EXCLUDES the run's worktree → classify worktree-gone → crash.
function makeOpts(over: {
  worktreePaths?: string[];
  liveSessions?: SupervisorSessionRecord[];
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

  const listSessions = async (): Promise<SupervisorSessionRecord[]> =>
    over.liveSessions ?? [];

  return {
    db,
    listSessions,
    listWorktrees,
    runFlow,
    scheduleResumedSessionDrive,
    now: () => new Date(),
  };
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function reloadPlan(
  nodeAttemptId: string,
): Promise<MaterializationPlan | null> {
  const rows = await db
    .select({ materializationPlan: nodeAttempts.materializationPlan })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, nodeAttemptId));

  return (rows[0]?.materializationPlan as MaterializationPlan | null) ?? null;
}

describe("runReconcileSweep — capability-dir cleanup on crash (C2)", () => {
  it("crashing an orphan Running run removes its per-node capability dir and records cleanup.done", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seedCrashEligibleRun();

    const dir = capabilityMaterializationRootPath(
      worktreePath,
      runId,
      nodeAttemptId,
    );

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "profile.json"), "{}");

    expect(await exists(dir)).toBe(true);

    // worktree ABSENT from listWorktrees + no live session → classify
    // worktree-gone → crash dispatch.
    const opts = makeOpts({ worktreePaths: [], liveSessions: [] });

    const summary = await runReconcileSweep(opts);

    // The sweep did not throw and crashed the orphan (existing behavior).
    expect(summary.crashed).toBeGreaterThanOrEqual(1);
    expect((await readRun(runId)).status).toBe("Crashed");

    // The capability-dir cleanup is the C2 contract: dir GONE + cleanup.done.
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan).not.toBeNull();
    expect(plan!.cleanup.status).toBe("done");
    // Plan BODY survives the cleanup transition.
    expect(plan!.profileDigest).toBe("digest-c2-reconcile");
    expect(plan!.enforcedClasses).toEqual(["github"]);
  }, 60_000);
});
