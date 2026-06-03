import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { getCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import { resolveManifest } from "@/lib/flows/graph/current-node-kind";
import { collapseLatestExternalPerGate } from "@/lib/flows/graph/external-gate-readiness";
import {
  getNodeAttemptsForRun,
  latestAttemptByNode,
} from "@/lib/flows/graph/ledger";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { artifactInstances, gateResults, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type GateExternalConfig = {
  description?: string;
  staleOnNewCommit: boolean;
};

// Resolve a run's flow manifest gates[].external block by gate id. Walks the
// graph manifest's nodes[].pre_finish.gates[] (linear `steps[]` manifests carry
// no gates). Defaults to { staleOnNewCommit: true } when the gate is undeclared
// or carries no external block. Shared by the gate-report route (M16 §D) and the
// readiness description projection (M16 §F).
export async function resolveGateExternalConfig(
  runId: string,
  gateId: string,
  db?: Db,
): Promise<GateExternalConfig> {
  const d = db ?? getDb();
  const fallback: GateExternalConfig = { staleOnNewCommit: true };

  // Resolve the run's PINNED manifest (`flow_revisions.manifest` via
  // `runs.flow_revision_id`), NOT the mutable `flows.manifest` enabled-cache —
  // a Flow upgrade/rollback while this run is live must not change its external
  // gate evidence semantics. Falls back to `flows.manifest` only for legacy runs
  // with a null revision (shared `resolveManifest`, same as node-kind resolution).
  const runRows = await d
    .select({ flowRevisionId: runs.flowRevisionId, flowId: runs.flowId })
    .from(runs)
    .where(eq(runs.id, runId));

  const run = runRows[0];

  if (!run) return fallback;

  const manifest = (await resolveManifest(d, run)) as unknown as {
    nodes?: Array<{ pre_finish?: { gates?: any[] } }>;
  } | null;

  for (const node of manifest?.nodes ?? []) {
    for (const gate of node.pre_finish?.gates ?? []) {
      if (gate?.id === gateId) {
        const ext = gate.external as
          | { description?: string; staleOnNewCommit?: boolean }
          | undefined;

        return {
          description: ext?.description,
          staleOnNewCommit: ext?.staleOnNewCommit !== false,
        };
      }
    }
  }

  return fallback;
}

export type ReadinessDTO = {
  readiness: "ready" | "blocked" | "stale" | "failed" | "waiting";
  externalGates: {
    gateId: string;
    status: string;
    description?: string;
    externalRunUrl?: string;
    commitSha?: string;
  }[];
  requiredArtifacts: {
    defId: string;
    kind: string;
    present: boolean;
    validity: string | null;
  }[];
  reasons: string[];
};

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export async function getRunReadiness(
  runId: string,
  projectId: string,
  db?: Db,
): Promise<ReadinessDTO | null> {
  const d = db ?? getDb();

  // Confirm the run exists and belongs to the project.
  const runRows = await d
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));

  if (runRows.length === 0) return null;

  // Gather live attempt ids (latest attempt per node).
  const liveAttemptIds = new Set(
    [
      ...latestAttemptByNode(await getNodeAttemptsForRun(runId, d)).values(),
    ].map((a: any) => a.id),
  );

  // Fetch all gate_results for this run.
  const allGateRows: Array<{
    id: string;
    nodeAttemptId: string;
    gateId: string;
    kind: string;
    mode: string;
    status: string;
    verdict: any;
    createdAt: Date;
  }> = await d
    .select({
      id: gateResults.id,
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
      verdict: gateResults.verdict,
      createdAt: gateResults.createdAt,
    })
    .from(gateResults)
    .where(eq(gateResults.runId, runId));

  // Filter to latest-attempt gates only.
  const liveGates = allGateRows.filter((g) =>
    liveAttemptIds.has(g.nodeAttemptId),
  );

  // Supersede-on-new-commit leaves the prior `passed` external_check row `stale`
  // and appends a fresh row on the SAME (gateId, attempt). The LATEST report per
  // gateId governs: collapse live external_check rows to the max-createdAt
  // representative per gateId (tiebreak by id desc) so the rollup and projection
  // never see the leftover stale row.
  const externalGateRows = collapseLatestExternalPerGate(
    liveGates.filter((g) => g.kind === "external_check"),
    (g) => g.gateId,
  );

  // blockingGates feeds the readiness rollup. External_check rows must be the
  // collapsed representatives only (a leftover stale row must not skew the
  // verdict); non-external blocking gates pass through unchanged.
  const blockingGates = [
    ...liveGates.filter(
      (g) => g.mode === "blocking" && g.kind !== "external_check",
    ),
    ...externalGateRows.filter((g) => g.mode === "blocking"),
  ];

  // Build externalGates projection. `description` is sourced from the flow
  // manifest gates[].external.description (M16 §F); url/commit come from the
  // gate verdict written by the report endpoint.
  const externalGates: ReadinessDTO["externalGates"] = [];

  for (const g of externalGateRows) {
    const entry: ReadinessDTO["externalGates"][number] = {
      gateId: g.gateId,
      status: g.status,
    };
    const verdict = g.verdict as Record<string, unknown> | null | undefined;

    if (verdict?.externalRunUrl)
      entry.externalRunUrl = String(verdict.externalRunUrl);
    if (verdict?.commitSha) entry.commitSha = String(verdict.commitSha);

    const external = await resolveGateExternalConfig(runId, g.gateId, d);

    if (external.description) entry.description = external.description;

    externalGates.push(entry);
  }

  // Gather required artifacts (required_for any phase).
  let requiredArtifactRows: Array<{
    id: string;
    artifactDefId: string | null;
    kind: string;
    validity: string | null;
    requiredFor: string[] | null;
  }>;

  if (isPostgres()) {
    const { sql } = await import("drizzle-orm");

    requiredArtifactRows = await d
      .select({
        id: artifactInstances.id,
        artifactDefId: artifactInstances.artifactDefId,
        kind: artifactInstances.kind,
        validity: artifactInstances.validity,
        requiredFor: artifactInstances.requiredFor,
      })
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.runId, runId),
          sql`${artifactInstances.requiredFor} IS NOT NULL AND ${artifactInstances.requiredFor} != '[]'::jsonb`,
        ),
      );
  } else {
    const all: Array<{
      id: string;
      artifactDefId: string | null;
      kind: string;
      validity: string | null;
      requiredFor: string[] | null;
    }> = await d
      .select({
        id: artifactInstances.id,
        artifactDefId: artifactInstances.artifactDefId,
        kind: artifactInstances.kind,
        validity: artifactInstances.validity,
        requiredFor: artifactInstances.requiredFor,
      })
      .from(artifactInstances)
      .where(eq(artifactInstances.runId, runId));

    requiredArtifactRows = all.filter(
      (r) => Array.isArray(r.requiredFor) && r.requiredFor.length > 0,
    );
  }

  // Unique def ids from required artifacts.
  const requiredDefIds = new Set<string>();

  for (const row of requiredArtifactRows) {
    if (row.artifactDefId) requiredDefIds.add(row.artifactDefId);
  }

  // Build requiredArtifacts projection.
  const requiredArtifactsResult: ReadinessDTO["requiredArtifacts"] = [];

  for (const defId of requiredDefIds) {
    const current = await getCurrentArtifact(runId, defId, d);
    // Find best row for kind/validity metadata.
    const representative = requiredArtifactRows.find(
      (r) => r.artifactDefId === defId,
    );

    requiredArtifactsResult.push({
      defId,
      kind: representative?.kind ?? "unknown",
      present: current !== null,
      validity: current?.validity ?? null,
    });
  }

  // Deterministic rollup.
  const reasons: string[] = [];

  // Blocking failed gates.
  const failedBlockingGates = blockingGates.filter(
    (g) => g.status === "failed",
  );

  if (failedBlockingGates.length > 0) {
    for (const g of failedBlockingGates) {
      reasons.push(`blocking gate "${g.gateId}" failed`);
    }

    return {
      readiness: "failed",
      externalGates,
      requiredArtifacts: requiredArtifactsResult,
      reasons,
    };
  }

  // Stale blocking gates or stale required artifacts.
  const staleBlockingGates = blockingGates.filter((g) => g.status === "stale");
  const staleArtifacts = requiredArtifactsResult.filter(
    (a) => a.validity === "stale",
  );

  if (staleBlockingGates.length > 0 || staleArtifacts.length > 0) {
    for (const g of staleBlockingGates) {
      reasons.push(`blocking gate "${g.gateId}" is stale`);
    }
    for (const a of staleArtifacts) {
      reasons.push(`required artifact "${a.defId}" is stale`);
    }

    return {
      readiness: "stale",
      externalGates,
      requiredArtifacts: requiredArtifactsResult,
      reasons,
    };
  }

  // Missing current required artifact.
  const missingArtifacts = requiredArtifactsResult.filter((a) => !a.present);

  if (missingArtifacts.length > 0) {
    for (const a of missingArtifacts) {
      reasons.push(`required artifact "${a.defId}" has no current row`);
    }

    return {
      readiness: "blocked",
      externalGates,
      requiredArtifacts: requiredArtifactsResult,
      reasons,
    };
  }

  // Pending/running blocking gates.
  const waitingGates = blockingGates.filter(
    (g) => g.status === "pending" || g.status === "running",
  );

  if (waitingGates.length > 0) {
    for (const g of waitingGates) {
      reasons.push(`blocking gate "${g.gateId}" is ${g.status}`);
    }

    return {
      readiness: "waiting",
      externalGates,
      requiredArtifacts: requiredArtifactsResult,
      reasons,
    };
  }

  // A blocking external_check in `skipped` is NOT ready — mirrors
  // assertEvidenceReady's passed/overridden allow-list (the read-model board /
  // portfolio badges apply the same rule). Without this, a skipped external_check
  // would fall through to "ready" while the authoritative gate still refuses.
  const skippedExternalGates = blockingGates.filter(
    (g) => g.kind === "external_check" && g.status === "skipped",
  );

  if (skippedExternalGates.length > 0) {
    for (const g of skippedExternalGates) {
      reasons.push(
        `blocking external_check gate "${g.gateId}" is skipped — not passed/overridden`,
      );
    }

    return {
      readiness: "blocked",
      externalGates,
      requiredArtifacts: requiredArtifactsResult,
      reasons,
    };
  }

  return {
    readiness: "ready",
    externalGates,
    requiredArtifacts: requiredArtifactsResult,
    reasons: [],
  };
}
