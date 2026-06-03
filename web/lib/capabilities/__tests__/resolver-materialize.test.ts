import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";

import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeCapabilityProfile } from "@/lib/capabilities/materialize";
import { resolveCapabilityProfile } from "@/lib/capabilities/resolver";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "capability-profile-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function record(
  over: Partial<CapabilityCatalogRecord>,
): CapabilityCatalogRecord {
  return {
    id: over.id ?? `row-${over.capabilityRefId ?? "x"}`,
    projectId: over.projectId ?? "project-1",
    capabilityRefId: over.capabilityRefId ?? "github",
    kind: over.kind ?? "mcp",
    label: over.label ?? over.capabilityRefId ?? "github",
    source: over.source ?? "platform",
    version: over.version ?? null,
    revision: over.revision ?? null,
    agents: over.agents ?? ["claude", "codex"],
    enforceability: over.enforceability ?? "enforced",
    selectedByDefault: over.selectedByDefault ?? true,
    selectable: over.selectable ?? true,
    material: over.material ?? {},
  };
}

describe("resolveCapabilityProfile", () => {
  it("selects all default MCPs when launcher omits MCP ids", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      catalog: [
        record({ capabilityRefId: "github" }),
        record({ capabilityRefId: "postgres", selectedByDefault: false }),
      ],
    });

    expect(profile.selectedMcpIds).toEqual(["github"]);
    expect(profile.enforced.map((e) => e.capabilityRefId)).toEqual(["github"]);
  });

  it("honors unchecked MCP omission with an explicit empty selection", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedMcpIds: [],
      catalog: [record({ capabilityRefId: "github" })],
    });

    expect(profile.selectedMcpIds).toEqual([]);
    expect(profile.enforced).toEqual([]);
  });

  it("resolves same MCP ref ids across platform and project scopes without overwriting", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedMcpIds: ["github"],
      catalog: [
        record({
          id: "platform-github",
          capabilityRefId: "github",
          source: "platform",
        }),
        record({
          id: "project-github",
          capabilityRefId: "github",
          source: "project",
        }),
      ],
    });

    expect(profile.selectedMcpIds).toEqual(["github"]);
    expect(
      profile.enforced.map((e) => `${e.source}:${e.capabilityRefId}`),
    ).toEqual(["platform:github", "project:github"]);
  });

  it("rejects unknown selected ids", () => {
    expect(() =>
      resolveCapabilityProfile({
        projectId: "project-1",
        executorAgent: "claude",
        planMode: "off",
        selectedSkillIds: ["missing"],
        catalog: [],
      }),
    ).toThrow(/Unknown or unavailable skill/);
  });

  it("fails closed for enforced capabilities unsupported by executor", () => {
    let caught: unknown;

    try {
      resolveCapabilityProfile({
        projectId: "project-1",
        executorAgent: "codex",
        planMode: "off",
        selectedMcpIds: ["claude-only"],
        catalog: [
          record({
            capabilityRefId: "claude-only",
            agents: ["claude"],
            enforceability: "enforced",
          }),
        ],
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
  });

  it("downgrades optional unsupported capabilities and records the reason", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "codex",
      planMode: "plan-first",
      selectedRuleIds: ["rule-a"],
      catalog: [
        record({
          capabilityRefId: "rule-a",
          kind: "rule",
          agents: ["claude"],
          enforceability: "instructed",
        }),
      ],
    });

    expect(profile.downgraded).toHaveLength(1);
    expect(profile.downgraded[0].reason).toContain("codex");
    expect(profile.instructed[0].capabilityRefId).toBe("rule-a");
  });

  it("serializes deterministic digests", () => {
    const catalog = [
      record({ capabilityRefId: "github" }),
      record({ capabilityRefId: "rule-a", kind: "rule" }),
    ];
    const left = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedRuleIds: ["rule-a"],
      catalog,
    });
    const right = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedRuleIds: ["rule-a"],
      catalog: [...catalog].reverse(),
    });

    expect(left.profileDigest).toBe(right.profileDigest);
  });

  it("maps agentName from record-form agents for claude", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedSkillIds: ["edit-tool"],
      catalog: [
        record({
          capabilityRefId: "edit-tool",
          kind: "skill",
          enforceability: "instructed",
          agents: { claude: "ClaudeEdit", codex: "CodexApplyPatch" },
        }),
      ],
    });

    const entry = profile.supported.find(
      (e) => e.capabilityRefId === "edit-tool",
    );

    expect(entry?.agentName).toBe("ClaudeEdit");
  });

  it("maps agentName from record-form agents for codex", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "codex",
      planMode: "off",
      selectedSkillIds: ["edit-tool"],
      catalog: [
        record({
          capabilityRefId: "edit-tool",
          kind: "skill",
          enforceability: "instructed",
          agents: { claude: "ClaudeEdit", codex: "CodexApplyPatch" },
        }),
      ],
    });

    const entry = profile.supported.find(
      (e) => e.capabilityRefId === "edit-tool",
    );

    expect(entry?.agentName).toBe("CodexApplyPatch");
  });

  it("sets agentName null for array-form agents", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedSkillIds: ["edit-tool"],
      catalog: [
        record({
          capabilityRefId: "edit-tool",
          kind: "skill",
          enforceability: "instructed",
          agents: ["claude", "codex"],
        }),
      ],
    });

    const entry = profile.supported.find(
      (e) => e.capabilityRefId === "edit-tool",
    );

    expect(entry?.agentName).toBeNull();
  });

  it("exposes the catalog revision on resolved entries", () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedSkillIds: ["with-rev", "no-rev"],
      catalog: [
        record({
          capabilityRefId: "with-rev",
          kind: "skill",
          enforceability: "instructed",
          revision: "sha-aaaaaaa",
        }),
        record({
          capabilityRefId: "no-rev",
          kind: "skill",
          enforceability: "instructed",
          revision: null,
        }),
      ],
    });

    const withRev = profile.supported.find(
      (e) => e.capabilityRefId === "with-rev",
    );
    const noRev = profile.supported.find((e) => e.capabilityRefId === "no-rev");

    expect(withRev?.revision).toBe("sha-aaaaaaa");
    expect(noRev?.revision).toBeNull();
  });

  it("produces a stable digest for identical inputs", () => {
    const catalog = [
      record({ capabilityRefId: "github" }),
      record({ capabilityRefId: "rule-a", kind: "rule" }),
    ];
    const args = {
      projectId: "project-1",
      executorAgent: "claude" as const,
      planMode: "off" as const,
      selectedRuleIds: ["rule-a"],
      catalog,
    };

    const first = resolveCapabilityProfile(args);
    const second = resolveCapabilityProfile(args);

    expect(first.profileDigest).toBe(second.profileDigest);
  });

  it("changes the digest when a selected capability's revision changes", () => {
    const resolveWithRevision = (revision: string) =>
      resolveCapabilityProfile({
        projectId: "project-1",
        executorAgent: "claude",
        planMode: "off",
        selectedSkillIds: ["edit-tool"],
        catalog: [
          record({
            capabilityRefId: "edit-tool",
            kind: "skill",
            enforceability: "instructed",
            revision,
          }),
        ],
      });

    const before = resolveWithRevision("sha-aaa");
    const after = resolveWithRevision("sha-bbb");

    expect(before.profileDigest).not.toBe(after.profileDigest);
  });
});

