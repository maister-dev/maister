import { describe, expect, it } from "vitest";

import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";

// M27/T-C8 (§7.1.8): the launch-frozen capability set picks the local-first
// winner per (kind, refId) and splits capabilities (non-mcp) from mcps.

describe("buildResolvedCapabilitySet (T-C8)", () => {
  it("carries flowRevisionId + flowOrigin through", () => {
    const snap = buildResolvedCapabilitySet({
      records: [],
      flowRevisionId: "rev-1",
      flowOrigin: "authored",
    });

    expect(snap.flowRevisionId).toBe("rev-1");
    expect(snap.flowOrigin).toBe("authored");
    expect(snap.capabilities).toEqual([]);
    expect(snap.mcps).toEqual([]);
  });

  it("splits mcp vs non-mcp and records sha + scope", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "platform",
          revision: "sha-mcp",
        },
        {
          capabilityRefId: "aif-plan",
          kind: "skill",
          source: "flow-package",
          revision: "sha-skill",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
    });

    expect(snap.mcps).toEqual([
      { refId: "github", sha: "sha-mcp", scope: "platform" },
    ]);
    expect(snap.capabilities).toEqual([
      {
        refId: "aif-plan",
        kind: "skill",
        sha: "sha-skill",
        scope: "flow-package",
      },
    ]);
  });

  it("picks exactly one winner per (kind, refId) by project > platform > flow-package", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "flow-package",
          revision: "fp",
        },
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "project",
          revision: "pj",
        },
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "platform",
          revision: "pf",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
    });

    expect(snap.mcps).toEqual([
      { refId: "github", sha: "pj", scope: "project" },
    ]);
  });

  it("does not collapse the same refId across different kinds", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        { capabilityRefId: "x", kind: "mcp", source: "project", revision: "a" },
        {
          capabilityRefId: "x",
          kind: "skill",
          source: "project",
          revision: "b",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
    });

    expect(snap.mcps).toHaveLength(1);
    expect(snap.capabilities).toHaveLength(1);
  });
});
