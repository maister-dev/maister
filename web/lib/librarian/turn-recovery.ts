import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import pino from "pino";

import { admitNextLibrarianTurn } from "./admission";
import { lockOwnerConversation } from "./conversation";
import { dispatchLibrarianTurn } from "./pool";
import { LIBRARIAN_MAX_START_ATTEMPTS, endLibrarianTurn } from "./runtime";

import { getDb } from "@/lib/db/client";
import {
  executionCommands,
  librarianConversations,
  librarianTurns,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

// D19: a started turn with no prompt command after this long lost its start.
export const LIBRARIAN_START_GRACE_MS = 60_000;

type ActiveTurn = {
  id: string;
  status: "admitted" | "running";
  startedAt: Date | null;
  admittedAt: Date | null;
  startAttempts: number;
  deadlineAt: Date | null;
  runId: string | null;
};

async function activeTurnOfRun(
  db: Db,
  runId: string,
): Promise<ActiveTurn | null> {
  const [row] = await db
    .select({
      id: librarianTurns.id,
      status: librarianTurns.status,
      startedAt: librarianTurns.startedAt,
      admittedAt: librarianTurns.admittedAt,
      startAttempts: librarianTurns.startAttempts,
      deadlineAt: librarianTurns.deadlineAt,
      runId: librarianConversations.runId,
    })
    .from(librarianTurns)
    .innerJoin(
      librarianConversations,
      eq(librarianConversations.id, librarianTurns.conversationId),
    )
    .where(
      and(
        eq(librarianConversations.runId, runId),
        inArray(librarianTurns.status, ["admitted", "running"]),
      ),
    )
    .limit(1);

  return (row as ActiveTurn | undefined) ?? null;
}

/** The turn's newest prompt command, if its start got that far. */
async function promptCommandOf(
  db: Db,
  turnId: string,
): Promise<{
  id: string;
  targetSessionId: string | null;
  assignmentId: string;
} | null> {
  const [row] = await db
    .select({
      id: executionCommands.id,
      targetSessionId: executionCommands.targetSessionId,
      assignmentId: executionCommands.executionAssignmentId,
    })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.ownerKind, "librarian_turn"),
        sql`${executionCommands.ownerRef}->>'turnId' = ${turnId}`,
      ),
    )
    .orderBy(sql`${executionCommands.createdAt} DESC`)
    .limit(1);

  return row ?? null;
}

export type HostLossOutcome = "parked" | "restarted" | "none";

/** D19 `running × run not live`: reconcile's librarian arm. A turn that never
 * reached its prompt restarts (bounded); one whose prompt the host lost fails
 * `host_lost`. Either way no run is ever `Crashed`. */
export async function failLibrarianTurnForHostLoss(
  db: Db,
  runId: string,
): Promise<HostLossOutcome> {
  const turn = await activeTurnOfRun(db, runId);

  if (!turn) {
    // A `Running` librarian run without an active turn is an orphaned claim.
    const [parked] = await db.transaction(async (tx) => {
      const { applyLibrarianPark } = await import("./park");
      const application = await applyLibrarianPark(tx, runId);

      return [application.parked];
    });

    log.warn({ runId, parked }, "librarian run parked without an active turn");

    return parked ? "parked" : "none";
  }
  const command = await promptCommandOf(db, turn.id);

  if (!command && turn.startAttempts < LIBRARIAN_MAX_START_ATTEMPTS) {
    log.warn(
      { runId, turnId: turn.id, attempts: turn.startAttempts },
      "librarian turn start lost; restarting",
    );
    void dispatchLibrarianTurn(turn.id);

    return "restarted";
  }
  const ended = await endLibrarianTurn(
    db,
    turn.id,
    {
      status: "failed",
      reason: command ? "host_lost" : "start_failed",
    },
    ["admitted", "running"],
  );

  log.warn(
    {
      runId,
      turnId: turn.id,
      ended,
      reason: command ? "host_lost" : "start_failed",
    },
    "librarian turn failed after host loss",
  );

  return ended ? "parked" : "none";
}

/** "Stop response" (LCV-08): cancels the active turn's prompt, revokes its
 * token and ends it `stopped`. It never touches a task run or an operation. */
