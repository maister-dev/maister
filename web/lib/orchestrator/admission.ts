import "server-only";

import type { DelegationBounds } from "@/lib/run-results/types";

import { and, eq, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  orchestratorMaxDepth,
  orchestratorMaxFanout,
} from "@/lib/instance-config";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";

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

/**
 * Serialize admission for ONE orchestrator.
 *
 * Deliberately NOT `SCHEDULER_LOCK_KEY`: that key is a single global mutex, so
 * reusing it would serialize every delegation on the platform against the
 * scheduler for the sake of a bound that is per-orchestrator by definition.
 * Keyed on the parent run id, two children of DIFFERENT orchestrators never
 * wait on each other while two children of the SAME one always do.
 */
async function takeDelegationLock(tx: Db, parentRunId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${DELEGATION_LOCK_NAMESPACE}::int, hashtext(${parentRunId})::int)`,
  );
}

/** One link of the ancestor chain: the run id and its bounds snapshot. */
type AncestorLink = { id: string; bounds: DelegationBounds | null };

/**
 * Walks up the `parent_run_id` chain from `startId`, collecting each ancestor's
 * bounds snapshot on the way.
 *
 * ONE walk serves all three bounds checks (ADR-165 T6.2): the depth count, the
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
  const cap = 64;

  while (currentId && chain.length < cap) {
    const rows = (await tx
      .select({
        parentRunId: runs.parentRunId,
        delegationBounds: runs.delegationBounds,
      })
      .from(runs)
      .where(eq(runs.id, currentId))) as {
      parentRunId: string | null;
      delegationBounds: DelegationBounds | null;
    }[];
    const row = rows[0];

    if (!row) break;
    chain.push({ id: currentId, bounds: row.delegationBounds ?? null });

    if (!row.parentRunId) break;
    currentId = row.parentRunId;
  }

  return chain;
}

/**
 * Descendants of `ancestorId` at ANY depth and in ANY status — the count
 * `budget.max_child_runs` bounds.
 *
 * All statuses on purpose: this is a "how much work has this coordinator caused"
 * budget, not a liveness question. A terminal child already spent its tokens.
 */
async function countRunSubtree(tx: Db, ancestorId: string): Promise<number> {
  const result: unknown = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM runs WHERE parent_run_id = ${ancestorId}
      UNION ALL
      SELECT r.id FROM runs r JOIN subtree s ON r.parent_run_id = s.id
    )
    SELECT count(*)::int AS n FROM subtree
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

  return rows[0]?.n ?? 0;
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
  args: { parentRunId: string; incoming?: number },
): Promise<void> {
  const incoming = args.incoming ?? 1;

  await takeDelegationLock(tx, args.parentRunId);

  // ONE walk for all three checks below.
  const chain = await walkAncestorChain(tx, args.parentRunId);
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

  const live = await countLiveDelegatedChildren(tx, args.parentRunId);
  const envFanout = orchestratorMaxFanout();
  const maxFanout = Math.min(envFanout, parentBounds?.maxFanout ?? envFanout);

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
  // Lock order is always parent-then-root, identical on every path, so no two
  // admissions can deadlock; when the parent IS the root the key repeats and
  // `pg_advisory_xact_lock` is re-entrant within one transaction.
  const rootRunId = chain.at(-1)?.id;

  if (rootRunId && rootRunId !== args.parentRunId) {
    await takeDelegationLock(tx, rootRunId);
  }

  for (const ancestor of chain) {
    const cap = ancestor.bounds?.budget?.maxChildRuns;

    if (cap === undefined) continue;

    const descendants = await countRunSubtree(tx, ancestor.id);

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
