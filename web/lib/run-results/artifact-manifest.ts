import type { RunResultArtifactRef } from "@/lib/run-results/types";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { artifactInstances } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-165: artifact metadata on a result row is ENGINE-DERIVED — read from
// `artifact_instances`, never from a producer's payload. A publishing agent
// cannot name an artifact into existence.
//
// The manifest captured here is the state AT PUBLISH (audit). `run_collect`
// deliberately serves the LIVE manifest instead, so a coordinator sees what
// exists NOW while the row records what existed THEN.

/**
 * Every artifact the run holds at this moment, ordered deterministically so two
 * publishes of the same state produce byte-identical manifests.
 *
 * Runs inside the caller's transaction, so the manifest is consistent with the
 * attempt close or terminal flip it is committed alongside.
 */
export async function engineArtifactManifest(
  tx: Db,
  runId: string,
): Promise<RunResultArtifactRef[]> {
  const rows = (await tx
    .select({
      artifactId: artifactInstances.id,
      kind: artifactInstances.kind,
      nodeId: artifactInstances.nodeId,
      validity: artifactInstances.validity,
    })
    .from(artifactInstances)
    .where(eq(artifactInstances.runId, runId))) as RunResultArtifactRef[];

  return [...rows].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}
