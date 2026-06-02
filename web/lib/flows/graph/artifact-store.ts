import "server-only";

import type {
  ArtifactInstance,
  ArtifactInstanceInsert,
  ArtifactKind,
  ArtifactLocator,
} from "@/lib/db/schema";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (see ledger.ts / schema
// integration test). Matches the existing store idiom.
const { artifactInstances } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "artifact-store",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// --- Pure id helpers (no I/O) -------------------------------------------

/**
 * Deterministic id for runner-inline artifacts.
 * Format: `run:<nodeAttemptId>:<artifactDefId>` when artifactDefId is present,
 * else `run:<nodeAttemptId>:default:<kind>` (or `generic_file` when no kind).
 */
export function artifactInstanceId({
  nodeAttemptId,
  artifactDefId,
  kind,
}: {
  nodeAttemptId: string;
  artifactDefId?: string;
  kind?: ArtifactKind;
}): string {
  if (artifactDefId) {
    return `run:${nodeAttemptId}:${artifactDefId}`;
  }

  return `run:${nodeAttemptId}:default:${kind ?? "generic_file"}`;
}

/**
 * Deterministic id for projector-derived artifacts.
 * Format: `proj:<runId>:<monotonicId>`
 */
export function projectorArtifactId({
  runId,
  monotonicId,
}: {
  runId: string;
  monotonicId: number;
}): string {
  return `proj:${runId}:${monotonicId}`;
}

// --- Store operations ---------------------------------------------------

type RecordArtifactArgs = Omit<ArtifactInstanceInsert, "id" | "createdAt"> & {
  /** Optional caller-supplied id (e.g. projector rows). When absent, built via artifactInstanceId(). */
  id?: string;
};

/**
 * Insert an artifact row. Idempotent: same id → onConflictDoUpdate (upsert).
 * Returns the resolved id.
 */
export async function recordArtifact(
  args: RecordArtifactArgs,
  db?: Db,
): Promise<{ id: string }> {
  const d = db ?? getDb();
  const id =
    args.id ??
    artifactInstanceId({
      nodeAttemptId: args.nodeAttemptId ?? "",
      artifactDefId: args.artifactDefId ?? undefined,
      kind: args.kind,
    });

  const row: ArtifactInstanceInsert = {
    ...args,
    id,
  };

  await d
    .insert(artifactInstances)
    .values(row)
    .onConflictDoUpdate({
      target: artifactInstances.id,
      set: {
        locator: row.locator,
        validity: row.validity ?? "current",
        uri: row.uri,
        hash: row.hash,
        sizeBytes: row.sizeBytes,
        requiredFor: row.requiredFor,
        monotonicId: row.monotonicId,
      },
    });

  log.info(
    {
      runId: args.runId,
      nodeId: args.nodeId,
      kind: args.kind,
      id,
      producer: args.producer,
    },
    "artifact recorded",
  );

  return { id };
}

/**
 * Mark ALL prior artifact(s) for (runId, nodeId, artifactDefId) as superseded
 * by newId, regardless of their validity (current/stale/failed → superseded);
 * only the row with id=newId is left untouched. Retiring the orphaned stale
 * history of a def when a fresh row is re-produced (PR1/F2) is what restores
 * per-def-current readiness after a rework re-run.
 */
export async function supersedePrior(
  runId: string,
  nodeId: string,
  artifactDefId: string,
  newId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  const superseded = await d
    .update(artifactInstances)
    .set({ validity: "superseded", supersededById: newId })
    .where(
      and(
        eq(artifactInstances.runId, runId),
        eq(artifactInstances.nodeId, nodeId),
        eq(artifactInstances.artifactDefId, artifactDefId),
        ne(artifactInstances.id, newId),
      ),
    )
    .returning({ id: artifactInstances.id });

  log.info(
    { runId, nodeId, artifactDefId, newId, count: superseded.length },
    "artifact superseded",
  );
}

/**
 * Record a `current` declared-output artifact AND retire all prior rows of the
 * same (run, node, artifact_def) in ONE transaction.
 *
 * This is the atomic replacement for a bare `recordArtifact(...)` followed by a
 * separate `supersedePrior(...)`. Those were two independently auto-committed
 * statements: a process death between them left TWO `current` rows of the same
 * def, and `getCurrentArtifact` (a single-row read) would then return an
 * arbitrary one — letting an evidence gate (`assertEvidenceReady` /
 * `artifact_required`) approve review/merge on a superseded attempt's payload.
 * Folding both writes into one transaction makes that dual-current window
 * unreachable. Only used for declared `requiredFor`-bearing outputs whose def is
 * superseded per (run,node,def); default/projector rows that intentionally keep
 * multiple current rows per def still use `recordArtifact` directly.
 */
export async function recordCurrentArtifact(
  args: RecordArtifactArgs,
  db?: Db,
): Promise<{ id: string }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const { id } = await recordArtifact(args, tx);

    if (args.runId && args.nodeId && args.artifactDefId) {
      await supersedePrior(args.runId, args.nodeId, args.artifactDefId, id, tx);
    }

    return { id };
  });
}

/**
 * Mark all current artifacts for the given nodeIds in a run as stale.
 * Used when downstream nodes are reworked or a takeover return is recorded.
 */
