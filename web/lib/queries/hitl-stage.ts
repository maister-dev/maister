import "server-only";

import type { NodeAttemptType } from "@/lib/db/schema";

import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveManifest } from "@/lib/flows/graph/current-node-kind";

export interface StageChip {
  // The originating HITL node id (`hitl_requests.step_id`) — free, always present.
  label: string;
  // Node kind from the run's compiled flow graph; null when unresolvable.
  type: NodeAttemptType | null;
}

export interface StageInput {
  hitlRequestId: string;
  stepId: string;
  flowRevisionId: string | null;
  flowId: string | null;
}

// FIXME(any): resolveManifest types its db param as `any` (dual drizzle peer-dep).
type Db = Parameters<typeof resolveManifest>[0];

// Resolve a `stage {label, type}` for each HITL row. `label` is the row's
// step_id (free); `type` is the node kind from the run's compiled flow graph.
// The graph is compiled at most ONCE per distinct flow revision (never per row)
// to avoid an N+1; an unresolved step_id degrades to a null type so the inbox
// always renders.
export async function resolveStages(
  db: Db,
  rows: StageInput[],
): Promise<Map<string, StageChip>> {
  const byManifest = new Map<string, StageInput[]>();

  for (const row of rows) {
    const key = `${row.flowRevisionId ?? ""}|${row.flowId ?? ""}`;
    const bucket = byManifest.get(key);

    if (bucket) bucket.push(row);
    else byManifest.set(key, [row]);
  }

  const result = new Map<string, StageChip>();

  for (const bucket of byManifest.values()) {
    const { flowRevisionId, flowId } = bucket[0];
    let graph: ReturnType<typeof compileManifest> | null = null;

    try {
      const manifest = await resolveManifest(db, { flowRevisionId, flowId });

      graph = manifest ? compileManifest(manifest) : null;
    } catch {
      graph = null;
    }

    for (const row of bucket) {
      result.set(row.hitlRequestId, {
        label: row.stepId,
        type: graph?.nodes.get(row.stepId)?.nodeType ?? null,
      });
    }
  }

  return result;
}
