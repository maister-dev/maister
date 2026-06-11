// M30 (ADR-079): 4-mode diff scope switcher contract — `?scope=` enum on
// GET /api/runs/{runId}/diff with per-scope base selection, an availability
// map with graceful degrade (missing-base scopes are disabled with a reason,
// never 500), and the new `uncommitted` working-tree diff that NEVER mutates
// the real index.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getTableName } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { captureCheckpoint } from "@/lib/flows/graph/workspace-checkpoint";
import { diffWorkingTree } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => undefined),
  requireProjectAction: vi.fn(async () => undefined),
}));

// Table-identity fake DB: each table name maps to a seeded row array. All
// drizzle chains the route uses resolve to the seeded rows (the SQL predicate
// semantics are exercised by seeding exactly what the query would yield).
const tables: Record<string, Record<string, unknown>[]> = {};

function chain(rows: Record<string, unknown>[]) {
  const thenable = {
    then: (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled),
    where: () => thenable,
    orderBy: () => thenable,
    limit: () => thenable,
  };

  return thenable;
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => chain(tables[getTableName(table as never)] ?? []),
  }),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

type Fixture = {
  repo: string;
  worktree: string;
  branch: string;
  baseSha: string;
  visit1Sha: string;
  ck2Sha: string;
  headSha: string;
};