export async function markArtifactsStale(
  runId: string,
  nodeIds: string[],
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  if (nodeIds.length === 0) return;

  const staled = await d
    .update(artifactInstances)
    .set({ validity: "stale" })
    .where(
      and(
        eq(artifactInstances.runId, runId),
        inArray(artifactInstances.nodeId, nodeIds),
        eq(artifactInstances.validity, "current"),
      ),
    )
    .returning({ id: artifactInstances.id });

  log.info({ runId, nodeIds, count: staled.length }, "artifacts marked stale");
}

/**
 * Return all artifact instance rows for a run.
 */
export async function getArtifactsForRun(
  runId: string,
  db?: Db,
): Promise<ArtifactInstance[]> {
  const d = db ?? getDb();

  return d
    .select()
    .from(artifactInstances)
    .where(eq(artifactInstances.runId, runId));
}

/**
 * Return the single validity='current' artifact for (runId, artifactDefId),
 * or undefined if none exists.
 */
export async function getCurrentArtifact(
  runId: string,
  artifactDefId: string,
  db?: Db,
): Promise<ArtifactInstance | undefined> {
  const d = db ?? getDb();

  const rows = await d
    .select()
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, runId),
        eq(artifactInstances.artifactDefId, artifactDefId),
        eq(artifactInstances.validity, "current"),
      ),
    )
    // Deterministic latest-wins: declared defs hold one current row (supersede
    // is atomic), but default-artifact defs intentionally keep one current row
    // per attempt — order so the newest attempt's row is the one returned.
    .orderBy(desc(artifactInstances.createdAt), desc(artifactInstances.id))
    .limit(1);

  return rows[0] as ArtifactInstance | undefined;
}

/**
 * Return the `current` git-payload artifacts (kind diff | commit_set) of a run
 * that are required for review or merge. Used by the takeover-return path to
 * re-pin these to the post-takeover branch tip so review/merge evidence reflects
 * the FULL cumulative diff (base..tip), not the pre-takeover range frozen when
 * the producing node ran. `required_for` is filtered in JS — dialect-agnostic,
 * no jsonb `@>` operator dependency.
 */
export async function getCurrentRequiredForGitArtifacts(
  runId: string,
  db?: Db,
): Promise<ArtifactInstance[]> {
  const d = db ?? getDb();

  const rows: ArtifactInstance[] = await d
    .select()
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, runId),
        eq(artifactInstances.validity, "current"),
        inArray(artifactInstances.kind, ["diff", "commit_set"]),
      ),
    );

  return rows.filter(
    (r) => Array.isArray(r.requiredFor) && r.requiredFor.length > 0,
  );
}

/**
 * Set validity='failed' on the artifact with the given id.
 */
export async function failArtifact(id: string, db?: Db): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(artifactInstances)
    .set({ validity: "failed" })
    .where(eq(artifactInstances.id, id));

  log.info({ id }, "artifact marked failed");
}

/**
 * Mark any `stale` row(s) of (runId, artifactDefId) as `failed` — the FSM
 * `stale → failed` edge used when a blocking `artifact_required` gate finds a
 * required input unavailable (the def is no longer current and the gate that
 * needed it failed). No-op when the def has no stale row (absent input). A later
 * rework that re-produces the def supersedes the failed row (supersedePrior
 * retires ALL prior rows regardless of validity), so this never blocks recovery.
 * Returns the number of rows transitioned.
 */
export async function failStaleArtifactsForDef(
  runId: string,
  artifactDefId: string,
  db?: Db,
): Promise<number> {
  const d = db ?? getDb();

  const failed = await d
    .update(artifactInstances)
    .set({ validity: "failed" })
    .where(
      and(
        eq(artifactInstances.runId, runId),
        eq(artifactInstances.artifactDefId, artifactDefId),
        eq(artifactInstances.validity, "stale"),
      ),
    )
    .returning({ id: artifactInstances.id });

  if (failed.length > 0) {
    log.info(
      { runId, artifactDefId, count: failed.length },
      "stale artifacts marked failed (gate-required input unavailable)",
    );
  }

  return failed.length;
}

/**
 * Record a `skipped` artifact row for a gate's declared output that could not be
 * evaluated — the FSM `(none) → skipped` edge. Used (forward-compat) when the
 * engine encounters a gate kind it cannot execute, so the declared output is
 * surfaced as explicitly skipped rather than silently absent. Idempotent on the
 * deterministic id `run:<nodeAttemptId>:<artifactDefId>`.
 */
export async function recordSkippedArtifact(
  args: {
    runId: string;
    nodeAttemptId: string;
    nodeId: string;
    attempt?: number | null;
    artifactDefId: string;
    kind: ArtifactKind;
  },
  db?: Db,
): Promise<{ id: string }> {
  return recordArtifact(
    {
      id: `run:${args.nodeAttemptId}:${args.artifactDefId}`,
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      nodeId: args.nodeId,
      attempt: args.attempt ?? null,
      artifactDefId: args.artifactDefId,
      kind: args.kind,
      producer: "gate",
      locator: { kind: "inline", text: "" },
      validity: "skipped",
    },
    db,
  );
}

// Re-export the locator type for convenience
export type { ArtifactLocator };
