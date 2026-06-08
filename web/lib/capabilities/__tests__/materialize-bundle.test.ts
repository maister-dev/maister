import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyBundleArtifactsToWorktree,
  writeAiFactoryConfigOverride,
} from "@/lib/capabilities/materialize-bundle";

describe("copyBundleArtifactsToWorktree", () => {
  let bundle: string;
  let worktree: string;

  beforeEach(async () => {
    bundle = await mkdtemp(path.join(tmpdir(), "aif-bundle-"));
    worktree = await mkdtemp(path.join(tmpdir(), "aif-wt-"));
  });

  afterEach(async () => {
    await rm(bundle, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  it("copies bundle skills/agents but never overwrites a repo-local copy", async () => {
    await mkdir(path.join(bundle, "skills", "aif-x"), { recursive: true });
    await writeFile(
      path.join(bundle, "skills", "aif-x", "SKILL.md"),
      "BUNDLE-X",
    );
    await mkdir(path.join(bundle, "skills", "aif-y"), { recursive: true });
    await writeFile(
      path.join(bundle, "skills", "aif-y", "SKILL.md"),
      "BUNDLE-Y",
    );
    await mkdir(path.join(bundle, "agents"), { recursive: true });
    await writeFile(path.join(bundle, "agents", "foo.md"), "BUNDLE-FOO");

    // worktree already carries a repo-local aif-x skill — it MUST win.
    await mkdir(path.join(worktree, ".claude", "skills", "aif-x"), {
      recursive: true,
    });
    await writeFile(
      path.join(worktree, ".claude", "skills", "aif-x", "SKILL.md"),
      "REPO-X",
    );

    const copied = await copyBundleArtifactsToWorktree({
      installedPath: bundle,
      worktreePath: worktree,
    });

    expect(copied).toEqual({ skills: true, agents: true });
    expect(
      await readFile(
        path.join(worktree, ".claude", "skills", "aif-x", "SKILL.md"),
        "utf8",
      ),
    ).toBe("REPO-X");
    expect(
      await readFile(
        path.join(worktree, ".claude", "skills", "aif-y", "SKILL.md"),
        "utf8",
      ),
    ).toBe("BUNDLE-Y");
    expect(
      await readFile(
        path.join(worktree, ".claude", "agents", "foo.md"),
        "utf8",
      ),
    ).toBe("BUNDLE-FOO");
  });

  it("is a no-op when the bundle has no skills/agents dirs", async () => {
    const copied = await copyBundleArtifactsToWorktree({
      installedPath: bundle,
      worktreePath: worktree,
    });

    expect(copied).toEqual({ skills: false, agents: false });
  });
});

describe("writeAiFactoryConfigOverride", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), "aif-wt-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("sets create_branches:false + base_branch and preserves other keys", async () => {
    await mkdir(path.join(worktree, ".ai-factory"), { recursive: true });
    await writeFile(
      path.join(worktree, ".ai-factory", "config.yaml"),
      "language:\n  ui: en\ngit:\n  enabled: true\n  create_branches: true\n  branch_prefix: feature/\n",
    );

    await writeAiFactoryConfigOverride({
      worktreePath: worktree,
      baseBranch: "main",
    });

    const cfg = parseYaml(
      await readFile(path.join(worktree, ".ai-factory", "config.yaml"), "utf8"),
    ) as { git: Record<string, unknown>; language: Record<string, unknown> };

    expect(cfg.git.create_branches).toBe(false);
    expect(cfg.git.base_branch).toBe("main");
    expect(cfg.git.branch_prefix).toBe("feature/");
    expect(cfg.language.ui).toBe("en");
  });

  it("creates config.yaml when absent", async () => {
    await writeAiFactoryConfigOverride({
      worktreePath: worktree,
      baseBranch: "develop",
    });

    const cfg = parseYaml(
      await readFile(path.join(worktree, ".ai-factory", "config.yaml"), "utf8"),
    ) as { git: Record<string, unknown> };

    expect(cfg.git.create_branches).toBe(false);
    expect(cfg.git.base_branch).toBe("develop");
  });
});
