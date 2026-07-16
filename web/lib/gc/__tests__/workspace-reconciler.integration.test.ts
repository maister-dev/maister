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
});
