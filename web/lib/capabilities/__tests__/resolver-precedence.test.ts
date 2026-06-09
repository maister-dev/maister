import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";

import { describe, expect, it } from "vitest";

import { resolveCapabilityProfile } from "@/lib/capabilities/resolver";

// M27/T-C7 (spec §9 7.2.2): uniform local-first precedence for EVERY capability
// kind — project > platform > flow-package, exactly ONE winner per (kind,refId),
// lower-precedence same-id records shadowed (no merge, no duplicate emitted).

function record(
  over: Partial<CapabilityCatalogRecord>,
): CapabilityCatalogRecord {
  return {
    id:
      over.id ??
      `row-${over.source ?? "platform"}-${over.capabilityRefId ?? "x"}`,
    projectId: over.projectId ?? "project-1",
    capabilityRefId: over.capabilityRefId ?? "ref",
    kind: over.kind ?? "mcp",
    label: over.label ?? over.capabilityRefId ?? "ref",
    source: over.source ?? "platform",
    version: over.version ?? null,
    revision: over.revision ?? null,
    agents: over.agents ?? ["claude", "codex"],
    enforceability: over.enforceability ?? "instructed",
    selectedByDefault: over.selectedByDefault ?? true,
    selectable: over.selectable ?? true,
    material: over.material ?? {},
  };
}

const KINDS = [
  { kind: "mcp", selectKey: "selectedMcpIds" },
  { kind: "skill", selectKey: "selectedSkillIds" },
  { kind: "rule", selectKey: "selectedRuleIds" },
  { kind: "agent_definition", selectKey: "selectedAgentDefinitionIds" },
  { kind: "restriction", selectKey: "selectedRestrictionIds" },
] as const;

function resolve(
  selectKey: string,
  catalog: CapabilityCatalogRecord[],
): ReturnType<typeof resolveCapabilityProfile> {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "claude",
    planMode: "off",
    [selectKey]: ["ref"],
    catalog,
  });
}

describe("resolveCapabilityProfile local-first precedence (T-C7)", () => {
  for (const { kind, selectKey } of KINDS) {
    it(`picks the project winner for kind=${kind} (project > platform > flow-package)`, () => {
      const profile = resolve(selectKey, [
        record({ kind, source: "flow-package", id: "fp" }),
        record({ kind, source: "platform", id: "pf" }),
        record({ kind, source: "project", id: "pj" }),
      ]);

      const hits = profile.supported.filter((e) => e.capabilityRefId === "ref");

      expect(hits).toHaveLength(1);
      expect(hits[0].source).toBe("project");
      expect(hits[0].id).toBe("pj");
    });

    it(`falls back to platform over flow-package for kind=${kind} when no project record`, () => {
      const profile = resolve(selectKey, [
        record({ kind, source: "flow-package", id: "fp" }),
        record({ kind, source: "platform", id: "pf" }),
      ]);

      const hits = profile.supported.filter((e) => e.capabilityRefId === "ref");

      expect(hits).toHaveLength(1);
      expect(hits[0].source).toBe("platform");
    });
  }

  it("uses the higher-precedence record's material when params differ (shadow, no merge)", () => {
    const profile = resolve("selectedMcpIds", [
      record({
        kind: "mcp",
        source: "platform",
        id: "pf",
        material: { command: "platform-cmd", envKeys: ["PLATFORM_KEY"] },
      }),
      record({
        kind: "mcp",
        source: "project",
        id: "pj",
        material: { command: "project-cmd", envKeys: ["PROJECT_KEY"] },
      }),
    ]);

    const hit = profile.supported.find((e) => e.capabilityRefId === "ref");

    expect(hit?.source).toBe("project");
    expect(hit?.material).toEqual({
      command: "project-cmd",
      envKeys: ["PROJECT_KEY"],
    });
  });

  it("emits no duplicate when the same id exists in all three scopes", () => {
    const profile = resolve("selectedMcpIds", [
      record({ kind: "mcp", source: "project", id: "a" }),
      record({ kind: "mcp", source: "platform", id: "b" }),
      record({ kind: "mcp", source: "flow-package", id: "c" }),
    ]);

    expect(profile.selectedMcpIds).toEqual(["ref"]);
    expect(
      profile.supported.filter((e) => e.capabilityRefId === "ref"),
    ).toHaveLength(1);
    expect(profile.enforced).toHaveLength(0); // instructed kind, none enforced
    expect(
      profile.instructed.filter((e) => e.capabilityRefId === "ref"),
    ).toHaveLength(1);
  });
});
