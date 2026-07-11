import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttemptType } from "@/lib/db/schema";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { compileManifest } from "@/lib/flows/graph/compile";
import { parseGraphOnlyFlowManifest } from "@/lib/flows/manifest-parser";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flowRevisions, flows } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// Load the run's authoritative manifest. A revision pin never falls back to
// mutable flow state; only unpinned historical rows may use `flows.manifest`.
export async function resolveManifest(
  db: Db,
  run: { flowRevisionId: string | null; flowId: string | null },
): Promise<FlowYamlV1 | null> {
  let manifest: FlowYamlV1 | null = null;

  if (run.flowRevisionId) {
    const revisionRows = await db
      .select({ manifest: flowRevisions.manifest })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, run.flowRevisionId));

    const rawManifest = revisionRows[0]?.manifest;

    manifest = rawManifest
      ? parseGraphOnlyFlowManifest(rawManifest, {
          code: "CONFIG",
          surface: "current-node-revision",
          manifestLabel: `flow revision ${run.flowRevisionId}`,
          revision: run.flowRevisionId,
        })
      : null;
  }

  if (!manifest && !run.flowRevisionId && run.flowId) {
    const flowRows = await db
      .select({ manifest: flows.manifest })
      .from(flows)
      .where(eq(flows.id, run.flowId));

    const rawManifest = flowRows[0]?.manifest;

    manifest = rawManifest
      ? parseGraphOnlyFlowManifest(rawManifest, {
          code: "CONFIG",
          surface: "current-node-flow",
          manifestLabel: `flow ${run.flowId}`,
          flowRefId: run.flowId,
        })
      : null;
  }

  return manifest;
}

// Resolve the node type of `currentStepId` from the run's pinned graph manifest.
// Null when there is no current step, no resolvable manifest, or the node is
// absent. Canonical extraction (reviewer N1) shared by reconcile.ts,
// queries/run.ts, and runs/recover.ts.
export async function resolveCurrentNodeKind(
  db: Db,
  run: {
    flowRevisionId: string | null;
    flowId: string | null;
    currentStepId: string | null;
  },
): Promise<NodeAttemptType | null> {
  if (!run.currentStepId) return null;

  const manifest = await resolveManifest(db, run);

  if (!manifest) return null;

  return (
    compileManifest(manifest).nodes.get(run.currentStepId)?.nodeType ?? null
  );
}

export async function resolveCurrentNodeContext(
  db: Db,
  run: {
    flowRevisionId: string | null;
    flowId: string | null;
    currentStepId: string | null;
  },
): Promise<{ nodeKind: NodeAttemptType | null }> {
  const manifest = await resolveManifest(db, run);

  if (!manifest) return { nodeKind: null };

  const nodeKind = run.currentStepId
    ? (compileManifest(manifest).nodes.get(run.currentStepId)?.nodeType ?? null)
    : null;

  return { nodeKind };
}

// M19 crash-recover (ADR-034): resolve BOTH the node kind and its `retry_safe`
// opt-in for a given step id (the recover target = resume_target_step_id ??
// current_step_id). The classifier needs both to decide resume-agent vs
// re-dispatch vs discard-only. `retrySafe` defaults false (unknown/missing node
// → not retry-safe → discard-only).
export async function resolveNodeRecoverInfo(
  db: Db,
  run: {
    flowRevisionId: string | null;
    flowId: string | null;
    stepId: string | null;
  },
): Promise<{ nodeKind: NodeAttemptType | null; retrySafe: boolean }> {
  if (!run.stepId) return { nodeKind: null, retrySafe: false };

  const manifest = await resolveManifest(db, run);

  if (!manifest) return { nodeKind: null, retrySafe: false };

  const node = compileManifest(manifest).nodes.get(run.stepId);

  return {
    nodeKind: node?.nodeType ?? null,
    retrySafe: node?.retrySafe ?? false,
  };
}
