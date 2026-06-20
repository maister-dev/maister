import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { RunFlowOptions } from "@/lib/flows/graph/runner-core";

import { and, count, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isRunSettledEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  markResumedFromWait,
  rollbackResumeFromWait,
} from "@/lib/runs/state-transitions";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "orchestrator-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

type ResumeFlowFn = (
  runId: string,
  opts: RunFlowOptions,
) => Promise<void> | void;

type ParentRow = {
  id: string;
  runKind: string;
  status: string;
  currentStepId: string | null;
};

async function loadParent(
  db: Db,
  parentRunId: string,
): Promise<ParentRow | null> {
  const rows = await db
    .select({
      id: runs.id,
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(eq(runs.id, parentRunId));

  return rows[0] ?? null;
}

// Pending (non-SETTLED) children of an orchestrator run. SETTLED = terminal OR
// Review (C-2): a Review child has settled into a diff awaiting the coordinator,
// so it no longer holds the batch open — the LAST child reaching Review (or a
// terminal state) drops this to 0 and the parent is woken.
async function pendingChildCount(db: Db, parentRunId: string): Promise<number> {
  const rows: Array<{ n: number }> = await db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, parentRunId),
        notInArray(runs.status, [...SETTLED_RUN_STATUSES]),
      ),
    );

  return Number(rows[0]?.n ?? 0);
}

// M37 (ADR-098) T5.2: the orchestrator_resume outbox consumer. A child-terminal
// event wakes a PARKED orchestrator (run_kind='flow', status='WaitingOnChildren')
// once the batch needs the coordinator's attention. Kept SEPARATE from the
// auto_launch_run_plan consumer so the two concerns — launch the next as-plan
// tasks vs wake the coordinator — stay independent.
//
// Wake policy (ADR-100 — reacts to the SETTLED set: terminal kinds + run.review):
//   - a child that ended run.failed/run.crashed/run.abandoned ALWAYS wakes the
//     parent (deferred-release: the coordinator must handle a failed child even
//     if other children are still pending);
//   - a child that SETTLED success-side (run.done OR run.review — a diff to
//     promote/rework) wakes the parent ONLY when no pending (non-settled)
//     children remain (the whole batch has settled);
//   - otherwise (settled but siblings still pending) → wait for the rest.
//
// Idempotency / races: the dispatcher is a singleton, so the only race is
// at-least-once REDELIVERY plus a concurrent manual resume. markResumedFromWait
// is the single-winner CAS (WaitingOnChildren → Running) — a redelivered event or
// a manual resume that already won leaves the parent Running, so the CAS returns
// {ok:false} and this consumer SKIPS (no duplicate respawn). Only the CAS winner
// re-drives.
export function buildOrchestratorResumeConsumer(
  opts: { db?: Db; resumeFlow?: ResumeFlowFn } = {},
): DomainEventConsumer {
  return {
    id: "orchestrator_resume",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const _db = opts.db ?? getDb();

      for (const event of events) {
        // Each event is handled independently in try/catch: at-least-once means
        // one bad event must not abort (and thus redeliver) the whole window.
        try {
          // React to the SETTLED set (terminal kinds + run.review). A child
          // reaching Review wakes the coordinator to promote/rework its diff.
          if (!isRunSettledEventKind(event.kind)) continue;

          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const parentRunId = payload.parentRunId;

          if (typeof parentRunId !== "string" || parentRunId.length === 0) {
            continue;
          }

          // Branch on run_kind FIRST (skill-context rule 207): the orchestrator
          // is a FLOW run. NEVER drive a non-flow parent into the flow resume
          // path. A non-flow parent (e.g. an agent orchestrator) is handled
          // elsewhere; an already-resumed/terminal parent is not WaitingOnChildren.
          const parent = await loadParent(_db, parentRunId);

          if (!parent) {
            log.debug(
              { eventId: event.id, parentRunId },
              "orchestrator-resume: parent run not found — skip",
            );
            continue;
          }
          if (parent.runKind !== "flow") continue;
          if (parent.status !== "WaitingOnChildren") continue;
          if (!parent.currentStepId) {
            log.warn(
              { eventId: event.id, parentRunId },
              "orchestrator-resume: parked parent has no current_step_id — skip",
            );
            continue;
          }

          // Wake decision. A failed/crashed/abandoned child wakes the parent
          // unconditionally (deferred-release); a done child wakes only once the
          // batch has no remaining pending children.
          const childFailed =
            event.kind === "run.failed" ||
            event.kind === "run.crashed" ||
            event.kind === "run.abandoned";

          if (!childFailed) {
            const pending = await pendingChildCount(_db, parentRunId);

            if (pending > 0) {
              log.debug(
                { eventId: event.id, parentRunId, pending },
                "orchestrator-resume: done child but siblings still pending — wait",
              );
              continue;
            }
          }

          // Claim-before-spawn: the CAS is the race guard. A concurrent manual
          // resume / another child event that already won leaves the parent
          // Running → {ok:false} → SKIP (do not respawn a duplicate session).
          const claim = await markResumedFromWait(parentRunId, { db: _db });

          if (!claim.ok) {
            log.info(
              { eventId: event.id, parentRunId, kind: event.kind },
              "orchestrator-resume: CAS lost (already resumed) — skip",
            );
            continue;
          }

          log.info(
            {
              eventId: event.id,
              parentRunId,
              nodeId: parent.currentStepId,
              kind: event.kind,
              childFailed,
            },
            "orchestrator-resume: woke parked coordinator — re-driving flow",
          );

          // Re-drive via the graph resume re-entry: runFlow → runGraph reuses the
          // parked orchestrator node's NeedsInput attempt and respawns its ACP
          // session via session/resume on the retained acp_session_id. The graph
          // runner owns the resumed turn AND its terminal/re-park state. On a
          // RETRYABLE respawn failure surfaced from the re-drive, roll the CAS
          // back to WaitingOnChildren so a later child event retries the wake.
          await driveResume(
            _db,
            parentRunId,
            parent.currentStepId,
            opts.resumeFlow,
          );
        } catch (err) {
          log.warn(
            {
              eventId: event.id,
              code: isMaisterError(err) ? err.code : "UNKNOWN",
              err: err instanceof Error ? err.message : String(err),
            },
            "orchestrator-resume: event handling failed (logged, not thrown)",
          );
        }
      }
    },
  };
}

