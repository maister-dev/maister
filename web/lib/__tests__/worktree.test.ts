import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  clearWorktreeProvenanceNode,
  readWorktreeProvenanceForPromotion,
  setWorktreeProvenanceNode,
} from "@/lib/worktree-provenance";
import {
  addWorktree,
  assertBaseCommitReachable,
  branchExists,
  deliveryCommitStats,
  deliveryHistoryStats,
  diffRunWorkspace,
  findTargetMergeByRunId,
  listBranches,
  promoteLocalMerge,
  promoteRebaseMerge,
  removeOwnedWorktree,
  removeWorktree,
  resolveBaseCommit,
  squashRunBranch,
} from "@/lib/worktree";

const execFileAsync = promisify(execFile);

let root: string;
let repo: string;

beforeEach(async () => {
  root = join(tmpdir(), `worktree-test-${randomUUID()}`);
  repo = join(root, "repo");

  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.test"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "file.txt"), "base\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

describe("worktree git helpers", () => {
  it("rejects unsafe base refs before invoking git", async () => {
    await expect(
      resolveBaseCommit({ projectRepoPath: repo, baseRef: "--bad" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("resolves base commit, adds worktree from start point, and lists branches", async () => {
    const wt = join(root, "scratch-wt");
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await assertBaseCommitReachable({
      projectRepoPath: repo,
      baseRef: "main",
      baseCommit,
    });
    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/test",
      worktreePath: wt,
      startPoint: baseCommit,
    });

    const { stdout } = await git(wt, ["rev-parse", "HEAD"]);
    const branches = await listBranches(repo);

    expect(stdout.trim()).toBe(baseCommit);
    expect(
      await branchExists({ projectRepoPath: repo, branch: "scratch/test" }),
    ).toBe(true);
    expect(branches).toContain("main");
    expect(branches).toContain("scratch/test");
  });

  it("stamps managed-worktree commits without changing the configured author", async () => {
    const wt = join(root, "provenance-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance",
      worktreePath: wt,
      startPoint: "main",
      provenance: {
        runId: "run-123",
        task: "MAI-42",
        flow: "example/flow@abcdef1",
      },
    });
    await git(wt, ["config", "user.email", "foreign@example.test"]);
    await git(wt, ["config", "user.name", "Foreign Author"]);
    await writeFile(join(wt, "provenance.txt"), "tracked\n");
    await git(wt, ["add", "provenance.txt"]);
    await git(wt, ["commit", "-m", "feat: add provenance fixture"]);

    const [{ stdout: message }, { stdout: author }, { stdout: status }] =
      await Promise.all([
        git(wt, ["log", "-1", "--format=%B"]),
        git(wt, ["log", "-1", "--format=%an <%ae>"]),
        git(wt, ["status", "--porcelain"]),
      ]);

    expect(message).toContain("Maister-Run-Id: run-123");
    expect(message).toContain("Maister-Task: MAI-42");
    expect(message).toContain("Maister-Flow: example/flow@abcdef1");
    expect(author.trim()).toBe("Foreign Author <foreign@example.test>");
    expect(status).not.toContain(".maister-managed");
  });

  it("keeps exactly one truthful trailer set through no-verify and amend commits", async () => {
    const wt = join(root, "provenance-amend-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance-amend",
      worktreePath: wt,
      startPoint: "main",
      provenance: { runId: "run-amend", task: "MAI-43" },
    });
    await writeFile(join(wt, "provenance.txt"), "first\n");
    await git(wt, ["add", "provenance.txt"]);
    await git(wt, ["commit", "--no-verify", "-m", "feat: first fixture"]);
    await writeFile(join(wt, "provenance.txt"), "first\nsecond\n");
    await git(wt, ["commit", "-am", "feat: update fixture"]);
    await git(wt, ["commit", "--amend", "--no-edit"]);

    const { stdout: message } = await git(wt, ["log", "-1", "--format=%B"]);

    expect(message.match(/^Maister-Run-Id: run-amend$/gm)).toHaveLength(1);
    expect(message.match(/^Maister-Task: MAI-43$/gm)).toHaveLength(1);
  });

  it("rejects fabricated task or flow trailers in a taskless managed worktree", async () => {
    const wt = join(root, "provenance-taskless-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance-taskless",
      worktreePath: wt,
      startPoint: "main",
      provenance: { runId: "run-taskless" },
    });
    await writeFile(join(wt, "taskless.txt"), "tracked\n");
    await git(wt, ["add", "taskless.txt"]);

    await expect(
      git(wt, [
        "commit",
        "-m",
        "chore: fabricated identity\n\nMaister-Task: MAI-99",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unexpected Maister-Task trailer"),
    });
  });

  it("distinguishes a legacy worktree from a broken managed provenance directory", async () => {
    const legacy = join(root, "legacy-wt");
    const managed = join(root, "managed-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/legacy-provenance",
      worktreePath: legacy,
      startPoint: "main",
    });
    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/broken-provenance",
      worktreePath: managed,
      startPoint: "main",
      provenance: { runId: "run-managed" },
    });
    await rm(join(managed, ".maister-managed", "provenance"));

    await expect(
      readWorktreeProvenanceForPromotion(legacy),
    ).resolves.toBeNull();
    await expect(
      readWorktreeProvenanceForPromotion(managed),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("exposes only the active graph node to managed commit hooks", async () => {
    const wt = join(root, "provenance-node-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance-node",
      worktreePath: wt,
      startPoint: "main",
      provenance: { runId: "run-node" },
    });
    await setWorktreeProvenanceNode({ worktreePath: wt, nodeId: "implement" });
    await writeFile(join(wt, "node.txt"), "first\n");
    await git(wt, ["add", "node.txt"]);
    await git(wt, ["commit", "-m", "feat: node fixture"]);
    await clearWorktreeProvenanceNode(wt);
    await writeFile(join(wt, "node.txt"), "first\nsecond\n");
    await git(wt, ["commit", "-am", "feat: after node fixture"]);

    const [{ stdout: nodeMessage }, { stdout: nextMessage }] =
      await Promise.all([
        git(wt, ["log", "-1", "--format=%B", "HEAD~1"]),
        git(wt, ["log", "-1", "--format=%B", "HEAD"]),
      ]);

    expect(nodeMessage).toContain("Maister-Node: implement");
    expect(nextMessage).not.toContain("Maister-Node:");
  });

  it("rejects a reused node-scoped message after the active node is cleared", async () => {
    const wt = join(root, "provenance-reused-node-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance-reused-node",
      worktreePath: wt,
      startPoint: "main",
      provenance: { runId: "run-reused-node" },
    });
    await setWorktreeProvenanceNode({ worktreePath: wt, nodeId: "implement" });
    await writeFile(join(wt, "node.txt"), "first\n");
    await git(wt, ["add", "node.txt"]);
    await git(wt, ["commit", "-m", "feat: node fixture"]);
    await clearWorktreeProvenanceNode(wt);
    await writeFile(join(wt, "node.txt"), "first\nsecond\n");
    await git(wt, ["add", "node.txt"]);

    await expect(git(wt, ["commit", "-C", "HEAD"])).rejects.toMatchObject({
      stderr: expect.stringContaining("unexpected Maister-Node trailer"),
    });
  });

  it("re-stamps the rewritten squash commit in a managed worktree", async () => {
    const wt = join(root, "provenance-squash-wt");
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/provenance-squash",
      worktreePath: wt,
      startPoint: baseCommit,
      provenance: { runId: "run-squash", task: "MAI-44" },
    });
    await writeFile(join(wt, "squash.txt"), "first\n");
    await git(wt, ["add", "squash.txt"]);
    await git(wt, ["commit", "-m", "feat: first squash fixture"]);
    await writeFile(join(wt, "squash.txt"), "first\nsecond\n");
    await git(wt, ["commit", "-am", "feat: second squash fixture"]);

    await expect(
      squashRunBranch({
        worktreePath: wt,
        baseCommit,
        message: "chore: squash managed fixture",
      }),
    ).resolves.toMatchObject({ squashed: true, collapsed: 2 });

    const { stdout: message } = await git(wt, ["log", "-1", "--format=%B"]);

    expect(message).toContain("Maister-Run-Id: run-squash");
    expect(message).toContain("Maister-Task: MAI-44");
  });

  it("rejects a missing pinned base commit as PRECONDITION", async () => {
    await expect(
      assertBaseCommitReachable({
        projectRepoPath: repo,
        baseRef: "main",
        baseCommit: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects a pinned base commit reachable only from a different branch", async () => {
    await git(repo, ["checkout", "-b", "side"]);
    await writeFile(join(repo, "side.txt"), "side\n");
    await git(repo, ["add", "side.txt"]);
    await git(repo, ["commit", "-m", "side commit"]);

    const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
    const sideCommit = stdout.trim();

    await git(repo, ["checkout", "main"]);

    await expect(
      assertBaseCommitReachable({
        projectRepoPath: repo,
        baseRef: "main",
        baseCommit: sideCommit,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("returns diff from base commit to scratch branch", async () => {
    const wt = join(root, "diff-wt");
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/diff",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "file.txt"), "base\nscratch\n");
    await git(wt, ["add", "file.txt"]);
    await git(wt, ["commit", "-m", "scratch change"]);

    const diff = await diffRunWorkspace({
      projectRepoPath: repo,
      baseCommit,
      branch: "scratch/diff",
    });

    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("+scratch");
  });

  it("counts per-commit target delivery instead of collapsing rebase churn", async () => {
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await git(repo, ["checkout", "-b", "delivery/history"]);
    await writeFile(join(repo, "file.txt"), "base\nfirst\n");
    await git(repo, ["commit", "-am", "first delivery"]);
    await writeFile(join(repo, "file.txt"), "base\n");
    await git(repo, ["commit", "-am", "second delivery"]);

    await expect(
      deliveryHistoryStats({
        worktreePath: repo,
        baseRef: baseCommit,
        branch: "delivery/history",
      }),
    ).resolves.toEqual({ files: 2, additions: 1, deletions: 1 });
  });

  it("rebases the source worktree before fast-forwarding the parent checkout", async () => {
    const wt = join(root, "delivery-rebase-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "delivery/rebase",
      worktreePath: wt,
      startPoint: "main",
      provenance: { runId: "run-rebase" },
    });
    await writeFile(join(wt, "delivery.ts"), "export const delivery = true;\n");
    await git(wt, ["add", "delivery.ts"]);
    await git(wt, ["commit", "-m", "feat: source delivery"]);
    await writeFile(join(repo, "target.ts"), "export const target = true;\n");
    await git(repo, ["add", "target.ts"]);
    await git(repo, ["commit", "-m", "feat: target delivery"]);

    const promotedHead = await promoteRebaseMerge({
      projectRepoPath: repo,
      sourceBranch: "delivery/rebase",
      worktreePath: wt,
      targetBranch: "main",
    });
    const [{ stdout: parentHead }, { stdout: message }] = await Promise.all([
      git(repo, ["rev-parse", "HEAD"]),
      git(repo, ["log", "-1", "--format=%B"]),
    ]);

    expect(promotedHead).toBe(parentHead.trim());
    expect(message).toContain("Maister-Run-Id: run-rebase");
  });

  it("aborts a conflicting rebase in the linked source worktree", async () => {
    const wt = join(root, "delivery-rebase-conflict-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "delivery/rebase-conflict",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "file.txt"), "source delivery\n");
    await git(wt, ["commit", "-am", "feat: source conflict"]);
    const { stdout: sourceHead } = await git(wt, ["rev-parse", "HEAD"]);

    await writeFile(join(repo, "file.txt"), "target delivery\n");
    await git(repo, ["commit", "-am", "feat: target conflict"]);

    await expect(
      promoteRebaseMerge({
        projectRepoPath: repo,
        sourceBranch: "delivery/rebase-conflict",
        worktreePath: wt,
        targetBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [
      { stdout: restoredHead },
      { stdout: sourceStatus },
      { stdout: targetFile },
    ] = await Promise.all([
      git(wt, ["rev-parse", "HEAD"]),
      git(wt, ["status", "--porcelain"]),
      git(repo, ["show", "main:file.txt"]),
    ]);

    expect(restoredHead.trim()).toBe(sourceHead.trim());
    expect(sourceStatus).toBe("");
    expect(targetFile).toBe("target delivery\n");
    await expect(
      git(wt, ["rev-parse", "--verify", "REBASE_HEAD"]),
    ).rejects.toBeDefined();
  });

  it("counts a target merge against its first parent without double-counting the source", async () => {
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await git(repo, ["checkout", "-b", "delivery/merge"]);
    await writeFile(join(repo, "merged.ts"), "export const merged = true;\n");
    await git(repo, ["add", "merged.ts"]);
    await git(repo, ["commit", "-m", "feat: merged delivery"]);
    await promoteLocalMerge({
      projectRepoPath: repo,
      sourceBranch: "delivery/merge",
      targetBranch: "main",
    });

    await expect(
      deliveryHistoryStats({
        worktreePath: repo,
        baseRef: baseCommit,
        branch: "main",
      }),
    ).resolves.toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("measures a non-FF merge against its first parent", async () => {
    await git(repo, ["checkout", "-b", "delivery/merge-source"]);
    await writeFile(join(repo, "source.txt"), "source\n");
    await git(repo, ["add", "source.txt"]);
    await git(repo, ["commit", "-m", "source delivery"]);
    await git(repo, ["checkout", "main"]);
    await writeFile(join(repo, "target.txt"), "target\n");
    await git(repo, ["add", "target.txt"]);
    await git(repo, ["commit", "-m", "target change"]);
    const targetBefore = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

    await git(repo, [
      "merge",
      "--no-ff",
      "-m",
      "merge source delivery",
      "delivery/merge-source",
    ]);

    await expect(
      deliveryHistoryStats({
        worktreePath: repo,
        baseRef: targetBefore,
        branch: "main",
      }),
    ).resolves.toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("excludes a rename when either delivery path is generated", async () => {
    await mkdir(join(repo, "generated"), { recursive: true });
    await writeFile(join(repo, "generated", "legacy.ts"), "legacy\n");
    await git(repo, ["add", "generated/legacy.ts"]);
    await git(repo, ["commit", "-m", "generated base"]);
    const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

    await git(repo, ["checkout", "-b", "delivery/rename"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await git(repo, ["mv", "generated/legacy.ts", "src/renamed.ts"]);
    await git(repo, ["commit", "-m", "rename generated delivery"]);

    await expect(
      deliveryHistoryStats({
        worktreePath: repo,
        baseRef: baseCommit,
        branch: "delivery/rename",
      }),
    ).resolves.toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("aborts merge and reports conflict when local promotion cannot merge", async () => {
    await git(repo, ["checkout", "-b", "scratch/conflict"]);
    await writeFile(join(repo, "file.txt"), "source\n");
    await git(repo, ["commit", "-am", "source change"]);
    await git(repo, ["checkout", "main"]);
    await writeFile(join(repo, "file.txt"), "target\n");
    await git(repo, ["commit", "-am", "target change"]);

    await expect(
      promoteLocalMerge({
        projectRepoPath: repo,
        sourceBranch: "scratch/conflict",
        targetBranch: "main",
      }),
    ).rejects.toBeInstanceOf(MaisterError);

    await expect(
      git(repo, ["rev-parse", "--verify", "MERGE_HEAD"]),
    ).rejects.toThrow();
  });

  it("composes provenance trailers for the non-FF target merge", async () => {
    await git(repo, ["checkout", "-b", "scratch/merge-provenance"]);
    await writeFile(join(repo, "merge.txt"), "source\n");
    await git(repo, ["add", "merge.txt"]);
    await git(repo, ["commit", "-m", "feat: source change"]);

    const mergeCommit = await promoteLocalMerge({
      projectRepoPath: repo,
      sourceBranch: "scratch/merge-provenance",
      targetBranch: "main",
      provenance: { runId: "run-merge", task: "MAI-7" },
    });
    const { stdout: message } = await git(repo, [
      "show",
      "-s",
      "--format=%B",
      mergeCommit,
    ]);

    expect(message).toContain("Maister-Run-Id: run-merge");
    expect(message).toContain("Maister-Task: MAI-7");
    await expect(
      findTargetMergeByRunId({
        projectRepoPath: repo,
        targetBranch: "main",
        runId: "run-merge",
      }),
    ).resolves.toBe(mergeCommit);
    await expect(
      deliveryCommitStats({ projectRepoPath: repo, commit: mergeCommit }),
    ).resolves.toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("refuses to remove a worktree outside the allowed root", async () => {
    const wt = join(root, "owned", "scratch-wt");

    await mkdir(join(root, "owned"), { recursive: true });
    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/remove",
      worktreePath: wt,
      startPoint: "main",
    });

    await expect(
      removeOwnedWorktree({
        projectRepoPath: repo,
        worktreePath: wt,
        allowedRoot: join(root, "other-root"),
        force: true,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(
      await branchExists({ projectRepoPath: repo, branch: "scratch/remove" }),
    ).toBe(true);

    await removeWorktree({
      projectRepoPath: repo,
      worktreePath: wt,
      force: true,
    });
  });
});
