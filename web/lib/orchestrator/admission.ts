import "server-only";

import type { DelegationBounds } from "@/lib/run-results/types";

import { and, eq, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { MAX_DELEGATION_ANCESTORS } from "./delegation-spec";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";
import {
  orchestratorMaxDepth,
  orchestratorMaxFanout,
} from "@/lib/instance-config";
import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
} from "@/lib/runs/run-status-sets";

// ADR-163 D8: ONE admission helper, called from every edge that creates a
// delegated child — `run_delegate`, `run_plan`'s source launch, and
// `auto_launch_run_plan`'s candidate launch (which has never had a depth or
// fan-out check at all). A guard on one of N edges is a guard on none, and the
// two routes had already grown two copies of the depth walk.

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "orchestrator-admission",
  level: process.env.LOG_LEVEL ?? "info",
});

// "dlgt" — a namespace distinct from every other advisory-lock user so a
// hashtext collision on the parent run id cannot serialize against them.
const DELEGATION_LOCK_NAMESPACE = 0x646c6774;

/** Serialize one tree before its immediate parent; independent roots retain independent admission. */
export async function lockDelegationParent(
  tx: Db,
  parentRunId: string,
): Promise<string> {
  const chain = await lockDelegationTree(tx, parentRunId);

  return chain[chain.length - 1]!.id;
}

