import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { FlowGraph } from "@/lib/flows/graph/compile";

import { eq } from "drizzle-orm";

import { flows, flowRevisions } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { compileManifest, resolveTransition } from "@/lib/flows/graph/compile";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";

/** Every successful route must encounter a primary AI action before termination. */
export function assertScheduledRequestConsumer(graph: FlowGraph): void {
  const visited = new Set<string>();
  const pending = [graph.entry];
  let consumer = false;

  while (pending.length) {
    const id = pending.pop()!;

    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes.get(id);

    if (!node)
      throw new MaisterError(
        "CONFIG",
        "Scheduled request has an unknown Flow input route",
      );
    if (["ai_coding", "judge", "orchestrator"].includes(node.nodeType)) {
      consumer = true;
      continue;
    }
    // Missing structured output is a successful implicit terminal in decide-eval.
    if (node.decide && node.decide.from !== "verdict") {
      throw new MaisterError(
        "CONFIG",
        "Scheduled request can finish before an AI action consumes it",
      );
    }
    const outcomes = node.decide
      ? (node.decide.cases ?? []).map((entry) => entry.target)
      : node.nodeType === "human" || node.nodeType === "form"
        ? Object.keys(node.transitions)
        : [
            "success",
            ...Object.keys(node.transitions).filter(
              (key) =>
                !["failure", "error", "cancelled", "crashed"].includes(key),
            ),
          ];

    if (
      !outcomes.length ||
      outcomes.some((outcome) => resolveTransition(node, outcome) === null)
    ) {
      throw new MaisterError(
        "CONFIG",
        "Scheduled request can finish before an AI action consumes it",
      );
    }
    for (const outcome of outcomes)
      pending.push(resolveTransition(node, outcome)!);
  }
  if (!consumer)
    throw new MaisterError(
      "CONFIG",
      "Scheduled request requires a reachable primary AI action",
    );
}

/** Resolve once before auto-task creation; the launcher must execute this revision. */
export async function resolveScheduledRequestFlowRevision(
  db: Db,
  flow: typeof flows.$inferSelect,
): Promise<string> {
  const revisionId = await resolveEffectiveFlowRevision(db, flow);
  const [revision] = revisionId
    ? await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, revisionId))
    : [];

  assertFlowLaunchable(flow.flowRefId, flow, revision ?? null);
  const manifest = parseExecutableStoredFlowManifest(revision!.manifest, {
    code: "CONFIG",
    surface: "scheduled-agent-request",
    manifestLabel: `flow revision ${revision!.id}`,
    flowRefId: flow.flowRefId,
    revision: revision!.resolvedRevision,
  });

  assertScheduledRequestConsumer(compileManifest(manifest));

  return revision!.id;
}
