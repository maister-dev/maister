import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import type { FlowYamlV1 } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { planReviewCaptureTargetForProducer } from "@/lib/flows/graph/runner-graph";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "plan-review-manifest-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function manifest(engineMin = "3.1.0"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "typed-plan-review",
    compat: { engine_min: engineMin },
    nodes: [
      {
        id: "plan",
        type: "ai_coding",
        action: { prompt: "Produce a plan and strict review JSON." },
        output: {
          produces: [
            {
              id: "plan-document",
              kind: "plan",
              path: "plan.md",
              current: true,
            },
            {
              id: "plan-review",
              kind: "plan",
              path: "plan-review.json",
              current: true,
            },
          ],
        },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: {
          human: {
            decisions: ["approve", "rework"],
            commentsVar: "plan_review_comments",
          },
        },
        transitions: { approve: "implement", rework: "plan" },
        rework: {
          allowedTargets: ["plan"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
          commentsVar: "plan_review_comments",
        },
        settings: {
          plan_review: {
            plan_document_artifact: "plan-document",
            plan_review_artifact: "plan-review",
            comments_var: "plan_review_comments",
            answers_var: "plan_review_answers",
            rework_transition: "rework",
            max_decision_reworks: 2,
          },
        },
      },
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "Implement the approved plan." },
        transitions: { success: "done" },
      },
    ],
  };
}

async function load(value: Record<string, unknown>): Promise<unknown> {
  const path = join(workDir, "flow.yaml");

  await writeFile(path, stringifyYaml(value), "utf8");

  return loadFlowManifest(path);
}

async function expectConfigRefusal(
  value: Record<string, unknown>,
): Promise<void> {
  try {
    await load(value);
  } catch (error) {
    expect(isMaisterError(error)).toBe(true);
    expect(isMaisterError(error) && error.code).toBe("CONFIG");

    return;
  }

  throw new Error("Expected the Plan-review manifest to be refused");
}

describe("Plan-review manifest contract", () => {
  it("accepts a human node with the declared artifacts and bounded rework", async () => {
    await expect(load(manifest())).resolves.toBeDefined();
  });

  it("requires engine 3.1.0 and exactly approve/rework parent outcomes", async () => {
    await expectConfigRefusal(manifest("3.0.0"));

    const invalidOutcomes = manifest();
    const nodes = invalidOutcomes.nodes as Array<Record<string, unknown>>;

    (
      nodes[1].finish as { human: { decisions: string[] } }
    ).human.decisions.push("takeover");
    await expectConfigRefusal(invalidOutcomes);
  });

  it("captures Plan-review artifacts from the direct producer, not the rework target", async () => {
    const value = manifest();
    const nodes = value.nodes as Array<Record<string, unknown>>;
    const plan = nodes[0];

    delete plan.output;
    plan.transitions = { success: "improve" };
    nodes.splice(1, 0, {
      id: "improve",
      type: "ai_coding",
      action: { prompt: "Write the immutable plan artifacts." },
      output: {
        produces: [
          { id: "plan-document", kind: "plan", path: "plan.md", current: true },
          {
            id: "plan-review",
            kind: "plan",
            path: "plan-review.json",
            current: true,
          },
        ],
      },
      transitions: { success: "review" },
    });

    const graph = compileManifest((await load(value)) as FlowYamlV1);

    expect(planReviewCaptureTargetForProducer(graph, "plan")).toBeUndefined();
    expect(planReviewCaptureTargetForProducer(graph, "improve")).toMatchObject({
      reviewNode: { id: "review" },
    });
  });

  it("refuses manual takeover and a rework transition that is not declared", async () => {
    const takeover = manifest();
    const takeoverNode = (takeover.nodes as Array<Record<string, unknown>>)[1];

    takeoverNode.settings = {
      ...(takeoverNode.settings as Record<string, unknown>),
      allowTakeover: true,
    };
    await expectConfigRefusal(takeover);

    const missingRework = manifest();
    const reworkNode = (
      missingRework.nodes as Array<Record<string, unknown>>
    )[1];

    (
      reworkNode.settings as { plan_review: { rework_transition: string } }
    ).plan_review.rework_transition = "missing";
    await expectConfigRefusal(missingRework);
  });
});
