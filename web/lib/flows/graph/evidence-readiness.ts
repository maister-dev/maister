import "server-only";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { getCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import {
  getNodeAttemptsForRun,
  latestAttemptByNode,
} from "@/lib/flows/graph/ledger";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { artifactInstances, gateResults } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "evidence-readiness",
  level: process.env.LOG_LEVEL ?? "info",
});

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export type EvidenceReadinessResult = {
  ready: boolean;
  reasons: string[];
};

/**
 * Check whether all evidence gates are satisfied for the given phase.
 *
 * Logic:
 * 1. Per-def-current: gather the distinct artifact_def_ids that any row marks
 *    `required_for: [phase]`, then for each def block iff NO `current` row of
 *    that def exists. Stale/superseded history is ignored — supersedePrior
 *    retires ALL prior rows when a def is re-produced (PR1/F2).
 * 2. Query all artifact_required gate_results for this run:
 *    - blocking + stale → always not ready (needs re-run)
 *    - blocking + failed → re-evaluate: if all inputArtifactRefs still missing
 *      the artifacts are not current → not ready
 * 3. Evidence is opt-in: a run that declares no required_for:[phase] artifacts
 *    and no blocking artifact_required gates is vacuously ready (nothing blocks
 *    it), so non-evidence / 1.1.0 flows are never marked not-ready.
 *
 * Returns `{ ready: true, reasons: [] }` when all checks pass.
 */
export async function assertEvidenceReady(
  runId: string,
  phase: "review" | "merge",
  db?: Db,
): Promise<EvidenceReadinessResult> {
  const d = db ?? getDb();
  const reasons: string[] = [];

  // Check 1 (per-def-current): the distinct def ids any row marks required for
  // this phase. required_for is a JSONB array. Postgres filters server-side with
  // the @> containment operator; SQLite (the ultra-light dev dialect) has no
  // such operator, so fall back to fetching the run's rows and filtering in JS.
  let requiredDefRows: Array<{ artifactDefId: string | null }>;

  if (isPostgres()) {
    requiredDefRows = await d
      .select({ artifactDefId: artifactInstances.artifactDefId })
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.runId, runId),
          sql`${artifactInstances.requiredFor} @> ${JSON.stringify([phase])}::jsonb`,
        ),
      );
  } else {
    const all: Array<{
      artifactDefId: string | null;
      requiredFor: string[] | null;
    }> = await d
      .select({
        artifactDefId: artifactInstances.artifactDefId,
        requiredFor: artifactInstances.requiredFor,
      })
      .from(artifactInstances)
      .where(eq(artifactInstances.runId, runId));

    requiredDefRows = all.filter(
      (r) => Array.isArray(r.requiredFor) && r.requiredFor.includes(phase),
    );
  }

  const requiredDefIds = new Set<string>();

  for (const row of requiredDefRows) {
    if (row.artifactDefId) requiredDefIds.add(row.artifactDefId);
  }

  // A def is satisfied iff a `current` row of that def exists; stale/superseded
  // history never blocks (it has been superseded by the re-produced row).
  for (const defId of requiredDefIds) {
    const current = await getCurrentArtifact(runId, defId, d);

    if (!current) {
      reasons.push(
        `artifact def "${defId}" required for ${phase} has no current row`,
      );
    }
  }

  // Check 2: artifact_required gate_results for this run.
  // stale blocking gates need a re-run — always not ready.
  // failed blocking gates are re-evaluated: if all required artifacts are now
  // current the gate would pass today, so we skip it; otherwise not ready.
  const allGates: Array<{
    id: string;
    nodeAttemptId: string;
    gateId: string;
    mode: string;
    status: string;
    inputArtifactRefs: string[] | null;
  }> = await d
    .select({
      id: gateResults.id,
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      mode: gateResults.mode,
      status: gateResults.status,
      inputArtifactRefs: gateResults.inputArtifactRefs,
    })
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, runId),
        eq(gateResults.kind, "artifact_required"),
      ),
    );

  // Only the latest attempt's gate verdict is live: a stale row left by a prior
  // attempt is retired once the node re-runs and re-evaluates its gate (mirrors
  // per-def-current for artifacts). Keyed on node-attempt lineage so it is
  // immune to gate-id reuse across nodes.
  const liveAttemptIds = new Set(
    [
      ...latestAttemptByNode(await getNodeAttemptsForRun(runId, d)).values(),
    ].map((a) => a.id),
  );

  for (const gate of allGates) {
    if (gate.mode !== "blocking") continue;
    if (!liveAttemptIds.has(gate.nodeAttemptId)) continue;

    if (gate.status === "stale") {
      reasons.push(
        `blocking artifact_required gate "${gate.gateId}" (id=${gate.id}) is stale — needs re-run`,
      );

      continue;
    }

    if (gate.status === "failed") {
      // Re-evaluate: check if all required artifacts are now current.
      const refs = gate.inputArtifactRefs ?? [];
      let stillMissing = false;

      for (const defId of refs) {
        const artifact = await getCurrentArtifact(runId, defId, d);

        if (!artifact) {
          stillMissing = true;
          break;
        }
      }

      if (stillMissing || refs.length === 0) {
        reasons.push(
          `blocking artifact_required gate "${gate.gateId}" (id=${gate.id}) failed and required artifacts are not yet current`,
        );
      }
    }
  }

  // Evidence is opt-in: a run that declares no required_for:[phase] artifacts
  // and no blocking artifact_required gates is vacuously ready (nothing blocks
  // it). This keeps non-evidence / 1.1.0 flows from being marked merge-blocked;
  // flows opt into gating by declaring requiredFor artifacts or
  // artifact_required gates.
  const ready = reasons.length === 0;

  log.info(
    { runId, phase, ready, reasonCount: reasons.length },
    "evidence readiness verdict",
  );

  return { ready, reasons };
}