export async function stopLibrarianTurn(
  ownerId: string,
  db: Db = getDb() as unknown as Db,
): Promise<{ turnId: string }> {
  const turn = await db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);
    const [active] = await tx
      .select({ id: librarianTurns.id, status: librarianTurns.status })
      .from(librarianTurns)
      .where(
        and(
          eq(librarianTurns.conversationId, conversation.id),
          inArray(librarianTurns.status, ["admitted", "running"]),
        ),
      )
      .limit(1);

    return active ?? null;
  });

  if (!turn)
    throw new MaisterError("CONFLICT", "No librarian response is running", {
      details: { reason: "no_active_turn" },
    });
  const command = await promptCommandOf(db, turn.id);

  if (command?.targetSessionId) {
    try {
      const client = await createExecutionHosts({ db }).forAssignment({
        id: command.assignmentId,
      });

      await client.cancelPrompt(command.targetSessionId);
      await client.deleteSession(command.targetSessionId).catch(() => null);
    } catch (err) {
      log.warn(
        {
          turnId: turn.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "librarian stop: prompt cancel failed; ending the turn anyway",
      );
    }
  }
  await endLibrarianTurn(db, turn.id, { status: "stopped" }, [
    "admitted",
    "running",
  ]);
  log.warn({ ownerId, turnId: turn.id }, "librarian turn stopped by its owner");

  return { turnId: turn.id };
}

export type LibrarianSweepSummary = {
  deadlines: number;
  restarts: number;
  admissions: number;
};

/** The `system_sweep` backstop (D19/D20): deadlines, lost starts and queued
 * turns nothing admitted. Each arm is isolated; one failure never blocks the
 * next. */
export async function runLibrarianTurnSweep(
  db: Db = getDb() as unknown as Db,
  now: Date = new Date(),
): Promise<LibrarianSweepSummary> {
  const summary: LibrarianSweepSummary = {
    deadlines: 0,
    restarts: 0,
    admissions: 0,
  };
  const overdue = await db
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.status, "running"),
        lt(librarianTurns.deadlineAt, now),
      ),
    )
    .limit(100);

  for (const turn of overdue) {
    try {
      const command = await promptCommandOf(db, turn.id);

      if (command?.targetSessionId) {
        const client = await createExecutionHosts({ db }).forAssignment({
          id: command.assignmentId,
        });

        await client.cancelPrompt(command.targetSessionId).catch(() => null);
      }
      if (
        await endLibrarianTurn(db, turn.id, {
          status: "failed",
          reason: "deadline",
        })
      )
        summary.deadlines += 1;
      log.warn({ turnId: turn.id }, "librarian turn passed its deadline");
    } catch (err) {
      log.error(
        {
          turnId: turn.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "librarian deadline arm failed",
      );
    }
  }
  const stranded = await db
    .select({ id: librarianTurns.id, runId: librarianConversations.runId })
    .from(librarianTurns)
    .innerJoin(
      librarianConversations,
      eq(librarianConversations.id, librarianTurns.conversationId),
    )
    .innerJoin(runs, eq(runs.id, librarianConversations.runId))
    .where(
      and(
        inArray(librarianTurns.status, ["admitted", "running"]),
        eq(runs.status, "Running"),
        lt(
          sql`coalesce(${librarianTurns.startedAt}, ${librarianTurns.admittedAt})`,
          new Date(now.getTime() - LIBRARIAN_START_GRACE_MS),
        ),
      ),
    )
    .limit(100);

  for (const turn of stranded) {
    try {
      if (await promptCommandOf(db, turn.id)) continue;
      const outcome = await failLibrarianTurnForHostLoss(db, turn.runId!);

      if (outcome === "restarted") summary.restarts += 1;
    } catch (err) {
      log.error(
        {
          turnId: turn.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "librarian start-recovery arm failed",
      );
    }
  }
  const waiting = await db
    .selectDistinct({ conversationId: librarianTurns.conversationId })
    .from(librarianTurns)
    .where(eq(librarianTurns.status, "queued"))
    .limit(100);

  for (const row of waiting) {
    try {
      if (await admitNextLibrarianTurn(row.conversationId, { db }))
        summary.admissions += 1;
    } catch (err) {
      log.error(
        {
          conversationId: row.conversationId,
          err: err instanceof Error ? err.message : String(err),
        },
        "librarian admission arm failed",
      );
    }
  }
  try {
    const { promoteNextPending } = await import("@/lib/scheduler");

    await promoteNextPending({ db, pool: "librarian" });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "librarian pool promotion arm failed",
    );
  }
  if (summary.deadlines + summary.restarts + summary.admissions > 0)
    log.warn(summary, "librarian sweep acted");

  return summary;
}
