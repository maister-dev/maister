import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttempt } from "@/lib/db/schema";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";
import { buildContext } from "@/lib/flows/context";
import { compileManifest } from "@/lib/flows/graph/compile";
import { collectDeclaredCommentsVars } from "@/lib/flows/graph/runner-graph";
import { renderStrict } from "@/lib/flows/templating";

// Runtime guard for the rework-comment templating contract on the SHIPPED AIF
// flows (the gap behind C1/I1: aif-flows.test.ts is static-load only and never
// renders a rework-target prompt). Reproduces the exact runtime context the
// graph runner builds on a rework jump — a reworked `review` attempt persists NO
// vars (markNodeReworked), so `steps.review.vars` reduces to {}, while the
// reviewer's comments arrive as the TOP-LEVEL injected var the node declared via
// `commentsVar`. A `fix` prompt must read that top-level var, never
// `steps.review.vars.*` (which strict templating throws on).
const here = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = resolve(here, "../../../../../plugins/aif/flows");

function aiNodePrompt(manifest: FlowYamlV1, nodeId: string): string {
  const node = (manifest.nodes ?? []).find((n) => n.id === nodeId);
  const prompt = (node as { action?: { prompt?: string } } | undefined)?.action
    ?.prompt;

  if (!prompt) throw new Error(`node "${nodeId}" has no ai_coding prompt`);

  return prompt;
}

// A reworked `review` attempt as persisted by markNodeReworked: status/decision
// only, vars left empty → reduceLedger yields steps.review.vars = {}.
function reworkedReviewAttempt(): NodeAttempt {
  return {
    nodeId: "review",
    attempt: 1,
    vars: {},
    stdout: "",
    exitCode: null,
  } as unknown as NodeAttempt;
}

// Render the `fix` node's prompt exactly as the runner would: declared
// commentsVars seeded to "", overlaid by the per-rework injection (when
// `comments` is provided). When `comments` is undefined the render simulates the
// node's initial (non-rework) visit — the case that crashes if a referenced
// commentsVar is not seeded.
async function renderFixPrompt(
  flow: "dev" | "bugfix",
  comments?: string,
): Promise<string> {
  const manifest = await loadFlowManifest(join(FLOWS_DIR, flow, "flow.yaml"));
  const graph = compileManifest(manifest);
  const declaredCommentsVars = collectDeclaredCommentsVars(graph.nodes.values());
  const injected =
    comments !== undefined ? { review_comments: comments } : undefined;

  const context = buildContext({
    task: { id: "t1", title: "Task", prompt: "ORIGINAL-TASK", attemptNumber: 1 },
    run: { id: "r1" },
    executor: { id: "e1", agent: "claude", model: "m" },
    stepRuns: [],
    nodeAttempts: comments !== undefined ? [reworkedReviewAttempt()] : [],
    projectSlug: "test",
    extraVars: { ...declaredCommentsVars, ...(injected ?? {}) },
  });

  return renderStrict(aiNodePrompt(manifest, "fix"), context);
}

describe("AIF shipped flows — rework comment templating (C1/I1 runtime regression)", () => {
  it("aif-dev: fix prompt renders the reviewer comments on a rework jump", async () => {
    const out = await renderFixPrompt("dev", "TIGHTEN-ERROR-HANDLING");

    expect(out).toContain("TIGHTEN-ERROR-HANDLING");
  });

  it("aif-bugfix: fix prompt renders the reviewer comments on a rework jump", async () => {
    const out = await renderFixPrompt("bugfix", "ADD-NULL-CHECK");

    expect(out).toContain("ADD-NULL-CHECK");
  });

  it("aif-bugfix: fix prompt renders on the initial (non-rework) entry without throwing", async () => {
    // aif-bugfix `fix` is BOTH the entry node and the rework target, so it runs
    // first with no injected comments — the seeded commentsVar must keep it
    // renderable.
    await expect(renderFixPrompt("bugfix")).resolves.toBeTypeOf("string");
  });

  it.each(["dev", "bugfix"] as const)(
    "%s: fix prompt uses the top-level review_comments var, not steps.review.vars.*",
    async (flow) => {
      const manifest = await loadFlowManifest(
        join(FLOWS_DIR, flow, "flow.yaml"),
      );
      const prompt = aiNodePrompt(manifest, "fix");

      expect(prompt).toContain("review_comments");
      expect(prompt).not.toMatch(/steps\.\w+\.vars\./);
    },
  );
});
