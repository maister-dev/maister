import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { claimLibrarianResumeInTransaction } from "./park";

import { getDb } from "@/lib/db/client";
import { librarianConversations, librarianTurns, runs } from "@/lib/db/schema";
import { localHost } from "@/lib/execution-host/resolver";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import { countLiveRuns, effectivePoolCap, takeSchedulerLock } from "@/lib/scheduler";

const log = pino({
  name: "librarian.pool",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LibrarianTurnStarter = (turnId: string) => Promise<void>;

/** The default dispatch: the runtime opens the turn's session and prompt. */
export const defaultLibrarianTurnStarter: LibrarianTurnStarter = async (
  turnId,
) => {
  const { startLibrarianTurn } = await import("./runtime");

  await startLibrarianTurn(turnId);
};

/** Starts a claimed turn outside every transaction. A failed start is the
 * turn's own recovery window (D19), never the caller's error. */
export function dispatchLibrarianTurn(
  turnId: string,
  start: LibrarianTurnStarter = defaultLibrarianTurnStarter,
): Promise<void> {
  return start(turnId).catch((err: unknown) => {
    log.error(
      {
        turnId,
        err: err instanceof Error ? err.message : String(err),
      },
      "librarian turn start failed",
    );
  });
}

/** ADR-185 D2: one slot of the librarian pool freed — admit the admitted turn
 * that has waited longest (FIFO by `admitted_at`). Queued, never refused. */
export async function promoteNextLibrarianTurn(
  opts: { db?: Db; start?: LibrarianTurnStarter } = {},
): Promise<{ promotedRunId: string | null }> {
  const db = opts.db ?? (getDb() as unknown as Db);

  if (upgradeMaintenanceEngaged()) return { promotedRunId: null };
  const host = await localHost({ db });
  const promoted = await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    const live = await countLiveRuns(tx, "librarian");
    const { cap } = await effectivePoolCap(tx, "librarian");

    if (live >= cap) {
      log.debug({ live, cap }, "librarian pool full; turns stay admitted");

      return null;
    }
    const [candidate] = await tx
      .select({ turnId: librarianTurns.id, runId: runs.id })
      .from(librarianTurns)
      .innerJoin(
        librarianConversations,
        eq(librarianConversations.id, librarianTurns.conversationId),
      )
      .innerJoin(runs, eq(runs.id, librarianConversations.runId))
      .where(
        and(
          eq(librarianTurns.status, "admitted"),
          eq(runs.runKind, "librarian"),
          inArray(runs.status, ["Pending", "NeedsInputIdle"]),
        ),
      )
      .orderBy(asc(librarianTurns.admittedAt), asc(librarianTurns.id))
      .limit(1)
      .for("update", { of: librarianTurns, skipLocked: true });

    if (!candidate) return null;
    const claim = await claimLibrarianResumeInTransaction(tx, {
      runId: candidate.runId,
      turnId: candidate.turnId,
      host,
    });

    return claim.claimed ? candidate : null;
  });

  if (!promoted) return { promotedRunId: null };
  log.info(
    { runId: promoted.runId, turnId: promoted.turnId },
    "librarian turn promoted from the pool queue",
  );
  void dispatchLibrarianTurn(promoted.turnId, opts.start);

  return { promotedRunId: promoted.runId };
}

/** 1-based position of an admitted turn waiting for a pool slot. */
export async function librarianPoolQueuePosition(
  db: Db,
  turnId: string,
): Promise<number | null> {
  const waiting = await db
    .select({ turnId: librarianTurns.id })
    .from(librarianTurns)
    .innerJoin(
      librarianConversations,
      eq(librarianConversations.id, librarianTurns.conversationId),
    )
    .innerJoin(runs, eq(runs.id, librarianConversations.runId))
    .where(
      and(
        eq(librarianTurns.status, "admitted"),
        inArray(runs.status, ["Pending", "NeedsInputIdle"]),
      ),
    )
    .orderBy(asc(librarianTurns.admittedAt), asc(librarianTurns.id));
  const index = waiting.findIndex((row) => row.turnId === turnId);

  return index < 0 ? null : index + 1;
}
