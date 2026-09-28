import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { librarianTurns, runs } from "@/lib/db/schema";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { mintPlacement } from "@/lib/execution-host/placement";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import { capForPool, countLiveRuns, takeSchedulerLock } from "@/lib/scheduler";

const log = pino({
  name: "librarian.park",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LibrarianParkApplication =
  | Readonly<{ parked: false }>
  | Readonly<{ parked: true; checkpointAt: Date; assignmentId: string | null }>;

/** ADR-185 D3: between turns the conversation run is parked, holding neither
 * a slot nor an assignment. The scheduler lock is taken FIRST so a parking
 * transaction and a pool promotion order run-row locks the same way. It never
 * touches `agent_turns` or `resume_requested_at` — `librarian_turns` is the
 * turn ledger. */
export async function applyLibrarianPark(
  tx: Db,
  runId: string,
): Promise<LibrarianParkApplication> {
  await takeSchedulerLock(tx);
  const [parked] = await tx
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.runKind, "librarian"),
        eq(runs.status, "Running"),
      ),
    )
    .returning({
      checkpointAt: runs.checkpointAt,
      assignmentId: runs.executionAssignmentId,
    });

  if (!parked?.checkpointAt) return { parked: false };
  await releaseAssignmentForRun(tx, runId, "parked");
  log.info(
    { runId, from: "Running", to: "NeedsInputIdle" },
    "librarian run parked",
  );

  return {
    parked: true,
    checkpointAt: parked.checkpointAt,
    assignmentId: parked.assignmentId,
  };
}

export type LibrarianResumeClaim =
  | Readonly<{ claimed: true; assignmentId: string }>
  | Readonly<{ claimed: false; reason: "pool_full" | "not_claimable" }>;

/** ADR-185 D3: takes a slot of the librarian pool for an ADMITTED turn and
 * places the run. A parked run (`NeedsInputIdle`) or a first turn's queued run
 * (`Pending`) becomes `Running`; anything else — above all a run that is
 * already `Running` — is refused. Under a full pool the run stays where it is
 * and the turn stays `admitted`, for the pool promotion to pick up. */
export async function claimLibrarianResumeInTransaction(
  tx: Db,
  input: { runId: string; turnId: string; host?: ExecutionHost },
): Promise<LibrarianResumeClaim> {
  await takeSchedulerLock(tx);
  const [turn] = await tx
    .select({ status: librarianTurns.status })
    .from(librarianTurns)
    .where(eq(librarianTurns.id, input.turnId))
    .for("update");

  if (turn?.status !== "admitted") {
    log.warn(
      { runId: input.runId, turnId: input.turnId, status: turn?.status },
      "librarian claim refused: turn not admitted",
    );

    return { claimed: false, reason: "not_claimable" };
  }
  const live = await countLiveRuns(tx, "librarian");
  const cap = capForPool("librarian");

  if (upgradeMaintenanceEngaged() || live >= cap) {
    log.debug(
      { runId: input.runId, turnId: input.turnId, live, cap },
      "librarian claim deferred: pool full",
    );

    return { claimed: false, reason: "pool_full" };
  }
  const [claimed] = await tx
    .update(runs)
    .set({ status: "Running", checkpointAt: null })
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.runKind, "librarian"),
        inArray(runs.status, ["NeedsInputIdle", "Pending"]),
      ),
    )
    .returning({ id: runs.id });

  if (!claimed) {
    log.warn(
      { runId: input.runId, turnId: input.turnId },
      "librarian claim refused: run not parked",
    );

    return { claimed: false, reason: "not_claimable" };
  }
  const assignment = await mintPlacement(tx, {
    runId: input.runId,
    reason: "librarian_turn",
    host: input.host,
  });

  log.info(
    {
      runId: input.runId,
      turnId: input.turnId,
      to: "Running",
      assignmentId: assignment.id,
      live: live + 1,
      cap,
    },
    "librarian run claimed",
  );

  return { claimed: true, assignmentId: assignment.id };
}
