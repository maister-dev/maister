// T8.1 (RED): pins the M12 migration of the bundled aif flow manifest.
//
// Loads the REAL plugins/aif/flow.yaml through the project's loader
// (loadFlowManifest, which parses + runs validateGraphManifest) and asserts the
// M12 declared-artifact contract. ALL assertions are FALSE against the current
// (un-migrated) manifest → RED. The failures are assertion-level: the manifest
// loads fine today (no declared artifacts, engine_min 1.1.0); the M12 fields
// are simply absent.

import type { FlowYamlV1, NodeDef } from "@/lib/config.schema";

import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";

const AIF_FLOW = resolve(__dirname, "../../../../plugins/aif/flow.yaml");

let manifest: FlowYamlV1;

// QUARANTINED (T1/T2 restructure removed the single plugins/aif/flow.yaml that
// this whole file targets; the M12/M15 artifact + calibration contract is
// re-expressed on the authored flows/<name>/flow.yaml in T7). The load is
// guarded so the suite collects (as skipped) instead of erroring at beforeAll.
// See .ai-factory/plans/feature-aif-flow-package.md (T4 inc3 note).
beforeAll(async () => {
  try {
    manifest = await loadFlowManifest(AIF_FLOW);
  } catch {
    manifest = { schemaVersion: 1, name: "missing", nodes: [] } as FlowYamlV1;
  }
});

function nodeById(id: string): NodeDef | undefined {
  return (manifest.nodes ?? []).find((n) => n.id === id);
}

// input.requires[] entries are `string | { artifact, kind }`; normalize to the
// artifact id either way so an assertion can accept whichever form the
// migration uses (prefer the {artifact, kind} object form).
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

describe.skip("aif flow.yaml — M12 declared-artifact migration", () => {
  // 1. Engine bump.
  it("declares compat.engine_min 1.2.0", () => {
    expect(manifest.compat?.engine_min).toBe("1.2.0");
  });

  // 2. The migrated manifest validates (no throw) AND carries declarations —
  // proving the engine bump and the artifact declarations are consistent.
  it("validates with no throw and carries declared output artifacts", () => {
    expect(manifest.nodes).toBeDefined();

    const anyProduces = (manifest.nodes ?? []).some(
      (n) => (n.output?.produces ?? []).length > 0,
    );

    expect(anyProduces).toBe(true);
  });

  // 3. plan produces plan-summary (human_note).
  it("plan produces { id: plan-summary, kind: human_note }", () => {
    const plan = producesById(nodeById("plan"), "plan-summary");

    expect(plan).toBeDefined();
    expect(plan?.kind).toBe("human_note");
  });

  // 4. implement requires plan-summary and produces impl-diff (diff)
  //    requiredFor [review, merge].
  it("implement requires plan-summary and produces impl-diff requiredFor review+merge", () => {
    const implement = nodeById("implement");

    expect(requiredArtifacts(implement)).toContain("plan-summary");

    const implDiff = producesById(implement, "impl-diff");

    expect(implDiff).toBeDefined();
    expect(implDiff?.kind).toBe("diff");
    expect(implDiff?.requiredFor).toContain("review");
    expect(implDiff?.requiredFor).toContain("merge");
  });

  // 5. checks produces lint-report (lint_report).
  it("checks produces { id: lint-report, kind: lint_report }", () => {
    const lint = producesById(nodeById("checks"), "lint-report");

    expect(lint).toBeDefined();
    expect(lint?.kind).toBe("lint_report");
  });

  // 6. judge requires impl-diff + lint-report and produces judge-verdict (ai_judgment).
  it("judge requires impl-diff + lint-report and produces judge-verdict", () => {
    const judge = nodeById("judge");
    const reqs = requiredArtifacts(judge);

    expect(reqs).toContain("impl-diff");
    expect(reqs).toContain("lint-report");

    const verdict = producesById(judge, "judge-verdict");

    expect(verdict).toBeDefined();
    expect(verdict?.kind).toBe("ai_judgment");
  });

  // 7. review requires judge-verdict and has a blocking artifact_required
  //    pre_finish gate on impl-diff (the review-refusal mechanism).
  it("review requires judge-verdict and has a blocking artifact_required pre_finish gate on impl-diff", () => {
    const review = nodeById("review");

    expect(requiredArtifacts(review)).toContain("judge-verdict");

    const gates = review?.pre_finish?.gates ?? [];
    const artifactGate = gates.find((g) => g.kind === "artifact_required");

    expect(artifactGate).toBeDefined();
    expect(artifactGate?.mode).toBe("blocking");
    expect(artifactGate?.inputArtifacts).toContain("impl-diff");
  });
});

// M15 (ADR-048): verdict calibration — flow-level default folds into the
// advisory ai_judgment gate on the review node at compile time.
describe.skip("aif flow.yaml — M15 verdict calibration", () => {
  it("declares flow-level verdict_calibration.confidence_min: 0.7", () => {
    expect(manifest.verdict_calibration?.confidence_min).toBe(0.7);
  });

  it("review node has an advisory ai_judgment gate (ai-quality-advisory)", () => {
    const review = (manifest.nodes ?? []).find((n) => n.id === "review");
    const gates = review?.pre_finish?.gates ?? [];
    const advisoryGate = gates.find((g) => g.id === "ai-quality-advisory");

    expect(advisoryGate).toBeDefined();
    expect(advisoryGate?.kind).toBe("ai_judgment");
    expect(advisoryGate?.mode).toBe("advisory");
  });

  it("after compile, the advisory ai_judgment gate has effective calibration.confidence_min === 0.7 (folded from flow default)", () => {
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
