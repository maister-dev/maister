import type { LocalPackage } from "@/lib/db/schema";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-packages/service", () => ({
  readWorkingDirArtifactFiles: async () => [],
}));

vi.mock("@/lib/local-packages/validate", () => ({
  validatePackageArtifacts: () => [],
}));

vi.mock("@/lib/queries/authored-flow-graph", () => ({
  buildAuthoredFlowGraph: () => ({ topology: { nodes: [], edges: [] } }),
}));

vi.mock("../actions", () => ({
  packageFileHash: () => "sha256:test",
}));

import { buildFlowDslGrammar } from "@/lib/flows/flow-dsl-grammar";
import { buildFlowAssistantContext } from "@/lib/studio/flow-assistant/context";

const localPackage = {
  id: "lp-1",
  name: "Test Package",
  slug: "test-package",
} as unknown as LocalPackage;

describe("buildFlowAssistantContext", () => {
  it("injects the authoritative Flow DSL grammar on every turn", async () => {
    const ctx = await buildFlowAssistantContext({
      localPackage,
      intent: "auto",
    });

    expect(ctx.prompt).toContain(buildFlowDslGrammar());
    expect(ctx.prompt).toContain("type: consensus");
    expect(ctx.prompt).toContain("authoritative Flow DSL grammar section");
  });
});
