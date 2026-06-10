import "server-only";

import type { GateResultStatus } from "@/lib/db/schema";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { getCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import { isExternalGateReady } from "@/lib/flows/graph/external-gate-readiness";
import {
  getNodeAttemptsForRun,
  latestAttemptByNode,
} from "@/lib/flows/graph/ledger";
import {
  blockingGateContribution,
  gateStatusContribution,
  liveBlockingGates,
} from "@/lib/flows/graph/readiness-core";

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
 * 2. Scan ALL blocking gates on live attempts via liveBlockingGates (M15):
 *    - artifact_required: stale → always not ready; failed → re-evaluate
 *      inputArtifactRefs against current artifacts (if all current → clear;
 *      else blocked). passed/overridden → clear via gateStatusContribution.
 *    - external_check: collapsed to latest-per-gateId by liveBlockingGates;
 *      passed/overridden → clear; else → not ready.
 *    - command_check, ai_judgment, skill_check: contribution via
 *      gateStatusContribution; non-clear → not ready (M15 new enforcement).
 * 3. Evidence is opt-in: a run that declares no required_for:[phase] artifacts
 *    and no blocking gates is vacuously ready (nothing blocks it).
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

  // Check 2 (M15): scan ALL blocking gates on live attempts.
  // liveBlockingGates handles: live-attempt filter, mode=blocking filter,
  // and external_check collapse to latest-per-gateId.
  const allGateRows: Array<{
    id: string;
    nodeAttemptId: string;
    gateId: string;
    kind: string;
    mode: string;
    status: GateResultStatus;
    inputArtifactRefs: string[] | null;
    // M29 (ADR-073): blockingGateContribution reads payload.assertionFailed —
    // an assertion-failed mutation gate must NOT self-clear on inputs-present.
    verdict: unknown;
    createdAt: Date;
  }> = await d
    .select({
      id: gateResults.id,
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
    .where(eq(gateResults.runId, runId));

  // Only the latest attempt's gate verdict is live: a stale row left by a prior
  // attempt is retired once the node re-runs and re-evaluates its gate (mirrors
  // per-def-current for artifacts). Keyed on node-attempt lineage so it is
  // immune to gate-id reuse across nodes.
  const liveAttemptIds = new Set(
    [
      ...latestAttemptByNode(await getNodeAttemptsForRun(runId, d)).values(),
    ].map((a) => a.id),
  );

  const blocking = liveBlockingGates(allGateRows, liveAttemptIds);

  for (const gate of blocking) {
    if (gate.kind === "artifact_required") {
      // Preserve existing artifact_required nuance.
      if (gate.status === "stale") {
        reasons.push(
          `blocking artifact_required gate "${gate.gateId}" (id=${gate.id}) is stale — needs re-run`,
        );
        continue;
      }

      if (gate.status === "failed") {
        // Re-evaluate via the shared SSOT: a failed artifact_required gate
        // whose inputArtifactRefs are all current again no longer blocks.
        const refs = gate.inputArtifactRefs ?? [];
        const currentRefDefIds = new Set<string>();

        for (const defId of refs) {
          if (await getCurrentArtifact(runId, defId, d)) {
            currentRefDefIds.add(defId);
          }
        }

        if (blockingGateContribution(gate, currentRefDefIds) !== "clear") {
          reasons.push(
            `blocking artifact_required gate "${gate.gateId}" (id=${gate.id}) failed and required artifacts are not yet current`,
          );
        }

        continue;
      }

      // passed/overridden/skipped/pending/running — use standard contribution.
      // "clear" (passed) and "overridden" both allow promotion.
      // (skipped/pending/running are unusual for artifact_required but handled.)
      const contribution = gateStatusContribution(gate.status);

      if (contribution !== "clear" && contribution !== "overridden") {
        reasons.push(
          `blocking artifact_required gate "${gate.gateId}" (id=${gate.id}) is ${gate.status}`,
        );
      }

      continue;
    }

    if (gate.kind === "external_check") {
      // external_check rows have been collapsed to latest-per-gateId by
      // liveBlockingGates. Use the allow-list check identical to M16 §C.
      if (!isExternalGateReady(gate.status)) {
        reasons.push(
          `blocking external_check gate "${gate.gateId}" (id=${gate.id}) is ${gate.status} — not passed/overridden`,
        );
      }

      continue;
    }

    // command_check, ai_judgment, skill_check — M15 new enforcement.
    // "clear" (passed) and "overridden" both allow promotion; everything else blocks.
    const contribution = gateStatusContribution(gate.status);

    if (contribution !== "clear" && contribution !== "overridden") {
      reasons.push(
        `blocking ${gate.kind} gate "${gate.gateId}" (id=${gate.id}) ${gate.status}`,
      );
    }
  }

  // Evidence is opt-in: a run that declares no required_for:[phase] artifacts
  // and no blocking gates is vacuously ready (nothing blocks it). This keeps
  // non-evidence / 1.1.0 flows from being marked merge-blocked; flows opt into
  // gating by declaring requiredFor artifacts or blocking gates.
  const ready = reasons.length === 0;

  log.info(
    { runId, phase, ready, reasonCount: reasons.length },
    "evidence readiness verdict",
  );

  return { ready, reasons };
}
