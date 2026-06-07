import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttemptType } from "@/lib/db/schema";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { compileManifest } from "@/lib/flows/graph/compile";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flowRevisions, flows } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// Load the run's pinned manifest: `flow_revisions.manifest`, falling back to
// live `flows.manifest`. Null when neither resolves.
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

    manifest = (revisionRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  if (!manifest && run.flowId) {
    const flowRows = await db
      .select({ manifest: flows.manifest })
      .from(flows)
      .where(eq(flows.id, run.flowId));

    manifest = (flowRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  return manifest;
}

// Resolve the node type of `currentStepId` from the run's pinned manifest,
// compiled via the graph compiler. Legacy `steps[]` compile to single-action
// nodes. Null when there is no current step, no resolvable manifest, or the
// step is absent. Canonical extraction (reviewer N1) shared by reconcile.ts,
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

// M17 (ADR-056): resolve BOTH the current node kind AND whether the run's flow
// is a flat `steps[]` (linear) flow, in ONE manifest load. Reconcile needs the
// linear flag to route a session-less gate/human orphan to `crash` (linear has
// no graph mid-flow resume) instead of `redispatch`. `isLinear` is true when the
// manifest declares `steps[]`; graph (`nodes[]`) flows return false.
export async function resolveCurrentNodeContext(
  db: Db,
  run: {
    flowRevisionId: string | null;
    flowId: string | null;
    currentStepId: string | null;
  },
): Promise<{ nodeKind: NodeAttemptType | null; isLinear: boolean }> {
  const manifest = await resolveManifest(db, run);

  if (!manifest) return { nodeKind: null, isLinear: false };

  const isLinear = Array.isArray(manifest.steps) && manifest.steps.length > 0;
  const nodeKind = run.currentStepId
    ? (compileManifest(manifest).nodes.get(run.currentStepId)?.nodeType ?? null)
    : null;

  return { nodeKind, isLinear };
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
