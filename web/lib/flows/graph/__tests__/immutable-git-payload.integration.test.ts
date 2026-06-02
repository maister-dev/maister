// PR2 / F3 (RED): git artifact payloads must be immutable. The runner stores
// locator.headRef = workspace.branch (a MUTABLE branch name) and the payload
// route renders diffRange({ branch: detail.branch }) (the LIVE branch), so
// advancing the branch makes an OLD artifact render the WRONG diff.
//
// Fix (Q3=A): record headRef as an immutable commit SHA (git rev-parse), and
// the payload route renders against the STORED locator.headRef.
//
// This test uses a REAL temp git repo + the REAL payload route end-to-end. It
// is RED today: the route ignores locator.headRef and renders C0..C2 (live
// branch), so the diff WOULD contain fileB committed AFTER the artifact was
// recorded.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";
import { recordDefaultArtifacts } from "@/lib/flows/graph/default-artifacts";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  })),
}));

let GET: typeof import("@/app/api/runs/[runId]/artifacts/[artifactId]/payload/route").GET;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_immutable_payload")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ GET } = await import(
    "@/app/api/runs/[runId]/artifacts/[artifactId]/payload/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type GitRepo = {
  repo: string;
  branch: string;
  c0: string;
  c1: string;
};

// A real repo: base C0; branch `feature` at C1 (adds fileA). Returns SHAs.
async function makeRepo(): Promise<GitRepo> {
  const repo = await mkdtemp(join(tmpdir(), "immutable-payload-"));

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");

  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "C0 base");
  const c0 = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "checkout", "-q", "-b", "feature");
  await writeFile(join(repo, "fileA"), "alpha\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "C1 add fileA");
  const c1 = (await git(repo, "rev-parse", "HEAD")).trim();

  return { repo, branch: "feature", c0, c1 };
}

// Advance `feature` to C2 (adds fileB) — the branch tip moves PAST the SHA
// recorded in the artifact locator.
async function advanceToC2(repo: GitRepo): Promise<void> {
  await writeFile(join(repo.repo, "fileB"), "bravo\n");
  await git(repo.repo, "add", "-A");
  await git(repo.repo, "commit", "-q", "-m", "C2 add fileB");
}

// Seed project/executor/flow/task/run/workspace; workspace branch + worktree
// point at the real repo. getRunDetail resolves branch=<branch>,
// worktreePath=<repo>.
async function seedRun(repo: GitRepo): Promise<{
  runId: string;
  nodeAttemptId: string;
  slug: string;
  workspaceId: string;
}> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: repo.repo,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: { schemaVersion: 1, name: "g", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
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
    executorId,
    flowVersion: "v1.0.0",
    status: "Review",
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: repo.branch,
    worktreePath: repo.repo,
    parentRepoPath: repo.repo,
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
  });

  return { runId, nodeAttemptId, slug, workspaceId };
}

async function payloadText(
  runId: string,
  artifactId: string,
): Promise<{ status: number; body: string }> {
  const res = await GET(
    new Request(
      `http://localhost/api/runs/${runId}/artifacts/${artifactId}/payload`,
    ),
    { params: Promise.resolve({ runId, artifactId }) },
  );

  return { status: res.status, body: await res.text() };
}

