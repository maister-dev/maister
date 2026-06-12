// T7: pins the M12 declared-artifact + M15 verdict-calibration contract of the
// bundled aif-dev flow. Loads the aif-dev fixture (web/test-fixtures/aif-flows) through
// the project's loader (loadFlowManifest → validateGraphManifest) and asserts the
// shipped graph carries typed artifacts (impl-diff requiredFor review+merge,
// a blocking artifact_required review gate) and the folded advisory calibration.

import type { FlowYamlV1, NodeDef } from "@/lib/config.schema";

import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";

const AIF_FLOW = resolve(
  __dirname,
  "../../../test-fixtures/aif-flows/dev/flow.yaml",
);

let manifest: FlowYamlV1;

beforeAll(async () => {
  manifest = await loadFlowManifest(AIF_FLOW);
});

function nodeById(id: string): NodeDef | undefined {
  return (manifest.nodes ?? []).find((n) => n.id === id);
}

// input.requires[] entries are `string | { artifact, kind }`; normalize to the
// artifact id either way.
function requiresArtifactId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "artifact" in entry) {
    return (entry as { artifact: string }).artifact;
  }

  return undefined;
}

function requiredArtifacts(node: NodeDef | undefined): string[] {
  const requires = (node?.input?.requires ?? []) as unknown[];

  return requires
    .map(requiresArtifactId)
    .filter((v): v is string => v !== undefined);
}

function producesById(node: NodeDef | undefined, id: string) {
  return (node?.output?.produces ?? []).find((p) => p.id === id);
}

describe("aif-dev flow.yaml — M12 declared-artifact contract", () => {
  it("declares compat.engine_min 1.2.0 (typed artifacts)", () => {
    expect(manifest.compat?.engine_min).toBe("1.2.0");
  });

  it("implement produces impl-diff (diff) requiredFor review+merge", () => {
    const implDiff = producesById(nodeById("implement"), "impl-diff");

    expect(implDiff).toBeDefined();
    expect(implDiff?.kind).toBe("diff");
    expect(implDiff?.requiredFor).toContain("review");
    expect(implDiff?.requiredFor).toContain("merge");
  });

  it("checks requires impl-diff and produces aif-gate-result (test_report)", () => {
    const checks = nodeById("checks");

    expect(requiredArtifacts(checks)).toContain("impl-diff");

    const gate = producesById(checks, "aif-gate-result");

    expect(gate).toBeDefined();
    expect(gate?.kind).toBe("test_report");
  });

  it("code_review requires impl-diff and produces ai-judgment (ai_judgment)", () => {
    const codeReview = nodeById("code_review");

    expect(requiredArtifacts(codeReview)).toContain("impl-diff");

    const verdict = producesById(codeReview, "ai-judgment");

    expect(verdict).toBeDefined();
    expect(verdict?.kind).toBe("ai_judgment");
  });

  it("review requires ai-judgment and has a blocking artifact_required gate on impl-diff", () => {
    const review = nodeById("review");

    expect(requiredArtifacts(review)).toContain("ai-judgment");

    const gates = review?.pre_finish?.gates ?? [];
    const artifactGate = gates.find((g) => g.kind === "artifact_required");

    expect(artifactGate).toBeDefined();
    expect(artifactGate?.mode).toBe("blocking");
    expect(artifactGate?.inputArtifacts).toContain("impl-diff");
  });
});

describe("aif-dev flow.yaml — M15 verdict calibration", () => {
  it("declares flow-level verdict_calibration.confidence_min 0.7", () => {
    expect(manifest.verdict_calibration?.confidence_min).toBe(0.7);
  });

  it("review node has an advisory ai_judgment gate (ai-quality-advisory)", () => {
    const review = nodeById("review");
    const gates = review?.pre_finish?.gates ?? [];
    const advisoryGate = gates.find((g) => g.id === "ai-quality-advisory");

    expect(advisoryGate).toBeDefined();
    expect(advisoryGate?.kind).toBe("ai_judgment");
    expect(advisoryGate?.mode).toBe("advisory");
  });

  it("after compile, the advisory ai_judgment gate inherits calibration.confidence_min 0.7", () => {
    const compiled = compileManifest(manifest);
    const reviewNode = compiled.nodes.get("review");

    expect(reviewNode).toBeDefined();

    const advisoryGate = (reviewNode?.gates ?? []).find(
      (g) => g.id === "ai-quality-advisory",
    );

    expect(advisoryGate).toBeDefined();
    expect(
      (advisoryGate as { calibration?: { confidence_min?: number } })
        .calibration?.confidence_min,
    ).toBe(0.7);
  });
});