const LIVE_SECRET = "ghp_LIVE_SECRET_VALUE";

const githubMaterial = {
  command: "github-mcp",
  args: [],
  envKeys: ["GITHUB_TOKEN"],
  config: {},
};

function nativeCatalog() {
  return [
    record({
      capabilityRefId: "github",
      kind: "mcp",
      agents: ["claude", "codex"],
      enforceability: "enforced",
      material: githubMaterial,
    }),
    record({
      id: "row-aif-implement",
      capabilityRefId: "aif-implement",
      kind: "skill",
      agents: ["claude", "codex"],
      enforceability: "instructed",
      material: { dir: "skills/aif-implement", entry: "SKILL.md" },
    }),
  ];
}

function nativeClaudeProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "claude",
    planMode: "plan-first",
    selectedMcpIds: ["github"],
    selectedSkillIds: ["aif-implement"],
    catalog: nativeCatalog(),
  });
}

function nativeCodexProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "codex",
    planMode: "plan-first",
    selectedMcpIds: ["github"],
    selectedSkillIds: ["aif-implement"],
    catalog: nativeCatalog(),
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }

  return out;
}

describe("materializeCapabilityProfile", () => {
  it("writes a run-scoped profile and instruction file without secret values", async () => {
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "plan-first",
      catalog: [
        record({
          capabilityRefId: "github",
          material: { command: "github-mcp", envKeys: ["GITHUB_TOKEN"] },
        }),
      ],
    });

    const materialized = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile,
    });

    const profileJson = await readFile(materialized.profilePath, "utf8");
    const instructions = await readFile(materialized.instructionsPath, "utf8");

    expect(materialized.profilePath.startsWith(workDir)).toBe(true);
    expect(materialized.adapterLaunch.env).toMatchObject({
      MAISTER_CAPABILITY_PROFILE_PATH: materialized.profilePath,
    });
    expect(profileJson).toContain("GITHUB_TOKEN");
    expect(profileJson).not.toContain("secret");
    expect(instructions).toContain("mcp/github");
  });

  it("writes <worktree>/.claude/settings.local.json with the tools allow-list + defaultMode (req 1)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
      permissionMode: "deny",
    });

    const settingsLocalPath = path.join(
      path.resolve(workDir),
      ".claude",
      "settings.local.json",
    );

    expect(result.settingsLocalPath).toBe(settingsLocalPath);

    const settings = JSON.parse(await readFile(settingsLocalPath, "utf8"));

    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Edit"]),
    );
    expect(settings.permissions.defaultMode).toBe("plan");
  });

  it("carries the selected mcp defs on result.mcpServers with names + env keys only (req 2)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    const github = result.mcpServers.find((s) => s.name === "github");

    expect(github).toEqual({
      name: "github",
      command: "github-mcp",
      args: [],
      envKeys: ["GITHUB_TOKEN"],
    });
  });

  it("never writes the secret value to disk or onto mcpServers (req 3, R-SECRET)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    // Whole tree under the worktree (node-scoped dir + .claude/) carries only
    // env NAMES, never the secret value.
    const files = await listFilesRecursive(path.resolve(workDir));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf8");

      expect(content).not.toContain(LIVE_SECRET);
    }

    const serialized = JSON.stringify(result.mcpServers);

    expect(serialized).toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain(LIVE_SECRET);
    expect(result.adapterLaunch.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it("never writes a secret placed in an mcp config: block to disk (ISSUE 2)", async () => {
    const CONFIG_SECRET = "cfg_ghp_SECRET_value_xyz";
    const profile = resolveCapabilityProfile({
      projectId: "project-1",
      executorAgent: "claude",
      planMode: "off",
      selectedMcpIds: ["github"],
      catalog: [
        record({
          capabilityRefId: "github",
          kind: "mcp",
          material: {
            command: "github-mcp",
            args: [],
            envKeys: ["GITHUB_TOKEN"],
            config: { token: CONFIG_SECRET, nested: { auth: CONFIG_SECRET } },
          },
        }),
      ],
    });

    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile,
      tools: ["Read"],
    });

    const files = await listFilesRecursive(path.resolve(workDir));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await readFile(file, "utf8")).not.toContain(CONFIG_SECRET);
    }

    // The structural env-key NAME is still recorded (not the secret value).
    const profileJson = await readFile(result.profilePath, "utf8");

    expect(profileJson).toContain("GITHUB_TOKEN");
  });

  // R-SECRET / ITEM B: `materialized.adapterLaunch` is persisted VERBATIM into
  // scratch_capability_profiles.adapter_launch (scratch-runs/service.ts:736). The
  // materialize API takes NO `secrets` arg and agent-map emits no env, so
  // adapterLaunch.env can ONLY ever hold the two non-secret MAISTER_* paths —
  // nothing secret can reach that DB column. This pins that at the source.
  it("adapterLaunch.env (the value persisted to scratch_capability_profiles) carries only the MAISTER_* paths, never secret values (ITEM B regression guard)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read"],
    });

    expect(Object.keys(result.adapterLaunch.env ?? {})).toEqual([
      "MAISTER_CAPABILITY_PROFILE_PATH",
      "MAISTER_CAPABILITY_INSTRUCTIONS_PATH",
    ]);
    expect(result.adapterLaunch.preArgs).toBeUndefined();
    expect(result.adapterLaunch.postArgs).toBeUndefined();
    for (const value of Object.values(result.adapterLaunch.env ?? {})) {
      expect(value).not.toContain(LIVE_SECRET);
      expect(value).not.toMatch(/ghp_|sk-/);
    }
  });

  it("removes the provisioningBoundary stub from profile.json (req 4)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    const profileJson = await readFile(result.profilePath, "utf8");

    expect(profileJson).not.toContain("provisioningBoundary");
    expect(profileJson).not.toContain(
      "native adapter provisioning is future work",
    );
  });

  it("scopes the node-dir root to the node attempt when nodeAttemptId is given (req 5)", async () => {
    const scoped = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      nodeAttemptId: "node-att-1",
      tools: ["Read", "Edit"],
    });

    expect(scoped.rootPath.endsWith(path.join("run-1", "node-att-1"))).toBe(
      true,
    );

    const unscoped = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    expect(unscoped.rootPath.endsWith(path.join("capabilities", "run-1"))).toBe(
      true,
    );
  });

  it("keeps every materialized path inside the worktree, no preArgs (req 6)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeClaudeProfile(),
      nodeAttemptId: "node-att-1",
      tools: ["Read", "Edit"],
    });

    const root = path.resolve(workDir);

    expect(result.profilePath.startsWith(root)).toBe(true);
    expect(result.settingsLocalPath?.startsWith(root)).toBe(true);
    expect(result.materializedFiles).toEqual([result.settingsLocalPath]);
    for (const file of result.materializedFiles) {
      expect(file.startsWith(root)).toBe(true);
    }
    expect(result.adapterLaunch.preArgs).toBeUndefined();
  });

  it("writes no settings.local.json / mcp defs for codex and leaks no secret (req 7)", async () => {
    const result = await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: workDir,
      profile: nativeCodexProfile(),
      tools: ["Read", "Edit"],
      permissionMode: "deny",
    });

    const files = await listFilesRecursive(path.resolve(workDir));
    const basenames = files.map((f) => path.basename(f));

    expect(basenames).not.toContain("settings.local.json");
    expect(basenames).toContain("profile.json");
    expect(basenames).toContain("instructions.md");
    expect(result.settingsLocalPath).toBeNull();
    expect(result.mcpServers).toEqual([]);
    expect(result.materializedFiles).toEqual([]);
    expect(result.adapterLaunch.preArgs).toBeUndefined();

    for (const file of files) {
      const content = await readFile(file, "utf8");

      expect(content).not.toContain(LIVE_SECRET);
    }
  });

  it("excludes the worktree settings files from git so they never register as untracked, idempotently", async () => {
    const root = path.resolve(workDir);

    execFileSync("git", ["init"], { cwd: root });

    // Seed a pre-existing settings.local.json so materialize also produces a
    // `.maister-bak` backup — both must be excluded.
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify({ preexisting: true }),
    );

    await materializeCapabilityProfile({
      runId: "run-1",
      worktreePath: root,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    const excludePath = path.join(root, ".git", "info", "exclude");
    const first = await readFile(excludePath, "utf8");

    expect(first).toContain(".claude/settings.local.json");
    expect(first).toContain("*.maister-bak");

    await materializeCapabilityProfile({
      runId: "run-2",
      worktreePath: root,
      profile: nativeClaudeProfile(),
      tools: ["Read", "Edit"],
    });

    const second = await readFile(excludePath, "utf8");

    expect(occurrences(second, ".claude/settings.local.json")).toBe(1);
    expect(occurrences(second, "*.maister-bak")).toBe(1);

    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: root },
    ).toString();

    expect(status).not.toContain("settings.local.json");
    expect(status).not.toContain(".maister-bak");
  });
});