async function lockDelegationKey(tx: Db, runId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${DELEGATION_LOCK_NAMESPACE}::int, hashtext(${runId})::int)`,
  );
}

/** One link of the ancestor chain: the run id and its bounds snapshot. */
type AncestorLink = {
  id: string;
  bounds: DelegationBounds | null;
  status: string;
};

function invalidDelegationLineage(
  parentRunId: string,
  failure: "missing_run" | "cycle" | "resolution_limit",
  resolvedAncestors: number,
): MaisterError {
  log.warn(
    { parentRunId, failure, resolvedAncestors, cap: MAX_DELEGATION_ANCESTORS },
    "delegation ancestry cannot establish a complete bounded tree",
  );

  return new MaisterError(
    "CONFIG",
    "Delegation requires a complete acyclic Run ancestry within the resolution bound; inspect the retained parent tree",
    { details: { reason: "delegation_lineage_invalid", failure } },
  );
}

/**
 * Walks up the `parent_run_id` chain from `startId`, collecting each ancestor's
 * bounds snapshot on the way.
 *
 * One current chain supplies all three bounds checks (ADR-165 T6.2): the depth count, the
 * root/parent min-merge, and the per-ancestor child-count budget. The chain is
 * `[parent, grandparent, ..., root]` — `parent` itself is depth 0 — and the cap
 * is what guarantees termination, since a self-referencing FK does not rule out
 * a cycle a manual DB edit could introduce.
 */
async function walkAncestorChain(
  tx: Db,
  startId: string,
): Promise<AncestorLink[]> {
  const chain: AncestorLink[] = [];
  let currentId: string | null = startId;
  const visited = new Set<string>();

  while (currentId !== null) {
    if (visited.has(currentId))
      throw invalidDelegationLineage(startId, "cycle", chain.length);
    if (chain.length === MAX_DELEGATION_ANCESTORS)
      throw invalidDelegationLineage(startId, "resolution_limit", chain.length);
    const rows = (await tx
      .select({
        parentRunId: runs.parentRunId,
        delegationBounds: runs.delegationBounds,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, currentId))) as {
      parentRunId: string | null;
      delegationBounds: DelegationBounds | null;
      status: string;
    }[];
    const row = rows[0];

    if (!row)
      throw invalidDelegationLineage(startId, "missing_run", chain.length);
    visited.add(currentId);
    chain.push({
      id: currentId,
      bounds: row.delegationBounds ?? null,
      status: row.status,
    });

    if (!row.parentRunId) break;
    currentId = row.parentRunId;
  }

  return chain;
}

/** Never hold a nested parent key while waiting for its root; recheck the actual chain after a wait. */
async function lockDelegationTree(
  tx: Db,
  parentRunId: string,
): Promise<AncestorLink[]> {
  const observed = await walkAncestorChain(tx, parentRunId);
  const rootRunId = observed.at(-1)!.id;

  await lockDelegationKey(tx, rootRunId);
  if (rootRunId !== parentRunId) await lockDelegationKey(tx, parentRunId);
  // Keep status and bounds stable until the child/reservation transaction commits.
  // NO KEY UPDATE remains compatible with child foreign-key KEY SHARE locks.
  for (const ancestor of [...observed].reverse()) {
    try {
      await tx.execute(
        sql`SELECT id FROM runs WHERE id=${ancestor.id} FOR NO KEY UPDATE NOWAIT`,
      );
    } catch (error) {
      if (pgErrorOf(error)?.code !== "55P03") throw error;
      log.warn(
        { parentRunId, ancestorRunId: ancestor.id },
        "delegation yielded to an existing execution writer",
      );
      throw new MaisterError(
        "CONFLICT",
        "The execution tree is being updated; retry the same work identity after the current writer settles",
        {
          details: {
            reason: "delegation_execution_busy",
            ancestorRunId: ancestor.id,
          },
        },
      );
    }
  }
  const current = await walkAncestorChain(tx, parentRunId);

  if (
    observed.length !== current.length ||
    observed.some((ancestor, index) => ancestor.id !== current[index]?.id)
  ) {
    log.warn(
      { parentRunId, reason: "delegation_lineage_changed" },
      "delegation ancestry changed before tree admission",
    );
    throw new MaisterError(
      "CONFLICT",
      "Delegation ancestry changed while waiting for admission; inspect the current parent tree before resubmitting the same work",
      { details: { reason: "delegation_lineage_changed" } },
    );
  }

  for (const ancestor of current) {
    if (!isTerminalRunStatus(ancestor.status)) continue;
    log.warn(
      { parentRunId, ancestorRunId: ancestor.id, status: ancestor.status },
      "delegation refused under a terminal execution ancestor",
    );
    throw new MaisterError(
      "PRECONDITION",
      "Delegation requires a current nonterminal execution tree; inspect the completed or cancelled ancestor",
      {
        details: {
          reason: "delegation_ancestor_inactive",
          ancestorRunId: ancestor.id,
          status: ancestor.status,
        },
      },
    );
  }

  return current;
}

/**
 * Descendants of `ancestorId` at ANY depth and in ANY status — the count
 * `budget.max_child_runs` bounds.
 *
 * All statuses on purpose: this is a "how much work has this coordinator caused"
 * budget, not a liveness question. A terminal child already spent its tokens.
 */
async function countRunSubtree(
  tx: Db,
  ancestorId: string,
  ownedTaskId: string | null,
  reservedRunId: string | null,
): Promise<number> {
  const result: unknown = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM runs WHERE parent_run_id = ${ancestorId}
      UNION ALL
      SELECT r.id FROM runs r JOIN subtree s ON r.parent_run_id = s.id
    )
    SELECT ((SELECT count(*) FROM subtree) + (
      SELECT count(*) FROM tasks child
      WHERE child.qualification_mode='execution_child'
        AND child.qualification_child_proof->>'parentRunId' IN (SELECT id FROM subtree UNION SELECT ${ancestorId})
        AND child.id IS DISTINCT FROM ${ownedTaskId}
        AND NOT EXISTS(SELECT 1 FROM runs WHERE task_id=child.id)
    ) + (
      SELECT count(*) FROM specialist_work work
      WHERE work.decision_state='open' AND work.child_run_id IS NULL
        AND work.reserved_run_id IS DISTINCT FROM ${reservedRunId}
        AND work.parent_run_id IN (SELECT id FROM subtree UNION SELECT ${ancestorId})
    ))::int AS n
  `);
  // node-postgres returns `{ rows }`; some drizzle drivers return the array
  // directly. Handle both rather than assume one — the shape difference is a
  // driver detail, not a contract.
  const list = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as { n?: number }[];

  return Number(list[0]?.n ?? 0);
}

