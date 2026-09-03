import type { ExecutionHostTransport } from "./contracts";
import type { Db } from "./db";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { mintAssignment, setAssignmentWorkspace } from "./assignments";
import { defaultTransport } from "./default-transport";
import { LIVE_DRIVER_RUN_STATUSES } from "./hosts";
import { localHost } from "./resolver";

import { getDb } from "@/lib/db/client";
import { runs, runSessions } from "@/lib/db/schema";

// ADR-165 D9: evidence-based backfill of pre-Stage-A active runs. A run that
// still carries `execution_assignment_id = NULL` while a live driver status
// says it is executing gets epoch 1 (`legacy_backfill`) iff the local host
// reports a live session for it; a run without a session is left NULL for the
// reconcile sweep to classify. Parked/queued statuses are untouched — their
// next placement mints. Runs at boot (after command recovery) and on every
// `executionCommandReconcilePass`. MUST be deleted in Stage C (ADR-165).

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "legacy-backfill" });

export type LegacyBackfillSummary = {
  candidates: number;
  minted: number;
  leftNull: number;
  // "no_host": the registrar refused or the host was unreachable — logged once
  // per outage, retried on the next sweep (X-EH-22).
  skipped: "no_host" | null;
  errors: string[];
};

export type LegacyBackfillOptions = {
  db?: Db;
  transport?: ExecutionHostTransport;
  logger?: Logger;
  now?: () => Date;
};

const state = { warnedNoHost: false };

export function resetLegacyBackfillStateForTests(): void {
  state.warnedNoHost = false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function adoptLegacyActiveRuns(
  opts: LegacyBackfillOptions = {},
): Promise<LegacyBackfillSummary> {
  const db = opts.db ?? getDb();
  const transport = opts.transport ?? defaultTransport();
  const logger = opts.logger ?? defaultLog;
  const now = opts.now ?? (() => new Date());
  const summary: LegacyBackfillSummary = {
    candidates: 0,
    minted: 0,
    leftNull: 0,
    skipped: null,
    errors: [],
  };
  const candidates = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        isNull(runs.executionAssignmentId),
        inArray(runs.status, [...LIVE_DRIVER_RUN_STATUSES]),
      ),
    );

  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  let hostId: string;
  let sessions: SupervisorSessionRecord[];

  try {
    hostId = (await localHost({ db, transport, logger })).id;
    sessions = await transport.listSessions();
  } catch (err) {
    if (!state.warnedNoHost) {
      logger.warn(
        { candidates: candidates.length, err: errorMessage(err) },
        "legacy-backfill-skipped-no-host",
      );
      state.warnedNoHost = true;
    }
    summary.skipped = "no_host";

    return summary;
  }
  state.warnedNoHost = false;

  const liveByRun = new Map<string, SupervisorSessionRecord>();

  for (const session of sessions) {
    if (session.status === "live" && !liveByRun.has(session.runId)) {
      liveByRun.set(session.runId, session);
    }
  }

  for (const candidate of candidates) {
    const live = liveByRun.get(candidate.id);

    if (!live) {
      summary.leftNull += 1;
      logger.info(
        { runId: candidate.id, status: candidate.status },
        "legacy-backfill-left-null",
      );
      continue;
    }

    try {
      const minted = await db.transaction(async (tx) => {
        // Re-check under the run lock: a command issuer may have minted lazily
        // between the candidate scan and this claim.
        const [locked] = await tx
          .select({ executionAssignmentId: runs.executionAssignmentId })
          .from(runs)
          .where(eq(runs.id, candidate.id))
          .for("update");

        if (!locked || locked.executionAssignmentId) return null;

        const at = now();
        // The host stamps the session with the fence that created it. Reusing
        // that assignment id keeps later commands on the host's own fence.
        const assignment = await mintAssignment(tx, {
          runId: candidate.id,
          hostId,
          reason: "legacy_backfill",
          id: live.assignmentId,
          now: at,
          logger,
        });

        if (live.executionWorkspaceId) {
          await setAssignmentWorkspace(
            tx,
            assignment.id,
            live.executionWorkspaceId,
            at,
          );
        }
        await tx
          .update(runSessions)
          .set({ executionAssignmentId: assignment.id, updatedAt: at })
          .where(
            and(
              eq(runSessions.runId, candidate.id),
              eq(runSessions.hostSessionId, live.sessionId),
              isNull(runSessions.executionAssignmentId),
            ),
          );

        return assignment;
      });

      if (!minted) continue;
      summary.minted += 1;
      logger.warn(
        {
          runId: candidate.id,
          status: candidate.status,
          assignmentId: minted.id,
          hostSessionId: live.sessionId,
          executionWorkspaceId: live.executionWorkspaceId ?? null,
        },
        "legacy-run-backfilled",
      );
    } catch (err) {
      const message = errorMessage(err);

      summary.errors.push(`legacy backfill of run ${candidate.id}: ${message}`);
      logger.warn(
        { runId: candidate.id, err: message },
        "legacy-backfill-failed",
      );
    }
  }

  return summary;
}
