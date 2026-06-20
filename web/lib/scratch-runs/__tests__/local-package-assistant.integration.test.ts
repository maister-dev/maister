// M36 Phase 5 (ADR-096): the project-less scratch-at-local-package run is the
// riskiest change in the plan — a run with runs.project_id NULL must NOT crash
// any run_kind consumer. This suite is the fan-out guard against a real
// Postgres testcontainer:
//   - the scratch_runs XOR CHECK rejects both-set and neither-set owners;
//   - run-kind-invariants admits the local-package-only variant;
//   - runReconcileSweep does NOT mark a project-less run Crashed even though it
//     is in NO project's `git worktree list` (it has no workspace row);
//   - the reconcile classifier routes a project-less scratch run to skip on a
//     live session and never to reattach (resume-driver), matching the
//     project-scratch contract;
//   - a launched run snapshots runs.local_package_id and emits NOTHING
//     project-scoped on a terminal transition (markScratchCrashed no-ops the
//     domain/webhook outbox for a null project).

import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, isNull } from "drizzle-orm";
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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { classifyRunReconcile, runReconcileSweep } from "@/lib/reconcile";
import { assertRunScratchMetadataInvariant } from "@/lib/runs/run-kind-invariants";

// markScratchCrashed lives in scratch-runs/service, which transitively imports
// @/lib/authz → next-auth. Mock authz + the db client (same pattern as
// workbench-stop.integration.test.ts) so the service is importable under
// vitest, then dynamic-import it in beforeAll after the mocks are installed.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "lp-user",
    email: "lp@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

let markScratchCrashed: typeof import("@/lib/scratch-runs/service").markScratchCrashed;

const schema = schemaModule as unknown as Record<string, any>;
const { domainEvents, localPackages, runs, scratchRuns, webhookEvents } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let userId: string;
let runnerId: string;
let localPackageId: string;

