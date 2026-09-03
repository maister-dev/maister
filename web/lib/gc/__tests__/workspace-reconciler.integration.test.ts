import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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

import * as schema from "@/lib/db/schema";
import {
  claimReconciliationFinding,
  observeReconciliationFinding,
  quarantineReconciliationFinding,
} from "@/lib/gc/workspace-reconciliation-findings";
import { runWorkspaceReconciliationSweep } from "@/lib/gc/workspace-reconciler";
import { addWorktree } from "@/lib/worktree";
import {
  fakeExecutionHosts,
  unknownOutcomeError,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const listSessionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supervisor-client", () => ({
  listSessions: listSessionsMock,
}));

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let fixtureRoot: string;
let repoPath: string;
let worktreesRoot: string;
let projectId: string;
let projectSlug: string;

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function seedProject(): Promise<void> {
  projectId = randomUUID();
  projectSlug = `reconciler-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug: projectSlug,
    name: "Reconciler",
    repoPath,
    taskKey: `REC${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
  });
}

async function seedRun(runId: string): Promise<void> {
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    status: "Review",
    flowVersion: "reconciler",
    flowRevision: "test",
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workspace_reconciler_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  fixtureRoot = path.join(tmpdir(), `workspace-reconciler-${randomUUID()}`);
  repoPath = path.join(fixtureRoot, "repo");
  worktreesRoot = path.join(fixtureRoot, "worktrees");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.test"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(path.join(repoPath, "README.md"), "fixture\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await mkdir(worktreesRoot, { recursive: true });
  listSessionsMock.mockReset().mockResolvedValue([]);
  await db.delete(schema.workspaceReconciliationFindings);
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.projects);
  await seedProject();
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("runWorkspaceReconciliationSweep", () => {
  it("enforces non-negative attempts and the resolved timestamp shape in the database", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const findingId = await observeReconciliationFinding({
      database: db,
      observation: {
        candidateKind: "untrusted",
        relativePath: "invalid-shape",
        provenanceVersion: null,
        provenanceFingerprint: null,
        provenanceRunId: null,
        projectId: null,
        runId: null,
        workspaceId: null,
      },
      now,
    });

    await expect(
      db
        .update(schema.workspaceReconciliationFindings)
        .set({ attemptCount: -1 })
        .where(eq(schema.workspaceReconciliationFindings.id, findingId)),
    ).rejects.toThrow("workspace_reconciliation_findings_attempt_count_check");
    await expect(
      db
        .update(schema.workspaceReconciliationFindings)
        .set({ state: "resolved" })
        .where(eq(schema.workspaceReconciliationFindings.id, findingId)),
    ).rejects.toThrow("workspace_reconciliation_findings_resolved_shape_check");
    await expect(
      db
        .update(schema.workspaceReconciliationFindings)
        .set({ state: "resolved", resolvedAt: now })
        .where(eq(schema.workspaceReconciliationFindings.id, findingId)),
    ).resolves.toBeDefined();
  });

  it("reconstructs the exact workspace row for a v2-managed rowless worktree whose run still exists", async () => {
    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, projectSlug, runId);

    await seedRun(runId);
    await addWorktree({
      projectRepoPath: repoPath,
      branch: `maister/${runId}`,
      worktreePath,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch: `maister/${runId}`,
        workspaceKind: "flow",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    const workspaceRows = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runId));

    expect(summary).toMatchObject({ recovered: 1, removed: 0, quarantined: 0 });
    expect(workspaceRows).toHaveLength(1);
    expect(workspaceRows[0]).toMatchObject({
      projectId,
      branch: `maister/${runId}`,
      worktreePath: await realpath(worktreePath),
      parentRepoPath: repoPath,
    });
    await expect(lstat(worktreePath)).resolves.toBeDefined();
  });

  it("quarantines legacy provenance instead of authorizing autonomous action", async () => {
    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, projectSlug, runId);

    await addWorktree({
      projectRepoPath: repoPath,
      branch: `maister/${runId}`,
      worktreePath,
      startPoint: "main",
      provenance: { runId },
    });

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    const findings = await db
      .select()
      .from(schema.workspaceReconciliationFindings);

    expect(summary).toMatchObject({ quarantined: 1, removed: 0 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      candidateKind: "untrusted",
      state: "quarantined",
      lastErrorCode: "legacy_provenance",
    });
    await expect(lstat(worktreePath)).resolves.toBeDefined();
  });

  it("processes a due candidate after more than one batch of quarantined paths", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const blockedRoot = path.join(worktreesRoot, "blocked");

    await mkdir(blockedRoot, { recursive: true });

    for (let index = 0; index < 100; index += 1) {
      const name = String(index).padStart(3, "0");
      const relativePath = path.join("blocked", name);

      await mkdir(path.join(blockedRoot, name));
      const findingId = await observeReconciliationFinding({
        database: db,
        observation: {
          candidateKind: "untrusted",
          relativePath,
          provenanceVersion: null,
          provenanceFingerprint: null,
          provenanceRunId: null,
          projectId: null,
          runId: null,
          workspaceId: null,
        },
        now,
      });
      const claim = await claimReconciliationFinding({
        database: db,
        findingId,
        now,
      });

      if (claim === null) throw new Error("expected finding claim");

      await quarantineReconciliationFinding({
        database: db,
        claim,
        errorCode: "seeded_quarantine",
        errorMessage: "seeded test finding",
        now,
      });
    }

    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, "z", runId);

    await seedRun(runId);
    await addWorktree({
      projectRepoPath: repoPath,
      branch: `maister/${runId}`,
      worktreePath,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch: `maister/${runId}`,
        workspaceKind: "flow",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => now,
    });

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, resolved: 1 });
    await expect(
      db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.runId, runId)),
    ).resolves.toHaveLength(1);
  });

  it("recovers a row whose worktree disappeared after preservation was recorded", async () => {
    const runId = randomUUID();
    const missingPath = path.join(worktreesRoot, projectSlug, runId);

    await seedRun(runId);
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: `maister/${runId}`,
      worktreePath: missingPath,
      parentRepoPath: repoPath,
      preservationOutcome: "not_needed",
    });

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    const workspace = (
      await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.runId, runId))
    )[0];

    expect(summary).toMatchObject({ removed: 1, resolved: 1, quarantined: 0 });
    expect(workspace).toMatchObject({ removalKind: "reconciliation" });
    expect(workspace.removedAt).not.toBeNull();
  });

  it("retains rescue evidence across a crash after deletion and resolves it on retry", async () => {
    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, projectSlug, runId);
    const firstNow = new Date("2026-07-16T12:00:00.000Z");

    await addWorktree({
      projectRepoPath: repoPath,
      branch: `maister/${runId}`,
      worktreePath,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch: `maister/${runId}`,
        workspaceKind: "flow",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const failed = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => firstNow,
      afterOwnedWorktreeRemoval: async () => {
        throw new Error("simulated process crash");
      },
    });
    const afterCrash = (
      await db.select().from(schema.workspaceReconciliationFindings)
    )[0];

    expect(failed).toMatchObject({ removed: 0, retryableFailed: 1 });
    expect(afterCrash).toMatchObject({
      state: "retry_waiting",
      rescueRef: expect.any(String),
      rescueCommit: expect.any(String),
    });
    await expect(lstat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date(firstNow.getTime() + 6 * 60_000),
    });
    const finding = (
      await db.select().from(schema.workspaceReconciliationFindings)
    )[0];

    expect(recovered).toMatchObject({ resolved: 1, quarantined: 0 });
    expect(finding).toMatchObject({
      state: "resolved",
      resultCode: "orphan_rescued_and_removed",
      rescueRef: afterCrash.rescueRef,
      rescueCommit: afterCrash.rescueCommit,
    });
  });

  it("does not remove a trusted orphan after its reconciliation lease expires", async () => {
    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, projectSlug, runId);
    const claimedAt = new Date("2026-07-16T12:00:00.000Z");
    const expiredAt = new Date(claimedAt.getTime() + 6 * 60_000);
    let clockCalls = 0;
    const now = () => {
      clockCalls += 1;

      return clockCalls <= 3 ? claimedAt : expiredAt;
    };
    const remove = vi.fn(async () => undefined);

    await addWorktree({
      projectRepoPath: repoPath,
      branch: `maister/${runId}`,
      worktreePath,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch: `maister/${runId}`,
        workspaceKind: "flow",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now,
      removeOwnedWorktree: remove,
    });
    const finding = (
      await db.select().from(schema.workspaceReconciliationFindings)
    )[0];

    expect(summary).toMatchObject({ retained: 1, removed: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(finding.leaseExpiresAt).toEqual(
      new Date(claimedAt.getTime() + 5 * 60_000),
    );
  });
});

