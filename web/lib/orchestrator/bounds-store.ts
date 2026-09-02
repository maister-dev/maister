import "server-only";

import type {
  DelegationBounds,
  DelegationInstanceCeilings,
} from "@/lib/run-results/types";

import { eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import {
  orchestratorMaxDepth,
  orchestratorMaxFanout,
} from "@/lib/instance-config";
import {
  computeEffectiveDelegationBounds,
  type ComputeBoundsArgs,
} from "@/lib/orchestrator/bounds";
import {
  maxConcurrentAgentRunsCap,
  maxConcurrentRunsCap,
} from "@/lib/scheduler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "delegation-bounds",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (D6): the SNAPSHOT side of the effective bounds. The computation is
// pure (`bounds.ts`); this module reads the instance ceilings and persists the
// result. Split so the formula stays table-testable without `server-only`.

/** The instance ceilings as configured right now. */
export function currentInstanceCeilings(): DelegationInstanceCeilings {
  return {
    maxDepth: orchestratorMaxDepth(),
    maxFanout: orchestratorMaxFanout(),
    flowPool: maxConcurrentRunsCap(),
    agentPool: maxConcurrentAgentRunsCap(),
  };
}

/**
 * Compute and persist `runs.delegation_bounds` for an orchestrator node start.
 *
 * Keyed by `nodeAttemptId`: this runs on every node start AND every wake, and a
 * wake on the SAME attempt must not rewrite — the snapshot is what makes an
 * env edit unable to change a tree already in flight. A second orchestrator
 * node (a new attempt) legitimately rewrites.
 *
 * Returns the effective bounds, whether or not a write happened.
 */
export async function writeDelegationBoundsIfChanged(
  db: Db,
  runId: string,
  args: ComputeBoundsArgs,
): Promise<DelegationBounds> {
  const next = computeEffectiveDelegationBounds(args);
  const existingRows = (await db
    .select({ delegationBounds: runs.delegationBounds })
    .from(runs)
    .where(eq(runs.id, runId))) as {
    delegationBounds: DelegationBounds | null;
  }[];
  const existing = existingRows[0]?.delegationBounds ?? null;

  if (existing && existing.nodeAttemptId === args.nodeAttemptId) {
    log.debug(
      { runId, nodeId: args.nodeId, nodeAttemptId: args.nodeAttemptId },
      "[delegation.bounds] snapshot retained for the same node attempt",
    );

    return existing;
  }

  await db
    .update(runs)
    .set({ delegationBounds: next })
    .where(eq(runs.id, runId));

  log.info(
    {
      runId,
      nodeId: next.nodeId,
      nodeAttemptId: next.nodeAttemptId,
      source: next.source,
      maxDepth: next.maxDepth,
      maxFanout: next.maxFanout,
      maxActiveChildren: next.maxActiveChildren,
      budget: next.budget,
    },
    "[delegation.bounds] effective bounds snapshotted",
  );

  return next;
}
