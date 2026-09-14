import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pullProjectRemote } from "@/lib/git-remotes";
import { fetchRemote, readBlob } from "@/lib/worktree";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string): string {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "change",
  );

  return git(repo, "rev-parse", "HEAD");
}

describe("project pull with real Git", () => {
  let root: string;
  let source: string;
  let clone: string;
  let oldHead: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "maister-project-pull-"));
    source = join(root, "source");
    clone = join(root, "clone");
    git(root, "init", "--initial-branch=main", source);
    await writeFile(join(source, "lesson.md"), "old lesson\n");
    oldHead = commit(source);
    git(root, "clone", source, clone);
    await writeFile(join(source, "lesson.md"), "updated lesson\n");
    await writeFile(join(source, "new.md"), "new file\n");
    commit(source);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pull = (repoPath: string, branch = "main") =>
    pullProjectRemote({
      project: { id: "project-1", repoPath },
      name: "origin",
      branch,
    });

  it("fetch leaves local files old; pull updates both checkout and browsed blobs", async () => {
    await fetchRemote({ projectRepoPath: clone, name: "origin" });
    expect(git(clone, "rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(join(clone, "lesson.md"), "utf8")).toBe(
      "old lesson\n",
    );

    await expect(pull(clone)).resolves.toEqual({ ok: true });

    expect(git(clone, "rev-parse", "HEAD")).toBe(
      git(source, "rev-parse", "HEAD"),
    );
    expect(await readFile(join(clone, "lesson.md"), "utf8")).toBe(
      "updated lesson\n",
    );
    expect(
      await readBlob({
        repo: clone,
        ref: "main",
        path: "new.md",
        maxBytes: 1024,
      }),
    ).toEqual({ kind: "text", content: "new file\n" });
    await expect(pull(clone)).resolves.toEqual({ ok: true });
  });

  it("refuses divergence without changing the local commit or creating a merge", async () => {
    await writeFile(join(clone, "local.md"), "local work\n");
    const localHead = commit(clone);

    await expect(pull(clone)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(git(clone, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("preserves dirty files even when autostash is enabled in Git config", async () => {
    git(clone, "config", "merge.autostash", "true");
    await writeFile(join(clone, "lesson.md"), "unsaved local work\n");

    await expect(pull(clone)).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "dirty_worktree" },
    });
    expect(git(clone, "rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(join(clone, "lesson.md"), "utf8")).toBe(
      "unsaved local work\n",
    );
    expect(git(clone, "stash", "list")).toBe("");
  });

  it("refuses to pull a viewed branch into a different checked-out branch", async () => {
    git(clone, "switch", "-c", "work");

    await expect(pull(clone)).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "branch_mismatch" },
    });
    expect(git(clone, "branch", "--show-current")).toBe("work");
    expect(git(clone, "rev-parse", "HEAD")).toBe(oldHead);
  });

  it("rejects an unavailable origin instead of returning success with a warning", async () => {
    git(clone, "remote", "set-url", "origin", join(root, "missing.git"));

    await expect(pull(clone)).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
    expect(git(clone, "rev-parse", "HEAD")).toBe(oldHead);
  });
});
