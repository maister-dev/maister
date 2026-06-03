import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";

import { describe, expect, it } from "vitest";

import { mapProfileToAgentArtifacts } from "@/lib/capabilities/agent-map";
import { resolveCapabilityProfile } from "@/lib/capabilities/resolver";

const SECRET_VALUE = "ghp_LIVE_SECRET_VALUE";

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

const githubRecord = record({
  capabilityRefId: "github",
  kind: "mcp",
  agents: ["claude", "codex"],
  enforceability: "enforced",
  material: {
    command: "github-mcp",
    args: [],
    envKeys: ["GITHUB_TOKEN"],
    config: {},
  },
});

const skillRecord = record({
  id: "row-aif-implement",
  capabilityRefId: "aif-implement",
  kind: "skill",
  agents: ["claude", "codex"],
  enforceability: "instructed",
  material: { dir: "skills/aif-implement", entry: "SKILL.md" },
});

// instructed so the resolver downgrades (does NOT throw) when the executor
// does not support it — under claude it lands in `unsupported`, never
// `supported`, so the agent-map omits it. Exercises "unknown -> omitted".
const codexOnlyRecord = record({
  id: "row-codex-only",
  capabilityRefId: "codex-only",
  kind: "mcp",
  agents: ["codex"],
  enforceability: "instructed",
  material: { command: "codex-only-mcp", args: [], envKeys: [], config: {} },
});

function claudeProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "claude",
    planMode: "off",
    selectedMcpIds: ["github", "codex-only"],
    selectedSkillIds: ["aif-implement"],
    catalog: [githubRecord, skillRecord, codexOnlyRecord],
  });
}

function codexProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "codex",
    planMode: "off",
    selectedMcpIds: ["github"],
    selectedSkillIds: ["aif-implement"],
    catalog: [githubRecord, skillRecord],
  });
}

function skillOnlyClaudeProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "claude",
    planMode: "off",
    selectedMcpIds: [],
    selectedSkillIds: ["aif-implement"],
    catalog: [skillRecord],
  });
}

describe("mapProfileToAgentArtifacts", () => {
  it("settingsLocal.permissions.allow equals the tools allow-list (assertion 1)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      tools: ["Read", "Edit", "Bash"],
    });

    expect(result.settingsLocal).not.toBeNull();
    expect([...result.settingsLocal!.permissions.allow!].sort()).toEqual([
      "Bash",
      "Edit",
      "Read",
    ]);
  });

  it("settingsLocal is null when neither tools nor permissionMode are present (assertion 1 negative)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
    });

    expect(result.settingsLocal).toBeNull();
  });

  it("maps permissionMode deny->plan, allow->bypassPermissions, ask->default; omits defaultMode when unset (assertion 2)", () => {
    const deny = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      permissionMode: "deny",
    });

    expect(deny.settingsLocal).not.toBeNull();
    expect(deny.settingsLocal!.permissions.defaultMode).toBe("plan");

    const allow = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      permissionMode: "allow",
    });

    expect(allow.settingsLocal!.permissions.defaultMode).toBe(
      "bypassPermissions",
    );

    const ask = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      permissionMode: "ask",
    });

    expect(ask.settingsLocal!.permissions.defaultMode).toBe("default");

    const none = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      tools: ["Read"],
    });

    expect(none.settingsLocal).not.toBeNull();
    expect(none.settingsLocal!.permissions.defaultMode).toBeUndefined();
  });

  it("emits mcpServers from supported mcp entries with envKeys names only, no secret value (assertion 3, R-SECRET)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
    });

    const github = result.mcpServers.find((s) => s.name === "github");

    expect(github).toEqual({
      name: "github",
      command: "github-mcp",
      args: [],
      envKeys: ["GITHUB_TOKEN"],
    });

    const serialized = JSON.stringify(result.mcpServers);

    expect(serialized).toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("value");
  });

  it("omits mcpServers when no supported mcp entry exists (assertion 3 negative)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: skillOnlyClaudeProfile(),
      agent: "claude",
    });

    expect(result.mcpServers).toEqual([]);
  });

  it("lists selected skills as {refId, material} and omits non-skill refs (assertion 4)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
    });

    const aif = result.skills.find((s) => s.refId === "aif-implement");

    expect(aif).toBeDefined();
    expect(aif!.material).toEqual(skillRecord.material);
    expect(result.skills.map((s) => s.refId)).not.toContain("github");
    expect(result.skills.map((s) => s.refId)).not.toContain("codex-only");
  });

  it("omits capabilities the agent does not support from settingsLocal/mcpServers/skills (assertion 5)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      tools: ["Read"],
      permissionMode: "deny",
    });

    expect(result.mcpServers.map((s) => s.name)).not.toContain("codex-only");
    expect(result.skills.map((s) => s.refId)).not.toContain("codex-only");

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("codex-only-mcp");
    expect(serialized).not.toContain("codex-only");
  });

  it("carries no legacy files/flags/env keys on the result (assertion 6)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: claudeProfile(),
      agent: "claude",
      tools: ["Read"],
      permissionMode: "ask",
    });

    expect("files" in result).toBe(false);
    expect("flags" in result).toBe(false);
    expect("env" in result).toBe(false);
  });

  it("produces instructed-only empty materialization for codex (assertion 7)", () => {
    const result = mapProfileToAgentArtifacts({
      profile: codexProfile(),
      agent: "codex",
      tools: ["Read"],
      permissionMode: "deny",
    });

    expect(result.settingsLocal).toBeNull();
    expect(result.mcpServers).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});
