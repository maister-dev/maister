import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";

import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});

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
});
