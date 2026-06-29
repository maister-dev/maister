import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  materializeAdapterCapabilityHome,
  materializeSubagentDefinition,
} from "@/lib/capabilities/adapter-home";

let base: string;
let work: string; // worktree
let pkg: string; // installed bundle dir
let codexGlobal: string; // fake ~/.codex

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "adapter-home-"));
  work = path.join(base, "worktree");
  pkg = path.join(base, "pkg");
  codexGlobal = path.join(base, "codex-global");

  await mkdir(work, { recursive: true });
  await mkdir(path.join(pkg, "skills", "aif-plan"), { recursive: true });
  await writeFile(
    path.join(pkg, "skills", "aif-plan", "SKILL.md"),
    "PROJECT aif-plan",
  );

  await mkdir(path.join(codexGlobal, "skills", "coding-style"), {
    recursive: true,
  });
  await writeFile(
    path.join(codexGlobal, "skills", "coding-style", "SKILL.md"),
    "GLOBAL coding-style",
  );
  await writeFile(path.join(codexGlobal, "auth.json"), "{}");
  await writeFile(path.join(codexGlobal, "config.toml"), "x = 1");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("materializeAdapterCapabilityHome — per-adapter target (FR-C1/C2)", () => {
  it("claude (cwd-dir): copies bundle skills into worktree .claude/, no redirect env", async () => {
    const res = await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: work,
      runId: "r1",
      installedPaths: [pkg],
    });

    expect(res.env).toEqual({});
    expect(
      await readFile(
        path.join(work, ".claude", "skills", "aif-plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("PROJECT aif-plan");
  });

  it("codex (home-redirect): composes CODEX_HOME with symlinked global auth/config + global skills + project skills", async () => {
    const res = await materializeAdapterCapabilityHome({
      agent: "codex",
      worktreePath: work,
      runId: "r1",
      installedPaths: [pkg],
      codexGlobalHome: codexGlobal,
    });

    const home = res.env.CODEX_HOME;

    expect(home).toBeTruthy();
    expect((await lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(
      true,
    );
    expect((await lstat(path.join(home, "config.toml"))).isSymbolicLink()).toBe(
      true,
    );
    // global skill restored via symlink
    expect(
      (await lstat(path.join(home, "skills", "coding-style"))).isSymbolicLink(),
    ).toBe(true);
    // project skill materialized
    expect(
      await readFile(path.join(home, "skills", "aif-plan", "SKILL.md"), "utf8"),
    ).toBe("PROJECT aif-plan");
  });

  it("codex: a project skill WINS over a same-named global skill", async () => {
    await mkdir(path.join(codexGlobal, "skills", "aif-plan"), {
      recursive: true,
    });
    await writeFile(
      path.join(codexGlobal, "skills", "aif-plan", "SKILL.md"),
      "GLOBAL aif-plan",
    );

    const res = await materializeAdapterCapabilityHome({
      agent: "codex",
      worktreePath: work,
      runId: "r1",
      installedPaths: [pkg],
      codexGlobalHome: codexGlobal,
    });
    const dest = path.join(res.env.CODEX_HOME, "skills", "aif-plan");

    // project wins → a real dir (not the global symlink), with project content
    expect((await lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(
      "PROJECT aif-plan",
    );
  });

  it("gemini (cwd-dir): materializes project skills into worktree .gemini without redirecting native auth", async () => {
    const res = await materializeAdapterCapabilityHome({
      agent: "gemini",
      worktreePath: work,
      runId: "r1",
      installedPaths: [pkg],
    });

    expect(res.env).toEqual({});
    expect(
      await readFile(
        path.join(work, ".gemini", "skills", "aif-plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("PROJECT aif-plan");
  });
});

describe("materializeSubagentDefinition (FR-C4)", () => {
  it("writes .claude/agents/<stem>.md from a package-qualified id", async () => {
    const target = await materializeSubagentDefinition({
      worktreePath: work,
      agentId: "test-pkg:reviewer",
      source: "AGENT BODY",
    });

    expect(target).toBe(path.join(work, ".claude", "agents", "reviewer.md"));
    expect(await readFile(target, "utf8")).toBe("AGENT BODY");
  });
});
