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

import { afterEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  applyWorkspacePolicy,
  captureCheckpoint,
  checkpointRefName,
  containmentAssert,
  deleteChatCheckpoint,
  deleteRunCheckpointRefs,
} from "@/lib/flows/graph/workspace-checkpoint";

const execFileAsync = promisify(execFile);

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

async function gitFails(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, ...args]);

    return false;
  } catch {
    return true;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

type PolicyWorkbench = {
  repo: string;
  worktree: string;
  baseSha: string;
  runId: string;
  branch: string;
};

// Modeled on workbench-lifecycle real-git.integration.test.ts (file-local
// helper there by design). Seeds a parent repo with a committed .gitignore
// (node_modules/ ignored) and a run worktree.
async function createPolicyWorkbench(
  runId = "run-wp",
): Promise<PolicyWorkbench> {
  const repo = await mkdtemp(join(tmpdir(), "maister-wp-parent-"));
  const worktreesRoot = await mkdtemp(join(tmpdir(), "maister-wp-wt-"));

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
  const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  return { repo, worktree, baseSha, runId, branch };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

describe("captureCheckpoint (DD5)", () => {
  it("captures tracked + untracked, excludes ignored, never advances the branch", async () => {
    const wb = await createPolicyWorkbench();

    await writeFile(join(wb.worktree, "base.txt"), "modified\n");
    await writeFile(join(wb.worktree, "notes.txt"), "untracked note\n");
    await mkdir(join(wb.worktree, "node_modules"), { recursive: true });
    await writeFile(join(wb.worktree, "node_modules", "dep.js"), "x\n");

    const tipBefore = (await git(wb.worktree, "rev-parse", "HEAD")).trim();

    const { ref, sha } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    expect(ref).toBe(`refs/maister/checkpoints/${wb.runId}/attempt-1`);
    expect(checkpointRefName("checkpoints", wb.runId, "attempt-1")).toBe(ref);

    // Branch tip untouched; ref resolves to the checkpoint commit.
    expect((await git(wb.worktree, "rev-parse", "HEAD")).trim()).toBe(
      tipBefore,
    );
    expect((await git(wb.worktree, "rev-parse", ref)).trim()).toBe(sha);

    // Parented on the then-current tip → `<ck>^` is the pre-attempt tip.
    expect((await git(wb.worktree, "rev-parse", `${sha}^`)).trim()).toBe(
      tipBefore,
    );

    // Checkpoint commit must NOT be reachable from the run branch.
    expect(
      await gitFails(wb.worktree, "merge-base", "--is-ancestor", sha, "HEAD"),
    ).toBe(true);

    const tree = await git(wb.worktree, "ls-tree", "-r", "--name-only", sha);

    expect(tree).toContain("base.txt");
    expect(tree).toContain("notes.txt");
    expect(tree).not.toContain("node_modules/dep.js");

    // Captured blob carries the capture-time (modified) content.
    expect(await git(wb.worktree, "show", `${sha}:base.txt`)).toBe(
      "modified\n",
    );
  });

  it("captures a clean worktree without error (tree == HEAD tree)", async () => {
    const wb = await createPolicyWorkbench("run-clean");

    const { sha } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    const headTree = (
      await git(wb.worktree, "rev-parse", "HEAD^{tree}")
    ).trim();
    const ckTree = (
      await git(wb.worktree, "rev-parse", `${sha}^{tree}`)
    ).trim();

    expect(ckTree).toBe(headTree);
  });

  it("throws MaisterError CHECKPOINT on git failure (not a worktree)", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "maister-wp-norepo-"));

    createdPaths.push(notARepo);

    await expect(
      captureCheckpoint({
        worktreePath: notARepo,
        namespace: "checkpoints",
        runId: "run-x",
        id: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });
  });
});

describe("applyWorkspacePolicy — keep (DD6)", () => {
  it("is a strict no-op: tip, dirty tracked state and untracked files all stay", async () => {
    const wb = await createPolicyWorkbench("run-keep");

    await writeFile(join(wb.worktree, "base.txt"), "dirty\n");
    await writeFile(join(wb.worktree, "scratch.txt"), "scratch\n");

    const { ref } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });
    const tipBefore = (await git(wb.worktree, "rev-parse", "HEAD")).trim();
    const rematerialize = vi.fn(async () => undefined);

    await applyWorkspacePolicy({
      policy: "keep",
      worktreePath: wb.worktree,
      checkpointRef: ref,
      rematerialize,
    });

    expect((await git(wb.worktree, "rev-parse", "HEAD")).trim()).toBe(
      tipBefore,
    );
    expect(await readFile(join(wb.worktree, "base.txt"), "utf8")).toBe(
      "dirty\n",
    );
    expect(await pathExists(join(wb.worktree, "scratch.txt"))).toBe(true);
    expect(rematerialize).not.toHaveBeenCalled();
  });
});

