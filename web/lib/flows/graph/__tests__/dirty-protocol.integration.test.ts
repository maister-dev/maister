import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// FIXME(any): dual drizzle-orm peer-dep variants (store idiom).
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { captureCheckpoint } from "@/lib/flows/graph/workspace-checkpoint";
import {
  computeDirtySummary,
  resolveDirtyWorktree,
} from "@/lib/runs/dirty-resolution";
import { discardWorktree } from "@/lib/worktree";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

async function createRepoWithWorktree(runId: string): Promise<{
  repo: string;
  worktree: string;
  branch: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), "maister-dirty-parent-"));
  const worktreesRoot = await mkdtemp(join(tmpdir(), "maister-dirty-wt-"));

  createdPaths.push(repo, worktreesRoot);

  const worktree = join(worktreesRoot, runId);
  const branch = `maister/${runId}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "MAIster Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  return { repo, worktree, branch };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

describe("computeDirtySummary (pure, porcelain v1)", () => {
  it("classifies staged / unstaged / untracked and counts them", () => {
    const porcelain = [
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "?? untracked.txt",
      "A  added.ts",
    ].join("\n");

    const s = computeDirtySummary(porcelain);

    expect(s.total).toBe(5);
    expect(s.staged).toBe(3); // staged.ts, both.ts, added.ts
    expect(s.unstaged).toBe(2); // unstaged.ts, both.ts
    expect(s.untracked).toBe(1);
    expect(s.files.map((f) => f.path)).toEqual([
      "staged.ts",
      "unstaged.ts",
      "both.ts",
      "untracked.txt",
      "added.ts",
    ]);
  });

  it("returns an empty summary for a clean worktree", () => {
    const s = computeDirtySummary("");

    expect(s.total).toBe(0);
    expect(s.files).toEqual([]);
  });
});

describe("discardWorktree (DD12 discard primitive)", () => {
  it("restores tracked (staged+unstaged), removes untracked, KEEPS ignored", async () => {
    const { worktree } = await createRepoWithWorktree("run-discard");

    await writeFile(join(worktree, "base.txt"), "unstaged change\n");
    await writeFile(join(worktree, "staged.txt"), "staged\n");
    await git(worktree, "add", "staged.txt");
    await writeFile(join(worktree, "untracked.txt"), "scratch\n");
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "cache.txt"), "keep\n");

    await discardWorktree(worktree);

    expect(await readFile(join(worktree, "base.txt"), "utf8")).toBe("base\n");
    expect(await pathExists(join(worktree, "staged.txt"))).toBe(false);
    expect(await pathExists(join(worktree, "untracked.txt"))).toBe(false);
    // `-fd`, never `-fdx`: ignored files survive.
    expect(
      await readFile(join(worktree, "node_modules", "cache.txt"), "utf8"),
    ).toBe("keep\n");

    const status = await git(worktree, "status", "--porcelain");

    expect(status.trim()).toBe("");
  });

  it("refuses to run when the runtime root resolves inside the worktree (containment)", async () => {
    const { worktree } = await createRepoWithWorktree("run-discard-contain");

    vi.stubEnv("MAISTER_RUNTIME_ROOT", join(worktree, ".maister-runtime"));

    await writeFile(join(worktree, "junk.txt"), "x\n");

    await expect(discardWorktree(worktree)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    // Hard-block: nothing was mutated.
    expect(await pathExists(join(worktree, "junk.txt"))).toBe(true);
  });

  it("never touches the runtime artifacts root outside the worktree", async () => {
    const { worktree } = await createRepoWithWorktree("run-discard-artifacts");
    const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-dirty-runtime-"));

    createdPaths.push(runtimeRoot);

    const artifacts = join(runtimeRoot, ".maister", "app", "runs", "r1");

    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "cost.jsonl"), '{"usd":0.28}\n');
    await writeFile(join(worktree, "untracked.txt"), "x\n");

    await discardWorktree(worktree);

    expect(await readFile(join(artifacts, "cost.jsonl"), "utf8")).toBe(
      '{"usd":0.28}\n',
    );
  });
});

describe("runReviewHuman stamps review_tip_sha (ADR-079)", () => {
  it("records the worktree HEAD sha on the review HITL insert", async () => {
    const { runReviewHuman } = await import("@/lib/flows/graph/runner-graph");
    const { compileManifest } = await import("@/lib/flows/graph/compile");
    const { worktree } = await createRepoWithWorktree("run-tip");
    const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-tip-runtime-"));

    createdPaths.push(runtimeRoot);

    const head = (await git(worktree, "rev-parse", "HEAD")).trim();

    const manifest = {
      schemaVersion: 1,
      name: "Fixture",
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/impl" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: null, rework: "implement" },
          rework: { allowedTargets: ["implement"], maxLoops: 2 },
        },
      ],
    };
    const graph = compileManifest(manifest as never);
    const node = graph.nodes.get("review");

    expect(node).toBeDefined();

    const { getTableName } = await import("drizzle-orm");
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    // Table-identity fake: the assignment creator validates the run row, the
    // rest of the lookups can stay empty.
    const rowsFor = (table: unknown): Record<string, unknown>[] => {
      const name = getTableName(table as never);

      if (name === "runs") {
        return [{ id: "run-tip", projectId: "proj-1", status: "Running" }];
      }
      if (name === "projects") {
        return [{ id: "proj-1", slug: "app", name: "App" }];
      }

      return [];
    };
    const fakeDb = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });

          const insertChain: Record<string, unknown> = {
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve(undefined).then(onFulfilled),
            onConflictDoUpdate: () => insertChain,
            onConflictDoNothing: () => insertChain,
            returning: async () => [{ id: "row-1" }],
          };

          return insertChain;
        },
      }),
      select: () => ({
        from: (table: unknown) => {
          const rows = rowsFor(table);
          const thenable = {
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve(rows).then(onFulfilled),
            where: () => thenable,
            innerJoin: () => thenable,
            leftJoin: () => thenable,
            orderBy: () => thenable,
            limit: () => thenable,
          };

          return thenable;
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
    };

    const loaded = {
      run: { id: "run-tip", projectId: "proj-1", acpSessionId: null },
      task: { id: "task-1", title: "t", prompt: "p" },
      flow: { id: "flow-1" },
      manifest,
      executor: { id: "exec-1", agent: "claude", model: "m" },
      workspace: {
        id: "ws-1",
        runId: "run-tip",
        branch: "maister/run-tip",
        worktreePath: worktree,
      },
      projectSlug: "app",
      flowInstallPath: "/cache/flow-1",
    };

    const result = await runReviewHuman(
      node as never,
      loaded as never,
      "Review?",
      {
        runtimeRoot,
        db: fakeDb as never,
        gateAttempt: 1,
      },
    );

    expect(result.needsInput).toBe(true);

    const hitlInsert = inserts.find(
      (i) => (i.values as { kind?: string }).kind === "human",
    );

    expect(hitlInsert).toBeDefined();
    expect(hitlInsert?.values.reviewTipSha).toBe(head);
  });
});

describe("resolveDirtyWorktree (service, X-2PC/X-ATOMIC)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("maister_test")
      .withUsername("test")
      .withPassword("test")
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function seedReviewPause(args: {
    worktreePath: string;
    parentRepoPath: string;
    branch: string;
  }): Promise<{ runId: string; hitlId: string; projectId: string }> {
    const projectId = randomUUID();
    const executorId = randomUUID();
    const flowId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const hitlId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `proj-${projectId.slice(0, 8)}`,
      name: "Test",
      repoPath: args.parentRepoPath,
      maisterYamlPath: "/tmp/m.yaml",
    });
    await db
      .insert(schema.platformAcpRunners)
      .values(testPlatformRunnerRow(executorId, "claude"));
    await db.insert(schema.flows).values({
      id: flowId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      title: "Test task",
      prompt: "do",
      flowId,
    });
    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      flowVersion: "v1.0.0",
      status: "NeedsInput",
      currentStepId: "review",
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: args.branch,
      worktreePath: args.worktreePath,
      parentRepoPath: args.parentRepoPath,
      baseBranch: "main",
    });
    await db.insert(schema.hitlRequests).values({
      id: hitlId,
      runId,
      stepId: "review",
      kind: "human",
      schema: { review: true },
      prompt: "Review?",
    });

    return { runId, hitlId, projectId };
  }

  it("commit: snapshots the dirty worktree (tip moves), records the choice, gate stays open", async () => {
    const { repo, worktree, branch } =
      await createRepoWithWorktree("rdw-commit");
    const { runId, hitlId } = await seedReviewPause({
      worktreePath: worktree,
      parentRepoPath: repo,
      branch,
    });

    await writeFile(join(worktree, "wip.txt"), "wip\n");
    const tipBefore = (await git(worktree, "rev-parse", "HEAD")).trim();

    const out = await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "commit",
      db,
    });

    expect(out.choice).toBe("commit");

    const tipAfter = (await git(worktree, "rev-parse", "HEAD")).trim();

    expect(tipAfter).not.toBe(tipBefore);

    const subject = await git(worktree, "log", "-1", "--format=%s");

    expect(subject).toContain("wip after node review");

    const row = (
      await pool.query(
        `SELECT dirty_resolution, responded_at FROM hitl_requests WHERE id = $1`,
        [hitlId],
      )
    ).rows[0];

    expect(row.dirty_resolution).toBe("commit");
    // The gate is NEVER blocked/resolved by a dirty-resolution.
    expect(row.responded_at).toBeNull();
  });

  it("discard: cleans the worktree, deletes the chat baseline, re-materializes, records", async () => {
    const { repo, worktree, branch } =
      await createRepoWithWorktree("rdw-discard");
    const { runId, hitlId } = await seedReviewPause({
      worktreePath: worktree,
      parentRepoPath: repo,
      branch,
    });

    // A chat baseline exists for this pause (DD11 L3) — the discard must
    // delete it so the sensor re-anchors (no false un-discard).
    await captureCheckpoint({
      worktreePath: worktree,
      namespace: "chat-checkpoints",
      runId,
      id: hitlId,
    });

    await writeFile(join(worktree, "wip.txt"), "wip\n");

    const rematerialize = vi.fn(async () => undefined);
    const out = await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "discard",
      db,
      rematerialize,
    });

    expect(out.choice).toBe("discard");
    expect(await pathExists(join(worktree, "wip.txt"))).toBe(false);
    expect(rematerialize).toHaveBeenCalledTimes(1);

    const refs = await git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/maister",
    );

    expect(refs).not.toContain(`chat-checkpoints/${runId}/${hitlId}`);

    const row = (
      await pool.query(
        `SELECT dirty_resolution, responded_at FROM hitl_requests WHERE id = $1`,
        [hitlId],
      )
    ).rows[0];

    expect(row.dirty_resolution).toBe("discard");
    expect(row.responded_at).toBeNull();
  });

  it("proceed: no git mutation, records the choice", async () => {
    const { repo, worktree, branch } =
      await createRepoWithWorktree("rdw-proceed");
    const { runId, hitlId } = await seedReviewPause({
      worktreePath: worktree,
      parentRepoPath: repo,
      branch,
    });

    await writeFile(join(worktree, "wip.txt"), "wip\n");
    const tipBefore = (await git(worktree, "rev-parse", "HEAD")).trim();

    await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "proceed",
      db,
    });

    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(tipBefore);
    expect(await readFile(join(worktree, "wip.txt"), "utf8")).toBe("wip\n");

    const row = (
      await pool.query(
        `SELECT dirty_resolution FROM hitl_requests WHERE id = $1`,
        [hitlId],
      )
    ).rows[0];

    expect(row.dirty_resolution).toBe("proceed");
  });

  it("is idempotency-guarded: a second resolution on the same visit is CONFLICT", async () => {
    const { repo, worktree, branch } =
      await createRepoWithWorktree("rdw-idempotent");
    const { runId, hitlId } = await seedReviewPause({
      worktreePath: worktree,
      parentRepoPath: repo,
      branch,
    });

    await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "proceed",
      db,
    });

    await expect(
      resolveDirtyWorktree({
        runId,
        hitlRequestId: hitlId,
        choice: "discard",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a hitl row that does not belong to the run (X-IDENT)", async () => {
    const a = await createRepoWithWorktree("rdw-ident-a");
    const b = await createRepoWithWorktree("rdw-ident-b");
    const seedA = await seedReviewPause({
      worktreePath: a.worktree,
      parentRepoPath: a.repo,
      branch: a.branch,
    });
    const seedB = await seedReviewPause({
      worktreePath: b.worktree,
      parentRepoPath: b.repo,
      branch: b.branch,
    });

    await expect(
      resolveDirtyWorktree({
        runId: seedA.runId,
        hitlRequestId: seedB.hitlId,
        choice: "proceed",
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});