async function buildFixture(runId: string): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "maister-scope-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-scope-wt-"));

  createdPaths.push(repo, wtRoot);

  const worktree = join(wtRoot, runId);
  const branch = `maister/${runId}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "MAIster Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  // Agent attempt 1 commits A1; review visit 1 opens at its tip.
  await writeFile(join(worktree, "a1.txt"), "attempt-1\n");
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-q", "-m", "A1");
  const visit1Sha = (await git(worktree, "rev-parse", "HEAD")).trim();

  // Rework: agent attempt 2 — checkpoint at the pre-attempt tip, then A2.
  const ck2 = await captureCheckpoint({
    worktreePath: worktree,
    namespace: "checkpoints",
    runId,
    id: "attempt-2",
  });

  await writeFile(join(worktree, "a2.txt"), "attempt-2\n");
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-q", "-m", "A2");
  const headSha = (await git(worktree, "rev-parse", "HEAD")).trim();

  return {
    repo,
    worktree,
    branch,
    baseSha,
    visit1Sha,
    ck2Sha: ck2.sha,
    headSha,
  };
}

function seedTables(
  fx: Fixture,
  runId: string,
  opts: {
    priorVisit?: boolean;
    lastNodeRef?: boolean;
  } = {},
): void {
  tables.runs = [
    { id: runId, projectId: "proj-1", runKind: "flow", status: "NeedsInput" },
  ];
  tables.workspaces = [
    {
      id: "ws-1",
      runId,
      branch: fx.branch,
      worktreePath: fx.worktree,
      parentRepoPath: fx.repo,
      baseCommit: fx.baseSha,
      baseBranch: "main",
      targetBranch: null,
      removedAt: null,
    },
  ];
  tables.projects = [
    { id: "proj-1", slug: "app", mainBranch: "main", repoPath: fx.repo },
  ];
  tables.hitl_requests =
    opts.priorVisit === false
      ? []
      : [
          {
            id: "hitl-1",
            runId,
            stepId: "review",
            kind: "human",
            reviewTipSha: fx.visit1Sha,
            respondedAt: new Date(),
          },
        ];
  tables.node_attempts =
    opts.lastNodeRef === false
      ? []
      : [
          {
            id: "na-2",
            runId,
            nodeId: "implement",
            nodeType: "ai_coding",
            attempt: 2,
            status: "Succeeded",
            checkpointRef: `refs/maister/checkpoints/${runId}/attempt-2`,
          },
        ];
  tables.scratch_runs = [];
}

async function getDiff(runId: string, scope?: string): Promise<Response> {
  const { GET } = await import("@/app/api/runs/[runId]/diff/route");
  const url = `http://x/api/runs/${runId}/diff${scope ? `?scope=${scope}` : ""}`;

  return GET(new Request(url), {
    params: Promise.resolve({ runId }),
  } as never);
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(async () => {
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

describe("GET /api/runs/{runId}/diff?scope= (ADR-079)", () => {
  it("default scope=run diffs baseCommit..branch and reports the availability map", async () => {
    const runId = "run-scope-default";
    const fx = await buildFixture(runId);

    seedTables(fx, runId);

    const res = await getDiff(runId);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;

    expect(body.scope).toBe("run");
    expect(body.baseCommit).toBe(fx.baseSha);
    expect(body.diff).toContain("a1.txt");
    expect(body.diff).toContain("a2.txt");
    expect(body.scopes.run.available).toBe(true);
    expect(body.scopes["since-last-review"].available).toBe(true);
    expect(body.scopes["last-node"].available).toBe(true);
    expect(body.scopes.uncommitted.available).toBe(true);
  });

  it("rejects an unknown scope with 400 CONFIG (allow-list)", async () => {
    const runId = "run-scope-bad";
    const fx = await buildFixture(runId);

    seedTables(fx, runId);

    const res = await getDiff(runId, "evil");

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("since-last-review diffs from the prior responded visit's review_tip_sha", async () => {
    const runId = "run-scope-slr";
    const fx = await buildFixture(runId);

    seedTables(fx, runId);

    const res = await getDiff(runId, "since-last-review");

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;

    expect(body.scope).toBe("since-last-review");
    expect(body.baseCommit).toBe(fx.visit1Sha);
    expect(body.diff).toContain("a2.txt");
    expect(body.diff).not.toContain("a1.txt");
  });

  it("since-last-review degrades when no prior visit exists: disabled in the map, 409 on request", async () => {
    const runId = "run-scope-slr-none";
    const fx = await buildFixture(runId);

    seedTables(fx, runId, { priorVisit: false });

    const mapRes = await getDiff(runId);
    const map = ((await mapRes.json()) as Record<string, any>).scopes;

    expect(map["since-last-review"].available).toBe(false);
    expect(typeof map["since-last-review"].reason).toBe("string");

    const res = await getDiff(runId, "since-last-review");

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });

  it("last-node diffs from the latest agent attempt's checkpoint (exact even with commits)", async () => {
    const runId = "run-scope-ln";
    const fx = await buildFixture(runId);

    seedTables(fx, runId);

    const res = await getDiff(runId, "last-node");

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;

    expect(body.scope).toBe("last-node");
    expect(body.baseCommit).toBe(fx.ck2Sha);
    expect(body.diff).toContain("a2.txt");
    expect(body.diff).not.toContain("a1.txt");
  });

  it("last-node degrades when no attempt carries a checkpoint ref", async () => {
    const runId = "run-scope-ln-none";
    const fx = await buildFixture(runId);

    seedTables(fx, runId, { lastNodeRef: false });

    const mapRes = await getDiff(runId);
    const map = ((await mapRes.json()) as Record<string, any>).scopes;

    expect(map["last-node"].available).toBe(false);

    const res = await getDiff(runId, "last-node");

    expect(res.status).toBe(409);
  });

  it("uncommitted diffs HEAD vs working tree with untracked rendered as additions", async () => {
    const runId = "run-scope-unc";
    const fx = await buildFixture(runId);

    seedTables(fx, runId);

    await writeFile(join(fx.worktree, "a2.txt"), "attempt-2 modified\n");
    await writeFile(join(fx.worktree, "new-untracked.txt"), "fresh\n");

    const res = await getDiff(runId, "uncommitted");

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;

    expect(body.scope).toBe("uncommitted");
    expect(body.baseCommit).toBe(fx.headSha);
    expect(body.diff).toContain("attempt-2 modified");
    expect(body.diff).toContain("new-untracked.txt");
    expect(body.diff).toContain("+fresh");
    // Committed-only content does not appear.
    expect(body.diff).not.toContain("a1.txt");
  });
});

describe("diffWorkingTree primitive (never mutates the real index)", () => {
  it("leaves the index and untracked status byte-identical", async () => {
    const runId = "run-wtdiff";
    const fx = await buildFixture(runId);

    await writeFile(join(fx.worktree, "a2.txt"), "modified\n");
    await writeFile(join(fx.worktree, "untracked.txt"), "u\n");
    await mkdir(join(fx.worktree, "node_modules"), { recursive: true });
    await writeFile(join(fx.worktree, "node_modules", "x.txt"), "ignored\n");

    const statusBefore = await git(fx.worktree, "status", "--porcelain=v1");
    const indexBefore = await git(fx.worktree, "ls-files", "--stage");

    const { text, truncated } = await diffWorkingTree(fx.worktree);

    expect(truncated).toBe(false);
    expect(text).toContain("a2.txt");
    expect(text).toContain("untracked.txt");
    expect(text).toContain("+u");
    // Ignored files are not part of the working-tree diff.
    expect(text).not.toContain("node_modules/x.txt");

    const statusAfter = await git(fx.worktree, "status", "--porcelain=v1");
    const indexAfter = await git(fx.worktree, "ls-files", "--stage");

    expect(statusAfter).toBe(statusBefore);
    expect(indexAfter).toBe(indexBefore);
    // The untracked file is STILL untracked (no intent-to-add leak).
    expect(statusAfter).toMatch(/^\?\? untracked\.txt$/m);
  });

  it("returns an empty diff for a clean worktree", async () => {
    const fx = await buildFixture("run-wtdiff-clean");

    const { text, truncated } = await diffWorkingTree(fx.worktree);

    expect(text.trim()).toBe("");
    expect(truncated).toBe(false);
  });
});