describe("applyWorkspacePolicy — rewind-to-node-checkpoint (DD6)", () => {
  it("restores the captured state unstaged; attempt commits discarded; untracked nuances hold", async () => {
    const wb = await createPolicyWorkbench("run-rewind");

    // Capture-time state: modified tracked file + captured-untracked file.
    await writeFile(join(wb.worktree, "base.txt"), "capture-mod\n");
    await writeFile(join(wb.worktree, "captured-untracked.txt"), "cap\n");

    const tipBefore = (await git(wb.worktree, "rev-parse", "HEAD")).trim();
    const { ref, sha } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    // Attempt activity: commits + new untracked file + overwrite of the
    // captured-untracked file.
    await writeFile(join(wb.worktree, "base.txt"), "attempt-mod\n");
    await writeFile(join(wb.worktree, "attempt-tracked.txt"), "tracked\n");
    await git(wb.worktree, "add", "-A");
    await git(wb.worktree, "commit", "-q", "-m", "attempt work");
    await writeFile(join(wb.worktree, "attempt-untracked.txt"), "scratch\n");
    await writeFile(
      join(wb.worktree, "captured-untracked.txt"),
      "attempt-overwrote\n",
    );

    const rematerialize = vi.fn(async () => undefined);

    await applyWorkspacePolicy({
      policy: "rewind-to-node-checkpoint",
      worktreePath: wb.worktree,
      checkpointRef: ref,
      rematerialize,
    });

    // Branch tip back to the pre-attempt tip; attempt commits discarded.
    expect((await git(wb.worktree, "rev-parse", "HEAD")).trim()).toBe(
      tipBefore,
    );
    // Checkpoint commit still not reachable from the run branch (never
    // `reset --hard <ck>` — that would graft it).
    expect(
      await gitFails(wb.worktree, "merge-base", "--is-ancestor", sha, "HEAD"),
    ).toBe(true);

    // Captured tracked content restored UNSTAGED.
    expect(await readFile(join(wb.worktree, "base.txt"), "utf8")).toBe(
      "capture-mod\n",
    );

    const status = await git(wb.worktree, "status", "--porcelain");

    expect(status).toMatch(/^ M base\.txt$/m);

    // Captured-untracked file restored to captured content and UNTRACKED.
    expect(
      await readFile(join(wb.worktree, "captured-untracked.txt"), "utf8"),
    ).toBe("cap\n");
    expect(status).toMatch(/^\?\? captured-untracked\.txt$/m);

    // Attempt-created untracked files survive the rewind.
    expect(await pathExists(join(wb.worktree, "attempt-untracked.txt"))).toBe(
      true,
    );

    // Files introduced only by attempt commits are gone.
    expect(await pathExists(join(wb.worktree, "attempt-tracked.txt"))).toBe(
      false,
    );

    // Rewind does not re-materialize (untracked bundle artifacts survive).
    expect(rematerialize).not.toHaveBeenCalled();
  });

  it("never touches the runtime artifacts root outside the worktree (DD10)", async () => {
    const wb = await createPolicyWorkbench("run-artifacts");
    const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-wp-runtime-"));

    createdPaths.push(runtimeRoot);

    const artifactsDir = join(
      runtimeRoot,
      ".maister",
      "proj",
      "runs",
      wb.runId,
    );

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "cost.jsonl"), '{"usd":0.28}\n');

    const { ref } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    await writeFile(join(wb.worktree, "junk.txt"), "x\n");

    await applyWorkspacePolicy({
      policy: "rewind-to-node-checkpoint",
      worktreePath: wb.worktree,
      checkpointRef: ref,
    });
    await applyWorkspacePolicy({
      policy: "fresh-attempt",
      worktreePath: wb.worktree,
      checkpointRef: ref,
    });

    expect(await readFile(join(artifactsDir, "cost.jsonl"), "utf8")).toBe(
      '{"usd":0.28}\n',
    );
  });
});

