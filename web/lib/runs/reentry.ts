import type { NodeAttempt } from "@/lib/db/schema";
import type { FlowGraph } from "@/lib/flows/graph/compile";

import pino from "pino";

const log = pino({
  name: "run-reentry",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReentrySource = "manifest" | "takeover_transition";

export type ReentryResolution =
  | { ok: true; nodeId: string; source: ReentrySource }
  | { ok: false; reason: "no_reentry_declared" };

/**
 * ADR-160: resolve the node an operator's rework claim re-enters the graph at.
 *
 * The chain is ordered and reads SERVER STATE ONLY — an operator can never
 * choose the node:
 *   1. the compiled flow-level `reentry`;
 *   2. else the LAST executed `human` node whose `transitions.takeover` names a
 *      node present in the compiled graph;
 *   3. else refuse, and the caller turns that into a `PRECONDITION` naming the
 *      relaunch escape hatch.
 *
 * Step 2 is ledger-derived rather than cursor-derived because `runGraph` writes
 * `current_step_id: null` on reaching `Review` — by the time a claim is
 * possible there is no cursor left to anchor on.
 *
 * Pure and synchronous: the caller supplies the compiled graph and the ledger
 * rows, so this is unit-testable without Postgres.
 */
export function resolveReentryNode(
  graph: FlowGraph,
  ledger: readonly NodeAttempt[],
): ReentryResolution {
  if (graph.reentry !== null) {
    log.debug({ reentry: graph.reentry }, "[reentry] manifest declared");

    // compileManifest already refused an unknown id, so this is present.
    return { ok: true, nodeId: graph.reentry, source: "manifest" };
  }

  log.debug(
    { attempts: ledger.length },
    "[reentry] no manifest reentry — scanning ledger for the last executed human node",
  );

  // Newest first. getNodeAttemptsForRun orders by (started_at, attempt), so
  // reversing gives last-executed-first without re-sorting.
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const nodeId = ledger[i].nodeId;
    const node = graph.nodes.get(nodeId);

    if (node === undefined || node.nodeType !== "human") continue;

    const target = node.transitions.takeover;

    log.debug({ nodeId, target }, "[reentry] candidate human node");

    // A takeover target that compiled away (or was hand-edited out) DISABLES
    // the action rather than throwing — the compiled graph is the allow-list.
    if (target !== undefined && graph.nodes.has(target)) {
      log.info(
        { nodeId: target, source: "takeover_transition" },
        "[reentry] resolved",
      );

      return { ok: true, nodeId: target, source: "takeover_transition" };
    }
  }

  log.debug({}, "[reentry] chain exhausted — no re-entry declared");

  return { ok: false, reason: "no_reentry_declared" };
}
