import "server-only";

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

/**
 * Hops from `startId` up the `parent_run_id` chain. The parent run itself is
 * depth 0; each ancestor adds 1. A self-referencing FK does not rule out a
 * cycle, so the loop cap is what guarantees termination; only a manual DB edit
 * could introduce one.
 */
async function delegationDepth(tx: Db, startId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = startId;
  const cap = 64;

  while (currentId && depth < cap) {
    const rows = (await tx
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, currentId))) as { parentRunId: string | null }[];
    const parentRunId: string | null = rows[0]?.parentRunId ?? null;

    if (!parentRunId) break;
    depth += 1;
    currentId = parentRunId;
  }

  return depth;
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

  const depth = await delegationDepth(tx, args.parentRunId);
  const maxDepth = orchestratorMaxDepth();

  if (depth >= maxDepth) {
    log.warn(
      { parentRunId: args.parentRunId, depth, cap: maxDepth },
      "[delegation.admit] refused — run-tree depth limit reached",
    );
    throw new MaisterError(
      "CONFIG",
      `delegation depth limit reached (${maxDepth})`,
    );
  }

  const live = await countLiveDelegatedChildren(tx, args.parentRunId);
  const maxFanout = orchestratorMaxFanout();

  if (live + incoming > maxFanout) {
    log.warn(
      { parentRunId: args.parentRunId, live, incoming, cap: maxFanout },
      "[delegation.fanout] refused — orchestrator fan-out cap reached",
    );
    throw new MaisterError(
      "CONFIG",
      `orchestrator fan-out limit reached (${maxFanout}); ${live} live child run(s) already`,
    );
  }
}
