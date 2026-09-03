import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  cancelActiveAssignmentsForRun,
  ensureUserActor,
} from "@/lib/assignments/service";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { cleanupRunMaterializations } from "@/lib/capabilities/cleanup";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { finalizeAgentRun } from "@/lib/agents/launch";
import { runFlow } from "@/lib/flows/runner";
import { promoteNextPending } from "@/lib/scheduler";
import {
  ABANDONABLE_STATUSES,
  markAbandoned,
  releaseHumanWorking,
} from "@/lib/runs/state-transitions";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-run-abandon",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "abandon error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "abandon unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // Auth-first.
    const user = await requireActiveSession();

    const db = getDb() as Db;
    const rows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = rows[0];

    if (!run) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(run.projectId, "answerHitl");

    const actor = await ensureUserActor({
      db,
      projectId: run.projectId,
      userId: user.id,
      label: user.name ?? user.email ?? user.id,
    });

    // M37 (ADR-098) T7.4: abandoning a flow orchestrator (parked on
    // WaitingOnChildren OR with live run-tree children) cancels its whole
    // sub-tree FIRST (children-first) — rows AND the cascaded children's live
    // sessions — then abandons the coordinator below. Idempotent; touches only
    // descendants, never the orchestrator row itself.
    // Refuse BEFORE the cascade, not after. The cascade is irreversible and the
    // only abandonability guard used to be `markAbandoned`'s CAS, which runs
    // AFTER it — so abandoning an already-terminal orchestrator destroyed its
    // whole sub-tree and then returned 409, mutating on a rejected request with
    // no way for the operator to learn the children were killed. Deterministic,
    // not a race. `HumanWorking` is allowed through because the transaction
    // below releases it (→ NeedsInput) before the abandon fires.
    const refusesAbandon = (status: string): boolean =>
      status !== "HumanWorking" &&
      !ABANDONABLE_STATUSES.includes(
        status as (typeof ABANDONABLE_STATUSES)[number],
      );
    const notAbandonable = NextResponse.json(
      {
        code: "PRECONDITION",
        message: `run ${runId} is not in an abandonable state`,
      },
      { status: 409 },
    );

    if (run.runKind === "flow" && refusesAbandon(run.status)) {
      return notAbandonable;
    }

    if (run.runKind === "flow") {
      const { getChildRuns } = await import("@/lib/queries/run");
      const isOrchestrator =
        run.status === "WaitingOnChildren" ||
        (await getChildRuns(runId, db)).length > 0;

      if (isOrchestrator) {
        // Re-read immediately before the cascade. The check above ran against the
        // status selected at the top of the route, and `requireProjectAction`,
        // `ensureUserActor`, `getChildRuns` and two dynamic imports sit in
        // between — a multi-await window in which the run can complete or be
        // terminalized. Re-checking here collapses that to one statement, so a
        // refusal is overwhelmingly unlikely to have already destroyed the
        // sub-tree. It does not eliminate the window: nothing short of a fence
        // does, and a lifecycle claim cannot serialize against the graph runner,
        // which advances a run with no claim at all.
        const [fresh] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, runId));

        if (!fresh || refusesAbandon(fresh.status)) {
          log.warn(
            { runId, from: run.status, to: fresh?.status ?? null },
            "abandon refused after re-read — sub-tree left untouched",
          );

          return notAbandonable;
        }

        const { cascadeAbandonRunTreeAndStopSessions } = await import(
          "@/lib/orchestrator/cascade"
        );

        await cascadeAbandonRunTreeAndStopSessions(
          runId,
          run.taskId,
          "user_stopped",
          { db, logLabel: "[abandon.cascade]" },
        );
      }
    }

    const abandoned =
      run.runKind === "agent"
        ? await finalizeAgentRun(runId, "Abandoned", {
            db,
            reason: "user",
            closeAssignments: {
              kind: "user",
              actorId: actor.id,
              eventKind: "system_closed",
              reason: "run abandoned",
            },
          }).then((result) => ({ ok: result.finalized }))
        : await db.transaction(async (tx: Db) => {
            // A HumanWorking run releases its takeover claim first (HumanWorking →
            // NeedsInput) so the standard abandon transition fires from a known
            // non-terminal status; the original review HITL re-opening is moot once
            // the run is abandoned.
            if (run.status === "HumanWorking") {
              await releaseHumanWorking(runId, { db: tx });
            }

            const result = await markAbandoned(runId, { db: tx });

            if (result.ok) {
              await cancelActiveAssignmentsForRun({
                db: tx,
                runId,
                actorId: actor.id,
                eventKind: "system_closed",
                reason: "run abandoned",
              });
            }

            return result;
          });

    if (!abandoned.ok) {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message: `run ${runId} is not in an abandonable state`,
        },
        { status: 409 },
      );
    }

    // Run is now Abandoned (terminal) — reclaim its per-node capability dirs.
    const wsRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, runId));
    const wtPath = wsRows[0]?.worktreePath;

    if (wtPath) {
      await cleanupRunMaterializations({ runId, worktreePath: wtPath, db });
    }

    if (run.runKind !== "agent") {
      // A claimed/running slot just freed — promote the next queued Pending run.
      try {
        await promoteNextPending({
          db,
          runFlow: (next: string) => void runFlow(next, { db }),
        });
      } catch (err) {
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "promoteNextPending after abandon failed (non-fatal)",
        );
      }
    }

    log.info({ runId, from: run.status }, "run abandoned");

    return NextResponse.json(
      { ok: true, runStatus: "Abandoned" },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
