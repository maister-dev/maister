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

// Resolve the node type of `currentStepId` from the run's pinned manifest
// (`flow_revisions.manifest`, falling back to live `flows.manifest`), compiled
// via the graph compiler. Legacy `steps[]` compile to single-action nodes. Null
// when there is no current step, no resolvable manifest, or the step is absent.
// Canonical extraction (reviewer N1) shared by reconcile.ts, queries/run.ts,
// and runs/recover.ts.
export async function resolveCurrentNodeKind(
  db: Db,
  run: {
    flowRevisionId: string | null;
    flowId: string | null;
    currentStepId: string | null;
  },
): Promise<NodeAttemptType | null> {
  if (!run.currentStepId) return null;

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

  if (!manifest) return null;

  return (
    compileManifest(manifest).nodes.get(run.currentStepId)?.nodeType ?? null
  );
}
