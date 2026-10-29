import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureOperationalBaseline,
  captureOperationalGeneration,
  verifyOperationalIntegrity,
} from "@/lib/agents/operational-integrity";

const exec = promisify(execFile);
let root: string;
let cwd: string;
const git = async (...args: string[]): Promise<void> => {
  await exec("git", ["-C", cwd, ...args]);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "operational-integrity-"));
  cwd = join(root, "repo");
  await mkdir(cwd);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "operation@example.test");
  await git("config", "user.name", "Operation test");
  await writeFile(join(cwd, "source.ts"), "export const value = 1;\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.bin\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("operational source integrity", () => {
  it("IT-OPL-04 accepts exact platform bytes and rejects later changes even inside owned directories", async () => {
    const baseline = await captureOperationalBaseline(cwd, "worktree");

    await mkdir(join(cwd, ".claude", "skills", "scan"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "SKILL.md"),
      "Trusted materialization.\n",
    );
    const ready = await captureOperationalGeneration(cwd, baseline, [
      ".claude/skills/scan",
    ]);

    expect((await verifyOperationalIntegrity(cwd, ready)).verdict).toBe(
      "clean",
    );
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "injected.ts"),
      "unexpected",
    );
    expect(await verifyOperationalIntegrity(cwd, ready)).toMatchObject({
      verdict: "changed",
      changedPaths: [".claude/skills/scan/injected.ts"],
    });
    await rm(join(cwd, ".claude", "skills", "scan", "injected.ts"));
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "SKILL.md"),
      "Tampered platform bytes.",
    );
    expect(await verifyOperationalIntegrity(cwd, ready)).toMatchObject({
      verdict: "changed",
      changedPaths: [".claude/skills/scan/SKILL.md"],
    });
    expect(baseline.generation).toBe(0);
    expect(baseline.platform).toEqual([]);
  });

  it.each([
    "tracked",
    "staged",
    "untracked",
    "ignored",
    "committed",
    "commit_and_revert",
    "commit_and_reset",
    "rename",
  ])("detects %s without destroying bytes", async (change) => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    if (change === "ignored")
      await writeFile(join(cwd, "ignored.bin"), Buffer.from([0, 255, 1, 2]));
    else if (change === "untracked")
      await writeFile(join(cwd, "new.ts"), "unexpected");
    else if (change === "rename") await git("mv", "source.ts", "renamed.ts");
    else {
      await writeFile(join(cwd, "source.ts"), "export const value = 2;\n");
      if (
        [
          "staged",
          "committed",
          "commit_and_revert",
          "commit_and_reset",
        ].includes(change)
      )
        await git("add", ".");
      if (
        ["committed", "commit_and_revert", "commit_and_reset"].includes(change)
      )
        await git("commit", "-qm", "unexpected");
      if (change === "commit_and_revert")
        await git("revert", "--no-edit", "HEAD");
      if (change === "commit_and_reset") await git("reset", "--hard", "HEAD~1");
    }
    const verdict = await verifyOperationalIntegrity(cwd, baseline);

    expect(verdict.verdict).toBe("changed");
    if (change === "ignored")
      expect(await readFile(join(cwd, "ignored.bin"))).toEqual(
        Buffer.from([0, 255, 1, 2]),
      );
  });

  it("IT-EDGE-OPL-04 refuses untrusted generation changes, symlink traversal, missing evidence and probe limits", async () => {
    const baseline = await captureOperationalBaseline(cwd, "worktree");

    await writeFile(join(cwd, "source.ts"), "unrelated source edit");
    await expect(
      captureOperationalGeneration(cwd, baseline, [".claude/skills/scan"]),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "operational_materialization_conflict" },
    });
    expect((await verifyOperationalIntegrity(cwd, null)).verdict).toBe(
      "indeterminate",
    );
    await expect(
      captureOperationalBaseline(cwd, "worktree", { maxBytes: 1 }),
    ).rejects.toMatchObject({
      details: { reason: "operational_integrity_limit" },
    });
    await symlink(root, join(cwd, "external"));
    const snapshot = await captureOperationalBaseline(cwd, "worktree");

    expect(
      snapshot.source.find((entry) => entry.path === "external")?.type,
    ).toBe("symlink");
    expect(
      snapshot.source.some((entry) => entry.path.startsWith("external/")),
    ).toBe(false);
  });

  it("accepts only server-proven parallel allocation or disposal, never a changed foreign ref", async () => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    await git("branch", "parallel-operation");
    const ref = "refs/heads/parallel-operation";

    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "indeterminate",
    );
    expect(
      (
        await verifyOperationalIntegrity(cwd, baseline, [
          { kind: "allocated", ref, sha: baseline.head! },
        ])
      ).verdict,
    ).toBe("clean");
    await writeFile(join(cwd, "source.ts"), "unexpected");
    await git("add", ".");
    await git("commit", "-qm", "changed");
    await git("branch", "-f", "parallel-operation", "HEAD");
    expect(
      (
        await verifyOperationalIntegrity(cwd, baseline, [
          { kind: "allocated", ref, sha: baseline.head! },
        ])
      ).verdict,
    ).not.toBe("clean");
  });

  it("marks shared-repository conflicts indeterminate and validates plain owned directories", async () => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "shared_repository"),
      [],
    );

    await writeFile(join(cwd, "source.ts"), "concurrent parent edit");
    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "indeterminate",
    );
    const plain = join(root, "plain");

    await mkdir(plain);
    const plainBaseline = await captureOperationalGeneration(
      plain,
      await captureOperationalBaseline(plain, "plain_directory"),
      [],
    );

    expect(
      (await verifyOperationalIntegrity(plain, plainBaseline)).verdict,
    ).toBe("clean");
  });
});