/**
 * Children of `parentRunId` that are not yet terminal, counted across BOTH run
 * kinds (ADR-163 D3 — one shared cap per orchestrator).
 *
 * The predicate derives from the single source `run-status-sets.ts` rather than
 * an inline status list, and is named for its own concern: this is a LIVENESS
 * question ("how much is this orchestrator still running?"), distinct from
 * `orchestrator-resume`'s SETTLED-based pending count, which asks "may the
 * coordinator wake?" — `Review` is live here and settled there, on purpose.
 */
async function countLiveDelegatedChildren(
  tx: Db,
  parentRunId: string,
  launchIntentId: string | null,
  reservedRunId: string | null,
): Promise<number> {
  const rows = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, parentRunId),
        notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      ),
    )) as { n: number }[];

  const reservations =
    await tx.execute(sql`SELECT count(*)::int n FROM task_launch_intents
    WHERE state='preparing' AND run_id IS NULL AND id IS DISTINCT FROM ${launchIntentId}
      AND settings_snapshot->'serverExecution'->'execution'->>'parentRunId'=${parentRunId}`);

  const work = await tx.execute(sql`SELECT count(*)::int n FROM specialist_work
    WHERE parent_run_id=${parentRunId} AND decision_state='open'
      AND child_run_id IS NULL AND reserved_run_id IS DISTINCT FROM ${reservedRunId}`);

  return (
    (rows[0]?.n ?? 0) +
    Number(reservations.rows[0]?.n ?? 0) +
    Number(work.rows[0]?.n ?? 0)
  );
}

/**
 * Admit `incoming` new children under `parentRunId`, or refuse with
 * `MaisterError("CONFIG")`.
 *
 * MUST be called inside the caller's transaction and BEFORE any child record is
 * created — the lock is `pg_advisory_xact_lock`, so it is held until that
 * transaction commits, which is what makes "count then create" atomic. A count
 * taken outside a lock is a fast-path read, never the decision: two concurrent
 * delegations at `cap - 1` would both observe `cap - 1` and both commit.
 */
