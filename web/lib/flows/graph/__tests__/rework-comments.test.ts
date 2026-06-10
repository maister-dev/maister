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
import { composeReworkPayload } from "@/lib/review-comments/serialize";

// Runtime guard for the rework-comment templating contract on the SHIPPED AIF
// flows (the gap behind C1/I1: aif-flows.test.ts is static-load only and never
// renders a rework-target prompt). Reproduces the exact runtime context the
// graph runner builds on a rework jump — a reworked gate attempt persists NO
// vars (markNodeReworked), so `steps.<gate>.vars` reduces to {}, while the
// reviewer's comments arrive as the TOP-LEVEL injected var the node declared
// via `commentsVar`. Every rework TARGET's prompt must read that top-level
// var, never `steps.<gate>.vars.*` (which strict templating throws on) — an
// unreferenced commentsVar means the composed review payload is silently
// never seen by the agent (Task 18 contract).
const here = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = resolve(here, "../../../../../plugins/aif/flows");
const ALL_FLOWS = ["bugfix", "dev", "evolve", "init", "roadmap"] as const;

type AifFlow = (typeof ALL_FLOWS)[number];

// An attempt row as reduceLedger sees it. A REWORKED gate attempt persists
// status/decision only, vars left empty (markNodeReworked) → steps.<gate>.vars
// reduces to {}. Upstream nodes (e.g. dev `intake`) keep their vars.
function nodeAttempt(
  nodeId: string,
  vars: Record<string, unknown>,
): NodeAttempt {
  return {
    nodeId,
    attempt: 1,
    vars,
    stdout: "",
    exitCode: null,
  } as unknown as NodeAttempt;
}

// Every shipped rework wiring: review gate → rework target → commentsVar. The
// inventory test below proves this matrix covers EVERY rework block in the
// five shipped flows — adding a rework to any flow forces a row here, and the
// render tests then force the target's prompt to consume the var.
// (aif-init and aif-roadmap gates are approve-only: commentsVar declared on
// finish.human, no rework block, hence no row — only the seeding test below
// applies to them.)
type ReworkWiring = {
  flow: AifFlow;
  gateNodeId: string;
  targetNodeId: string;
  commentsVar: string;
  // Attempts of nodes that ALWAYS precede the target (their vars stay live in
  // the ledger on both the initial visit and a rework jump).
  priorAttempts: () => NodeAttempt[];
};

const REWORK_WIRINGS: ReworkWiring[] = [
  {
    flow: "bugfix",
    gateNodeId: "review",
    targetNodeId: "fix",
    commentsVar: "review_comments",
    priorAttempts: () => [],
  },
  {
    flow: "dev",
    gateNodeId: "plan_review",
    targetNodeId: "plan",
    commentsVar: "plan_review_comments",
    priorAttempts: () => [
      nodeAttempt("intake", {
        tests: "vitest",
        logging: "verbose",
        docs: "yes",
      }),
    ],
  },
  {
    flow: "dev",
    gateNodeId: "review",
    targetNodeId: "fix",
    commentsVar: "review_comments",
    priorAttempts: () => [],
  },
  {
    flow: "evolve",
    gateNodeId: "review",
    targetNodeId: "evolve",
    commentsVar: "review_comments",
    priorAttempts: () => [],
  },
];

// commentsVars the runner seeds to "" once per run. collectDeclaredCommentsVars
// collects from BOTH rework.commentsVar and finish.human.commentsVar, so the
// approve-only gates of aif-init/aif-roadmap are seeded too — a prompt
// referencing their var stays renderable even though no rework ever injects it.
const EXPECTED_SEEDS: Record<AifFlow, Record<string, string>> = {
  bugfix: { review_comments: "" },
  dev: { plan_review_comments: "", review_comments: "" },
  evolve: { review_comments: "" },
  init: { review_comments: "" },
  roadmap: { review_comments: "" },
};

function aiNodePrompt(manifest: FlowYamlV1, nodeId: string): string {
  const node = (manifest.nodes ?? []).find((n) => n.id === nodeId);
  const prompt = (node as { action?: { prompt?: string } } | undefined)?.action
    ?.prompt;

  if (!prompt) throw new Error(`node "${nodeId}" has no ai_coding prompt`);

  return prompt;
}

async function loadManifest(flow: AifFlow): Promise<FlowYamlV1> {
  return loadFlowManifest(join(FLOWS_DIR, flow, "flow.yaml"));
}