// Re-drive the woken orchestrator. The CAS already committed (Running), so this
// is a soft graph re-entry with the orchestratorResume signal. A retryable
// respawn failure surfaced HERE rolls the CAS back (Running → WaitingOnChildren)
// so a later event can retry; any other re-drive failure is owned by the graph
// runner (which marks the run terminal + emits run.failed). The default re-drive
// runs in the background (queueMicrotask) so the dispatcher loop is not blocked
// by a full coordinator turn; tests inject a synchronous resumeFlow.
async function driveResume(
  db: Db,
  parentRunId: string,
  targetStepId: string,
  injected?: ResumeFlowFn,
): Promise<void> {
  const resumeOpts: RunFlowOptions = {
    db,
    orchestratorResume: { targetStepId },
  };

  if (injected) {
    try {
      await injected(parentRunId, resumeOpts);
    } catch (err) {
      await rollbackOnRetryable(db, parentRunId, err);
    }

    return;
  }

  queueMicrotask(() => {
    void (async () => {
      try {
        const { runFlow } = await import("@/lib/flows/runner");

        await runFlow(parentRunId, resumeOpts);
      } catch (err) {
        await rollbackOnRetryable(db, parentRunId, err);
      }
    })();
  });
}

async function rollbackOnRetryable(
  db: Db,
  parentRunId: string,
  err: unknown,
): Promise<void> {
  const retryable = isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE";

  if (retryable) {
    log.warn(
      { parentRunId, err: err instanceof Error ? err.message : String(err) },
      "orchestrator-resume: retryable respawn failure — rolling CAS back to WaitingOnChildren",
    );
    await rollbackResumeFromWait(parentRunId, { db }).catch(() => {});

    return;
  }

  // Non-retryable: the graph runner owns the terminal state of the run (it marks
  // it Failed/Crashed and emits the terminal event). Nothing to roll back.
  log.error(
    {
      parentRunId,
      code: isMaisterError(err) ? err.code : "UNKNOWN",
      err: err instanceof Error ? err.message : String(err),
    },
    "orchestrator-resume: re-drive failed (terminal owned by graph runner)",
  );
}

export const orchestratorResumeConsumer = buildOrchestratorResumeConsumer();
