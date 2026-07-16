import "server-only";

import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): schema-module bridge (matches lib/evaluations/studies.ts).
const { evaluationEvidenceSnapshots, evaluationExecutions } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-evidence-gc",
  level: process.env.LOG_LEVEL ?? "info",
});

// A `preparing` snapshot older than this never completed its seal transaction (a
// crash between blob write and seal) — the DB row is an orphan whose blobs are
// GC-eligible by generation rotation. Default 1h.
const DEFAULT_ORPHAN_PREPARING_AGE_MS = 60 * 60 * 1000;
// A `pending_delete` snapshot is finalized to `deleted` only after this grace
// window, and only when no execution still cites it (D5 two-stage delete).
const DEFAULT_PENDING_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface EvidenceSweepSummary {
  orphansMarked: number;
  deleted: number;
}

// Recover crashed captures and finalize two-stage deletes (T2.3). Idempotent and
// bounded — safe to run on every system sweep tick. Blob pruning is a separate
// generation-rotation concern; this owns the DB lifecycle rows.
export async function sweepEvaluationEvidence(
  args: {
    now?: Date;
    orphanPreparingAgeMs?: number;
    pendingDeleteGraceMs?: number;
  } = {},
  db?: Db,
): Promise<EvidenceSweepSummary> {
  const d = db ?? getDb();
  const now = args.now ?? new Date();
  const orphanCutoff = new Date(
    now.getTime() -
      (args.orphanPreparingAgeMs ?? DEFAULT_ORPHAN_PREPARING_AGE_MS),
  );
  const pendingCutoff = new Date(
    now.getTime() -
      (args.pendingDeleteGraceMs ?? DEFAULT_PENDING_DELETE_GRACE_MS),
  );

  // 1. Orphan `preparing` snapshots (seal never completed) → pending_delete.
  const orphaned = await d
    .update(evaluationEvidenceSnapshots)
    .set({ status: "pending_delete", pendingDeleteAt: now })
    .where(
      and(
        eq(evaluationEvidenceSnapshots.status, "preparing"),
        lt(evaluationEvidenceSnapshots.createdAt, orphanCutoff),
      ),
    )
    .returning({ id: evaluationEvidenceSnapshots.id });

  // 2. `pending_delete` past grace AND cited by no execution → deleted. The
  //    NOT IN (referenced) guard is the safety net over the RESTRICT FK: a sealed
  //    snapshot an execution still points at is never finalized.
  const referenced = d
    .select({ id: evaluationExecutions.evidenceSnapshotId })
    .from(evaluationExecutions)
    .where(sql`${evaluationExecutions.evidenceSnapshotId} is not null`);

  const deleted = await d
    .update(evaluationEvidenceSnapshots)
    .set({ status: "deleted", deletedAt: now })
    .where(
      and(
        eq(evaluationEvidenceSnapshots.status, "pending_delete"),
        lt(evaluationEvidenceSnapshots.pendingDeleteAt, pendingCutoff),
        notInArray(evaluationEvidenceSnapshots.id, referenced),
      ),
    )
    .returning({ id: evaluationEvidenceSnapshots.id });

  const summary: EvidenceSweepSummary = {
    orphansMarked: orphaned.length,
    deleted: deleted.length,
  };

  if (summary.orphansMarked > 0 || summary.deleted > 0) {
    log.info(summary, "evaluation evidence swept");
  }

  return summary;
}
