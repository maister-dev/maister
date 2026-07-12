import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { flowManifestMcpRequirements } from "@/lib/flows/mcp-requirements";

// ADR-129 (W-A): the flow-manifest MCP-requirement extractor feeds the project
// requirements ledger. It must agree with the launch-time derivation: top-level
// `mcps` are required (package-level), node `settings.mcps` contribute
// required/additional, and a ref required anywhere is never also "additional".

describe("flowManifestMcpRequirements", () => {
  it("collects top-level + node required/additional and dedups required over additional", () => {
    const manifest = {
      schemaVersion: 1,
      name: "bugfix",
      // package-level required MCP refs.
      mcps: ["pkg-required"],
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/aif-implement" },
          transitions: { success: "review" },
          settings: {
            mcps: { required: ["github"], additional: ["filesystem"] },
          },
        },
        {
          id: "review",
          type: "ai_coding",
          action: { prompt: "/aif-review" },
          transitions: { success: "done" },
          // Array form ⇒ additional; "github" also appears here but is required
          // by `implement`, so it must not be double-listed as additional.
          settings: { mcps: ["search", "github"] },
        },
      ],
    } as unknown as FlowYamlV1;

    const { required, additional } = flowManifestMcpRequirements(manifest);

    expect([...required].sort()).toEqual(["github", "pkg-required"]);
    expect([...additional].sort()).toEqual(["filesystem", "search"]);
  });

  it("returns empty sets for a flow that declares no MCP refs", () => {
    const manifest = {
      schemaVersion: 1,
      name: "noop",
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/go" },
          transitions: { success: "done" },
        },
      ],
    } as unknown as FlowYamlV1;

    expect(flowManifestMcpRequirements(manifest)).toEqual({
      required: [],
      additional: [],
    });
  });
});