describe("applyWorkspacePolicy — fresh-attempt (DD6)", () => {
  it("resets to the pre-attempt tip, cleans untracked source, KEEPS ignored, re-materializes", async () => {
    const wb = await createPolicyWorkbench("run-fresh");

    const tipBefore = (await git(wb.worktree, "rev-parse", "HEAD")).trim();
    const { ref } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    // Attempt activity: commit, dirty mod, untracked file, ignored file,
    // and a (deleted-by-clean) fake materialized bundle artifact.
    await writeFile(join(wb.worktree, "attempt-tracked.txt"), "tracked\n");
    await git(wb.worktree, "add", "-A");
    await git(wb.worktree, "commit", "-q", "-m", "attempt work");
    await writeFile(join(wb.worktree, "base.txt"), "attempt-mod\n");
    await writeFile(join(wb.worktree, "attempt-untracked.txt"), "scratch\n");
    await mkdir(join(wb.worktree, "node_modules"), { recursive: true });
    await writeFile(join(wb.worktree, "node_modules", "cache.txt"), "keep\n");
    await mkdir(join(wb.worktree, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(wb.worktree, ".claude", "skills", "aif.md"),
      "bundle\n",
    );

    const rematerialize = vi.fn(async () => {
      await mkdir(join(wb.worktree, ".claude", "skills"), { recursive: true });
      await writeFile(
        join(wb.worktree, ".claude", "skills", "aif.md"),
        "bundle\n",
      );
    });

    await applyWorkspacePolicy({
      policy: "fresh-attempt",
      worktreePath: wb.worktree,
      checkpointRef: ref,
      rematerialize,
    });

    expect((await git(wb.worktree, "rev-parse", "HEAD")).trim()).toBe(
      tipBefore,
    );
    expect(await readFile(join(wb.worktree, "base.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(await pathExists(join(wb.worktree, "attempt-untracked.txt"))).toBe(
      false,
    );
    expect(await pathExists(join(wb.worktree, "attempt-tracked.txt"))).toBe(
      false,
    );
    // `-fd` (never `-fdx`): ignored files survive the clean.
    expect(
      await readFile(join(wb.worktree, "node_modules", "cache.txt"), "utf8"),
    ).toBe("keep\n");
    // DD6-note-2: the materialization hook ran and restored the bundle.
    expect(rematerialize).toHaveBeenCalledTimes(1);
    expect(
      await readFile(join(wb.worktree, ".claude", "skills", "aif.md"), "utf8"),
    ).toBe("bundle\n");
  });
});

describe("containmentAssert (DD10)", () => {
  it("throws PRECONDITION when the runtime root resolves inside the worktree", async () => {
    const wb = await createPolicyWorkbench("run-contain");

    expect(() =>
      containmentAssert(wb.worktree, join(wb.worktree, ".maister-runtime")),
    ).toThrowError(MaisterError);
    try {
      containmentAssert(wb.worktree, join(wb.worktree, ".maister-runtime"));
    } catch (e) {
      expect((e as MaisterError).code).toBe("PRECONDITION");
    }
  });

  it("passes when the runtime root is outside the worktree", async () => {
    const wb = await createPolicyWorkbench("run-contain-ok");
    const outside = await mkdtemp(join(tmpdir(), "maister-wp-outside-"));

    createdPaths.push(outside);

    expect(() => containmentAssert(wb.worktree, outside)).not.toThrow();
  });

  it("applyWorkspacePolicy hard-blocks (no mutation) on containment violation", async () => {
    const wb = await createPolicyWorkbench("run-contain-block");

    vi.stubEnv("MAISTER_RUNTIME_ROOT", join(wb.worktree, ".maister-runtime"));

    const { ref } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    await writeFile(join(wb.worktree, "junk.txt"), "x\n");

    await expect(
      applyWorkspacePolicy({
        policy: "fresh-attempt",
        worktreePath: wb.worktree,
        checkpointRef: ref,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // Hard-block means nothing was mutated.
    expect(await pathExists(join(wb.worktree, "junk.txt"))).toBe(true);
  });
});

describe("ledger — checkpoint_ref on the attempt row", () => {
  it("setCheckpointRef records the namespaced ref on node_attempts", async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const fullSchema = await import("@/lib/db/schema");
    const { appendNodeAttempt, setCheckpointRef } = await import(
      "@/lib/flows/graph/ledger"
    );
    const { testPlatformRunnerRow, testRunnerSnapshot } = await import(
      "@/lib/__tests__/runner-fixtures"
    );

    // FIXME(any): same drizzle duplicate peer-dep type clash as
    // schema.integration.test.ts — runtime is fine.
    const schema = fullSchema as unknown as Record<string, any>;

    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("maister_test")
      .withUsername("test")
      .withPassword("test")
      .start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const db = drizzle(pool);

    try {
      await migrate(db, { migrationsFolder: "./lib/db/migrations" });

      const projectId = randomUUID();
      const executorId = randomUUID();
      const flowId = randomUUID();
      const taskId = randomUUID();
      const runId = randomUUID();

      await db.insert(schema.projects).values({
        id: projectId,
        slug: `proj-${projectId.slice(0, 8)}`,
        name: "Test",
        repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
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
        prompt: "do the thing",
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
      });

      const { id: attemptId } = await appendNodeAttempt({
        runId,
        nodeId: "implement",
        nodeType: "ai_coding",
        db,
      });

      const ref = `refs/maister/checkpoints/${runId}/${attemptId}`;

      await setCheckpointRef(attemptId, ref, db);

      const rows = await pool.query(
        `SELECT checkpoint_ref FROM node_attempts WHERE id = $1`,
        [attemptId],
      );

      expect(rows.rows[0].checkpoint_ref).toBe(ref);
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 180_000);
});

describe("promotion keeps history clean (B5 reviewer assert, ADR-079)", () => {
  it("no checkpoint commit is reachable from main after a no-ff promotion of the run branch", async () => {
    const wb = await createPolicyWorkbench("run-promote");

    // Checkpoint over a dirty pre-attempt state, then real attempt commits.
    await writeFile(join(wb.worktree, "base.txt"), "wip\n");
    const { sha } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    await writeFile(join(wb.worktree, "base.txt"), "feature work\n");
    await git(wb.worktree, "add", "-A");
    await git(wb.worktree, "commit", "-q", "-m", "feature work");

    // Promotion-style local merge (CLAUDE.md §8: git merge --no-ff).
    await git(wb.repo, "checkout", "-q", "main");
    await git(wb.repo, "merge", "--no-ff", "-q", wb.branch);

    expect(
      await gitFails(wb.repo, "merge-base", "--is-ancestor", sha, "main"),
    ).toBe(true);

    // The checkpoint commit itself still exists as a dangling ref (GC's job),
    // but promoted history contains only the real attempt commits.
    const mainLog = await git(wb.repo, "log", "--format=%s", "main");

    expect(mainLog).not.toContain("maister checkpoint");
  });
});

describe("deleteRunCheckpointRefs (GC, ADR-079)", () => {
  it("deletes all of the run's refs in both namespaces, sparing other runs; idempotent", async () => {
    const wb = await createPolicyWorkbench("run-gc");

    await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });
    await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-2",
    });
    await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "chat-checkpoints",
      runId: wb.runId,
      id: "hitl-1",
    });
    const other = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: "other-run",
      id: "attempt-1",
    });

    // Refs are repo-global — deletion through the PARENT repo path must see
    // and remove the refs created through the worktree.
    const removed = await deleteRunCheckpointRefs(wb.repo, wb.runId);

    expect(removed).toBe(3);

    const remaining = await git(
      wb.repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/maister",
    );

    expect(remaining).toContain(other.ref);
    expect(remaining).not.toContain(`refs/maister/checkpoints/${wb.runId}/`);
    expect(remaining).not.toContain(
      `refs/maister/chat-checkpoints/${wb.runId}/`,
    );

    // Idempotent: nothing left for the run.
    expect(await deleteRunCheckpointRefs(wb.repo, wb.runId)).toBe(0);
  });

  it("scopes to a single namespace when asked (chat-only GC on pause resolve)", async () => {
    const wb = await createPolicyWorkbench("run-gc-chat");

    const node = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "checkpoints",
      runId: wb.runId,
      id: "attempt-1",
    });

    await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "chat-checkpoints",
      runId: wb.runId,
      id: "hitl-1",
    });

    const removed = await deleteRunCheckpointRefs(wb.worktree, wb.runId, [
      "chat-checkpoints",
    ]);

    expect(removed).toBe(1);

    const remaining = await git(
      wb.worktree,
      "for-each-ref",
      "--format=%(refname)",
      "refs/maister",
    );

    expect(remaining).toContain(node.ref);
    expect(remaining).not.toContain("chat-checkpoints");
  });
});

describe("deleteChatCheckpoint (DD11/DD12 baseline invalidation)", () => {
  it("deletes the chat-checkpoint ref and is idempotent on a missing ref", async () => {
    const wb = await createPolicyWorkbench("run-chat");

    const { ref } = await captureCheckpoint({
      worktreePath: wb.worktree,
      namespace: "chat-checkpoints",
      runId: wb.runId,
      id: "hitl-1",
    });

    expect(ref).toBe(`refs/maister/chat-checkpoints/${wb.runId}/hitl-1`);
    expect((await git(wb.worktree, "rev-parse", ref)).trim()).toBeTruthy();

    await deleteChatCheckpoint(wb.worktree, wb.runId, "hitl-1");

    expect(await gitFails(wb.worktree, "rev-parse", "--verify", ref)).toBe(
      true,
    );

    // Idempotent: deleting again must not throw.
    await expect(
      deleteChatCheckpoint(wb.worktree, wb.runId, "hitl-1"),
    ).resolves.not.toThrow();
  });
});