describe("workspace release after removal (ADR-164 N5)", () => {
  // A trusted on-disk worktree whose workspace row is already removed and whose
  // run holds an adopted handle: the sweep removes the tree, then releases the
  // handle on the host as a driverless `workspace.release`.
  async function seedRemovedWorkspaceWithHandle(): Promise<{
    runId: string;
    handle: string;
  }> {
    const runId = randomUUID();
    const worktreePath = path.join(worktreesRoot, projectSlug, runId);
    const branch = `maister/${runId}`;

    await seedRun(runId);
    await addWorktree({
      projectRepoPath: repoPath,
      branch,
      worktreePath,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch,
        workspaceKind: "flow",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch,
      worktreePath: await realpath(worktreePath),
      parentRepoPath: repoPath,
      removedAt: new Date("2026-07-16T11:00:00.000Z"),
      removalKind: "reconciliation",
      preservationOutcome: "not_needed",
    });

    return { runId, handle: `ws_${randomUUID().replace(/-/g, "")}` };
  }

  it("issues workspace.release for the run's adopted handle after removing the tree", async () => {
    const { runId, handle } = await seedRemovedWorkspaceWithHandle();
    const { hosts, fake, assignment } = await fakeExecutionHosts(db, {
      runId,
    });

    await db
      .update(schema.executionAssignments)
      .set({ executionWorkspaceId: handle, workspaceAdoptedAt: new Date() })
      .where(eq(schema.executionAssignments.id, assignment!.id));

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      executionHosts: hosts,
    });

    expect(summary).toMatchObject({ removed: 1, resolved: 1, quarantined: 0 });
    expect(
      fake.callsOf("releaseWorkspace").map((call) => call.args[0]),
    ).toEqual([handle]);
    expect(await releaseCommandRows(runId)).toEqual([
      { kind: "workspace.release", state: "succeeded", driverless: true },
    ]);
  });

  it("leaves the release queued for recovery when the host is unreachable (driverless)", async () => {
    const { runId, handle } = await seedRemovedWorkspaceWithHandle();
    const { hosts, fake, assignment } = await fakeExecutionHosts(db, {
      runId,
    });

    await db
      .update(schema.executionAssignments)
      .set({ executionWorkspaceId: handle, workspaceAdoptedAt: new Date() })
      .where(eq(schema.executionAssignments.id, assignment!.id));
    fake.failOnce("releaseWorkspace", unknownOutcomeError("host stopped"));

    const summary = await runWorkspaceReconciliationSweep({
      database: db,
      root: worktreesRoot,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      executionHosts: hosts,
    });

    // The removal itself is durable; the release rides recovery.
    expect(summary).toMatchObject({ removed: 1, resolved: 1 });
    expect(await releaseCommandRows(runId)).toEqual([
      { kind: "workspace.release", state: "queued", driverless: true },
    ]);
  });
});

async function releaseCommandRows(runId: string) {
  return await db
    .select({
      kind: schema.executionCommands.kind,
      state: schema.executionCommands.state,
      driverless: schema.executionCommands.driverless,
    })
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.runId, runId));
}