describe("F3: git artifact payloads render against the stored immutable ref", () => {
  // 4. git-range: recorded C0..C1, branch advanced to C2 → diff must contain
  // fileA (the recorded range) and NOT fileB (committed after recording).
  it("git-range diff renders the recorded headRef, not the live branch tip", async () => {
    const repo = await makeRepo();
    const { runId, nodeAttemptId } = await seedRun(repo);
    const artifactId = `run:${nodeAttemptId}:impl-diff`;

    // The FIXED runner records headRef as the resolved C1 SHA (not a branch).
    await recordArtifact(
      {
        id: artifactId,
        runId,
        nodeAttemptId,
        nodeId: "implement",
        attempt: 1,
        artifactDefId: "impl-diff",
        kind: "diff",
        producer: "runner",
        locator: { kind: "git-range", baseCommit: repo.c0, headRef: repo.c1 },
        validity: "current",
      },
      db,
    );

    // Advance the branch PAST the recorded SHA.
    await advanceToC2(repo);

    const { status, body } = await payloadText(runId, artifactId);

    expect(status).toBe(200);
    expect(body).toContain("fileA");
    // RED today: the route renders against the live branch (C0..C2), so fileB
    // leaks into a payload recorded before C2 existed.
    expect(body).not.toContain("fileB");
  });

  // 5. git-log (commit_set) sibling-sweep: recorded C0..C1, branch advanced to
  // C2 → log must show C1's commit and NOT C2's.
  it("git-log payload renders the recorded headRef, not the live branch tip", async () => {
    const repo = await makeRepo();
    const { runId, nodeAttemptId } = await seedRun(repo);
    const artifactId = `run:${nodeAttemptId}:commits`;

    await recordArtifact(
      {
        id: artifactId,
        runId,
        nodeAttemptId,
        nodeId: "implement",
        attempt: 1,
        artifactDefId: "commits",
        kind: "commit_set",
        producer: "runner",
        locator: { kind: "git-log", baseRef: repo.c0, headRef: repo.c1 },
        validity: "current",
      },
      db,
    );

    await advanceToC2(repo);

    const { status, body } = await payloadText(runId, artifactId);

    expect(status).toBe(200);
    expect(body).toContain("C1 add fileA");
    // RED today: the route renders C0..<live branch>=C2, leaking C2's commit.
    expect(body).not.toContain("C2 add fileB");
  });

  // Sibling-sweep gap: recordDefaultArtifacts records its always-on default
  // `diff` (git-range) with headRef = workspace.branch (MUTABLE). Same drift.
  it("default-artifact diff renders the recorded headRef, not the live branch tip", async () => {
    const repo = await makeRepo();
    const { runId, nodeAttemptId, slug, workspaceId } = await seedRun(repo);

    // Pass the real workspace row (carries worktreePath + branch) to
    // recordDefaultArtifacts; runtimeRoot only governs the optional log path.
    const wsRows = (await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))) as unknown as any[];
    const runtimeRoot = await mkdtemp(join(tmpdir(), "default-diff-rt-"));

    await recordDefaultArtifacts(
      {
        runId,
        nodeAttemptId,
        nodeId: "implement",
        attempt: 1,
        projectSlug: slug,
        workspace: wsRows[0],
        runtimeRoot,
      },
      db,
    );

    // The always-on default diff: id run:<nodeAttemptId>:default:diff,
    // artifactDefId default:<nodeId>:diff.
    const defaultDiffId = `run:${nodeAttemptId}:default:diff`;
    const recorded = (await db
      .select()
      .from(schema.artifactInstances)
      .where(
        eq(schema.artifactInstances.id, defaultDiffId),
      )) as unknown as any[];

    expect(recorded[0]?.artifactDefId).toBe("default:implement:diff");
    // Sanity: it is the git-range default diff we are about to render.
    expect(recorded[0]?.kind).toBe("diff");

    await advanceToC2(repo);

    const { status, body } = await payloadText(runId, defaultDiffId);

    expect(status).toBe(200);
    expect(body).toContain("fileA");
    // RED today: default-diff headRef = branch name → route renders C0..C2.
    expect(body).not.toContain("fileB");
  });
});

// F3 (runner-generated locator): the existing tests above feed a manually
// correct baseRef. This drives the REAL runner so a commit_set's baseRef is the
// merge-base, not the branch name (which resolved baseRef == headRef → empty
// `git log`). Seeds a Running run on a real repo and runs a commit_set producer.
describe("F3: runner records commit_set baseRef as the merge-base", () => {
  async function seedRunningRun(
    repo: GitRepo,
    manifest: unknown,
  ): Promise<{ runId: string; runtimeRoot: string }> {
    const projectId = randomUUID();
    const slug = `proj-${projectId.slice(0, 8)}`;
    const executorId = randomUUID();
    const flowId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "commitset-rt-"));

    await db.insert(schema.projects).values({
      id: projectId,
      slug,
      name: "Test",
      repoPath: repo.repo,
      maisterYamlPath: "/tmp/m.yaml",
    });
    await db.insert(schema.executors).values({
      id: executorId,
      projectId,
      executorRefId: "claude-sonnet",
      agent: "claude",
      model: "claude-sonnet-4-6",
    });
    await db.insert(schema.flows).values({
      id: flowId,
      projectId,
      flowRefId: "g",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/g",
      manifest,
      schemaVersion: 1,
    });
    await db.insert(schema.tasks).values({
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
      executorId,
      flowVersion: "v1.0.0",
      status: "Running",
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: repo.branch,
      worktreePath: repo.repo,
      parentRepoPath: repo.repo,
    });

    return { runId, runtimeRoot };
  }

  it("commit_set locator.baseRef is the merge-base, and the payload lists the branch commit", async () => {
    const repo = await makeRepo();
    const { runId, runtimeRoot } = await seedRunningRun(repo, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "implement",
          type: "cli",
          action: { command: "echo work" },
          output: { produces: [{ id: "commits", kind: "commit_set" }] },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(runId, { db, runtimeRoot });

    const recorded = (await db
      .select()
      .from(schema.artifactInstances)
      .where(
        eq(schema.artifactInstances.artifactDefId, "commits"),
      )) as unknown as any[];
    const commitSet = recorded.find((a) => a.runId === runId);

    expect(commitSet).toBeDefined();
    expect(commitSet.kind).toBe("commit_set");
    // The crux of F3: baseRef is the merge-base SHA (C0), NOT the branch name.
    expect(commitSet.locator.baseRef).toBe(repo.c0);
    expect(commitSet.locator.baseRef).not.toBe(repo.branch);
    expect(commitSet.locator.headRef).toBe(repo.c1);

    const { status, body } = await payloadText(runId, commitSet.id);

    expect(status).toBe(200);
    // BUG would render `git log feature..C1` = empty; the fix renders C0..C1.
    expect(body).toContain("C1 add fileA");
  });
});
