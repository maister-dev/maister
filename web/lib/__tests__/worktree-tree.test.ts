// M22 Phase 4a (RED): failing unit tests for the git-tracked-only file-read CORE.
//
// Contract (NOT yet built — RED on the missing exports):
//   web/lib/instance-config.ts
//     - workbenchMaxFileBytes(): number   (env MAISTER_WORKBENCH_MAX_FILE_BYTES,
//       default 524288 = 512 KiB, floor 1; mirror gcAgeDays)
//   web/lib/worktree.ts
//     - repoRelPathSchema (zod): non-empty, max 4096, no NUL, not absolute, no
//       leading '/', no leading '-', no '..' path segment
//     - listTree({repo, ref, dir}): Promise<{path, entries:[{name, type}]}|null>
//     - readBlob({repo, ref, path, maxBytes}): Promise<RepoBlobResult>
//       RepoBlobResult = {kind:"text",content} | {kind:"too-large",size}
//                      | {kind:"binary"} | {kind:"not-found"}
//
// The lib tests run against a REAL temp git repo built with the worktree-range
// harness (mkdtemp, git init -q -b main, config user, writeFile, add, commit) so
// the tracked-only trust boundary is exercised for real: gitignored, untracked,
// and `.git` paths must surface as not-found, never disclosed.

import type { RepoTreeEntry } from "@/lib/worktree";

import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { listTree, readBlob, repoRelPathSchema } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

describe("workbenchMaxFileBytes", () => {
  const ORIGINAL = process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES;
    } else {
      process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES = ORIGINAL;
    }
  });

  it("defaults to 524288 (512 KiB) when the env var is unset", () => {
    delete process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES;

    expect(workbenchMaxFileBytes()).toBe(524288);
  });

  it("honors a valid env value", () => {
    process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES = "1048576";

    expect(workbenchMaxFileBytes()).toBe(1048576);
  });

  it("falls back to the default for a non-numeric env value", () => {
    process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES = "not-a-number";

    expect(workbenchMaxFileBytes()).toBe(524288);
  });

  it("falls back to the default for a value below the floor of 1", () => {
    process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES = "0";

    expect(workbenchMaxFileBytes()).toBe(524288);
  });
});