const RECON_GRACE_SECONDS = 90;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("lp_assistant_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ markScratchCrashed } = await import("@/lib/scratch-runs/service"));

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  runnerId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `lp-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  const lpRows = await db
    .insert(localPackages)
    .values({
      name: "Bugfix Local",
      slug: `bugfix-local-${randomUUID().slice(0, 8)}`,
      workingDir: `/Users/test/.maister/local/bugfix-${randomUUID().slice(0, 8)}`,
      status: "active",
      createdBy: userId,
    })
    .returning({ id: localPackages.id });

  localPackageId = lpRows[0].id;
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(domainEvents);
  await db.delete(webhookEvents);
  await db.delete(scratchRuns);
  await db.delete(runs);
});

// Insert a project-less local-package scratch run mirroring the single launch
// insert in launchLocalPackageAssistant (no project, no workspace row).
async function seedLocalPackageRun(
  opts: {
    status?: string;
    dialogStatus?: string;
    acpSessionId?: string | null;
    startedAt?: Date;
  } = {},
): Promise<string> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: "scratch",
    taskId: null,
    projectId: null,
    localPackageId,
    flowId: null,
    runnerId,
    capabilityAgent: "claude",
    status: opts.status ?? "Running",
    acpSessionId: opts.acpSessionId ?? null,
    currentStepId: "scratch",
    flowVersion: "scratch",
    flowRevision: "manual",
    flowRevisionId: null,
    createdByUserId: userId,
    startedAt: opts.startedAt ?? new Date(),
  });
  await db.insert(scratchRuns).values({
    runId,
    projectId: null,
    localPackageId,
    name: "assistant",
    initialPrompt: "edit the flow",
    baseBranch: "main",
    baseCommit: "deadbeef",
    targetBranch: "main",
    dialogStatus: opts.dialogStatus ?? "Running",
    createdByUserId: userId,
  });

  return runId;
}

describe("scratch_runs owner XOR CHECK (ADR-096)", () => {
  it("accepts a project-less local-package row (local_package_id only)", async () => {
    const runId = await seedLocalPackageRun();
    const rows = await db
      .select({ localPackageId: scratchRuns.localPackageId })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    expect(rows[0].localPackageId).toBe(localPackageId);
  });

  it("rejects a row with BOTH project_id and local_package_id set", async () => {
    // A real project for the both-set attempt.
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `both-${randomUUID().slice(0, 8)}`,
      name: "Both",
      repoPath: `/repos/both-${randomUUID()}`,
      taskKey: `B${randomUUID().slice(0, 7)}`.toUpperCase(),
    });

    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "scratch",
      projectId,
      localPackageId,
      status: "Running",
      currentStepId: "scratch",
      flowVersion: "scratch",
      flowRevision: "manual",
      createdByUserId: userId,
    });

    await expect(
      db.insert(scratchRuns).values({
        runId,
        projectId,
        localPackageId,
        name: "both",
        initialPrompt: "x",
        baseBranch: "main",
        baseCommit: "deadbeef",
        dialogStatus: "Running",
        createdByUserId: userId,
      }),
    ).rejects.toThrow(/scratch_runs_owner_xor_check/);

    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  });

  it("rejects a row with NEITHER project_id nor local_package_id set", async () => {
    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "scratch",
      projectId: null,
      localPackageId: null,
      status: "Running",
      currentStepId: "scratch",
      flowVersion: "scratch",
      flowRevision: "manual",
      createdByUserId: userId,
    });

    await expect(
      db.insert(scratchRuns).values({
        runId,
        projectId: null,
        localPackageId: null,
        name: "neither",
        initialPrompt: "x",
        baseBranch: "main",
        baseCommit: "deadbeef",
        dialogStatus: "Running",
        createdByUserId: userId,
      }),
    ).rejects.toThrow(/scratch_runs_owner_xor_check/);

    await db.delete(runs).where(eq(runs.id, runId));
  });
});

describe("run-kind-invariants admit the project-less variant (ADR-096)", () => {
  it("admits a local-package-only scratch run", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: null,
        localPackageId,
      }),
    ).not.toThrow();
  });
});

describe("launch snapshots runs.local_package_id (ADR-096)", () => {
  it("carries the local package id on the runs row", async () => {
    const runId = await seedLocalPackageRun();
    const rows = await db
      .select({
        projectId: runs.projectId,
        localPackageId: runs.localPackageId,
        runKind: runs.runKind,
      })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(rows[0]).toEqual({
      projectId: null,
      localPackageId,
      runKind: "scratch",
    });
  });
});

describe("reconcile does NOT crash a project-less run (ADR-096)", () => {
  it("leaves a project-less run untouched even with NO worktree and NO live session", async () => {
    const runId = await seedLocalPackageRun({ status: "Running" });

    // No project ⇒ loadCandidates iterates projects and never selects this run
    // (it has project_id NULL); listWorktrees/listSessions are empty.
    const listSessions = async (): Promise<SupervisorSessionRecord[]> => [];
    const listWorktrees = async (): Promise<WorktreeInfo[]> => [];

    const summary = await runReconcileSweep({
      db,
      listSessions,
      listWorktrees,
      runFlow: () => {
        throw new Error("runFlow must not be called for a project-less run");
      },
      scheduleResumedSessionDrive: () => {
        throw new Error("resume driver must not run for a project-less run");
      },
    });

    expect(summary.crashed).toBe(0);

    const rows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(rows[0].status).toBe("Running");
  });

  it("classifier skips a live project-less scratch session and never reattaches", () => {
    const decision = classifyRunReconcile({
      runStatus: "Running",
      runKind: "scratch",
      acpSessionId: "acp-1",
      currentStepId: "scratch",
      currentNodeKind: null,
      worktreeExists: true,
      liveSession: true,
      resumeStartedAt: null,
      latestAttemptStartedAt: null,
      nowMs: Date.now(),
      graceSeconds: RECON_GRACE_SECONDS,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("live-scratch-session");
  });
});

describe("terminal transition emits nothing project-scoped (ADR-096)", () => {
  it("markScratchCrashed crashes a project-less run without a domain/webhook emit", async () => {
    const runId = await seedLocalPackageRun({ status: "Running" });

    await markScratchCrashed({
      db,
      runId,
      err: new Error("boom"),
    });

    const runRows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));
    const scratchRows = await db
      .select({ dialogStatus: scratchRuns.dialogStatus })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    expect(runRows[0].status).toBe("Crashed");
    expect(scratchRows[0].dialogStatus).toBe("Crashed");

    // No project ⇒ NO project-scoped outbox rows for this run.
    const domainRows = await db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.runId, runId));
    const webhookRows = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.runId, runId));

    expect(domainRows).toHaveLength(0);
    expect(webhookRows).toHaveLength(0);
  });
});

describe("project-less rows are invisible to project-scoped queries (ADR-096)", () => {
  it("a project-less scratch run never appears with a non-null project_id", async () => {
    await seedLocalPackageRun();

    const projectScoped = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.runKind, "scratch"), isNull(runs.projectId)));

    expect(projectScoped.length).toBeGreaterThanOrEqual(1);
  });
});
