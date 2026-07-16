import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
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
      worktreePath,
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
});
