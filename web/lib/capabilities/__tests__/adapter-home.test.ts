import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  materializeAdapterCapabilityHome,
  materializeSubagentDefinition,
} from "@/lib/capabilities/adapter-home";
import { releaseAgentMaterialization } from "@/lib/agents/materialization-manifest";

let base: string;
let work: string; // worktree
let pkg: string; // installed bundle dir
let codexGlobal: string; // fake ~/.codex

beforeEach(async () => {
  // realpath so the macOS /var -> /private/var tmp symlink does not trip the
  // in-worktree path-safety checks (production worktrees are not symlinked).
  base = await realpath(await mkdtemp(path.join(tmpdir(), "adapter-home-")));
  work = path.join(base, "worktree");
  pkg = path.join(base, "pkg");
  codexGlobal = path.join(base, "codex-global");

  await mkdir(work, { recursive: true });
  await mkdir(path.join(pkg, "skills", "aif-plan"), { recursive: true });
  await writeFile(
    path.join(pkg, "skills", "aif-plan", "SKILL.md"),
    "PROJECT aif-plan",
  );
  await mkdir(path.join(pkg, "agents"), { recursive: true });
  await writeFile(path.join(pkg, "agents", "helper.md"), "PROJECT helper");

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
  it("claude (cwd-dir): copies bundle skills and subagents into worktree .claude/, no redirect env", async () => {
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
    expect(
      await readFile(path.join(work, ".claude", "agents", "helper.md"), "utf8"),
    ).toBe("PROJECT helper");
  });

  it("claude package capability roots materialize capability subagents", async () => {
    const capRoot = path.join(pkg, "capability", "review");

    await mkdir(path.join(capRoot, "skills", "aif-review"), {
      recursive: true,
    });
    await writeFile(
      path.join(capRoot, "skills", "aif-review", "SKILL.md"),
      "PROJECT aif-review",
    );
    await mkdir(path.join(capRoot, "agents"), { recursive: true });
    await writeFile(
      path.join(capRoot, "agents", "reviewer.md"),
      "capability subagent",
    );

    const res = await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: work,
      runId: "r1",
      installedPaths: [capRoot],
    });

    expect(res.env).toEqual({});
    expect(
      await readFile(
        path.join(work, ".claude", "skills", "aif-review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("PROJECT aif-review");
    expect(
      await readFile(
        path.join(work, ".claude", "agents", "reviewer.md"),
        "utf8",
      ),
    ).toBe("capability subagent");
  });

  it("claude preserves user-owned same-name skills and subagents", async () => {
    await mkdir(path.join(work, ".claude", "skills", "aif-plan"), {
      recursive: true,
    });
    await writeFile(
      path.join(work, ".claude", "skills", "aif-plan", "SKILL.md"),
      "USER aif-plan",
    );
    await mkdir(path.join(work, ".claude", "agents"), { recursive: true });
    await writeFile(
      path.join(work, ".claude", "agents", "helper.md"),
      "USER helper",
    );

    await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: work,
      runId: "r1",
      installedPaths: [pkg],
    });

    expect(
      await readFile(
        path.join(work, ".claude", "skills", "aif-plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("USER aif-plan");
    expect(
      await readFile(path.join(work, ".claude", "agents", "helper.md"), "utf8"),
    ).toBe("USER helper");
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

  it.each([
    ["codex", "codex-home", "CODEX_HOME"],
    ["opencode", "opencode-home", "OPENCODE_CONFIG_DIR"],
    ["mimo", "mimo-home", "XDG_CONFIG_HOME"],
  ] as const)(
    "%s leaves an interrupted unleased legacy home untouched",
    async (agent, legacyDirectory, envKey) => {
      const runId = `interrupted-${agent}`;
      const legacyHome = path.join(
        work,
        ".maister",
        "capabilities",
        runId,
        legacyDirectory,
      );
      const recordPath = path.join(
        work,
        ".maister",
        "agent-materialization",
        "runs",
        `${runId}.json`,
      );

      await mkdir(legacyHome, { recursive: true });
      await writeFile(path.join(legacyHome, "keep.txt"), "user-content");
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(
        recordPath,
        JSON.stringify({
          version: 1,
          runId,
          state: "preparing",
          paths: [`.maister/capabilities/${runId}/${legacyDirectory}`],
        }),
      );

      const result = await materializeAdapterCapabilityHome({
        agent,
        worktreePath: work,
        runId,
        installedPaths: [pkg],
        codexGlobalHome: codexGlobal,
      });
      const ownedHome = result.env[envKey];

      expect(ownedHome).toContain(`${legacyDirectory}-`);
      expect(ownedHome).not.toBe(legacyHome);
      await expect(
        readFile(path.join(legacyHome, "keep.txt"), "utf8"),
      ).resolves.toBe("user-content");

      await releaseAgentMaterialization(work, runId);

      await expect(lstat(ownedHome)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(legacyHome, "keep.txt"), "utf8"),
      ).resolves.toBe("user-content");
    },
  );

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
    await expect(
      lstat(path.join(work, ".gemini", "agents", "helper.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to materialize through a symlinked adapter root", async () => {
    const outside = path.join(base, "outside");

    await mkdir(outside, { recursive: true });
    await mkdir(path.join(work, ".claude"), { recursive: true });
    await symlink(outside, path.join(work, ".claude", "skills"));

    await expect(
      materializeAdapterCapabilityHome({
        agent: "claude",
        worktreePath: work,
        runId: "r1",
        installedPaths: [pkg],
      }),
    ).rejects.toThrow(/symlinked path component/);
    await expect(lstat(path.join(outside, "aif-plan"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("materializeSubagentDefinition (FR-C4)", () => {
  it("writes .claude/agents/<stem>.md from a package-qualified id", async () => {
    const target = await materializeSubagentDefinition({
      worktreePath: work,
      runId: "subagent-run",
      agentId: "test-pkg:reviewer",
      source: "AGENT BODY",
    });

    expect(target).toBe(path.join(work, ".claude", "agents", "reviewer.md"));
    expect(await readFile(target, "utf8")).toBe("AGENT BODY");
  });

  it("refuses a symlinked .claude path before writing a subagent definition", async () => {
    const outside = path.join(base, "outside");

    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(work, ".claude"));

    await expect(
      materializeSubagentDefinition({
        worktreePath: work,
        runId: "subagent-run",
        agentId: "test-pkg:reviewer",
        source: "AGENT BODY",
      }),
    ).rejects.toThrow(/symlinked path component/);
    await expect(
      readFile(path.join(outside, "agents", "reviewer.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records an owned definition for terminal cleanup", async () => {
    const target = await materializeSubagentDefinition({
      worktreePath: work,
      runId: "subagent-run",
      agentId: "test-pkg:reviewer",
      source: "AGENT BODY",
    });

    await releaseAgentMaterialization(work, "subagent-run");

    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a user-owned definition with the same stem", async () => {
    const target = path.join(work, ".claude", "agents", "reviewer.md");

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "USER BODY");

    await expect(
      materializeSubagentDefinition({
        worktreePath: work,
        runId: "subagent-run",
        agentId: "test-pkg:reviewer",
        source: "AGENT BODY",
      }),
    ).rejects.toThrow(/user-owned subagent definition/);
    await expect(readFile(target, "utf8")).resolves.toBe("USER BODY");
  });
});
