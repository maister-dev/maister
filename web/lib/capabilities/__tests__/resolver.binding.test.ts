import { describe, expect, it } from "vitest";

import {
  buildResolvedCapabilitySet,
  firstAgentUnsupportedRequiredMcp,
  type McpBindingInput,
} from "@/lib/capabilities/resolver";

// ADR-129 (W-B): a project_mcp_bindings row overrides SOURCE_PRECEDENCE for its
// ref. Enabled binding target wins; disabled binding makes the ref unresolvable;
// absent binding is unchanged (grandfather). The snapshot records provenance.

const mcp = (refId: string, source: string, revision: string | null) => ({
  capabilityRefId: refId,
  kind: "mcp",
  source,
  revision,
});

const binding = (
  refId: string,
  targetKind: McpBindingInput["targetKind"],
  targetId: string,
  enabled = true,
): McpBindingInput => ({ refId, targetKind, targetId, enabled });

describe("buildResolvedCapabilitySet — binding-aware (W-B)", () => {
  it("records provenance='precedence' when no binding applies", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        mcp("github", "project", "pj"),
        mcp("github", "platform", "pf"),
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
    });

    expect(snap.mcps).toEqual([
      {
        refId: "github",
        sha: "pj",
        scope: "project",
        provenance: "precedence",
      },
    ]);
  });

  it("an enabled binding target WINS over precedence and records boundTarget", () => {
    // Without the binding, project(pj) would win. The binding forces platform.
    const snap = buildResolvedCapabilitySet({
      records: [
        mcp("github", "project", "pj"),
        mcp("github", "platform", "pf"),
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
      mcpBindings: [binding("github", "platform", "srv-1")],
    });

    expect(snap.mcps).toEqual([
      {
        refId: "github",
        sha: "pf",
        scope: "platform",
        provenance: "binding",
        boundTarget: { kind: "platform", id: "srv-1" },
      },
    ]);
  });

  it("a disabled binding makes the ref UNRESOLVABLE (excluded from the executable set)", () => {
    const snap = buildResolvedCapabilitySet({
      records: [mcp("github", "platform", "pf")],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
      mcpBindings: [binding("github", "platform", "srv-1", false)],
    });

    expect(snap.mcps).toEqual([]);
  });

  it("a misconfigured binding (bound target's source absent) excludes the ref", () => {
    // Binding points at platform but only a project record exists.
    const snap = buildResolvedCapabilitySet({
      records: [mcp("github", "project", "pj")],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
      mcpBindings: [binding("github", "platform", "srv-1")],
    });

    expect(snap.mcps).toEqual([]);
  });

  it("package binding maps to the flow-package source", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        mcp("github", "flow-package", "fp"),
        mcp("github", "platform", "pf"),
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
      mcpBindings: [binding("github", "package", "cap-1")],
    });

    expect(snap.mcps).toEqual([
      {
        refId: "github",
        sha: "fp",
        scope: "flow-package",
        provenance: "binding",
        boundTarget: { kind: "package", id: "cap-1" },
      },
    ]);
  });

  it("leaves non-mcp capabilities untouched by mcpBindings", () => {
    const snap = buildResolvedCapabilitySet({
      records: [
        {
          capabilityRefId: "aif-plan",
          kind: "skill",
          source: "project",
          revision: "s",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
      mcpBindings: [binding("aif-plan", "platform", "srv-x")],
    });

    expect(snap.capabilities).toEqual([
      { refId: "aif-plan", kind: "skill", sha: "s", scope: "project" },
    ]);
    expect(snap.mcps).toEqual([]);
  });
});

describe("firstAgentUnsupportedRequiredMcp — binding-aware (W-B)", () => {
  const rec = (refId: string, source: string, agents: string[]) => ({
    capabilityRefId: refId,
    source,
    agents: agents as never,
  });

  it("uses the bound record's agents, not the precedence winner's", () => {
    // Precedence winner project(codex-only) would flag github for a claude run;
    // the binding redirects to platform(claude+codex) → supported → null.
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [
          rec("github", "project", ["codex"]),
          rec("github", "platform", ["claude", "codex"]),
        ],
        "claude",
        [binding("github", "platform", "srv-1")],
      ),
    ).toBeNull();
  });

  it("still flags an agent-unsupported bound record", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [
          rec("github", "project", ["claude"]),
          rec("github", "platform", ["codex"]),
        ],
        "claude",
        [binding("github", "platform", "srv-1")],
      ),
    ).toBe("github");
  });

  it("skips a disabled-bound required ref (unresolvable → owned by the CONFIG gate)", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [rec("github", "project", ["codex"])],
        "claude",
        [binding("github", "project", "cap-1", false)],
      ),
    ).toBeNull();
  });

  it("is unchanged when no bindings are passed (grandfather)", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [rec("github", "project", ["codex"])],
        "claude",
      ),
    ).toBe("github");
  });
});