describe("repoRelPathSchema", () => {
  it.each(["foo/bar.txt", "src/index.ts", "a.txt"])(
    "accepts the tracked-relative path %j",
    (p) => {
      expect(repoRelPathSchema.safeParse(p).success).toBe(true);
    },
  );

  it("rejects a parent-traversal path '../etc'", () => {
    expect(repoRelPathSchema.safeParse("../etc").success).toBe(false);
  });

  it("rejects an embedded '..' segment 'a/../b'", () => {
    expect(repoRelPathSchema.safeParse("a/../b").success).toBe(false);
  });

  it("rejects an absolute path '/etc/passwd'", () => {
    expect(repoRelPathSchema.safeParse("/etc/passwd").success).toBe(false);
  });

  it("rejects a leading-dash path '-rf' (option-injection shape)", () => {
    expect(repoRelPathSchema.safeParse("-rf").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(repoRelPathSchema.safeParse("").success).toBe(false);
  });

  it("rejects a NUL byte in the path", () => {
    expect(repoRelPathSchema.safeParse("a\0b").success).toBe(false);
  });
});

describe("listTree / readBlob against a real temp git repo", () => {
  let repo: string;
  let bigSize: number;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "worktree-tree-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");

    // tracked: a.txt, src/index.ts (forces the src/ subdir into the tree)
    await writeFile(join(repo, "a.txt"), "alpha\n");
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await execFileAsync("mkdir", ["-p", join(repo, "src")]);
    await writeFile(join(repo, "src", "index.ts"), "export const x = 1;\n");

    // tracked binary: a committed blob that contains a NUL byte
    await writeFile(
      join(repo, "bin.dat"),
      new Uint8Array([0x42, 0x00, 0x43, 0x0a]),
    );

    // tracked large file: > 64 bytes so a maxBytes:8 read reports too-large
    const big = "x".repeat(200) + "\n";

    await writeFile(join(repo, "big.txt"), big);
    bigSize = Buffer.byteLength(big);

    // gitignored secret (.env) — written but NOT committed; untracked secret.
    await writeFile(join(repo, ".env"), "SECRET=top\n");
    await writeFile(join(repo, "secret-untracked.txt"), "leak me\n");

    // A tracked symlink pointing OUTSIDE the repo. git stores it as a mode
    // 120000 blob whose content is the target PATH — cat-file must return that
    // path text, never dereference to the referenced file's content.
    await symlink("/etc/passwd", join(repo, "evil-link"));

    await git(
      repo,
      "add",
      "a.txt",
      ".gitignore",
      "src/index.ts",
      "bin.dat",
      "big.txt",
      "evil-link",
    );
    await git(repo, "commit", "-q", "-m", "seed tracked content");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe("listTree", () => {
    it("lists the repo root with a.txt as a file and src as a dir", async () => {
      const res = await listTree({ repo, ref: "main", dir: "" });

      expect(res).not.toBeNull();
      expect(res?.path).toBe("");
      const byName = new Map(
        (res?.entries ?? []).map(
          (e: RepoTreeEntry) => [e.name, e.type] as const,
        ),
      );

      expect(byName.get("a.txt")).toBe("file");
      expect(byName.get("src")).toBe("dir");
    });

    it("sorts directories before files at the root", async () => {
      const res = await listTree({ repo, ref: "main", dir: "" });
      const types = (res?.entries ?? []).map((e: RepoTreeEntry) => e.type);
      const firstFileIdx = types.indexOf("file");
      const lastDirIdx = types.lastIndexOf("dir");

      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    });

    it("lists index.ts inside the src directory", async () => {
      const res = await listTree({ repo, ref: "main", dir: "src" });

      expect(res?.entries.map((e: RepoTreeEntry) => e.name)).toContain(
        "index.ts",
      );
    });

    it("returns null for the .git directory (not in the tracked tree)", async () => {
      const res = await listTree({ repo, ref: "main", dir: ".git" });

      expect(res).toBeNull();
    });

    it("returns null for a nonexistent directory", async () => {
      const res = await listTree({ repo, ref: "main", dir: "nope-dir" });

      expect(res).toBeNull();
    });
  });

  describe("readBlob", () => {
    it("returns text content for a tracked file", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "a.txt",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "text", content: "alpha\n" });
    });

    it("returns not-found for a .git path (never disclosed)", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: ".git/config",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "not-found" });
    });

    it("returns not-found for a gitignored, untracked .env secret", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: ".env",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "not-found" });
    });

    it("returns not-found for an untracked file", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "secret-untracked.txt",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "not-found" });
    });

    it("returns binary for a tracked blob containing a NUL byte", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "bin.dat",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "binary" });
    });

    it("returns too-large with the blob size when over the cap", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "big.txt",
        maxBytes: 8,
      });

      expect(res).toEqual({ kind: "too-large", size: bigSize });
    });

    it("returns not-found for an unknown tracked path", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "nope.txt",
        maxBytes: workbenchMaxFileBytes(),
      });

      expect(res).toEqual({ kind: "not-found" });
    });

    it("returns the symlink target text, never the dereferenced file content", async () => {
      const res = await readBlob({
        repo,
        ref: "main",
        path: "evil-link",
        maxBytes: workbenchMaxFileBytes(),
      });

      // The blob is the link TARGET path, not the contents of /etc/passwd.
      expect(res).toEqual({ kind: "text", content: "/etc/passwd" });
      if (res.kind === "text") expect(res.content).not.toContain("root:");
    });
  });

  describe("defensive path validation (git is NOT shelled for a traversal)", () => {
    it("listTree throws MaisterError for a traversal dir without invoking git", async () => {
      await expect(
        listTree({ repo, ref: "main", dir: "../x" }),
      ).rejects.toBeInstanceOf(MaisterError);
    });

    it("readBlob throws MaisterError for a traversal path without invoking git", async () => {
      await expect(
        readBlob({
          repo,
          ref: "main",
          path: "../x",
          maxBytes: workbenchMaxFileBytes(),
        }),
      ).rejects.toBeInstanceOf(MaisterError);
    });
  });
});
