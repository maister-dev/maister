import "server-only";

import type { NodeAttemptType } from "@/lib/db/schema";

import pino from "pino";

import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveManifest } from "@/lib/flows/graph/current-node-kind";
import {
  loadNodeInterruptMatrices,
  type NodeInterruptOptionMatrix,
} from "@/lib/runs/node-interrupt";

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

const log = pino({
  name: "hitl-stage",
  level: process.env.LOG_LEVEL ?? "info",
});

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
    } catch (err) {
      log.warn(
        { flowRevisionId, flowId, err },
        "[hitl-stage] manifest resolve/compile failed",
      );
      graph = null;
    }

    for (const row of bucket) {
      const type = graph?.nodes.get(row.stepId)?.nodeType ?? null;

      // A resolved graph that lacks the row's step_id is a genuine mismatch
      // (the inbox still renders with the raw label); the legacy no-manifest
      // fallback is expected and stays quiet.
      if (graph && type === null) {
        log.warn(
          { hitlRequestId: row.hitlRequestId, stepId: row.stepId },
          "[hitl-stage] unresolved step_id",
        );
      }

      result.set(row.hitlRequestId, { label: row.stepId, type });
    }
  }

  return result;
}

/**
 * ADR-160: batch the pending-interrupt option matrices for a page of inbox
 * rows, keyed by `hitl_request_id`.
 *
 * Sits beside `resolveStages` because it has the same shape — an async
 * enrichment the pure row mapper cannot perform — and because both inbox
 * callers already pre-fetch stages right before mapping. Grouped by run so a
 * page holding several interrupts of one run pays the ledger read once.
 */
export async function resolveNodeInterruptMatrices(
  db: Db,
  rows: ReadonlyArray<{
    hitlRequestId: string;
    runId: string;
    kind: string;
    stepId: string | null;
  }>,
): Promise<Map<string, NodeInterruptOptionMatrix>> {
  const byRun = new Map<
    string,
    Array<{ id: string; kind: string; stepId: string | null }>
  >();

  for (const row of rows) {
    if (row.kind !== "node_interrupt") continue;
    const bucket = byRun.get(row.runId) ?? [];

    bucket.push({ id: row.hitlRequestId, kind: row.kind, stepId: row.stepId });
    byRun.set(row.runId, bucket);
  }

  const resolved = new Map<string, NodeInterruptOptionMatrix>();

  for (const [runId, pending] of byRun) {
    const matrices = await loadNodeInterruptMatrices({ runId, pending, db });

    for (const [hitlRequestId, matrix] of matrices) {
      resolved.set(hitlRequestId, matrix);
    }
  }

  return resolved;
}