export async function admitDelegatedChild(
  tx: Db,
  args: {
    parentRunId: string;
    incoming?: number;
    launchIntentId?: string;
    assignmentBounds?: { maxDepth: number; maxFanout: number };
    reservedRunId?: string;
  },
): Promise<void> {
  const incoming = args.incoming ?? 1;

  const chain = await lockDelegationTree(tx, args.parentRunId);

  if (!args.assignmentBounds) {
    const [nativeAppointment] = (
      await tx.execute(sql`
        SELECT 1 FROM specialist_run_links
        WHERE run_id=${args.parentRunId} AND (
          work_witness IS NOT NULL OR (
            work_id IS NULL AND role IN ('specialist','coordinator','continuation')
          )
        )
      `)
    ).rows;

    if (nativeAppointment)
      throw new MaisterError(
        "PRECONDITION",
        "An appointed specialist must delegate through exact assignment work",
        { details: { reason: "assignment_work_required" } },
      );
  }

  // One current locked ancestry supplies all three bounds checks below.
  const [ownedIntent] = args.launchIntentId
    ? (
        await tx.execute(sql`SELECT task_id FROM task_launch_intents
    WHERE id=${args.launchIntentId} AND settings_snapshot->'serverExecution'->'execution'->>'parentRunId'=${args.parentRunId}`)
      ).rows
    : [];

  if (args.launchIntentId && !ownedIntent)
    throw new MaisterError(
      "CONFLICT",
      "Delegated launch does not own this parent reservation",
      { details: { reason: "delegation_intent_fenced" } },
    );
  if (args.reservedRunId) {
    const [ownedWork] = (
      await tx.execute(sql`SELECT 1 FROM specialist_work
        WHERE parent_run_id=${args.parentRunId} AND reserved_run_id=${args.reservedRunId}
          AND child_run_id IS NULL AND decision_state='open' FOR SHARE`)
    ).rows;

    if (
      !args.assignmentBounds ||
      incoming !== 1 ||
      args.launchIntentId ||
      !ownedWork
    )
      throw new MaisterError(
        "CONFLICT",
        "Delegated launch does not own this work reservation",
        {
          details: { reason: "delegated_work_binding_changed" },
        },
      );
  }
  const depth = chain.length - 1;
  const parentBounds = chain[0]?.bounds ?? null;
  const rootBounds = chain.at(-1)?.bounds ?? null;

  // ADR-165 (D5): min-merge the instance ceiling with the ROOT's and the
  // PARENT's snapshots. A NULL snapshot means env-only, which is what every
  // pre-3.7.0 tree has — so those keep byte-identical ADR-163 semantics.
  const envDepth = orchestratorMaxDepth();
  const maxDepth = Math.min(
    envDepth,
    rootBounds?.maxDepth ?? envDepth,
    parentBounds?.maxDepth ?? envDepth,
    args.assignmentBounds?.maxDepth ?? envDepth,
  );
  const boundsSource =
    parentBounds?.source === "node" || rootBounds?.source === "node"
      ? "node"
      : "env";

  if (depth >= maxDepth) {
    log.warn(
      {
        parentRunId: args.parentRunId,
        depth,
        cap: maxDepth,
        source: boundsSource,
        effective: maxDepth,
      },
      "[delegation.admit] refused — run-tree depth limit reached",
    );
    throw new MaisterError(
      "CONFIG",
      `delegation depth limit reached (${maxDepth})`,
    );
  }

  const live = await countLiveDelegatedChildren(
    tx,
    args.parentRunId,
    args.launchIntentId ?? null,
    args.reservedRunId ?? null,
  );
  const envFanout = orchestratorMaxFanout();
  const maxFanout = Math.min(
    envFanout,
    parentBounds?.maxFanout ?? envFanout,
    args.assignmentBounds?.maxFanout ?? envFanout,
  );

  if (live + incoming > maxFanout) {
    log.warn(
      {
        parentRunId: args.parentRunId,
        live,
        incoming,
        cap: maxFanout,
        source: boundsSource,
        effective: maxFanout,
      },
      "[delegation.fanout] refused — orchestrator fan-out cap reached",
    );
    throw new MaisterError(
      "CONFIG",
      `orchestrator fan-out limit reached (${maxFanout}); ${live} live child run(s) already`,
      {
        details: {
          reason: "delegation_fanout_exhausted",
          parentRunId: args.parentRunId,
        },
      },
    );
  }

  // ADR-165 (D8): the child-COUNT budget binds at EVERY ancestor. Depth and
  // fan-out alone cannot stop a depth-2 x fan-out-6 tree from causing 42 runs;
  // this is the bound that does.
  //
  // The PARENT lock cannot protect it. Its invariant is scoped to an ANCESTOR's
  // subtree, while the lock is keyed on the parent: two orchestrators in the
  // same tree hash to different keys, cannot see each other's uncommitted
  // children under READ COMMITTED, and both read the same pre-insert count —
  // so both admit and the ancestor's cap is blown. Serializing the whole TREE
  // on its ROOT is the coarsest scope that still contains every ancestor, and
  // it is per-tree, never the platform-wide mutex D-note above rejects.
  //
  // The shared tree helper already holds root-then-parent advisory locks.
  // A transaction holding the root can reenter for a nested parent while a
  // competitor waits at the root without holding that nested parent's key.

  for (const ancestor of chain) {
    const cap = ancestor.bounds?.budget?.maxChildRuns;

    if (cap === undefined) continue;

    const descendants = await countRunSubtree(
      tx,
      ancestor.id,
      ownedIntent?.task_id ?? null,
      args.reservedRunId ?? null,
    );

    if (descendants + incoming > cap) {
      log.warn(
        {
          ancestorRunId: ancestor.id,
          parentRunId: args.parentRunId,
          descendants,
          incoming,
          cap,
        },
        "[budget.tree.children] refused — child-count budget exhausted",
      );
      throw new MaisterError(
        "CONFIG",
        `child-run budget exhausted at run ${ancestor.id} (max_child_runs ${cap}); ${descendants} descendant run(s) already`,
      );
    }
  }
}
