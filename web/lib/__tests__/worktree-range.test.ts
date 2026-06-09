import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import { diffRange, logRange, resolveBaseRef } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

describe("worktree range ops", () => {
  let repo: string;
  let baseSha: string;
  let branchTip: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "worktree-range-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");

    await writeFile(join(repo, "base.txt"), "base\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base commit");
    baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

    await git(repo, "checkout", "-q", "-b", "feature");

    await writeFile(join(repo, "a.txt"), "alpha\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add alpha");

    await writeFile(join(repo, "b.txt"), "bravo\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add bravo");
    branchTip = (await git(repo, "rev-parse", "HEAD")).trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe("resolveBaseRef", () => {
    it("returns the merge-base SHA of mainBranch and branch", async () => {
      const sha = await resolveBaseRef({
        worktreePath: repo,
        branch: "feature",
        mainBranch: "main",
      });

      expect(sha).toBe(baseSha);
    });

    it("rejects a branch failing branchNameSchema before shelling out", async () => {
      await expect(
        resolveBaseRef({
          worktreePath: repo,
          branch: "bad branch",
          mainBranch: "main",
        }),
      ).rejects.toBeInstanceOf(MaisterError);
    });

    it("fails closed for a leading-dash branch as a revision, not a parsed git flag (--end-of-options)", async () => {
      const err = await resolveBaseRef({
        worktreePath: repo,
        branch: "-foo",
        mainBranch: "main",
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MaisterError);
      expect((err as MaisterError).code).toBe("CONFLICT");
      expect((err as MaisterError).message).not.toMatch(
        /unknown (switch|option)/i,
      );
      expect((err as MaisterError).message).toMatch(
        /not a valid object name|bad revision|unknown revision/i,
      );
    });

    it("fails closed for a leading-dash mainBranch as a revision, not a parsed git flag (--end-of-options)", async () => {
      const err = await resolveBaseRef({
        worktreePath: repo,
        branch: "feature",
        mainBranch: "-foo",
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MaisterError);
      expect((err as MaisterError).code).toBe("CONFLICT");
      expect((err as MaisterError).message).not.toMatch(
        /unknown (switch|option)/i,
      );
      expect((err as MaisterError).message).toMatch(
        /not a valid object name|bad revision|unknown revision/i,
      );
    });
  });

  describe("logRange", () => {
    it("returns the oneline commit list for base..branch", async () => {
      const out = await logRange({
        worktreePath: repo,
        baseRef: baseSha,
        branch: "feature",
      });

      expect(out).toContain("add alpha");
      expect(out).toContain("add bravo");
      expect(out).not.toContain("base commit");
    });

    it("rejects a baseRef containing '..'", async () => {
      await expect(
        logRange({
          worktreePath: repo,
          baseRef: `${baseSha}..${branchTip}`,
          branch: "feature",
        }),
      ).rejects.toBeInstanceOf(MaisterError);
    });

    it("rejects a branch failing branchNameSchema", async () => {
      await expect(
        logRange({
          worktreePath: repo,
          baseRef: baseSha,
          branch: "bad;branch",
        }),
      ).rejects.toBeInstanceOf(MaisterError);
    });

    it("rejects a leading-dash baseRef at the schema refine (PRECONDITION, before shelling out)", async () => {
      await expect(
        logRange({
          worktreePath: repo,
          baseRef: "-foo",
          branch: "feature",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });
    });

    it("throws CONFLICT when git fails (unknown ref)", async () => {
      await expect(
        logRange({
          worktreePath: repo,
          baseRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          branch: "feature",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("diffRange", () => {
    it("returns the raw unified diff for base..branch", async () => {
      const out = await diffRange({
        worktreePath: repo,
        baseRef: baseSha,
        branch: "feature",
      });

      expect(out.truncated).toBe(false);
      expect(out.text).toContain("diff --git");
      expect(out.text).toContain("a.txt");
      expect(out.text).toContain("b.txt");
      expect(out.text).toContain("+alpha");
      expect(out.text).toContain("+bravo");
    });

    it("rejects a baseRef containing '..'", async () => {
      await expect(
        diffRange({
          worktreePath: repo,
          baseRef: `${baseSha}..HEAD`,
          branch: "feature",
        }),
      ).rejects.toBeInstanceOf(MaisterError);
    });

    it("truncates an oversized diff with a structured flag instead of throwing", async () => {
      const bigRepo = await mkdtemp(join(tmpdir(), "worktree-range-big-"));

      try {
        await git(bigRepo, "init", "-q", "-b", "main");
        await git(bigRepo, "config", "user.email", "test@maister.local");
        await git(bigRepo, "config", "user.name", "Test");
        await git(bigRepo, "config", "commit.gpgsign", "false");

        await writeFile(join(bigRepo, "seed.txt"), "seed\n");
        await git(bigRepo, "add", "-A");
        await git(bigRepo, "commit", "-q", "-m", "seed");
        const bigBase = (await git(bigRepo, "rev-parse", "HEAD")).trim();

        await git(bigRepo, "checkout", "-q", "-b", "huge");
        const huge = `${"x".repeat(64)}\n`.repeat(120_000);

        await writeFile(join(bigRepo, "huge.txt"), huge);
        await git(bigRepo, "add", "-A");
        await git(bigRepo, "commit", "-q", "-m", "huge file");

        const out = await diffRange({
          worktreePath: bigRepo,
          baseRef: bigBase,
          branch: "huge",
        });

        expect(out.truncated).toBe(true);
        // The partial diff carries a bounded prefix of real content and NO
        // in-band marker — the structured flag is the only truncation signal.
        expect(out.text).toContain("diff --git");
        expect(out.text).not.toMatch(/maister: diff truncated/);
      } finally {
        await rm(bigRepo, { recursive: true, force: true });
      }
    });
  });
});
