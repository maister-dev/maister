import "server-only";

import { rm } from "node:fs/promises";

import { and, eq, lte } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { gcAgeDays } from "@/lib/instance-config";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flowRevisions, flows, runs } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gc-revision",
  level: process.env.LOG_LEVEL ?? "info",
});

const PER_TICK_LIMIT = 100;

export interface RevisionGcSummary {
  scanned: number;
  deleted: number;
  skippedReferenced: number;
}

type CandidateRow = {
  id: string;
  installedPath: string;
};

// Removed revisions older than gcAgeDays (no removed_at column → installed_at is
// the age gate). Older means further in the past.
async function loadCandidates(db: Db, now: Date): Promise<CandidateRow[]> {
  const cutoff = new Date(now.getTime() - gcAgeDays() * 86_400_000);

  const rows = await db
    .select({
      id: flowRevisions.id,
      installedPath: flowRevisions.installedPath,
    })
    .from(flowRevisions)
    .where(
      and(
        eq(flowRevisions.packageStatus, "Removed"),
        lte(flowRevisions.installedAt, cutoff),
      ),
    )
    .limit(PER_TICK_LIMIT);

  return rows;
}

// GC of Removed flow revisions. Per row, under FOR UPDATE, re-assert the
// dual-FK guard mirrored from removeRevision (zero runs.flow_revision_id refs
// AND zero flows.enabled_revision_id refs). Clear → DELETE the row in-tx, then
// rm the installedPath dir after commit. Still referenced → skip.
export async function runRevisionGcSweep(
  opts: { db?: Db; now?: () => Date } = {},
): Promise<RevisionGcSummary> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? (() => new Date());

  const candidates = await loadCandidates(db, now());

  log.info({ scanned: candidates.length }, "revision GC sweep start");

  let deleted = 0;
  let skippedReferenced = 0;

  for (const cand of candidates) {
    const removable: boolean = await db.transaction(async (tx: Db) => {
      await tx
        .select({ packageStatus: flowRevisions.packageStatus })
        .from(flowRevisions)
        .where(eq(flowRevisions.id, cand.id))
        .for("update");

      const refRuns = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.flowRevisionId, cand.id))
        .limit(1);

      if (refRuns.length > 0) return false;

      const enabledBy = await tx
        .select({ id: flows.id })
        .from(flows)
        .where(eq(flows.enabledRevisionId, cand.id))
        .limit(1);

      if (enabledBy.length > 0) return false;

      await tx.delete(flowRevisions).where(eq(flowRevisions.id, cand.id));

      return true;
    });

    if (!removable) {
      skippedReferenced += 1;
      log.info(
        { revisionId: cand.id },
        "revision GC: still referenced — skipped",
      );

      continue;
    }

    await rm(cand.installedPath, { recursive: true, force: true }).catch(
      (err) =>
        log.warn(
          {
            revisionId: cand.id,
            installedPath: cand.installedPath,
            err: err instanceof Error ? err.message : String(err),
          },
          "revision GC: cache rm failed (row already deleted)",
        ),
    );

    deleted += 1;
    log.info(
      { revisionId: cand.id, installedPath: cand.installedPath },
      "revision GC: deleted",
    );
  }

  const summary: RevisionGcSummary = {
    scanned: candidates.length,
    deleted,
    skippedReferenced,
  };

  log.info(summary, "revision GC sweep complete");

  return summary;
}
