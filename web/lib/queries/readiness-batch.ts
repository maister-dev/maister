import "server-only";

import type { GateResultStatus } from "@/lib/db/schema";
import type {
  ReadinessContribution,
  ReadinessState,
} from "@/lib/flows/graph/readiness-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { inArray } from "drizzle-orm";

import * as schema from "@/lib/db/schema";
import {
  blockingGateContribution,
  latestAttemptIdsByNode,
  liveBlockingGates,
  rollupReadiness,
} from "@/lib/flows/graph/readiness-core";
import {
  checksFromSnapshot,
  type CheckStrictness,
} from "@/lib/runs/execution-policy";

const { artifactInstances, gateResults, nodeAttempts, runs } = schema;

// T15/T16 (M15, ADR-048): the unified readiness state per run, batched across
// many runs (no per-run query, no N+1) and shared verbatim by the board,
// portfolio, and project read models. Bulk-fetches node_attempts +
// gate_results + artifact_instances once, groups by runId in memory, and
// classifies each run through the shared readiness-core SSOT
// (latestAttemptIdsByNode + liveBlockingGates + blockingGateContribution +
// rollupReadiness) — the SAME contributions the merge guard (assertEvidenceReady)
// and the run-detail DTO (getRunReadiness) apply, including the failed
// `artifact_required` re-evaluation against current artifacts. A required def
// (`requiredFor` non-empty) with no validity="current" row contributes `blocked`.
export async function computeReadinessByRun(
  client: NodePgDatabase<typeof schema>,
  runIds: string[],
): Promise<Map<string, ReadinessState>> {
  const readinessByRun = new Map<string, ReadinessState>();

  if (runIds.length === 0) return readinessByRun;

  // Live-attempt lineage: latest attempt per (runId, nodeId). nodeIds repeat
  // across runs, so grouping must stay run-scoped.
  const attemptRows: Array<{
    id: string;
    runId: string;
    nodeId: string;
    attempt: number;
  }> = await client
    .select({
      id: nodeAttempts.id,
      runId: nodeAttempts.runId,
      nodeId: nodeAttempts.nodeId,
      attempt: nodeAttempts.attempt,
    })
    .from(nodeAttempts)
    .where(inArray(nodeAttempts.runId, runIds));

  // All gate_results on the runs (every kind, every status). The blocking +
  // live-attempt + external-collapse filtering happens in liveBlockingGates
  // (SSOT). `inputArtifactRefs` feeds the failed artifact_required re-eval.
  const gateRows: Array<{
    id: string;
    runId: string;
    nodeAttemptId: string;
    gateId: string;
    kind: string;
    mode: string;
    status: GateResultStatus;
    inputArtifactRefs: string[] | null;
    // M29 (ADR-074): blockingGateContribution reads payload.assertionFailed so
    // board/portfolio badges match the merge guard for mutation failures.
    verdict: unknown;
    createdAt: Date;
  }> = await client
    .select({
      id: gateResults.id,
      runId: gateResults.runId,
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
      inputArtifactRefs: gateResults.inputArtifactRefs,
      verdict: gateResults.verdict,
      createdAt: gateResults.createdAt,
    })
    .from(gateResults)
    .where(inArray(gateResults.runId, runIds));

  // Required-artifact rows for the review phase, plus the validity of each
  // (runId, defId)'s current row. requiredFor is JSONB; filter in JS so the
  // computation is dialect-agnostic.
  const artifactRows: Array<{
    runId: string;
    artifactDefId: string | null;
    validity: string;
    requiredFor: string[] | null;
  }> = await client
    .select({
      runId: artifactInstances.runId,
      artifactDefId: artifactInstances.artifactDefId,
      validity: artifactInstances.validity,
      requiredFor: artifactInstances.requiredFor,
    })
    .from(artifactInstances)
    .where(inArray(artifactInstances.runId, runIds));

  // Execution-policy check-strictness per run (axis A3). One batched select (no
  // N+1) — the badge classifier MUST apply the same relaxation the merge guard
  // does, else a run "ready under advisory checks" reads as blocked on the board
  // while assertEvidenceReady would promote it.
  const policyRows: Array<{ id: string; executionPolicy: unknown }> =
    await client
      .select({ id: runs.id, executionPolicy: runs.executionPolicy })
      .from(runs)
      .where(inArray(runs.id, runIds));
  const checksByRun = new Map<string, CheckStrictness>();

  for (const r of policyRows) {
    checksByRun.set(r.id, checksFromSnapshot(r.executionPolicy ?? null));
  }

  const attemptsByRun = new Map<string, typeof attemptRows>();
  const gatesByRun = new Map<string, typeof gateRows>();
  const artifactsByRun = new Map<string, typeof artifactRows>();

  for (const a of attemptRows) {
    (
      attemptsByRun.get(a.runId) ?? attemptsByRun.set(a.runId, []).get(a.runId)!
    ).push(a);
  }
  for (const g of gateRows) {
    (gatesByRun.get(g.runId) ?? gatesByRun.set(g.runId, []).get(g.runId)!).push(
      g,
    );
  }
  for (const r of artifactRows) {
    (
      artifactsByRun.get(r.runId) ??
      artifactsByRun.set(r.runId, []).get(r.runId)!
    ).push(r);
  }

  for (const runId of runIds) {
    // Def ids with a validity="current" row — the set the failed
    // artifact_required re-eval and the required-artifact presence check share.
    const presentDefIds = new Set<string>();

    for (const r of artifactsByRun.get(runId) ?? []) {
      if (r.artifactDefId && r.validity === "current") {
        presentDefIds.add(r.artifactDefId);
      }
    }

    const liveAttemptIds = latestAttemptIdsByNode(
      attemptsByRun.get(runId) ?? [],
    );
    const blocking = liveBlockingGates(
      gatesByRun.get(runId) ?? [],
      liveAttemptIds,
      checksByRun.get(runId) ?? "strict",
    );
    const gateContributions: ReadinessContribution[] = blocking.map((g) =>
      blockingGateContribution(g, presentDefIds),
    );

    // A required def (requiredFor non-empty, any phase) is satisfied iff a
    // validity="current" row exists for it — identical to getRunReadiness's
    // requiredFor NON-EMPTY filter.
    const requiredDefIds = new Set(
      (artifactsByRun.get(runId) ?? [])
        .filter(
          (r) =>
            r.artifactDefId &&
            Array.isArray(r.requiredFor) &&
            r.requiredFor.length > 0,
        )
        .map((r) => r.artifactDefId as string),
    );

    const artifactContributions: ReadinessContribution[] = [];

    for (const defId of requiredDefIds) {
      if (!presentDefIds.has(defId)) artifactContributions.push("blocked");
    }

    readinessByRun.set(
      runId,
      rollupReadiness([...artifactContributions, ...gateContributions]),
    );
  }

  return readinessByRun;
}