// Render the rework TARGET's prompt exactly as the runner would: declared
// commentsVars seeded to "", overlaid by the per-rework injection (when
// `comments` is provided). When `comments` is undefined the render simulates
// the target's non-rework visit (initial entry, or a rework where the reviewer
// submitted nothing) — the case that crashes if a referenced commentsVar is
// not seeded.
async function renderTargetPrompt(
  wiring: ReworkWiring,
  comments?: string,
): Promise<string> {
  const manifest = await loadManifest(wiring.flow);
  const graph = compileManifest(manifest);
  const declaredCommentsVars = collectDeclaredCommentsVars(
    graph.nodes.values(),
  );
  const injected =
    comments !== undefined ? { [wiring.commentsVar]: comments } : undefined;
  const nodeAttempts =
    comments !== undefined
      ? [...wiring.priorAttempts(), nodeAttempt(wiring.gateNodeId, {})]
      : wiring.priorAttempts();

  const context = buildContext({
    task: {
      id: "t1",
      title: "Task",
      prompt: "ORIGINAL-TASK",
      attemptNumber: 1,
    },
    run: { id: "r1" },
    executor: { id: "e1", agent: "claude", model: "m" },
    stepRuns: [],
    nodeAttempts,
    projectSlug: "test",
    extraVars: { ...declaredCommentsVars, ...(injected ?? {}) },
  });

  return renderStrict(aiNodePrompt(manifest, wiring.targetNodeId), context);
}

describe("AIF shipped flows — rework comment templating (C1/I1 runtime regression)", () => {
  it("the wiring matrix covers every rework block shipped in the aif flows", async () => {
    const discovered: string[] = [];

    for (const flow of ALL_FLOWS) {
      const graph = compileManifest(await loadManifest(flow));

      for (const node of graph.nodes.values()) {
        if (!node.rework) continue;
        const commentsVar =
          node.rework.commentsVar ?? node.finishHuman?.commentsVar ?? "";

        for (const target of node.rework.allowedTargets) {
          discovered.push(`${flow}/${node.id}->${target}:${commentsVar}`);
        }
      }
    }

    const expected = REWORK_WIRINGS.map(
      (w) => `${w.flow}/${w.gateNodeId}->${w.targetNodeId}:${w.commentsVar}`,
    );

    expect(discovered.sort()).toEqual(expected.sort());
  });

  it.each(ALL_FLOWS)(
    "%s: every declared commentsVar (rework AND finish.human) is runner-seeded",
    async (flow) => {
      const graph = compileManifest(await loadManifest(flow));

      expect(collectDeclaredCommentsVars(graph.nodes.values())).toEqual(
        EXPECTED_SEEDS[flow],
      );
    },
  );

  it.each(REWORK_WIRINGS)(
    "$flow: $targetNodeId prompt consumes the top-level $commentsVar var, never the reworked gate's steps entry",
    async (wiring) => {
      const manifest = await loadManifest(wiring.flow);
      const prompt = aiNodePrompt(manifest, wiring.targetNodeId);

      expect(prompt).toMatch(
        new RegExp(`\\{\\{\\s*${wiring.commentsVar}\\s*\\}\\}`),
      );
      expect(prompt).not.toMatch(new RegExp(`steps\\.${wiring.gateNodeId}\\.`));
    },
  );

  it.each(REWORK_WIRINGS)(
    "$flow: $targetNodeId prompt renders with the seeded empty var on a non-rework visit",
    async (wiring) => {
      const out = await renderTargetPrompt(wiring);

      expect(out).toBeTypeOf("string");
      expect(out).toContain("/aif-");
      expect(out).not.toContain("{{");
    },
  );

  it.each(REWORK_WIRINGS)(
    "$flow: $targetNodeId prompt renders the reviewer comments on a rework jump",
    async (wiring) => {
      const marker = `REWORK-MARKER-${wiring.flow}-${wiring.targetNodeId}`;
      const out = await renderTargetPrompt(wiring, marker);

      expect(out).toContain(marker);
    },
  );

  it.each(REWORK_WIRINGS)(
    "$flow: $targetNodeId prompt renders an ADR-072 composed-threads payload intact (anchors, quotes, replies)",
    async (wiring) => {
      // The runner injects composeReworkPayload output on a rework jump;
      // the frozen markdown (### anchors, > quotes, ** bold) must survive the
      // strict Mustache render of the REAL flow prompt unescaped.
      const composed = composeReworkPayload("SUMMARY-NOTE", [
        {
          root: {
            id: "c1",
            filePath: "lib/auth.ts",
            side: "new",
            line: 7,
            lineContent: "const token = req.headers.authorization;",
            authorLabel: "Reviewer",
            body: "VALIDATE-THE-HEADER",
            createdAt: new Date("2026-06-10T10:00:00Z"),
          },
          replies: [
            {
              id: "c2",
              authorLabel: "Author",
              body: "WILL-DO",
              createdAt: new Date("2026-06-10T10:05:00Z"),
            },
          ],
        },
      ]);
      const out = await renderTargetPrompt(wiring, composed);

      expect(out).toContain("SUMMARY-NOTE");
      expect(out).toContain("### lib/auth.ts:7 (new)");
      expect(out).toContain("> const token = req.headers.authorization;");
      expect(out).toContain("**Reviewer:**");
      expect(out).toContain("VALIDATE-THE-HEADER");
      expect(out).toContain("**Reply — Author:**");
      expect(out).toContain("WILL-DO");
    },
  );
});
