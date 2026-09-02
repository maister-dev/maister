import type {
  DeclaredDelegationBounds,
  DelegationBounds,
  DelegationInstanceCeilings,
} from "@/lib/run-results/types";

import { RAH_ENGINE_MIN } from "@/lib/config.schema";
import { semverGte } from "@/lib/flows/engine-version";

// ADR-165 (D5): the EFFECTIVE delegation bounds. Pure — no db, no `server-only`
// — so the formula is table-testable and the snapshot writer, admission and the
// scheduler all read one computation.
//
// The floor is the whole safety argument. Below `3.7.0` the node declaration
// has been parsed and ignored since ADR-098, so honouring it retroactively would
// change the behaviour of any shipped manifest that set it decoratively. At or
// above it, a declaration can only LOWER an instance ceiling.

/** Node-level defaults when a `>= 3.7.0` manifest omits a key (ADR-165 Q3). */
export const DEFAULT_NODE_MAX_DEPTH = 2;
export const DEFAULT_NODE_MAX_FANOUT = 6;
export const DEFAULT_NODE_MAX_ACTIVE_CHILDREN = 3;

export type ComputeBoundsArgs = {
  instance: DelegationInstanceCeilings;
  /** The MANIFEST's `compat.engine_min`; null/"" reads as below the floor. */
  engineMin: string | null;
  declared: DeclaredDelegationBounds | null;
  nodeId: string;
  nodeAttemptId: string;
};

export function computeEffectiveDelegationBounds(
  args: ComputeBoundsArgs,
): DelegationBounds {
  const { instance, declared, engineMin } = args;
  const base = {
    nodeId: args.nodeId,
    nodeAttemptId: args.nodeAttemptId,
    engineMin,
    declared: declared ?? null,
    instance,
  };

  if (!semverGte(engineMin ?? "", RAH_ENGINE_MIN)) {
    return {
      ...base,
      source: "env",
      maxDepth: instance.maxDepth,
      maxFanout: instance.maxFanout,
      maxActiveChildren: null,
      budget: null,
    };
  }

  return {
    ...base,
    source: "node",
    maxDepth: Math.min(
      instance.maxDepth,
      declared?.max_depth ?? DEFAULT_NODE_MAX_DEPTH,
    ),
    maxFanout: Math.min(
      instance.maxFanout,
      declared?.max_fanout ?? DEFAULT_NODE_MAX_FANOUT,
    ),
    // Bounded by the POOL cap, not the fan-out ceiling: this is a concurrency
    // bound, and no orchestrator may hold more children active than the pool
    // could run anyway. The flow pool is used because a coordinator's children
    // are predominantly flow runs; an agent child is additionally bounded by the
    // agent pool at the scheduler.
    maxActiveChildren: Math.min(
      instance.flowPool,
      declared?.max_active_children ?? DEFAULT_NODE_MAX_ACTIVE_CHILDREN,
    ),
    // Verbatim. It is required and complete at this floor (load gate R10), so
    // there is nothing to merge or default here — the min-merge against the
    // execution policy happens at the ROOT meter, not per node.
    budget: declared?.budget ?? null,
  };
}
